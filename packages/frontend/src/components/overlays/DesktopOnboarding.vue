<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import OnboardingOverlay, { type OnboardingStep } from './OnboardingOverlay.vue'
import { getDesktopSteps } from '../../composables/launcher/onboardingScripts'
import {
  completeOnboarding,
  loadOnboardingFlow,
  onboardingStorageKey,
  ONBOARDING_CHANGED,
  type OnboardingFlow,
} from '../../composables/launcher/onboardingFlow'
import { isElectron } from '../../utils/ipcAdapter'
import { logger } from '../../lib/logger'
import { t } from '../../i18n'
import { configApi } from '../../api/modules/configApi'
import { modelApi } from '../../api/modules/modelApi'
import { useAgentStore } from '../../stores'

const props = defineProps<{
  ready: boolean
  currentTab: string
  navigate: (tab: string) => Promise<void>
}>()
const emit = defineEmits<{ active: [value: boolean] }>()
const agentStore = useAgentStore()
const hasAssignedModel = ref(false)
const steps = computed(() => getDesktopSteps(hasAssignedModel.value))
const visible = ref(false)
const pending = ref<OnboardingFlow | null>(null)
const setupVisible = ref(false)
const setupCollapsed = ref(false)
let selectedChoice = ''
let runId = ''
let previousTab = 'chat'
let previousFocus: HTMLElement | null = null
let disposed = false
let starting = false
let reading = false
let readAgain = false
let finishing = false
let run: AbortController | undefined

/** 等真实页面替换加载占位；目标不存在时有上限，不会困住导览。 */
function waitForPage(tab: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let frame = 0
    const finish = () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      observer?.disconnect()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const inspect = () => {
      if (signal.aborted || disposed) {
        finish()
        return
      }
      const page = document.querySelector<HTMLElement>(`[data-onboarding-tab="${tab}"]`)
      if (!page || page.matches('.main-tab-loading') || page.querySelector('.main-tab-loading'))
        return
      const motion = page.closest('.surface-transition')
      if (motion && !motion.classList.contains('is-idle')) return
      const box = page.getBoundingClientRect()
      if (!box.width || !box.height) return
      observer?.disconnect()
      // 页面过渡完成后再等两次绘制，避免 Vue 已挂载但布局还没落位。
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(finish)
      })
    }
    const timer = setTimeout(finish, 12_000)
    signal.addEventListener('abort', finish, { once: true })
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    inspect()
  })
}
async function prepare(step: OnboardingStep, _index: number, signal: AbortSignal) {
  if (signal.aborted || disposed) return
  if (step.tab) {
    await props.navigate(step.tab)
    if (signal.aborted || disposed) return
    await nextTick()
    await waitForPage(step.tab, signal)
  }
  if (signal.aborted || disposed) return
  const target = step.focusSelector ? document.querySelector<HTMLElement>(step.focusSelector) : null
  target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  await nextTick()
}
async function start() {
  if (
    !props.ready ||
    !document.hasFocus() ||
    !pending.value ||
    starting ||
    visible.value ||
    finishing ||
    setupVisible.value ||
    disposed
  )
    return
  starting = true
  run?.abort()
  const controller = new AbortController()
  run = controller
  const request = pending.value
  runId = request.runId
  previousTab = props.currentTab
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  emit('active', true)
  try {
    selectedChoice = ''
    hasAssignedModel.value = false
    try {
      const agentKey = `model.agent.${agentStore.activeAgentId.trim().toLowerCase()}`
      const [assignments, models] = await Promise.all([
        configApi.batch(['model.main', agentKey]),
        modelApi.list(),
      ])
      const ids = new Set((models.data ?? []).map((model) => String(model.id)))
      hasAssignedModel.value = [assignments.data?.[agentKey], assignments.data?.['model.main']].some(
        (id) => !!id && ids.has(id),
      )
    } catch {
      // 无法确认配置时保留选择，让用户自行决定是否设置。
    }
    if (disposed || controller.signal.aborted || !props.ready) {
      emit('active', false)
      return
    }
    await props.navigate('chat')
    await nextTick()
    if (document.fonts) await document.fonts.ready
    await waitForPage('chat', controller.signal)
    if (disposed || controller.signal.aborted || !props.ready) {
      emit('active', false)
      return
    }
    visible.value = true
  } catch (error) {
    emit('active', false)
    logger.warn(
      'Onboarding',
      t('logs.frontend.onboarding', '读取桌面教程进度失败，稍后重试'),
      error,
    )
  } finally {
    starting = false
    if (!disposed && pending.value && pending.value.runId !== runId) void start()
  }
}
async function reload() {
  if (!isElectron() || disposed || finishing) return
  if (reading) {
    readAgain = true
    return
  }
  reading = true
  try {
    const flow = await loadOnboardingFlow()
    if (disposed) return
    if (runId && (flow.stage !== 'desktop' || runId !== flow.runId)) {
      run?.abort()
      visible.value = false
      setupVisible.value = false
      emit('active', false)
    }
    pending.value = flow.stage === 'desktop' ? flow : null
  } catch (error) {
    logger.warn(
      'Onboarding',
      t('logs.frontend.onboarding', '读取桌面教程进度失败，稍后重试'),
      error,
    )
  } finally {
    reading = false
  }
  if (readAgain) {
    readAgain = false
    void reload()
    return
  }
  void start()
}
function choose(value: string) {
  selectedChoice = value
}
async function finish() {
  if (selectedChoice === 'setup-model') {
    visible.value = false
    setupVisible.value = true
    setupCollapsed.value = false
    emit('active', false)
    try {
      await props.navigate('model_config')
    } catch {
      setupVisible.value = false
      await complete('chat')
    }
    return
  }
  await complete('chat')
}
async function skip() {
  selectedChoice = ''
  await complete(previousTab)
}
async function complete(target: string) {
  if (finishing || !runId) return
  finishing = true
  run?.abort()
  visible.value = false
  setupVisible.value = false
  pending.value = null
  emit('active', false)
  try {
    await completeOnboarding(runId)
    if (!disposed) {
      await props.navigate(target)
      await nextTick()
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  } finally {
    finishing = false
    if (!disposed) void reload()
  }
}
function storage(event: StorageEvent) {
  if (event.key === onboardingStorageKey()) void reload()
}
watch(
  () => props.ready,
  (ready) => {
    if (ready) void reload()
  },
)
onMounted(() => {
  window.addEventListener('storage', storage)
  window.addEventListener('focus', reload)
  window.addEventListener(ONBOARDING_CHANGED, reload)
  void reload()
})
onBeforeUnmount(() => {
  disposed = true
  run?.abort()
  window.removeEventListener('storage', storage)
  window.removeEventListener('focus', reload)
  window.removeEventListener(ONBOARDING_CHANGED, reload)
})
</script>
<template>
  <OnboardingOverlay
    v-model:visible="visible"
    :steps="steps"
    :prepare-step="prepare"
    @finish="finish"
    @skip="skip"
    @choice="choose"
  />
  <Teleport to="body">
    <aside
      v-if="setupVisible"
      class="setup-guide"
      :aria-label="t('ui.onboarding', '模型配置小提示')"
    >
      <header>
        <strong>{{ t('ui.onboarding', 'Pero · 模型配置小提示') }}</strong>
        <button type="button" @click="setupCollapsed = !setupCollapsed">
          {{ setupCollapsed ? t('ui.onboarding', '展开步骤') : t('ui.onboarding', '收起步骤') }}
        </button>
      </header>
      <template v-if="!setupCollapsed">
        <p>
          {{
            t('ui.onboarding', '准备好服务商提供的地址、API Key 和模型 ID，我们一起设置吧！部分服务不需要密钥，以服务商说明为准。')
          }}
        </p>
        <ol>
          <li>
            {{ t('ui.onboarding', '点「服务商连接」→「新建」，选择品牌模板，填写连接信息后点「创建连接」。') }}
          </li>
          <li>
            {{ t('ui.onboarding', '关闭连接窗口，点「添加模型」，选择刚才的连接，填写或获取模型 ID，再点「添加」。') }}
          </li>
          <li>
            {{ t('ui.onboarding', '在模型卡片点「测试」。成功后点「设为主模型」；如果已经显示「主模型」，就不用再点啦。') }}
          </li>
        </ol>
        <p>{{ t('ui.onboarding', '如果服务商指定了协议，请在连接和模型里按它的说明选择哦。') }}</p>
        <p class="setup-guide__hint">{{ t('ui.onboarding', 'API Key 像密码一样，请不要分享给别人哦。') }}</p>
      </template>
      <button type="button" class="setup-guide__done" @click="complete('chat')">
        {{ t('ui.onboarding', '返回聊天') }}
      </button>
    </aside>
  </Teleport>
</template>

<style scoped>
.setup-guide {
  position: fixed;
  z-index: 10001;
  right: 18px;
  bottom: 18px;
  width: min(340px, calc(100vw - 36px));
  max-height: min(70vh, 620px);
  overflow-y: auto;
  padding: 16px;
  border: 1px solid var(--ui-border-default);
  border-top: 3px solid var(--ui-accent-primary);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-primary);
  box-shadow: var(--ui-shadow-lg);
  font: 500 13px/1.65 var(--ui-font-sans);
}
.setup-guide header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.setup-guide header strong {
  color: var(--ui-accent-primary);
}
.setup-guide p {
  margin: 10px 0;
}
.setup-guide ol {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 20px;
}
.setup-guide__hint {
  color: var(--ui-text-secondary);
}
.setup-guide button {
  border: 0;
  background: transparent;
  color: var(--ui-accent-primary);
  cursor: pointer;
  font: inherit;
}
.setup-guide__done {
  padding: 5px 0;
  font-weight: 700;
}
.setup-guide button:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 2px;
}
</style>
