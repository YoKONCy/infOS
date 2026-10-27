import type { AchievementSnapshot } from '@infos/shared'
import { apiClient } from '../client'

export const achievementsApi = {
  list: () => apiClient.get<AchievementSnapshot>('/achievements'),
}
