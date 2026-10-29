import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeAtomicJsonSync } from '../lib/atomicJson'

export interface ClientDevice {
  id: string
  name: string
  hash: string
  admin: boolean
  createdAt: number
  expiresAt: number
}
export interface ClientAccessState {
  version: 1
  localToken: string
  enabled: boolean
  port: number
  devices: ClientDevice[]
}

/** 安装实例的凭据独立于角色与会话数据，不进入同步快照或前端配置列表。 */
export class ClientAccessRepository {
  private file: string
  constructor(directory: string) {
    this.file = path.join(directory, 'client-access.json')
  }
  load(docker: boolean): ClientAccessState {
    if (existsSync(this.file)) {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as ClientAccessState
      if (
        !value ||
        value.version !== 1 ||
        typeof value.localToken !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.localToken) ||
        typeof value.enabled !== 'boolean' ||
        !Array.isArray(value.devices) ||
        value.devices.some(
          (device) =>
            !device ||
            typeof device.id !== 'string' ||
            typeof device.name !== 'string' ||
            typeof device.hash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(device.hash) ||
            typeof device.admin !== 'boolean' ||
            !Number.isFinite(device.createdAt) ||
            !Number.isFinite(device.expiresAt),
        ) ||
        !Number.isInteger(value.port) ||
        value.port < 1024 ||
        value.port > 65535
      )
        throw new Error('客户端鉴权存储损坏，请检查 client-access.json，已停止开放访问')
      return value
    }
    const value: ClientAccessState = {
      version: 1,
      localToken: randomBytes(32).toString('hex'),
      enabled: docker,
      port: 9122,
      devices: [],
    }
    this.save(value)
    return value
  }
  save(value: ClientAccessState): void {
    writeAtomicJsonSync(this.file, value)
  }
}
