import os from 'node:os'
import path from 'node:path'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { HomeError } from './homeErrors'

export const pathKey = (value: string) =>
  process.platform === 'win32' ? value.toLowerCase() : value
export function containsPath(root: string, target: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(target))
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}
/** 拒绝路径穿越、NT 设备路径、ADS、符号链接和 junction；允许尚未创建的叶子。 */
export function canonicalPath(input: string): string {
  if (!path.isAbsolute(input) || /[\x00-\x1f]/.test(input) || input.split(/[\\/]/).includes('..'))
    throw new HomeError('HOME_PATH_INVALID')
  if (
    process.platform === 'win32' &&
    (input.startsWith('\\\\') ||
      input.slice(2).includes(':') ||
      input
        .split(/[\\/]/)
        .some((p) => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
  )
    throw new HomeError('HOME_PATH_INVALID')
  const resolved = path.resolve(input)
  let cursor = path.parse(resolved).root
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        throw new HomeError('HOME_PATH_INVALID')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  let ancestor = resolved
  const rest: string[] = []
  while (!existsSync(ancestor)) {
    rest.unshift(path.basename(ancestor))
    ancestor = path.dirname(ancestor)
  }
  return path.join(realpathSync.native(ancestor), ...rest)
}

/** @platform WINDOWS/LINUX/DARWIN 系统及程序目录固定逐次确认。 */
export function protectedRoots(): string[] {
  return process.platform === 'win32'
    ? [
        process.env.SystemRoot ?? 'C:\\Windows',
        process.env.ProgramFiles ?? 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        process.env.ProgramData ?? 'C:\\ProgramData',
      ]
    : [
        '/bin',
        '/sbin',
        '/usr',
        '/etc',
        '/System',
        '/Library',
        '/Applications',
        '/boot',
        '/proc',
        '/dev',
        '/sys',
      ]
}

/**
 * 放进去就会被系统自动运行或优先解析的位置：新建、修改都问，优先于「新建」和「她建的」。
 * 不靠扩展名判断：同一个 .bat 放在普通文件夹里只是文件，放在启动文件夹里才会运行。
 * - trees：这个目录（或文件）本身和它下面的一切；
 * - searchDirs：可执行搜索路径，只有直接放在里面才会被解析到，子目录不算。
 */
export interface HomeSensitiveLocations {
  trees: string[]
  searchDirs: string[]
}

/** 换算成和 canonicalPath 同样的真实路径（短文件名、链接都展开）；还不存在的部分原样接上。 */
const resolveExisting = (file: string) => {
  let ancestor = path.resolve(file)
  const rest: string[] = []
  for (;;) {
    try {
      return path.join(realpathSync.native(ancestor), ...rest)
    } catch {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return path.resolve(file)
      rest.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}
export const resolveLocations = (locations: HomeSensitiveLocations): HomeSensitiveLocations => ({
  trees: locations.trees.map(resolveExisting),
  searchDirs: locations.searchDirs.map(resolveExisting),
})

/** @platform WINDOWS/LINUX/DARWIN 要扩展已知的自动加载位置，就加在这一处。 */
export function sensitiveLocations(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): HomeSensitiveLocations {
  const under = (root: string | undefined, ...parts: string[]) =>
    root ? [path.join(root, ...parts)] : []
  const trees =
    platform === 'win32'
      ? [
          // 开机启动
          ...under(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
          ...under(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
          // 计划任务
          ...under(env.SystemRoot, 'System32', 'Tasks'),
          ...under(env.SystemRoot, 'Tasks'),
          // PowerShell 配置文件（文档目录可能被 OneDrive 接管）
          ...[env.USERPROFILE ?? home, env.OneDrive].flatMap((root) =>
            ['WindowsPowerShell', 'PowerShell'].flatMap((name) => under(root, 'Documents', name)),
          ),
        ]
      : [
          ...['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile'].map((name) =>
            path.join(home, name),
          ),
          path.join(home, '.config', 'autostart'),
          path.join(home, '.config', 'powershell'),
          path.join(home, 'Library', 'LaunchAgents'),
        ]
  // 进程环境里的 PATH 就是用户和系统 PATH 合起来的结果。
  const searchPath = env.PATH ?? env.Path ?? ''
  const searchDirs = searchPath
    .split(platform === 'win32' ? ';' : ':')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter((dir) => dir && path.isAbsolute(dir))
  return { trees, searchDirs }
}

export function isSensitiveLocation(locations: HomeSensitiveLocations, file: string): boolean {
  return (
    locations.trees.some((root) => containsPath(root, file)) ||
    locations.searchDirs.some((dir) => pathKey(dir) === pathKey(path.dirname(file)))
  )
}
