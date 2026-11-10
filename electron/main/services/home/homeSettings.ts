/**
 * @file 「桌面与家」的配置文件 `desktop-home.json`（用户数据目录）。
 *
 * - 分区：vision（眼睛）、ears（耳朵）、companion（陪看）、environment（环境事件），
 *   字段见 homeSettingsSchema；
 *   另有不在设置页出现的内部状态 internal（耳朵模型的校验记录、编译缓存 DLL 的哈希）。
 * - 带版本号；旧版本按 homeSettingsMigrations 逐级迁移并写回，再按 schema 校验，损坏或缺失的部分用默认值。
 * - 写入原子化：先写临时文件再改名。
 * - 迁移：读到第一步前半的 `desktop-vision.json` 时，把它的值并入 vision 分区，写好新文件后删除旧文件。
 *
 * 只影响清晰度、耳朵与陪看的偏好，不涉及授权（桌面操作总开关仍在签名文件里）。
 * DLL 哈希一项额外带 HMAC 签名，见 assemblyIntegrity.ts。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 「桌面与家」设置
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { t } from '../../utils/i18n'
import type { DesktopHomeSection, DesktopHomeSettings } from '@infos/shared'
import {
  HOME_SETTINGS_MAX_BYTES,
  HOME_SETTINGS_VERSION,
  normalizeHomeSettings,
  normalizeInternal,
  normalizeSection,
  validatePatch,
  type HomeInternalState,
} from './homeSettingsSchema'
import { migrateHomeRecord } from './homeSettingsMigrations'

export const HOME_SETTINGS_FILE = 'desktop-home.json'
/** 第一步前半的旧文件，迁移后删除。 */
export const LEGACY_VISION_FILE = 'desktop-vision.json'

interface Snapshot {
  settings: DesktopHomeSettings
  internal: HomeInternalState
}

/** 解析文件内容并迁移到当前版本；不是对象、版本更新或体积过大时返回 undefined（按默认值处理）。 */
export function parseHomeRecord(text: string): { snapshot: Snapshot; version: number } | undefined {
  if (Buffer.byteLength(text, 'utf8') > HOME_SETTINGS_MAX_BYTES) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const version = record.version
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > HOME_SETTINGS_VERSION
  )
    return undefined
  const current = migrateHomeRecord(record, version, HOME_SETTINGS_VERSION)
  return {
    snapshot: {
      settings: normalizeHomeSettings(current),
      internal: normalizeInternal(current.internal),
    },
    version,
  }
}

export function parseHomeFile(text: string): Snapshot | undefined {
  return parseHomeRecord(text)?.snapshot
}

export class HomeSettingsStore {
  private cache?: { mtime: number; snapshot: Snapshot }
  private migrated = false
  private readonly listeners = new Set<(settings: DesktopHomeSettings) => void>()

  constructor(private readonly dir: () => string) {}

  file(): string {
    return path.join(this.dir(), HOME_SETTINGS_FILE)
  }

  /** 只在新文件可读取或已成功落盘时移除旧文件；失败时保留旧值供本次读取。 */
  private migrate(): Snapshot | undefined {
    if (this.migrated) return
    const legacy = path.join(this.dir(), LEGACY_VISION_FILE)
    if (!fs.existsSync(legacy)) {
      this.migrated = true
      return
    }
    let fallback: Snapshot | undefined
    try {
      if (fs.statSync(legacy).size > HOME_SETTINGS_MAX_BYTES) return
      const vision: unknown = JSON.parse(fs.readFileSync(legacy, 'utf8'))
      if (!vision || typeof vision !== 'object' || Array.isArray(vision)) return
      fallback = {
        settings: { ...normalizeHomeSettings({}), vision: normalizeSection('vision', vision) },
        internal: normalizeInternal({}),
      }
      if (fs.existsSync(this.file())) {
        // 损坏或未来版本的新文件不能证明迁移已完成，也不能覆盖或删除唯一旧副本。
        if (!parseHomeFile(fs.readFileSync(this.file(), 'utf8'))) return fallback
      } else this.write(fallback)
      fs.rmSync(legacy, { force: true })
      this.migrated = true
    } catch {
      // 用户数据目录不可写时继续使用旧值，下次读取再重试迁移。
    }
    return fallback
  }

  private read(): Snapshot {
    const legacy = this.migrate()
    let mtime = -1
    try {
      mtime = fs.statSync(this.file()).mtimeMs
    } catch {
      return legacy ?? { settings: normalizeHomeSettings({}), internal: normalizeInternal({}) }
    }
    if (this.cache?.mtime === mtime) return structuredClone(this.cache.snapshot)
    let snapshot: Snapshot | undefined
    try {
      const parsed = parseHomeRecord(fs.readFileSync(this.file(), 'utf8'))
      snapshot = parsed?.snapshot
      if (parsed && parsed.version < HOME_SETTINGS_VERSION) {
        // 旧版本文件按迁移结果写回；失败时本次仍用迁移后的值，旧文件原样保留，下次读取再试。
        try {
          this.write(parsed.snapshot)
          mtime = fs.statSync(this.file()).mtimeMs
        } catch {
          /* 用户数据目录暂时不可写。 */
        }
      }
    } catch {
      snapshot = undefined
    }
    snapshot ??= legacy ?? { settings: normalizeHomeSettings({}), internal: normalizeInternal({}) }
    this.cache = { mtime, snapshot }
    return structuredClone(snapshot)
  }

  private write(snapshot: Snapshot): void {
    const file = this.file()
    let version: unknown
    try {
      version = JSON.parse(fs.readFileSync(file, 'utf8'))?.version
    } catch {
      /* 文件缺失或损坏时允许写入修复。 */
    }
    if (typeof version === 'number' && version > HOME_SETTINGS_VERSION)
      throw new Error(
        `DESKTOP_HOME_SETTINGS_INVALID: ${t('electron.ui.desktopControl', '设置文件版本较新，请更新客户端后再修改。')}`,
      )
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify(
          { version: HOME_SETTINGS_VERSION, ...snapshot.settings, internal: snapshot.internal },
          null,
          2,
        ),
        'utf8',
      )
      fs.renameSync(temporary, file)
    } finally {
      // 写入或重命名失败也不遗留半截设置；旧目标文件由原子重命名保留。
      fs.rmSync(temporary, { force: true })
    }
    this.cache = undefined
  }

  get(): DesktopHomeSettings {
    return this.read().settings
  }

  section<S extends DesktopHomeSection>(section: S): DesktopHomeSettings[S] {
    return this.read().settings[section]
  }

  /** 设置页的修改：校验后写入，返回完整设置并通知订阅者。 */
  update(section: unknown, patch: unknown): DesktopHomeSettings {
    const valid = validatePatch(section, patch)
    const snapshot = this.read()
    const next = {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        [valid.section]: { ...snapshot.settings[valid.section], ...valid.values },
      },
    }
    this.write(next)
    const settings = this.get()
    for (const listener of this.listeners) listener(settings)
    return settings
  }

  internal(): HomeInternalState {
    return this.read().internal
  }

  /** 改内部状态（模型校验记录、DLL 哈希）；不通知设置页。 */
  updateInternal(change: (internal: HomeInternalState) => HomeInternalState): void {
    const snapshot = this.read()
    this.write({ ...snapshot, internal: normalizeInternal(change(snapshot.internal)) })
  }

  onChange(listener: (settings: DesktopHomeSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const homeSettings = new HomeSettingsStore(() => app.getPath('userData'))
