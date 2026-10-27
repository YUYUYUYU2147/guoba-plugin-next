import fs from 'fs'
import path from 'path'
import lodash from 'lodash'
import {_paths, ApiController, cfg} from '#guoba.platform'
import {autowired, Result} from '#guoba.framework'

/**
 * 首页相关查询
 */
export class HomeController extends ApiController {

  botService = autowired('botService')
  oicqService = autowired('oicqService')
  statusService = autowired('statusService')

  constructor(guobaApp) {
    super('/home', guobaApp)
  }

  registerRouters() {
    this.get('/data', this.getHomeData)
    this.get('/status', this.getSystemStatus)
    this.get('/msg-stat', this.getMsgStat)
    this.get('/random-image', this.randomImage)
  }

  /** 获取首页数据 */
  async getHomeData() {
    return Result.ok({
      cookieCount: await this.botService.getCookieCount(),
      friendCount: await this.oicqService.getFriendCount(),
      groupCount: await this.oicqService.getGroupCount(),
    })
  }

  /** 系统状态：负载、CPU、内存、磁盘、运行时长 */
  async getSystemStatus() {
    return Result.ok(await this.statusService.getSystemStatus())
  }

  /** 消息统计：收发量、近 7 天趋势、各 Bot 账号 */
  async getMsgStat(req) {
    const days = Math.min(30, Math.max(1, Number(req.query?.days) || 7))
    const [stat, bots] = await Promise.all([
      this.statusService.getMsgStat(days),
      this.statusService.getBotStat(),
    ])
    return Result.ok({...stat, bots})
  }

  // 随机角色图片
  async randomImage(req, res) {
    // 立绘来源：miao=喵喵素材随机，builtin=锅巴内置图，off=不显示
    const source = cfg.get('home.heroSource') || 'miao'
    if (source === 'off') {
      res.status(204).end()
      return Result.VOID
    }
    let imgPath = source === 'builtin' ? null : this.getRandomRoleImage()
    if (imgPath == null) {
      // 没装喵喵（或素材目录是空的），用锅巴自带的图兜底。
      // 这些是干净的透明底插画，不用再走 trim
      const fallback = this.getRandomHeroImage()
      res.sendFile(fallback ?? path.join(_paths.pluginResources, 'images/no-miao.png'))
      return Result.VOID
    }
    const trimmed = await this.trimImage(imgPath)
    if (trimmed) {
      res.type('webp').send(trimmed)
    } else {
      res.sendFile(imgPath)
    }
    return Result.VOID
  }

  /**
   * 裁掉立绘四周的空白边。
   *
   * 面板图素材约一半是「人物偏一侧、另一侧大片留白」的构图（喵喵渲染面板时
   * 在留白处叠文字），前端直接展示就会出现大块白边。这里用 sharp 的 trim
   * 按边缘颜色去边，得到只含人物的紧凑图。
   *
   * 裁完结果缓存在内存里，避免同一张图反复解码 —— 面板图最大有 5501×2655，
   * 一次 trim 要几百毫秒。
   */
  async trimImage(imgPath) {
    if (!this.trimCache) {
      this.trimCache = new Map()
    }
    if (this.trimCache.has(imgPath)) {
      return this.trimCache.get(imgPath)
    }
    let buffer = null
    try {
      const sharp = (await import('sharp')).default
      buffer = await this.buildHeroBuffer(sharp, imgPath)
        // 必须先填白再 trim：素材的空白边有的是透明、有的是纯白，
        // 而 trim 只认左上角一种基准色，不统一的话另一侧的白边裁不掉
        .flatten({background: '#ffffff'})
        // threshold 允许边缘有轻微渐变/杂色，纯 0 会漏掉压缩产生的噪点
        .trim({threshold: 12})
        // 裁完仍可能很大，限高到 2 倍展示尺寸，省带宽也省前端解码
        .resize({height: 400, withoutEnlargement: true})
        .webp({quality: 82})
        .toBuffer()
    } catch (e) {
      logger.warn('[Guoba] 裁剪角色图失败，返回原图：', e.message || e)
    }
    // 失败也缓存 null，避免每次请求都重试同一张坏图
    if (this.trimCache.size > 300) {
      this.trimCache.clear()
    }
    this.trimCache.set(imgPath, buffer)
    return buffer
  }


  /**
   * 抹掉素材图上的二维码水印后再裁剪。
   *
   * 喵喵素材（miao-plugin/resources/profile）来自米游社分享图，左侧留白区带二维码水印。
   * trim 只按边缘颜色去白边，水印不是白色会被保留，所以先把水印那块涂白，再交给 trim 当白边一起裁掉。
   */
  async buildHeroBuffer(sharp, imgPath) {
    const input = sharp(imgPath).flatten({background: '#ffffff'})
    if (cfg.get('home.heroClearQr') === false) {
      return input
    }
    try {
      const {width: W, height: H} = await sharp(imgPath).metadata()
      if (!W || !H) return input
      // 水印位于左侧留白区中部，按比例取一块，正常碰不到人物
      const left = 0
      const top = Math.round(H * 0.23)
      const width = Math.round(W * 0.20)
      const height = Math.round(H * 0.26)
      const {data, info} = await sharp(imgPath)
        .flatten({background: '#ffffff'})
        .extract({left, top, width, height})
        .resize({width: 80})
        .raw()
        .toBuffer({resolveWithObject: true})
      let dark = 0
      let total = 0
      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const mx = Math.max(r, g, b)
        const mn = Math.min(r, g, b)
        total++
        if (mx < 140 && mx - mn < 50) dark++
      }
      // 纯白留白的图不动，避免误伤左侧构图
      // 带咕咕牛二维码的素材，这块深色像素占比在 20% 以上；没有水印的图不到 12%
      if (total === 0 || dark / total < 0.18) return input
      const overlay = await sharp({create: {width, height, channels: 4, background: {r: 255, g: 255, b: 255, alpha: 1}}})
        .png()
        .toBuffer()
      // 同一条 pipeline 里 composite 会晚于 trim 执行，坐标会越界，先落地成图再包回去
      const composed = await input.composite([{input: overlay, left, top}]).png().toBuffer()
      return sharp(composed)
    } catch (e) {
      logger.warn('[Guoba] 抹除首页立绘水印失败：', e.message || e)
      return input
    }
  }
  /**
   * 锅巴自带的兜底立绘。
   *
   * 往 resources/images/hero/ 里丢图就会自动参与随机，不用改代码；
   * 目录被清空则回落到 no-miao.png。
   */
  getRandomHeroImage() {
    const dir = path.join(_paths.pluginResources, 'images/hero')
    let files = []
    try {
      files = fs.readdirSync(dir).filter((p) => /\.(jpg|jpeg|png|webp|gif)$/i.test(p))
    } catch {
      // 目录不存在，当没图处理
    }
    if (files.length === 0) {
      return null
    }
    return path.join(dir, lodash.sample(files))
  }

  // 安装了喵喵插件后，获取随机角色图片
  getRandomRoleImage() {
    if (!this.dirPaths) {
      let miaoPath = path.join(_paths.root, 'plugins', 'miao-plugin')
      // 均为「角色名/图片」两层结构，可共用下面的抽样逻辑。
      // 按优先级取第一个存在的：profile 是面板图素材，数量最多、画质最好，
      // 后两个仅作为未装该素材时的兜底 —— 若并列参与随机，
      // 会有相当比例的图仍来自体量小得多的 character-img。
      this.dirPaths = [
        path.join(miaoPath, 'resources/profile/normal-character'),
        path.join(miaoPath, 'resources/character-img'),
        path.join(miaoPath, 'resources/miao-res-plus/character-img'),
      ].filter(p => fs.existsSync(p)).slice(0, 1)
    }
    if (this.dirPaths.length === 0) {
      return null
    }
    let dirPath = this.dirPaths[0]
    let rolePaths = []
    fs.readdirSync(dirPath).forEach(p => rolePaths.push(path.join(dirPath, p)))
    if (rolePaths.length === 0) {
      return null
    }
    let rolePath = null
    let picPaths = []
    for (let i = 0; i < 10; i++) {
      rolePath = lodash.sample(rolePaths)
      if (fs.statSync(rolePath).isDirectory()) {
        picPaths = []
        fs.readdirSync(rolePath).filter((p) => /\.(jpg|png|jpeg|webp)$/i.test(p)).forEach(p => picPaths.push(path.join(rolePath, p)))
        // 好可怜，居然一张图片都没有，最多尝试10次
        if (picPaths.length > 0) {
          break
        }
      } else {
        rolePath = null
      }
    }
    if (picPaths.length === 0) {
      return null
    }
    return lodash.sample(picPaths)
  }

}
