/** 成就目录只包含产品规则标识，不向 Agent 暴露解锁工具。 */
export const ACHIEVEMENTS = [
  {
    id: 'fresh_start',
    steamApiName: 'ACH_FRESH_START',
    name: '崭新启程',
    description: '完成与角色的首次有效对话。',
  },
] as const

export type AchievementId = (typeof ACHIEVEMENTS)[number]['id']

export interface AchievementInfo {
  id: AchievementId
  steamApiName: string
  unlockedAt: string | null
  steamAccountId: string | null
  /** 表示 SDK 已接受提交，不冒充 Steam 服务端确认。 */
  steamSubmittedAt: string | null
}

export interface AchievementSnapshot {
  sourceId: string
  subjectId: string
  achievements: AchievementInfo[]
}

export interface SteamAchievementSyncResult {
  available: boolean
  accountId: string | null
  submitted: AchievementId[]
  accountMismatch: boolean
}
