import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isRemoteConnection, remoteClientToken } from '../services/clientConnection'
let directory = ''

/** 主进程注入统一路径工厂的结果，读取器本身不初始化 Electron 或窗口。 */
export function configureClientCredential(value: string): void {
  directory = value
}

/** 凭据由本机主进程读取，不写入网页源码或日志。 */
export function getClientCredential(): string {
  if (isRemoteConnection()) return remoteClientToken()
  if (process.env.INFOS_API_TOKEN) return process.env.INFOS_API_TOKEN
  if (!directory) return ''
  try {
    return String(
      JSON.parse(readFileSync(path.join(directory, 'client-access.json'), 'utf8')).localToken || '',
    )
  } catch {
    return ''
  }
}
