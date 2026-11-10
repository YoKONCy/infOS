/** 只识别受管 NapCat 安装目录，其他工具与用户工作区保持原有备份范围。 */
function napCatPath(relative: string): string | undefined {
  const path = relative.replaceAll('\\', '/').toLowerCase()
  const match = /^(?:data\/)?tools\/napcat\/(.+)$/.exec(path)
  return match?.[1]
}

const programFiles = new Set([
  'index.js', 'napcat.mjs', 'package.json', 'config.json', 'napcat.bat',
  'node.exe', 'napcat.shell.exe', 'wrapper.node', 'qqnt.dll',
  'avif_convert.dll', 'broadcast_ipc.dll', 'crypto.dll', 'libglib-2.0-0.dll',
  'libgobject-2.0-0.dll', 'libvips-42.dll', 'lightquic.dll', 'ncnn.dll',
  'opencv.dll', 'qbar.dll', 'ssl.dll',
])
const napCatProgramFiles = new Set([
  'napcat.mjs', 'loadnapcat.js', 'package.json', 'killqq.bat',
  'launcher.bat', 'launcher-win10.bat', 'launcher-user.bat', 'launcher-win10-user.bat',
  'launcher-elevate.ps1', 'quickloginexample.bat', 'napcatwinboothook.dll', 'napcatwinbootmain.exe',
])

/** 发行渠道可重新安装的程序文件；账号配置、数据、快速登录选择与第三方插件继续保存。 */
export function isSnapshotProgramPath(relative: string): boolean {
  const path = napCatPath(relative)
  if (!path) return false
  if (programFiles.has(path)) return true
  if (/^(?:win64|node_modules)(?:\/|$)/.test(path)) return true
  if (/^napcat\/(?:static|native|node_modules|worker)(?:\/|$)/.test(path)) return true
  if (/^(?:napcat\/)?plugins\/builtin(?:\/|$)/.test(path)) return true
  return path.startsWith('napcat/') && (
    napCatProgramFiles.has(path.slice(7)) || /^napcat\/conout-[\w-]+\.js$/.test(path)
  )
}

/** 运行日志和缓存按已知位置排除，工作区资料与账号数据库继续保存。 */
export function isSnapshotTransientPath(relative: string): boolean {
  const normalized = relative.replaceAll('\\', '/').toLowerCase()
  // 客户端启动语言由本机缓存提供，正式语言配置随主库同步。
  if (normalized === 'client-language.txt') return true
  if (/^data\/logs(?:\/|$)/.test(normalized)) return true
  const path = napCatPath(relative)
  return path !== undefined && (
    /^(?:napcat\/)?(?:logs|cache|temp)(?:\/|$)/.test(path) ||
    path === 'beacon_report.log' || path === '.infos-installing'
  )
}
