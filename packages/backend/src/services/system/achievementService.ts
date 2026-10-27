import { randomUUID } from 'node:crypto'
import { ACHIEVEMENTS, type AchievementId, type AchievementSnapshot } from '@infos/shared'
import type { AchievementRepository } from '../../repositories/achievement.repo'
import type { ConfigRepository } from '../../repositories/config.repo'

/** 业务达成在服务端判定；Steam 只是当前客户端可用的提交适配器。 */
export class AchievementService {
  private sourceId = ''

  constructor(
    private readonly repository: AchievementRepository,
    private readonly config: ConfigRepository,
  ) {}

  async initialize(): Promise<void> {
    const existing = await this.config.get('achievements.sourceId')
    this.sourceId = existing || randomUUID()
    if (!existing) await this.config.set('achievements.sourceId', this.sourceId)
  }

  snapshot(subjectId: string): AchievementSnapshot {
    return {
      sourceId: this.sourceId,
      subjectId,
      achievements: ACHIEVEMENTS.map((definition) => {
        const row = this.repository.get(subjectId, definition.id)
        return {
          id: definition.id,
          steamApiName: definition.steamApiName,
          unlockedAt: row?.unlockedAt ?? null,
          steamAccountId: row?.steamAccountId ?? null,
          steamSubmittedAt: row?.steamSubmittedAt ?? null,
        }
      }),
    }
  }

  claimSteamAccount(subjectId: string, id: AchievementId, steamId: string): boolean {
    return this.repository.claimSteamAccount(subjectId, id, steamId)
  }

  markSteamSubmitted(subjectId: string, id: AchievementId, steamId: string): void {
    this.repository.markSteamSubmitted(subjectId, id, steamId)
  }
}
