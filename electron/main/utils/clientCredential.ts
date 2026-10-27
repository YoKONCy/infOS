import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isRemoteConnection, remoteClientToken } from '../services/clientConnection'
let directory = ''

/** 本机凭据短期复用；只容忍有上限的文件占用，不容忍删除或损坏。 */
export class LocalClientCredentialCache {
  private token = ''
  private lastReadAt = 0
  private nextReadAt = 0
  constructor(
    private readonly read: () => string,
    private readonly now = Date.now,
  ) {}

  get(refresh = false): string {
    const time = this.now()
    if (!refresh && this.token && time < this.nextReadAt) return this.token
    try {
      const token: unknown = JSON.parse(this.read())?.localToken
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        this.token = ''
        return ''
      }
      this.token = token
      this.lastReadAt = time
      this.nextReadAt = time + 1000
      return token
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      const transient = ['EACCES', 'EPERM', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE'].includes(
        code || '',
      )
      // 短暂占用只复用最近五秒内读到的有效值，服务端仍会逐次验证其是否有效。
      if (transient && this.token && time - this.lastReadAt <= 5000) {
        this.nextReadAt = Math.min(time + 200, this.lastReadAt + 5000)
        return this.token
      }
      this.token = ''
      return ''
    }
  }
}

let localCredential = new LocalClientCredentialCache(() => '')

/** 主进程注入统一路径工厂的结果，读取器本身不初始化 Electron 或窗口。 */
export function configureClientCredential(value: string): void {
  directory = value
  localCredential = new LocalClientCredentialCache(() =>
    readFileSync(path.join(directory, 'client-access.json'), 'utf8'),
  )
}

/** 凭据由本机主进程读取，不写入网页源码或日志。 */
export function getClientCredential(refresh = false): string {
  if (isRemoteConnection()) return remoteClientToken()
  if (process.env.INFOS_API_TOKEN) return process.env.INFOS_API_TOKEN
  if (!directory) return ''
  return localCredential.get(refresh)
}
