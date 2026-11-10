/**
 * infOS 自己的凭据与访问控制文件：她的文件工具（home_files、旧 read_file / write_file / delete_file、
 * 搜索与列目录）一律读不到、写不到、删不到。
 *
 * - 后端数据目录里的机器私有文件按完整路径保护（与 backupStorage.LOCAL_FILES、
 *   distributedSyncService.MACHINE_PATHS 同一份清单：管理凭据、网关令牌、JWT 密钥、节点身份与信任、
 *   设备令牌、分布式凭据）。容器启动时用 registerProtectedDataDir 登记数据目录。
 * - 名字足够独特的凭据文件不论在哪个目录都保护：Electron 用户数据目录里的设备凭据、
 *   设置签名密钥、连接凭据、桌面安全与总开关设置（后端不知道 Electron 用户数据目录在哪）。
 *   原子写入的临时文件（`名字.tmp`、`名字.<随机>.tmp`）同样保护。
 */

import path from 'node:path'

/** 数据目录下的机器私有文件（相对路径）。 */
export const PROTECTED_DATA_FILES = [
  'client-access.json',
  'gateway_token.json',
  'jwt_secret.key',
  'kernel/nodes.json',
  'kernel/node-identity.json',
  'kernel/trust.json',
  'kernel/capability-device-tokens.json',
  'distributed/server-credentials.key',
  'distributed/servers.json',
  'distributed/last-sync.json',
  'electron-node-id.txt',
] as const

/** 不论在哪个目录都保护的凭据与访问控制文件名。 */
export const PROTECTED_FILE_NAMES = [
  // 后端
  'client-access.json',
  'gateway_token.json',
  'jwt_secret.key',
  'server-credentials.key',
  'node-identity.json',
  'capability-device-tokens.json',
  // Electron 用户数据目录
  'capability-device-credential.json',
  'client-connection.json',
  'infos-settings.key',
  'desktop-safety.json',
  'desktop-safety.accepted.json',
  'desktop-control.json',
] as const

let dataFiles: string[] = []

const key = (file: string) => {
  const resolved = path.resolve(file).replace(/\\/g, '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 登记后端数据目录（容器启动时调用；测试可重复调用）。 */
export function registerProtectedDataDir(dataDir: string | undefined): void {
  dataFiles = dataDir ? PROTECTED_DATA_FILES.map((file) => key(path.join(dataDir, file))) : []
}

/** 名字或它的原子写入临时文件是不是受保护的凭据文件。 */
function protectedName(base: string): boolean {
  const name = process.platform === 'win32' ? base.toLowerCase() : base
  return PROTECTED_FILE_NAMES.some(
    (item) => name === item || (name.startsWith(`${item}.`) && name.endsWith('.tmp')),
  )
}

/** 这个路径是不是 infOS 的凭据或访问控制文件（含原子写入的临时文件）。 */
export function isProtectedCredentialFile(file: string): boolean {
  if (!file) return false
  const normalized = key(file)
  if (
    dataFiles.some(
      (item) =>
        normalized === item || (normalized.startsWith(`${item}.`) && normalized.endsWith('.tmp')),
    )
  )
    return true
  return protectedName(path.basename(normalized))
}
