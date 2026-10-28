import path from 'node:path'
import {
  cleanUntracked, commitsBetween, fastForward, fetchRepo, firstLine, readRepoInfo,
  resetToUpstream, runGit, stashPop, stashPush,
} from './gitRepo.js'

/**
 * 「把一个 git 仓库更新到上游最新」这件事本身。
 *
 * 从 Service 里抽出来是为了能测：更新的难点全在决策分支上 —— 有本地改动怎么办、历史分叉了
 * 怎么办、暂存的改动放不回去怎么办 —— 而这些分支只有在真实 git 仓库上跑才算验证过。
 * Service 那边只剩任务日志、装依赖和回滚记录。
 */

/** 这些文件变了就说明依赖可能要重装 */
const DEP_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'])

/** 遇到本地改动的三种处置 */
export const UPDATE_MODES = new Set(['safe', 'stash', 'force'])

/**
 * 更新一个仓库。
 *
 * @param {string} dir 仓库目录
 * @param {object} [opts]
 * @param {'safe'|'stash'|'force'} [opts.mode] 有本地改动时：跳过 / 暂存 / 丢弃，默认 safe
 * @param {(text: string, level?: string) => void} [opts.log] 过程说明，调用方自己加插件名前缀
 * @param {(child: object) => void} [opts.onSpawn] 透给 git，用来在取消任务时杀进程
 * @return {Promise<object>} `status`：updated / up-to-date / skipped / failed。
 *   跳过和失败都会在 `reason` 里写清原因 —— 一排「跳过」而不说为什么是最气人的
 */
export async function updateRepo(dir, {mode = 'safe', log = () => {}, onSpawn} = {}) {
  const out = {
    status: 'skipped', reason: '', from: '', to: '', before: '', after: '',
    commits: [], stash: '', depsChanged: false,
  }
  let info = await readRepoInfo(dir)
  if (!info.updatable) {
    log(info.reason, 'warn')
    return {...out, reason: info.reason}
  }

  log(`拉取 ${info.remote} 的最新引用`)
  const fetched = await fetchRepo(dir, info.remote, {onSpawn, onLine: (l) => log(`  ${l}`, 'cmd')})
  if (!fetched.ok) {
    const reason = firstLine(fetched.stderr) || `git fetch 退出码 ${fetched.code}`
    log(`拉取失败 —— ${reason}`, 'error')
    return {...out, status: 'failed', reason: `拉取失败：${reason}`}
  }

  info = await readRepoInfo(dir)
  // 强制更新时上游没有新提交也得动手：本地改动、未推送的提交、未跟踪文件都在要丢的范围里，
  // 只按「已是最新」提前返回的话，用户选了强制更新却什么都没变
  const mustDiscard = mode === 'force' && (info.dirty || info.ahead > 0 || info.untracked.length > 0)
  if (info.behind === 0 && !mustDiscard) {
    log('已是最新')
    return {...out, status: 'up-to-date', reason: '已是最新', before: info.commit, after: info.commit}
  }
  out.before = info.commit
  out.from = info.shortCommit

  // 本地改动：默认不碰，要动得由用户明确选
  let stashed = false
  if (info.dirty) {
    if (mode === 'safe') {
      const reason = `有 ${info.changed.length} 个文件被改过，已跳过（可选「暂存改动」或「强制更新」）`
      log(reason, 'warn')
      return {...out, reason}
    }
    if (mode === 'stash') {
      const res = await stashPush(dir, `guoba-update-${Date.now()}`, {onSpawn})
      if (!res.ok) {
        const reason = firstLine(res.stderr) || `git stash 退出码 ${res.code}`
        log(`暂存失败 —— ${reason}`, 'error')
        return {...out, status: 'failed', reason: `暂存本地改动失败：${reason}`}
      }
      stashed = true
      log(`本地改动已暂存（${info.changed.length} 个文件）`)
    }
  }

  const advance = mode === 'force'
    ? await discardLocal(dir, info.upstream, {onSpawn, log})
    : await fastForward(dir, info.upstream, {onSpawn, onLine: (l) => log(`  ${l}`, 'cmd')})
  if (!advance.ok) {
    // 快进不了基本只有一个原因：本地有没推上去的提交，历史分叉了
    let reason = info.ahead > 0
      ? `本地有 ${info.ahead} 个未推送的提交，没法快进（要么先推上去，要么用强制更新丢弃）`
      : firstLine(advance.stderr) || `git 退出码 ${advance.code}`
    log(`更新失败 —— ${reason}`, 'error')
    if (mode !== 'force' && info.untracked.length > 0) {
      // 未跟踪文件挡路时 git 只说 would be overwritten，看不出是哪几个文件，这里点一下
      reason += '；本地还有 ' + info.untracked.length + ' 个未跟踪文件，可能挡住了更新，可改用「强制更新」'
    }
    if (stashed) await popStash(dir, out, log)
    return {...out, status: 'failed', reason}
  }

  const after = await readRepoInfo(dir)
  out.after = after.commit
  out.to = after.shortCommit
  out.commits = await commitsBetween(dir, out.before, out.after)
  if (out.commits.length === 0) {
    // 上游没有新提交，这次只是强制更新把本地东西清掉了，不能报成更新成功；
    // 本地未推送的提交也会在这一步一并丢掉
    log('上游没有新提交；本地改动与未推送提交已按强制更新丢弃', 'warn')
    return {...out, status: 'up-to-date', reason: '已是最新，本地改动已丢弃'}
  }
  log(`${out.from} → ${out.to}，共 ${out.commits.length} 个提交`)
  for (const c of out.commits.slice(0, 5)) log(`  ${c.hash} ${c.subject}`, 'cmd')

  if (stashed) await popStash(dir, out, log)
  out.depsChanged = await depsChanged(dir, out.before, out.after)
  return {...out, status: 'updated', reason: ''}
}

/** 把暂存的改动放回去。冲突时 git 会留着 stash 不动，得说清楚让用户自己收拾 */
async function popStash(dir, out, log) {
  const res = await stashPop(dir)
  out.stash = res.ok ? 'restored' : 'kept'
  log(res.ok
    ? '暂存的改动已放回'
    : '暂存的改动放回时冲突了，还在 git stash 里，需要手动 git stash pop 处理',
  res.ok ? 'info' : 'warn')
}

/**
 * 强制更新：先硬对齐上游，再把未跟踪文件清掉。
 *
 * 两步必须一起做 —— 只 reset 的话，插件目录里新加的文件会留下来，用户看到的就是
 * 「选了强制更新，我的文件还在」。清不掉不算失败：代码已经对齐上游，残留文件在日志里提示。
 */
async function discardLocal(dir, upstream, {onSpawn, log}) {
  const res = await resetToUpstream(dir, upstream, {onSpawn})
  if (!res.ok) return res
  const cleaned = await cleanUntracked(dir, {onSpawn})
  if (!cleaned.ok) {
    const why = firstLine(cleaned.stderr) || ('git clean 退出码 ' + cleaned.code)
    log('已对齐上游，但未跟踪文件没清干净（' + why + '），需要手动处理', 'warn')
  }
  return res
}

/** 这次更新有没有动依赖文件 */
export async function depsChanged(dir, from, to) {
  if (!from || !to || from === to) return false
  const res = await runGit(['diff', '--name-only', `${from}..${to}`], {cwd: dir, timeout: 30000})
  if (!res.ok) return false
  return res.stdout.split(/\r?\n/).some((line) => DEP_FILES.has(path.basename(line.trim())))
}
