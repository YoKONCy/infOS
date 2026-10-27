import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  ACHIEVEMENTS,
  type AchievementSnapshot,
  type SteamAchievementSyncResult,
} from '@infos/shared'
import { achievementsApi } from '../api/modules/achievementsApi'
import { getApiBaseUrl, getClientToken } from '../api/transport'
import { useNotificationStore } from './useNotificationStore'
import { t } from '../i18n'

export const useAchievementStore = defineStore('achievements', () => {
  const snapshot = ref<AchievementSnapshot | null>(null)
  const loading = ref(false)
  const failed = ref(false)
  const steamAvailable = ref(false)
  const accountMismatch = ref(false)
  let revision = 0
  let pending: Promise<void> | undefined
  let notifying = false
  let loadedScope = ''
  const scope = () => JSON.stringify([getApiBaseUrl(), getClientToken()])

  function reset(): void {
    revision++
    snapshot.value = null
    loading.value = failed.value = steamAvailable.value = accountMismatch.value = false
    pending = undefined
    loadedScope = ''
  }

  function refresh(): Promise<void> {
    const requestedScope = scope()
    if (requestedScope !== loadedScope) {
      reset()
      loadedScope = requestedScope
    }
    if (pending) return pending
    const requestedRevision = revision
    loading.value = true
    const task = (async () => {
      try {
        const response = await achievementsApi.list()
        if (requestedRevision !== revision || requestedScope !== scope()) return
        snapshot.value = response.data ?? null
        failed.value = !response.data
      } catch {
        if (requestedRevision === revision) failed.value = true
      } finally {
        if (requestedRevision === revision) loading.value = false
      }
    })()
    pending = task
    void task.finally(() => {
      if (pending === task) pending = undefined
    })
    return task
  }

  async function notifyEarned(): Promise<void> {
    if (notifying || !snapshot.value) return
    if (loadedScope !== scope()) {
      reset()
      return
    }
    notifying = true
    const requestedRevision = revision
    const current = snapshot.value
    const notifications = useNotificationStore()
    let submitted: string[] = []
    try {
      if (current.achievements.some((item) => item.unlockedAt) && window.electron?.invoke) {
        try {
          const result = (await window.electron.invoke(
            'steam-achievements-sync',
          )) as SteamAchievementSyncResult
          if (requestedRevision !== revision || loadedScope !== scope()) return
          steamAvailable.value = result.available === true
          accountMismatch.value =
            result.accountMismatch === true ||
            Boolean(
              result.accountId &&
              current.achievements.some(
                (item) => item.steamAccountId && item.steamAccountId !== result.accountId,
              ),
            )
          submitted = Array.isArray(result.submitted) ? result.submitted : []
          if (
            submitted.length &&
            current.achievements.some(
              (item) => !item.steamSubmittedAt && submitted.includes(item.id),
            )
          )
            await refresh()
        } catch {
          // Steam 不可用时保留产品内的成就与通知，稍后可重新提交。
        }
      }
      if (requestedRevision !== revision || loadedScope !== scope()) return
      for (const item of current.achievements) {
        if (!item.unlockedAt) continue
        const id = `achievement:${current.sourceId}:${current.subjectId}:${item.id}`
        if (submitted.includes(item.id)) {
          notifications.rememberRemote(id)
          continue
        }
        if (!document.hasFocus()) continue
        const definition = ACHIEVEMENTS.find((entry) => entry.id === item.id)
        if (!definition) continue
        notifications.toastRemote(id, t('ui.achievements', definition.description), {
          get title() {
            return t('ui.achievements', '成就达成 · {0}', [t('ui.achievements', definition.name)])
          },
          type: 'success',
          duration: 5500,
        })
      }
    } finally {
      notifying = false
    }
  }

  return {
    snapshot,
    loading,
    failed,
    steamAvailable,
    accountMismatch,
    refresh,
    notifyEarned,
    reset,
  }
})
