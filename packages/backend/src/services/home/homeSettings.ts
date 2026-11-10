import {
  HOME_DEFAULT_SETTINGS,
  HOME_DELETE_TARGET_KEY,
  HOME_SETTINGS_KEY,
  type HomeDeleteTarget,
  type HomeSettings,
} from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'
import { homeSettingsFields, homeSettingsSchema } from './homeSettingsSchema'
import { HomeError } from './homeErrors'

/** 唯一权威是既有 configs 表；无配置文件、缓存或 home_records 配置副本。 */
export class HomeSettingsService {
  constructor(private config: ConfigRepository) {}
  read(): HomeSettings {
    const raw = this.config.getSync(HOME_SETTINGS_KEY)
    try {
      const partial = raw === undefined ? {} : homeSettingsFields.partial().parse(JSON.parse(raw))
      return homeSettingsSchema.parse({ ...HOME_DEFAULT_SETTINGS, ...partial })
    } catch {
      return { ...HOME_DEFAULT_SETTINGS, mapBlockedTerms: [] }
    }
  }
  update(input: unknown) {
    const partial = homeSettingsFields.partial().safeParse(input)
    if (!partial.success) throw new HomeError('HOME_INVALID')
    const result = homeSettingsSchema.safeParse({ ...this.read(), ...partial.data })
    if (!result.success) throw new HomeError('HOME_INVALID')
    this.config.setJsonSync(HOME_SETTINGS_KEY, result.data)
    return result.data
  }
  reset() {
    this.config.deleteSync(HOME_SETTINGS_KEY)
    return this.read()
  }
  describe() {
    return { key: HOME_SETTINGS_KEY, values: this.read(), defaults: HOME_DEFAULT_SETTINGS }
  }
  /** 她删除用户文件去哪：默认 Windows 回收站；读不懂按默认。单独一个键，不进数值设置。 */
  deleteTarget(): HomeDeleteTarget {
    return this.config.getSync(HOME_DELETE_TARGET_KEY) === '"infos"' ? 'infos' : 'system'
  }
  setDeleteTarget(value: unknown): HomeDeleteTarget {
    if (value !== 'system' && value !== 'infos') throw new HomeError('HOME_INVALID')
    this.config.setJsonSync(HOME_DELETE_TARGET_KEY, value)
    return this.deleteTarget()
  }
}
