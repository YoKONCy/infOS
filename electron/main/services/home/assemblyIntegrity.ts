/**
 * @file 编译缓存 DLL（桌面桥接、视觉助手）的完整性校验。
 *
 * 这两个 DLL 缓存在用户数据目录的 `desktop-bridge/`，同一用户的其他程序可以替换它们。
 * 编译时记下 SHA-256（存在 `desktop-home.json` 的内部状态里，附 HMAC 签名），加载前比对：
 * - 记录与文件一致：照常加载。加载方（PowerShell / 桥接 C#）也先读字节、算哈希、比对后再从字节加载，
 *   不再按路径加载，读取与加载之间文件被换掉也无效。
 * - 没有记录、签名不对、哈希不一致：删掉文件，重新编译。
 *
 * 系统加密不可用（取不到签名密钥）时只记哈希不签名，仍能挡住「只替换 DLL」这一条路径。
 * 能同时改配置并调用系统加密接口的本机程序不在这道防线的范围内（与 settingsSigner 相同）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 桥接编译缓存
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sameSignature, settingsSigner, type SettingsSigner } from '../settingsSigner'
import { homeSettings, type HomeSettingsStore } from './homeSettings'

/** 签名的用途域：同一把密钥签的其他设置不能拿来冒充。 */
const DOMAIN = 'infos-desktop-assemblies/v1'
/** 最多记住几个 DLL（源码每次更新会换一个文件名）。 */
const MAX_RECORDS = 8

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256File(file: string): string {
  return sha256(fs.readFileSync(file))
}

function payload(assemblies: Record<string, string>): string {
  const sorted = Object.keys(assemblies)
    .sort()
    .map((name) => [name, assemblies[name]])
  return `${DOMAIN}\n${JSON.stringify(sorted)}`
}

export class AssemblyIntegrity {
  constructor(
    private readonly store: HomeSettingsStore,
    private readonly signer: SettingsSigner,
  ) {}

  /** 签名有效时的记录；签名不对（被改过）时视为没有任何记录。 */
  /** 签名器出错（系统加密接口异常）按「不可用」处理。 */
  private sign(text: string): string | null {
    try {
      return this.signer.sign(text)
    } catch {
      return null
    }
  }

  private records(): Record<string, string> {
    const internal = this.store.internal()
    const expected = this.sign(payload(internal.assemblies))
    if (expected === null) return internal.assemblies
    return sameSignature(internal.assembliesSignature, expected) ? internal.assemblies : {}
  }

  /** 这个 DLL 记录的哈希；没有可信记录时返回 undefined。 */
  expected(file: string): string | undefined {
    return this.records()[path.basename(file)]
  }

  /** 编译完成后记下哈希（只保留最近 MAX_RECORDS 个）。 */
  record(file: string, hash: string): void {
    const name = path.basename(file)
    const kept = Object.entries(this.records())
      .filter(([key]) => key !== name)
      .slice(-(MAX_RECORDS - 1))
    const assemblies = Object.fromEntries([...kept, [name, hash]])
    const signature = this.sign(payload(assemblies))
    this.store.updateInternal((internal) => ({
      ...internal,
      assemblies,
      ...(signature ? { assembliesSignature: signature } : { assembliesSignature: undefined }),
    }))
  }

  /**
   * 加载前检查：文件存在且与记录一致时返回哈希；不一致或没有记录时删掉文件并返回 undefined
   * （调用方随后重新编译）。文件不存在时也返回 undefined。
   */
  verifyOrRemove(file: string): string | undefined {
    if (!fs.existsSync(file)) return undefined
    const expected = this.expected(file)
    let actual: string | undefined
    try {
      actual = sha256File(file)
    } catch {
      actual = undefined
    }
    if (expected && actual === expected) return expected
    fs.rmSync(file, { force: true })
    return undefined
  }
}

/** 全局实例：与启动设置、护栏名单共用一把签名密钥。 */
export const assemblyIntegrity = new AssemblyIntegrity(homeSettings, settingsSigner)
