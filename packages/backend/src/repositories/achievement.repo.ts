import { and, eq, isNull, or } from 'drizzle-orm'
import type { AchievementId } from '@infos/shared'
import type { DrizzleDb } from '../database'
import { achievements } from '../database/schema'

/** 成就事实与回复同事务写入，本仓库只读取与管理当前身份的 Steam 提交回执。 */
export class AchievementRepository {
  constructor(private readonly db: DrizzleDb) {}

  get(subjectId: string, id: AchievementId) {
    return this.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.subjectId, subjectId), eq(achievements.achievementId, id)))
      .get()
  }

  claimSteamAccount(subjectId: string, id: AchievementId, steamId: string): boolean {
    this.db
      .update(achievements)
      .set({ steamAccountId: steamId })
      .where(
        and(
          eq(achievements.subjectId, subjectId),
          eq(achievements.achievementId, id),
          or(isNull(achievements.steamAccountId), eq(achievements.steamAccountId, steamId)),
        ),
      )
      .run()
    return this.get(subjectId, id)?.steamAccountId === steamId
  }

  markSteamSubmitted(subjectId: string, id: AchievementId, steamId: string): void {
    this.db
      .update(achievements)
      .set({ steamSubmittedAt: new Date().toISOString() })
      .where(
        and(
          eq(achievements.subjectId, subjectId),
          eq(achievements.achievementId, id),
          eq(achievements.steamAccountId, steamId),
          isNull(achievements.steamSubmittedAt),
        ),
      )
      .run()
  }
}
