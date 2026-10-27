import { t as __t } from '../utils/i18n'
/**
 * @file Steam 集成
 * @description 延迟加载 steamworks.js，始终尝试连接 Steam。
 *              连接失败时优雅降级，不阻塞应用启动。
 *              开发模式下跳过 Overlay 注入，避免幽灵窗口。
 *
 * @platform ELECTRON
 * @module electron/main/services/steam
 */

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { logger } from '../utils/logger'
import { isPackagedRuntime } from '../utils/runtimeMode'
import { isRemoteConnection } from './clientConnection'
import { ACHIEVEMENTS, type AchievementId } from '@infos/shared'

// ─── 延迟加载 steamworks.js ──────────────────────────
// 不在模块顶层 require()，防止缺 steam_api64.dll 时 segfault
let steamworks: any = null
let steamLoadAttempted = false

function getSteamworksModuleName(): string {
  return ['steamworks', 'js'].join('.')
}

function loadSteamworks(): any {
  if (steamLoadAttempted) return steamworks
  steamLoadAttempted = true

  try {
    // 安全检查: 先确认 steam_api64.dll 存在
    const exeDir = path.dirname(process.execPath)
    const dllPath = path.join(exeDir, 'steam_api64.dll')
    const hasDll = fs.existsSync(dllPath)

    if (!hasDll && isPackagedRuntime) {
      logger.info(
        'Steam',
        __t('electron.logs.steam', 'steam_api64.dll 未找到，跳过 Steamworks 加载 (非 Steam 版本)'),
      )
      return null
    }

    steamworks = require(getSteamworksModuleName())
  } catch (e) {
    logger.warn(
      'Steam',
      __t('electron.logs.steam', '无法加载 steamworks.js (可能缺少 steam_api64.dll): {0}', [e]),
    )
    steamworks = null
  }
  return steamworks
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let steamApi: any = null
let isInitialized = false

/** Steam 是否可用 (初始化成功后为 true) */
export const IS_STEAM = () => isInitialized

/** 初始化 Steam — 始终尝试连接，失败则优雅降级 */
export function initSteam(): 'ok' | 'not-available' | 'restarting' | 'failed' {
  if (isInitialized) return 'ok'

  // 检查是否显式禁用
  if (process.env.PERO_DISABLE_STEAM || process.env.IS_DOCKER || process.env.DOCKER_ENV) {
    logger.info('Steam', __t('electron.logs.steam', 'Steam 已被环境变量禁用'))
    return 'not-available'
  }

  const sw = loadSteamworks()
  if (!sw) return 'not-available'

  const appId = 4457100

  // 生产环境: 检查是否需要通过 Steam 重启
  if (isPackagedRuntime) {
    const exePath = app.getPath('exe').toLowerCase()
    const isSteamLibrary = exePath.includes('steamapps')
    const hasAppIdFile =
      fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'steam_appid.txt')) ||
      fs.existsSync(path.join(process.cwd(), 'steam_appid.txt'))

    if (isSteamLibrary || hasAppIdFile) {
      try {
        if (sw.restartAppIfNecessary(appId)) {
          logger.info(
            'Steam',
            __t('electron.logs.steam', '应用未通过 Steam 启动，正在请求 Steam 重启...'),
          )
          return 'restarting'
        }
      } catch (e) {
        logger.warn('Steam', __t('electron.logs.steam', 'restartAppIfNecessary 失败: {0}', [e]))
      }
    } else {
      logger.info('Steam', __t('electron.logs.steam', '检测为非 Steam 环境启动，跳过强制重启逻辑'))
    }
  }

  try {
    // 开发模式跳过 Overlay 注入，避免幽灵窗口
    if (isPackagedRuntime) {
      sw.electronEnableSteamOverlay()
    } else {
      logger.info('Steam', __t('electron.logs.steam', '开发模式，跳过 Overlay 注入'))
    }

    // 初始化 Steamworks
    steamApi = sw.init(appId)
    isInitialized = true

    logger.info('Steam', '════════════════════════════════════════════')
    logger.info('Steam', __t('electron.logs.steam', '初始化成功'))
    logger.info(
      'Steam',
      __t('electron.logs.steam', '当前用户: {0}', [steamApi.localplayer.getName()]),
    )
    logger.info('Steam', `Steam ID: ${steamApi.localplayer.getSteamId().steamId64}`)
    logger.info('Steam', '════════════════════════════════════════════')

    return 'ok'
  } catch (e: unknown) {
    if (String(e).includes('already initialized')) {
      isInitialized = true
      return 'ok'
    }
    logger.warn('Steam', '════════════════════════════════════════════')
    logger.warn('Steam', __t('electron.logs.steam', '初始化失败: {0}', [e]))
    logger.warn('Steam', __t('electron.logs.steam', 'Steam 是否正在运行？或当前用户未拥有此 AppID'))
    logger.warn('Steam', '════════════════════════════════════════════')
    return 'failed'
  }
}

/** 获取 Steam 用户信息 */
export function getSteamUser(): { name: string; steamId: string } | null {
  if (!steamApi) return null
  try {
    return {
      name: steamApi.localplayer.getName(),
      steamId: steamApi.localplayer.getSteamId().steamId64.toString(),
    }
  } catch {
    return null
  }
}

/** 只提交产品内置的成就；true 表示 SDK 已接受，不代表云端已确认。 */
export function submitSteamAchievement(id: AchievementId): boolean {
  const definition = ACHIEVEMENTS.find((item) => item.id === id)
  if (!definition || !steamApi) return false
  if (
    !steamApi.achievement.isActivated(definition.steamApiName) &&
    !steamApi.achievement.activate(definition.steamApiName)
  )
    return false
  return steamApi.stats.store() === true
}

export function isSteamAchievementActivated(id: AchievementId): boolean {
  const definition = ACHIEVEMENTS.find((item) => item.id === id)
  return !!definition && !!steamApi?.achievement.isActivated(definition.steamApiName)
}

/** Workshop 已安装物品信息 */
export interface WorkshopInstallation {
  itemId: string
  folder: string
  sizeOnDisk: string
  timestamp: number
}

/** 获取已订阅的 Workshop 物品 ID（使用字符串避免 bigint 穿越 IPC 时失败） */
export function getSubscribedItems(): string[] {
  if (!steamApi) return []
  try {
    const items = steamApi.workshop.getSubscribedItems() ?? []
    return items.map((itemId: bigint | number | string) => itemId.toString())
  } catch {
    return []
  }
}

/**
 * 获取已下载完成的 Workshop 物品安装目录。
 * Steam 负责下载、更新和删除这些只读目录；应用只消费 installInfo 返回的真实路径，
 * 不猜测 steamapps 的磁盘位置，从而兼容多库、多磁盘和跨平台安装。
 */
export function getWorkshopInstallations(): WorkshopInstallation[] {
  if (!steamApi) return []

  const installations: WorkshopInstallation[] = []
  try {
    const items = steamApi.workshop.getSubscribedItems() ?? []
    for (const itemId of items as Array<bigint>) {
      const info = steamApi.workshop.installInfo(itemId)
      if (!info?.folder || !fs.existsSync(info.folder)) continue
      installations.push({
        itemId: itemId.toString(),
        folder: path.resolve(info.folder),
        sizeOnDisk: info.sizeOnDisk?.toString?.() ?? '0',
        timestamp: Number(info.timestamp ?? 0),
      })
    }
  } catch (e) {
    logger.warn('Steam', __t('electron.logs.steam', '获取 Workshop 安装目录失败: {0}', [e]))
  }
  return installations
}

/** 获取已初始化的 Steam Cloud API，仅供主进程服务复用。 */
export function getSteamCloudApi(): any | null {
  return steamApi?.cloud ?? null
}

/** 云存档状态 */
export function getCloudStatus(): { enabled: boolean } {
  if (!steamApi || isRemoteConnection()) return { enabled: false }
  try {
    return { enabled: steamApi.cloud.isEnabledForApp() ?? false }
  } catch {
    return { enabled: false }
  }
}

/** 手动上传完整快照到云存档。 */
export async function uploadToCloud(): Promise<{ success: boolean; errors: string[] }> {
  if (!steamApi) return { success: false, errors: ['Steam 不可用'] }
  const { cloudSyncService } = await import('./cloudSync')
  const result = await cloudSyncService.uploadFullSnapshot()
  return { success: result.success, errors: result.errors }
}

/** 手动从云存档下载完整快照。 */
export async function downloadFromCloud(): Promise<{ success: boolean; errors: string[] }> {
  if (!steamApi) return { success: false, errors: ['Steam 不可用'] }
  const { cloudSyncService } = await import('./cloudSync')
  const result = await cloudSyncService.downloadFullSnapshot()
  return { success: result.success, errors: result.errors }
}
