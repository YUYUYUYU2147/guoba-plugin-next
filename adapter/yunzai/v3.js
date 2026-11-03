import {hasGenshin, hasPlugin} from './version.js'

let Restart
try {
  Restart = (await import('../../../other/restart.js')).Restart
} catch {
  Restart = (await import('./mock/system/apps.js')).Restart
}

let MysInfo, MysUser

/**
 * 米游社那套只在装了 genshin 插件时才有。
 *
 * 判据只看 `plugins/genshin` 在不在，不看宿主是哪一家 —— TRSS 系（含 Orangezai 这类
 * fork）默认不带 genshin，写死「非 TRSS 就 import」会让锅巴在这些宿主上直接加载失败。
 */
if (hasGenshin) {
  MysInfo = (await import('../../../genshin/model/mys/mysInfo.js')).default
  MysUser = (await import('../../../genshin/model/mys/MysUser.js')).default
} else if (hasPlugin('Mys-plugin')) {
  /**
   * 独立 Mys 插件（如 JiuLi 上的 Mys-plugin）不是 genshin，但它实现了与云崽 mys
   * 一致的 MysInfo / MysUser 接口（initCache / getBingCkUid / getStatData），
   * 首页的 CK 统计直接复用它，数据才和插件里看到的一致。
   * 导入失败（插件未启用/结构变化）时退回 mock，不影响锅巴其它功能。
   */
  try {
    MysInfo = (await import('../../../Mys-plugin/lib/components/Mys/model/mys/mysInfo.js')).default
    MysUser = (await import('../../../Mys-plugin/lib/components/Mys/model/mys/MysUser.js')).default
  } catch (e) {
    console.error('[guoba] 加载 Mys-plugin 失败，CK 统计退回 mock:', e?.message || e)
    MysInfo = undefined
    MysUser = undefined
  }
}

if (!MysInfo || !MysUser) {
  const mys = await import('./mock/genshin/mys.js')
  MysInfo = mys.MysInfo
  MysUser = mys.MysUser
}

export {
  Restart,
  MysInfo,
  MysUser,
}
