import {
  computed,
  inject,
  onScopeDispose,
  provide,
  ref,
  shallowReactive,
  type InjectionKey,
  type Ref,
  type ComputedRef,
} from 'vue'

export interface SettingsConfigItem {
  key: string
  value: string
}
export interface SettingsSaveSnapshot {
  items?: SettingsConfigItem[]
  persist?: () => Promise<void>
  committed?: () => void
}
export interface SettingsParticipant {
  ready?: () => boolean
  capture: () => SettingsSaveSnapshot
}
export interface SystemSettingsPage {
  saving: Readonly<Ref<boolean>>
  ready: ComputedRef<boolean>
  disabled: ComputedRef<boolean>
  register: (participant: SettingsParticipant) => () => void
  save: (after?: () => Promise<void>, actionKey?: string) => Promise<boolean>
  discard: (actionKey: string) => void
  retry: () => Promise<boolean>
}
const SETTINGS_PAGE: InjectionKey<SystemSettingsPage> = Symbol('SystemSettingsPage')

/** 每次操作固定整页快照，串行写入；失败不抛弃草稿，也不阻断后续重试。 */
export function createSystemSettingsPage(options: {
  write: (items: SettingsConfigItem[]) => Promise<unknown>
  saved: () => void
  failed: (cause: unknown) => void
}): SystemSettingsPage {
  const participants = shallowReactive(new Set<SettingsParticipant>())
  const saving = ref(false)
  const ready = computed(() =>
    [...participants].every((participant) => participant.ready?.() !== false),
  )
  const disabled = computed(() => saving.value || !ready.value)
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  let unfinishedActions: Array<{ run: () => Promise<void>; key?: string }> = []
  const register = (participant: SettingsParticipant) => {
    participants.add(participant)
    return () => {
      participants.delete(participant)
    }
  }
  function discard(actionKey: string): void {
    unfinishedActions = unfinishedActions.filter((action) => action.key !== actionKey)
  }
  function save(after?: () => Promise<void>, actionKey?: string): Promise<boolean> {
    if (!ready.value) return Promise.resolve(false)
    const snapshots = [...participants].map((participant) => participant.capture())
    pending++
    saving.value = true
    const result = queue
      .then(async () => {
        // 失败操作属于整页未提交的修改，后续任意保存都继续处理，不能被成功的普通保存清掉。
        // 同一资源的新操作替代旧失败操作，其他资源仍按原顺序继续。
        const actions = unfinishedActions.filter(
          (action) => !after || (actionKey ? action.key !== actionKey : action.run !== after),
        )
        if (after) actions.push({ run: after, key: actionKey })
        unfinishedActions = actions
        try {
          const items = snapshots.flatMap((snapshot) => snapshot.items ?? [])
          if (items.length) await options.write(items)
          for (const snapshot of snapshots) await snapshot.persist?.()
          while (unfinishedActions.length) {
            await unfinishedActions[0]!.run()
            unfinishedActions.shift()
          }
          for (const snapshot of snapshots) snapshot.committed?.()
          options.saved()
          return true
        } catch (cause) {
          options.failed(cause)
          return false
        }
      })
      .finally(() => {
        saving.value = --pending > 0
      })
    queue = result
    return result
  }
  return { saving, ready, disabled, register, save, discard, retry: () => save() }
}

export function provideSystemSettingsPage(page: SystemSettingsPage): void {
  provide(SETTINGS_PAGE, page)
}
export function useSystemSettingsPage(): SystemSettingsPage | undefined {
  return inject(SETTINGS_PAGE, undefined)
}
export function registerSettingsParticipant(
  page: SystemSettingsPage | undefined,
  participant: SettingsParticipant,
): void {
  if (page) onScopeDispose(page.register(participant))
}
