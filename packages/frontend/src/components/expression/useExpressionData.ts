/** 表达调教里手册和开关的读写；接口不存在时只标记 missing，由页面显示「后端还不支持」。 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { t as __t } from '../../i18n/index'
import { expressionApi, isExpressionApiMissing } from '../../api/modules/expressionApi'
import { useNotificationStore } from '../../stores/useNotificationStore'
import type {
  ExpressionLearningStatus,
  ExpressionSettings,
  HandbookRule,
  HandbookVersion,
} from './expressionTypes'

const SAVE_DELAY_MS = 600

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : __t('ui.chat', '保存失败')

export function useExpressionSettings(agentId: Ref<string>) {
  const notify = useNotificationStore()
  const settings = ref<ExpressionSettings | null>(null)
  const missing = ref(false)
  const failed = ref(false)
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let queued: Partial<ExpressionSettings> | null = null
  let queuedAgent = ''

  async function load(): Promise<void> {
    const request = ++sequence
    failed.value = false
    try {
      const response = await expressionApi.getSettings(agentId.value)
      if (request !== sequence) return
      missing.value = false
      settings.value = response.data ?? null
    } catch (error) {
      if (request !== sequence) return
      missing.value = isExpressionApiMissing(error)
      failed.value = !missing.value
      settings.value = null
    }
  }

  async function send(agent: string, patch: Partial<ExpressionSettings>): Promise<void> {
    const request = ++sequence
    try {
      const response = await expressionApi.updateSettings(agent, patch)
      if (request === sequence && response.data && agent === agentId.value)
        settings.value = response.data
    } catch (error) {
      notify.toast(messageOf(error), 'error')
      if (request === sequence) await load()
    }
  }

  function flush(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (queued) void send(queuedAgent, queued)
    queued = null
  }

  /** 开关：立刻显示，立刻保存，失败退回服务端的值。 */
  function patch(next: Partial<ExpressionSettings>): void {
    if (!settings.value) return
    flush()
    settings.value = { ...settings.value, ...next }
    void send(agentId.value, next)
  }

  /** 数字：输入过程中不保存，停一下再存。 */
  function patchLater(next: Partial<ExpressionSettings>): void {
    if (!settings.value) return
    settings.value = { ...settings.value, ...next }
    queued = { ...queued, ...next }
    queuedAgent = agentId.value
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DELAY_MS)
  }

  watch(agentId, () => {
    flush()
    void load()
  })
  onBeforeUnmount(flush)
  return { settings, missing, failed, load, patch, patchLater }
}

export function useExpressionHandbook(agentId: Ref<string>) {
  const notify = useNotificationStore()
  const rules = ref<HandbookRule[]>([])
  const usedChars = ref<number | null>(null)
  const maxChars = ref<number | null>(null)
  const learningFailures = ref(0)
  const versions = ref<HandbookVersion[]>([])
  const loading = ref(false)
  const missing = ref(false)
  const failed = ref(false)
  const busy = ref(false)
  const learning = ref<ExpressionLearningStatus | null>(null)
  let sequence = 0
  let statusSequence = 0

  /** 学习状态读不到不算错：只是不显示这一块。学完一批时顺手刷新手册。 */
  async function loadLearning(): Promise<void> {
    const request = ++statusSequence
    try {
      const response = await expressionApi.getLearningStatus(agentId.value)
      if (request !== statusSequence) return
      const next = response.data ?? null
      const wasBusy = learning.value?.state === 'learning' || learning.value?.state === 'retrying'
      learning.value = next
      if (wasBusy && next?.state !== 'learning' && next?.state !== 'retrying') void load()
    } catch {
      if (request === statusSequence) learning.value = null
    }
  }

  async function load(): Promise<void> {
    const request = ++sequence
    loading.value = true
    failed.value = false
    const agent = agentId.value
    try {
      const [book, history] = await Promise.all([
        expressionApi.getHandbook(agent),
        expressionApi.listHandbookVersions(agent),
      ])
      if (request !== sequence) return
      missing.value = false
      rules.value = book.data?.rules ?? []
      usedChars.value = book.data?.usedChars ?? 0
      maxChars.value = book.data?.maxChars ?? null
      learningFailures.value = book.data?.learningFailures ?? 0
      versions.value = history.data?.items ?? []
    } catch (error) {
      if (request !== sequence) return
      missing.value = isExpressionApiMissing(error)
      failed.value = !missing.value
      rules.value = []
      versions.value = []
      usedChars.value = null
      maxChars.value = null
    } finally {
      if (request === sequence) loading.value = false
    }
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      await action()
      await load()
      void loadLearning()
      return true
    } catch (error) {
      notify.toast(messageOf(error), 'error')
      return false
    } finally {
      busy.value = false
    }
  }

  watch(agentId, () => {
    void load()
    void loadLearning()
  })
  return {
    learning,
    loadLearning,
    rules,
    usedChars,
    maxChars,
    learningFailures,
    versions,
    loading,
    missing,
    failed,
    busy,
    load,
    add: (text: string) => run(() => expressionApi.addHandbookRule(agentId.value, text)),
    update: (id: string, text: string) => run(() => expressionApi.updateHandbookRule(id, text)),
    remove: (id: string) => run(() => expressionApi.deleteHandbookRule(id)),
    restore: (id: string) => run(() => expressionApi.restoreHandbookVersion(id, agentId.value)),
    learnNow: () =>
      run(async () => {
        const response = await expressionApi.learnNow(agentId.value)
        const pending = response.data?.pending ?? 0
        notify.toast(
          pending
            ? __t('ui.chat', '开始学了，这次有 {0} 条。', [pending])
            : __t('ui.chat', '现在没有要学的内容。想重学某一条，到批注列表点「重新学」。'),
          pending ? 'success' : 'info',
        )
      }),
  }
}

export type ExpressionSettingsState = ReturnType<typeof useExpressionSettings>
export type ExpressionHandbookState = ReturnType<typeof useExpressionHandbook>
