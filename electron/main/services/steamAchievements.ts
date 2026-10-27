import {
  ACHIEVEMENTS,
  type AchievementSnapshot,
  type SteamAchievementSyncResult,
} from '@infos/shared'
import { getBackendOrigin } from './clientConnection'
import { getClientCredential } from '../utils/clientCredential'
import { getSteamUser, isSteamAchievementActivated, submitSteamAchievement } from './steam'
import { logger } from '../utils/logger'
import { t } from '../utils/i18n'

/** 主进程自行读取当前服务端的达成记录，不接受渲染进程提供的成就或账号。 */
class SteamAchievements {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<SteamAchievementSyncResult>
  private stopped = false

  start(): void {
    if (this.timer) return
    this.stopped = false
    if (!getSteamUser()) return
    void this.sync()
    this.timer = setInterval(() => {
      void this.sync()
    }, 60_000)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  sync(): Promise<SteamAchievementSyncResult> {
    if (this.running) return this.running
    this.running = this.perform().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async perform(): Promise<SteamAchievementSyncResult> {
    const user = getSteamUser()
    const result: SteamAchievementSyncResult = {
      available: !!user,
      accountId: user?.steamId ?? null,
      submitted: [],
      accountMismatch: false,
    }
    if (!user || this.stopped) return result
    const origin = getBackendOrigin()
    const token = getClientCredential()
    if (!token) return result
    const current = () =>
      !this.stopped &&
      origin === getBackendOrigin() &&
      token === getClientCredential() &&
      user.steamId === getSteamUser()?.steamId
    const request = (suffix: string, body?: unknown) =>
      fetch(`${origin}/api/achievements${suffix}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
    try {
      const response = await request('')
      if (!response.ok || !current()) return result
      const snapshot = ((await response.json()) as { data?: AchievementSnapshot }).data
      if (!snapshot || !Array.isArray(snapshot.achievements)) return result
      for (const definition of ACHIEVEMENTS) {
        const earned = snapshot.achievements.find((item) => item.id === definition.id)
        if (!earned?.unlockedAt || !current()) continue
        if (earned.steamAccountId && earned.steamAccountId !== user.steamId) {
          result.accountMismatch = true
          continue
        }
        if (
          earned.steamAccountId === user.steamId &&
          earned.steamSubmittedAt &&
          isSteamAchievementActivated(definition.id)
        ) {
          result.submitted.push(definition.id)
          continue
        }
        const claim = await request('/steam', {
          achievementId: definition.id,
          steamId: user.steamId,
        })
        if (!current()) return result
        if (claim.status === 409) {
          result.accountMismatch = true
          continue
        }
        if (!claim.ok) continue
        // 启动后仍核对 SDK 缓存，提交记录不会掩盖 Steam 上尚未解锁的情况。
        const activated = isSteamAchievementActivated(definition.id)
        if (!(activated && earned.steamSubmittedAt) && !submitSteamAchievement(definition.id))
          continue
        if (!current()) return result
        const stored = await request('/steam', {
          achievementId: definition.id,
          steamId: user.steamId,
          submitted: true,
        })
        if (stored.ok && current()) result.submitted.push(definition.id)
      }
    } catch (error) {
      logger.debug(
        'Achievements',
        `${t('electron.logs.achievements', '成就暂未提交，将在连接恢复后重试。')} ${String(error)}`,
      )
    }
    return result
  }
}

export const steamAchievements = new SteamAchievements()
