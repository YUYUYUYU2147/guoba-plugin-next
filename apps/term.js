import {autowired} from '#guoba.framework'
import {cfg} from '#guoba.platform'
import {renderLogImage, makeForwardMsg} from '#guoba.utils'

/**
 * 锅巴远程终端。
 *
 * 网页终端走 TermService（TermController），这里把同一条终端会话开到 QQ 上：
 * 主人发指令执行 shell，输出回聊天，长输出合并转发、或出图。
 *
 * 与网页终端共用一套开关（security.enableTerminal）和同一条会话：网页里正在跑的
 * 命令在 QQ 这边能看到，「中断」也会一并生效。没有单独再开一个 shell —— 多开等于
 * 多个 cwd 状态，反而更难对。
 *
 * 等价于服务器 root shell，只认主人，且默认关闭。
 */

/** 一次执行最多回多少行，再多转图或截断 */
const MAX_TEXT_LINES = 120
/** 轮询间隔 */
const POLL_INTERVAL = 200
/** 默认等待命令结束的上限（毫秒），可在指令后加秒数覆盖 */
const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 600_000

/** 等待当前命令结束，返回它新产生的输出行 */
async function waitForOutput(termService, startSeq, timeout) {
  const deadline = Date.now() + timeout
  // 先给命令一点启动时间，避免 exec 后立刻读到 running=false 的空窗
  await new Promise(r => setTimeout(r, 80))
  let quiet = 0
  for (;;) {
    const state = termService.query(startSeq)
    const running = state.running
    const lines = state.lines || []
    if (!running) {
      // 结束后再等一小会儿，收尾可能还有 chunk 落进缓冲
      if (quiet++ >= 2) return {lines, state}
    } else {
      quiet = 0
    }
    if (Date.now() > deadline) return {lines, state, timeout: true}
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
}

function formatLines(lines) {
  const out = []
  const err = []
  for (const line of lines) {
    if (line.type === 'err') err.push(line.text)
    else if (line.type === 'out') out.push(line.text)
    // type === 'cmd' 是提示符回显，跳过
  }
  const parts = []
  if (out.length) parts.push(out.join('\n'))
  if (err.length) parts.push(`标准错误：\n${err.join('\n')}`)
  return parts.join('\n\n').trim()
}

export class GuobaTerm extends plugin {
  termService = autowired('termService')

  constructor() {
    super({
      name: '锅巴远程终端',
      dsc: '在 QQ 上操作锅巴网页终端的同一条 shell 会话',
      event: 'message',
      priority: 90,
      // 全称 #锅巴终端…，简写 #gt…（对齐 TRSS 的 rc/rcp 那种手感）。
      // 不用 rc/rcp 是因为 TRSS-Plugin 已占用且优先级更高，会抢走。
      rule: [
        {reg: '^#?(?:锅巴终端|gt)(开启|打开|启用|关闭|关)$', fnc: 'toggle', permission: 'master'},
        {reg: '^#?(?:锅巴终端|gt)状态$', fnc: 'status', permission: 'master'},
        {reg: '^#?(?:锅巴终端|gt)中断$', fnc: 'interrupt', permission: 'master'},
        {reg: '^#?(?:锅巴终端图|gtp)\\s+([\\s\\S]+)$', fnc: 'execImage', permission: 'master'},
        {reg: '^#?(?:锅巴终端|gt)\\s+([\\s\\S]+)$', fnc: 'execText', permission: 'master'},
      ],
    })
  }

  #enabled() {
    return cfg.get('security.enableTerminal') === true
  }

  #assertEnabled() {
    if (this.#enabled()) return true
    this.reply('锅巴终端未开启。先发「#gt开启 / #锅巴终端开启」或到面板终端页打开开关（等同服务器 shell，请谨慎）')
    return false
  }

  async toggle() {
    const enable = !/关闭|关$/.test(this.e.msg.replace(/\s/g, ''))
    cfg.set('security.enableTerminal', enable)
    logger.mark(`[Guoba] 网页/远程终端${enable ? '已启用' : '已关闭'}（QQ）`)
    return this.reply(enable
      ? '锅巴终端已开启：发「#gt 命令」或「#锅巴终端 命令」执行，等同服务器 shell，请谨慎使用。'
      : '锅巴终端已关闭。')
  }

  async status() {
    try {
      const s = this.termService.status()
      return this.reply([
        `终端开关：${this.#enabled() ? '开启' : '关闭'}`,
        `shell：${s.shell}`,
        `当前目录：${s.cwd}`,
        `运行中：${s.running ? '是' : '否'}`,
        `提示符：${s.prompt}`,
      ].join('\n'))
    } catch (err) {
      logger.debug(`[Guoba] 取终端状态失败：${err?.message}`)
      return this.reply('锅巴服务没有启动，取不到终端状态')
    }
  }

  async interrupt() {
    if (!this.#assertEnabled()) return
    try {
      this.termService.interrupt()
      return this.reply('已发送中断（Ctrl+C）')
    } catch (err) {
      return this.reply(err?.message || '没有正在执行的命令')
    }
  }

  /** 从指令里拆出命令本身；`图` 指令带「图」前缀 */
  #parseCommand() {
    const msg = String(this.e.msg || '')
    // 全称：「锅巴终端 / 锅巴终端图」；简写：「gt / gtp」
    const m = msg.match(/^#?(?:锅巴终端(图)?|(gtp)|gt)\s+([\s\S]+)$/)
    if (!m) return null
    let body = m[3].trim()
    let timeout = DEFAULT_TIMEOUT
    // 允许末尾用 --timeout=秒 指定等待上限
    const t = body.match(/\s*--timeout=(\d+(?:\.\d+)?)\s*$/)
    if (t) {
      timeout = Math.min(Math.max(Number(t[1]) * 1000, 1000), MAX_TIMEOUT)
      body = body.slice(0, t.index).trim()
    }
    return {cmd: body, image: m[1] === '图', timeout}
  }

  async #run(cmd, timeout) {
    const before = this.termService.query(0)
    const startSeq = before.cursor || 0
    let execRet
    try {
      execRet = this.termService.exec(cmd)
    } catch (err) {
      return {error: err?.message || String(err), lines: []}
    }
    if (!execRet?.ok) return {error: '命令为空或未执行', lines: []}
    const {lines, state, timeout: timedOut} = await waitForOutput(this.termService, startSeq, timeout)
    return {lines, state, timedOut}
  }

  async execText() {
    if (!this.#assertEnabled()) return
    const parsed = this.#parseCommand()
    if (!parsed) return
    if (!parsed.cmd) return this.reply('用法：#gt 命令（或 #锅巴终端 命令）')
    try {
      const {error, lines, timedOut} = await this.#run(parsed.cmd, parsed.timeout)
      if (error) return this.reply(`执行失败：${error}`)
      const text = formatLines(lines)
      if (!text && !timedOut) return this.reply('命令执行完成，没有输出')
      const header = timedOut ? '（等待超时，命令可能仍在运行；可发「#gt中断」）' : ''
      const body = text || '（暂无输出）'
      const all = text ? text.split('\n') : []
      if (all.length <= MAX_TEXT_LINES && (header + body).length <= 1500) {
        return this.reply([header, body].filter(Boolean).join('\n'))
      }
      // 太长：合并转发，避免刷屏
      const chunks = []
      for (let i = 0; i < all.length; i += 60) chunks.push(all.slice(i, i + 60).join('\n'))
      if (header) chunks.unshift(header)
      return this.reply(await makeForwardMsg(this.e, chunks, '锅巴终端输出'))
    } catch (err) {
      logger.error(`[Guoba] 远程终端执行失败：${err?.message}`)
      return this.reply(`执行失败：${err?.message || err}`)
    }
  }

  async execImage() {
    if (!this.#assertEnabled()) return
    const parsed = this.#parseCommand()
    if (!parsed) return
    if (!parsed.cmd) return this.reply('用法：#gtp 命令（或 #锅巴终端图 命令）')
    try {
      const {error, lines, timedOut} = await this.#run(parsed.cmd, parsed.timeout)
      if (error) return this.reply(`执行失败：${error}`)
      const text = formatLines(lines)
      const footer = timedOut ? '等待超时，命令可能仍在运行' : ''
      const items = (text || '（暂无输出）').split('\n').map((line) => ({
        time: '',
        level: /^(标准错误|\[exit )/.test(line) ? 'ERRO' : 'INFO',
        message: line,
      }))
      const res = await renderLogImage(items, {title: '锅巴终端', footer})
      if (res?.image) return this.reply(res.image)
      // 渲染器不可用就退回文本
      return this.reply(text || '命令执行完成，没有输出')
    } catch (err) {
      logger.error(`[Guoba] 远程终端出图失败：${err?.message}`)
      return this.reply(`执行失败：${err?.message || err}`)
    }
  }
}
