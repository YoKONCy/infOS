/**
 * @file 「桌面操作」总开关的设置文件：签名、递增 revision 与 `.accepted` 副本。从 desktopControl 拆出。
 *
 * 从未保存过时默认打开；保存过就记住用户的选择，重启不变。
 * 文件损坏、版本回退、签名不符或两份内容不一致时一律视为关闭，只能经设置页原生确认重新打开。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 总开关
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DesktopControlSettings } from '@infos/shared'
import type { SettingsSigner } from './settingsSigner'
import {
  lastAccepted,
  rememberAccepted,
  verifyVersioned,
  versionedPayload,
} from './versionedSettings'

const KIND = 'desktop-control'

export class DesktopControlSettingsFile {
  private revision = 0
  private snapshot = ''

  constructor(
    private readonly signer: SettingsSigner,
    private readonly file: () => string,
  ) {}

  private accepted(): string {
    return `${this.file()}.accepted`
  }

  private read(): string {
    return JSON.stringify(
      [this.file(), this.accepted()].map((file) => {
        try {
          return fs.readFileSync(file, 'utf8')
        } catch {
          return null
        }
      }),
    )
  }

  /** 文件自上次读写后是否被改过（包括应用外的修改）。 */
  changed(): boolean {
    return this.snapshot !== this.read()
  }

  /** 读取并校验；从未保存过时默认打开，其他异常返回关闭状态，快捷键沿用当前值。 */
  load(current: DesktopControlSettings): DesktopControlSettings {
    const key = this.accepted()
    if (!lastAccepted(key) && !fs.existsSync(this.file()) && !fs.existsSync(key)) {
      this.snapshot = this.read()
      return { ...current, enabled: true }
    }
    let settings = { ...current, enabled: false }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
      const baseline = JSON.parse(fs.readFileSync(key, 'utf8'))
      const next = { enabled: raw.enabled, stopShortcut: raw.stopShortcut }
      if (
        typeof next.enabled !== 'boolean' ||
        typeof next.stopShortcut !== 'string' ||
        !next.stopShortcut.trim() ||
        next.stopShortcut.length > 100
      )
        throw new Error('SETTINGS_INVALID')
      const payload = { enabled: baseline.enabled, stopShortcut: baseline.stopShortcut }
      if (
        JSON.stringify(next) !== JSON.stringify(payload) ||
        raw.revision !== baseline.revision ||
        !verifyVersioned(key, KIND, baseline.revision, payload, baseline.signature, this.signer) ||
        !verifyVersioned(key, KIND, raw.revision, next, raw.signature, this.signer)
      )
        throw new Error('SETTINGS_INVALID')
      rememberAccepted(key, KIND, raw.revision, next, false)
      this.revision = raw.revision
      // 签名有效就是用户上次的选择，重启后沿用（用户要求，不再每次重启都关）。
      settings = next
    } catch {
      // 只缺一份文件、损坏、回放或篡改均保持关闭，只能通过原生确认重新打开。
    }
    this.snapshot = this.read()
    return settings
  }

  /** 签名后写入两份文件（先写临时文件再改名）。 */
  write(next: DesktopControlSettings): void {
    const key = this.accepted()
    const revision = Math.max(this.revision, lastAccepted(key)?.revision ?? 0) + 1
    const signature = this.signer.sign(versionedPayload(KIND, revision, next))
    if (!signature) throw new Error('DESKTOP_SAFETY_ENCRYPTION_UNAVAILABLE')
    const content = JSON.stringify({ ...next, revision, signature }, null, 2)
    for (const file of [key, this.file()]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(`${file}.tmp`, content, 'utf8')
      fs.renameSync(`${file}.tmp`, file)
    }
    rememberAccepted(key, KIND, revision, next)
    this.revision = revision
    this.snapshot = this.read()
  }
}
