/**
 * @file 本机设置签名
 * @description 只能由用户本人修改的设置（后端启动程序、桌面操作护栏名单）写在 Electron 用户数据目录，
 *              角色的文件工具在获批或自动执行模式下可能写到这里。设置文件带 HMAC 签名，
 *              密钥随机生成并经系统加密（Windows DPAPI / macOS 钥匙串，Electron safeStorage）保存；
 *              在应用外改写 JSON 无法伪造签名。密钥丢失或损坏时重新生成，旧签名随之失效（按“被外部修改”处理）。
 *
 *              这不是对抗本机任意代码执行的防线：能以用户身份运行任意程序的进程同样能调用系统加密接口。
 *              它挡住的是“只写文件”这一条路径。护栏与总开关通过 versionedSettings.ts 将用途域和递增版本纳入
 *              签名，并由主进程及受信副本保留版本水位；HMAC 本身不提供跨进程、全副本回放的历史证明。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 2、阶段 5
 * @module electron/main/services/settingsSigner
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { app, safeStorage } from 'electron'

export interface SettingsSigner {
  /** 返回签名；系统加密不可用时返回 null（调用方不保存需要签名的设置）。 */
  sign(payload: string): string | null
  /** 已有本机签名状态时，配置被全部删除也不能当作首次安装。 */
  hasKey?(): boolean
}

export const SETTINGS_KEY_FILE = 'infos-settings.key'

/** 比较签名（等长时用常量时间比较）。 */
export function sameSignature(left: unknown, right: string | null): boolean {
  if (typeof left !== 'string' || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 生产环境签名：随机 HMAC 密钥经 safeStorage 加密存放。 */
export function createSafeStorageSigner(keyFile: () => string): SettingsSigner {
  let key: Buffer | null = null
  const load = (): Buffer | null => {
    if (key) return key
    if (!safeStorage.isEncryptionAvailable()) return null
    const file = keyFile()
    try {
      const stored = Buffer.from(safeStorage.decryptString(fs.readFileSync(file)), 'base64')
      if (stored.length === 32) return (key = stored)
    } catch {
      // 不存在或无法解密：重新生成。
    }
    const created = randomBytes(32)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, safeStorage.encryptString(created.toString('base64')))
    return (key = created)
  }
  return {
    hasKey: () => fs.existsSync(keyFile()),
    sign: (payload) => {
      const current = load()
      return current ? createHmac('sha256', current).update(payload).digest('base64') : null
    },
  }
}

/** 全局签名器（启动设置与护栏名单共用一把密钥）。 */
export const settingsSigner = createSafeStorageSigner(() =>
  path.join(app.getPath('userData'), SETTINGS_KEY_FILE),
)
