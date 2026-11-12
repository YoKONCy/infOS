<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * InputBar.vue — 界面组件
 *
 * 负责组织该界面的响应式状态、用户交互与领域数据展示。
 * 副作用在组件生命周期内建立并清理，避免跨页面残留监听器或异步状态。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ConversationQueueItem, InteractionMode, ThreadModelSettings } from '@infos/shared'
import {
  EXECUTION_MODE_OPTIONS,
  resolveExecutionMode,
  type ExecutionMode,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  classifyAttachmentUpload,
  MAX_NATIVE_AUDIO_BYTES,
  MAX_AUDIO_RECORDING_MS,
} from '@infos/shared'
import PixelIcon from '../pixel/PixelIcon.vue'
import { useWatchAlongInput } from '../../composables/chat/useWatchAlongInput'
import { cacheThreadUsableModel } from '../../composables/chat/sendModelGuard'
import { attachmentsApi, type AttachmentInfo } from '../../api/modules/attachmentsApi'
import { ApiError } from '../../api/errors'
import { configApi } from '../../api/modules/configApi'
import ThreadSkillControls from './ThreadSkillControls.vue'
import ThreadExperiences from './ThreadExperiences.vue'
import SessionSettingsPanel from './SessionSettingsPanel.vue'
import { voiceApi } from '../../api/modules/voiceApi'
import { useAgentStore, useNotificationStore, useThreadStore } from '../../stores'
import {
  threadsApi,
  type FlowStateInfo,
  type ThreadToolSetting,
  type ThreadToolsData,
  type TokenBudgetPreview,
} from '../../api/modules/threadsApi'
import { toolDisplayColor, toolDisplayIcon } from '../../composables/tools/useToolDisplay'
import { logger } from '../../lib/logger'
import { sortThreadTools } from '../../lib/threadToolOrder'
import { useMobileLayout } from '../../composables/ui/useMobileLayout'
import { useFileDrop } from '../../composables/chat/useFileDrop'
import { useAudioCapture, type VoiceClip } from '../../composables/audio/useAudioCapture'
import { recordingWave } from '../../lib/recordingAudio'
import AudioRecordingHud from './AudioRecordingHud.vue'
import ResourceAudioPlayer from '../resources/ResourceAudioPlayer.vue'

/** 可被 @ 的成员候选（group 模式 @ 弹窗数据源）。 */
export interface MentionCandidate {
  agentId: string
  name: string
  avatarUrl?: string
}

interface Props {
  queueEnabled?: boolean
  queuePending?: boolean
  submissionBusy?: boolean
  draftRequest?: { text: string; revision: number }
  isSending?: boolean
  placeholder?: string
  disabled?: boolean
  /** 窄容器模式：隐藏次要文字并将工具区改为自适应网格。 */
  compact?: boolean
  /** 输入台所处通道；group 模式复用 CHAR OPS 外观但关闭 desktop 专属能力。 */
  channel?: 'desktop' | 'group'
  /** group 模式显示的上下文名称，例如房间名。 */
  contextLabel?: string
  /** group 模式显示的参与者摘要。 */
  participantLabel?: string
  /** group 模式 @ 弹窗的候选成员（当前房间在场的 Agent）。 */
  mentionCandidates?: MentionCandidate[]
  /** @ 弹窗中「全体成员」选项的展示名。 */
  mentionAllLabel?: string
  /** 当前对话角色信息（供主会话「生活经历」抽屉使用）。 */
  agentId?: string
  agentName?: string
  agentAvatarUrl?: string
}

const props = withDefaults(defineProps<Props>(), {
  queueEnabled: false,
  queuePending: false,
  submissionBusy: false,
  draftRequest: undefined,
  isSending: false,
  placeholder: undefined,
  disabled: false,
  compact: false,
  channel: 'desktop',
  contextLabel: '据点房间',
  participantLabel: '群聊成员',
  mentionCandidates: () => [],
  mentionAllLabel: '全体成员',
  agentId: '',
  agentName: '',
  agentAvatarUrl: '',
})

const emit = defineEmits<{
  draftConsumed: []
  send: [
    text: string,
    mentions: string[],
    attachmentIds: string[],
    attachments: AttachmentInfo[],
    imageMode: 'auto' | 'native' | 'relay',
    complete: (success: boolean) => void,
  ]
  stop: []
  newThread: []
}>()

interface PendingAttachment extends AttachmentInfo {
  uploadState: 'uploading' | 'checking' | 'processing' | 'success' | 'failed'
  localKey: string
  previewUrl?: string
  sourceFile?: File
  error?: string
}

const threadStore = useThreadStore()
const displayPlaceholder = computed(
  () => props.placeholder ?? __t('ui.chat', '向角色下达指令或输入 / 打开命令面板…'),
)
const agentStore = useAgentStore()
const resolvedAgentId = computed(() => props.agentId || agentStore.activeAgentId || '')
const resolvedAgentName = computed(
  () => props.agentName || agentStore.currentAgent?.name || 'Pero',
)
const notify = useNotificationStore()
const { isMobile } = useMobileLayout()
const inputText = ref('')
const submitting = ref(false)
const queueAction = computed(() => props.queueEnabled && (props.isSending || props.queuePending))
const executionModeOptions = computed(() =>
  EXECUTION_MODE_OPTIONS.map((option) => ({
    ...option,
    label: __t('common.interface', option.label),
    description: __t('common.interface', option.description),
  })),
)
const sendActionLabel = computed(() =>
  submitting.value || props.submissionBusy
    ? __t('ui.chat', '提交中…')
    : queueAction.value
      ? __t('ui.chat', '加入队列')
      : __t('ui.chat', '发送'),
)
const restoredQueueDrafts = new Set<string>()
watch(
  () => props.draftRequest,
  async (request) => {
    if (!request) return
    inputText.value = [inputText.value.trim(), request.text].filter(Boolean).join('\n\n')
    await nextTick()
    textareaRef.value?.focus()
    emit('draftConsumed')
  },
  { immediate: true },
)
const INPUT_HISTORY_KEY = 'infos:char-ops-input-history'
const INPUT_HISTORY_LIMIT = 100
const inputHistory = ref<string[]>(loadInputHistory())
const historyIndex = ref(inputHistory.value.length)
const historyDraft = ref('')
const pendingAttachments = ref<PendingAttachment[]>([])
const submittedAttachments = new Set<PendingAttachment>()
let attachmentDraftVersion = 0
const pdfAvailable = ref(false)
const maxPdfBytes = ref(0)
let pdfCapabilitiesLoaded = false
let pdfCapabilitiesPromise: Promise<void> | null = null
async function loadPdfCapabilities(force = false): Promise<void> {
  if (pdfCapabilitiesLoaded && !force) return
  if (pdfCapabilitiesPromise && !force) return pdfCapabilitiesPromise
  const task = (async () => {
    try {
      const response = await attachmentsApi.capabilities()
      pdfAvailable.value = response.data?.pdf ?? false
      maxPdfBytes.value = response.data?.maxPdfBytes ?? 0
      pdfCapabilitiesLoaded = true
    } catch {
      pdfAvailable.value = false
      maxPdfBytes.value = 0
    }
  })().finally(() => {
    if (pdfCapabilitiesPromise === task) pdfCapabilitiesPromise = null
  })
  pdfCapabilitiesPromise = task
  return task
}
let lastFocusSyncAt = 0
function onIntegrationsChanged(): void {
  pdfCapabilitiesLoaded = false
  capabilitiesLoadedKey = ''
  void loadPdfCapabilities(true)
  void loadCapabilities(true)
  if (!toolsSaving.value) void loadThreadTools()
}
function onWindowFocus(): void {
  const now = Date.now()
  if (now - lastFocusSyncAt < 30_000) return
  lastFocusSyncAt = now
  if (!toolsSaving.value) void loadThreadTools()
}
const textareaRef = ref<HTMLTextAreaElement | null>(null)
useWatchAlongInput(textareaRef, () => ({
  agentId: agentStore.activeAgentId,
  threadId: threadStore.threadId ?? '',
  channel: props.channel,
}))
/** @ 内联 chip 的叠加渲染层（group 模式与 textarea 同尺寸叠放）。 */
const overlayRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const commandOpen = ref(false)
const toolOpen = ref(false)
const flowOpen = ref(false)
const flowLoading = ref(false)
const flowClearing = ref(false)
const flowStates = ref<FlowStateInfo[]>([])
const tokenBudget = ref<TokenBudgetPreview | null>(null)
let tokenBudgetTimer: ReturnType<typeof setTimeout> | null = null
let tokenBudgetRequest = 0
const threadTools = ref<ThreadToolSetting[]>([])
const toolsLoading = ref(false)
const toolsSaving = ref(false)
const modeSaving = ref(false)
const pendingInteractionMode = ref<InteractionMode | null>(null)
const debugStatus = ref({ enabled: false, busy: false })
const skillControls = ref<InstanceType<typeof ThreadSkillControls> | null>(null)
const skillSettingsBusy = ref(false)
const sessionPanel = ref<InstanceType<typeof SessionSettingsPanel> | null>(null)
const inputScope = computed(
  () => `${agentStore.activeAgentId}:${threadStore.threadId}:${props.channel}`,
)
const disabledToolNames = ref<string[]>([])
let toolsRequest = 0
const executionMode = computed<ExecutionMode>({
  get: () => threadStore.executionMode,
  set: (value) => {
    threadStore.executionMode = value
  },
})
const toolQuery = ref('')
const imageMode = ref<'auto' | 'native' | 'relay'>('auto')
const relayAvailable = ref(false)

function closeInputPopovers() {
  sessionPanel.value?.close()
  skillControls.value?.close()
  onFoldoutOpened()
}

function onFoldoutOpened(): void {
  commandOpen.value = false
  toolOpen.value = false
  flowOpen.value = false
}

/** 会话设置面板的“恢复默认”：模式、执行权限与识图/语音回到初始值。 */
async function resetSessionSettings(): Promise<void> {
  imageMode.value = 'auto'
  recordingMode.value = 'native'
  // 两项保存共用工具配置锁，需依次执行；降低权限不需要确认。
  if (executionMode.value !== 'manual') await changeExecutionMode('manual')
  if (threadStore.interactionMode !== 'chat') await switchInteractionMode('chat')
}

const commandQuery = ref('')
const enableVision = ref(false)
const enableAudioInput = ref(false)
const nativeAudioAvailable = ref(false)
const modelSettingsBusy = ref(false)
let capabilitiesRequest = 0

function onThreadModelChanged(settings: ThreadModelSettings): void {
  if (settings.threadId !== threadStore.threadId) return
  cacheThreadUsableModel(settings.threadId, Boolean(settings.effective.modelId))
  enableVision.value = settings.effective.enableVision
  enableAudioInput.value = settings.effective.enableAudioInput
  nativeAudioAvailable.value = settings.effective.nativeAudioAvailable === true
  tokenBudget.value = null
  scheduleTokenBudgetRefresh()
}
const asrAvailable = ref(false)

watch(
  () => [enableVision.value, relayAvailable.value],
  () => {
    // 当前选择的能力变得不可用时自动回退到“自动选择”，避免发送时被拦截。
    if (imageMode.value === 'native' && !enableVision.value) imageMode.value = 'auto'
    if (imageMode.value === 'relay' && !relayAvailable.value) imageMode.value = 'auto'
  },
)
const recordingMode = ref<'asr' | 'native'>('native')
const preferredRecordingMode = computed(() =>
  asrAvailable.value && (recordingMode.value === 'asr' || !nativeAudioAvailable.value)
    ? 'asr'
    : 'native',
)
const capture = useAudioCapture(handleVoiceClip, undefined, {
  maxDurationMs: MAX_AUDIO_RECORDING_MS,
  discardSilence: false,
  releaseAfterCapture: true,
})
const {
  isRecording,
  recognizing: isTranscribing,
  preparing: preparingRecording,
  audioLevel,
  error: recordingError,
} = capture
let recordTarget: {
  agentId: string
  threadId: string
  version: number
  mode: 'asr' | 'native'
} | null = null
const voiceBusy = computed(
  () => isRecording.value || isTranscribing.value || preparingRecording.value,
)
const recordingSeconds = computed(() => Math.floor(capture.elapsedMs.value / 1000))
const recordState = computed(() =>
  recordingError.value
    ? 'error'
    : preparingRecording.value
      ? 'preparing'
      : isRecording.value
        ? 'recording'
        : isTranscribing.value
          ? 'processing'
          : 'idle',
)

const isGroupChannel = computed(() => props.channel === 'group')
const channelLabel = computed(
  () =>
    ({
      get desktop() {
        return __t('ui.chat', '桌面会话')
      },
      get group() {
        return __t('ui.chat', '据点群聊')
      },
      get companion() {
        return __t('ui.chat', '陪伴会话')
      },
      get social() {
        return __t('ui.chat', '社交会话')
      },
      get work() {
        return __t('ui.chat', '工作会话')
      },
    })[props.channel] ?? __t('ui.chat', '当前会话'),
)
const successfulAttachments = computed(() =>
  pendingAttachments.value.filter((item) => item.uploadState === 'success'),
)
const hasUploading = computed(() =>
  pendingAttachments.value.some((item) =>
    ['uploading', 'checking', 'processing'].includes(item.uploadState),
  ),
)
const enabledToolCount = computed(() => threadTools.value.filter((tool) => tool.enabled).length)
const availableToolCount = computed(
  () => threadTools.value.filter((tool) => tool.modeAllowed).length,
)
const modeSwitchDisabled = computed(
  () =>
    (toolsLoading.value && !threadTools.value.length) ||
    props.isSending ||
    threadStore.isGenerating ||
    threadStore.isLoadingHistory ||
    props.disabled,
)
const executionModeDisabled = computed(() => modeSwitchDisabled.value || !threadStore.threadId)

function applyThreadTools(data: ThreadToolsData): void {
  threadTools.value = data.tools
  disabledToolNames.value = data.disabledTools ?? []
  executionMode.value = resolveExecutionMode(data.executionMode, data.autoExecuteTools)
  threadStore.interactionMode = data.interactionMode
}
const budgetIsRunning = computed(() => Boolean(props.isSending || threadStore.isGenerating))
const currentLiveContextBudget = computed(() =>
  threadStore.agentId === agentStore.activeAgentId ? threadStore.liveContextBudget : null,
)
const displayedTokenBudget = computed(() => currentLiveContextBudget.value ?? tokenBudget.value)
const tokenBudgetTitle = computed(() => {
  const budget = currentLiveContextBudget.value
  if (budget) {
    return __t('ui.chat', '第 {0} 轮输入{1}：{2}', [
      budget.turn,
      budget.estimated ? __t('ui.chat', '（估算）') : '',
      tokenBudgetLabel.value,
    ])
  }
  const note = tokenBudget.value?.memoryRetrievalDeferred
    ? __t('ui.chat', '（不含待检索记忆）')
    : ''
  return `${budgetIsRunning.value ? __t('ui.chat', '等待输入统计') : __t('ui.chat', '预计输入{0}', [note])}：${tokenBudgetLabel.value}`
})
const tokenBudgetRatio = computed(() => {
  const budget = displayedTokenBudget.value
  if (!budget?.maxInputTokens) return 0
  return Math.min(1, Math.max(0, budget.usedTokens / budget.maxInputTokens))
})
const hasTokenBudget = computed(() => Boolean(displayedTokenBudget.value?.maxInputTokens))
const tokenBudgetPercent = computed(() => Math.round(tokenBudgetRatio.value * 100))
const tokenBudgetPercentText = computed(() =>
  hasTokenBudget.value ? `${tokenBudgetPercent.value}%` : '--%',
)
const tokenBudgetSweepDeg = computed(() => {
  if (!hasTokenBudget.value || tokenBudgetRatio.value <= 0) return '0deg'
  const deg = Math.min(360, Math.max(18, Math.round(tokenBudgetRatio.value * 360)))
  return `${deg}deg`
})
const tokenBudgetTone = computed<'idle' | 'normal' | 'warn' | 'danger'>(() => {
  if (!hasTokenBudget.value) return 'idle'
  if (tokenBudgetPercent.value >= 90) return 'danger'
  if (tokenBudgetPercent.value >= 75) return 'warn'
  return 'normal'
})
const tokenBudgetUsedText = computed(() => {
  const budget = displayedTokenBudget.value
  return budget?.maxInputTokens ? formatTokenCount(budget.usedTokens) : '—'
})
const tokenBudgetMaxText = computed(() => {
  const budget = displayedTokenBudget.value
  return budget?.maxInputTokens ? formatTokenCount(budget.maxInputTokens) : '—'
})
const tokenBudgetStatusNote = computed(() => {
  const budget = currentLiveContextBudget.value
  if (budget) {
    return __t('ui.chat', '第 {0} 轮输入{1}', [
      budget.turn,
      budget.estimated ? __t('ui.chat', '（估算）') : '',
    ])
  }
  if (budgetIsRunning.value) return __t('ui.chat', '等待输入统计')
  const note = tokenBudget.value?.memoryRetrievalDeferred
    ? __t('ui.chat', '（不含待检索记忆）')
    : ''
  return __t('ui.chat', '预计输入{0}', [note])
})
const tokenBudgetLabel = computed(() => {
  const budget = displayedTokenBudget.value
  if (!budget?.maxInputTokens) return '— / — Token'
  return `${formatTokenCount(budget.usedTokens)} / ${formatTokenCount(budget.maxInputTokens)} Token`
})
const sortedThreadTools = computed(() => sortThreadTools(threadTools.value))
const visibleThreadTools = computed(() => {
  const query = toolQuery.value.trim().toLowerCase()
  return sortedThreadTools.value.filter(
    (tool) =>
      !query || `${tool.name} ${tool.label} ${tool.description}`.toLowerCase().includes(query),
  )
})
const filteredCommands = computed(() => {
  const query = commandQuery.value.trim().toLowerCase()
  return commands.value.filter(
    (command) => !query || `${command.label} ${command.keywords}`.toLowerCase().includes(query),
  )
})

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}m`
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`
  return String(tokens)
}

async function refreshTokenBudget(): Promise<void> {
  if (budgetIsRunning.value) return
  if (
    isGroupChannel.value ||
    !threadStore.threadId ||
    threadStore.agentId !== agentStore.activeAgentId
  ) {
    tokenBudget.value = null
    return
  }
  const request = ++tokenBudgetRequest
  const threadId = threadStore.threadId
  const agentId = agentStore.activeAgentId
  try {
    const response = await threadsApi.previewTokenBudget(threadId, {
      content: inputText.value,
    })
    if (
      request === tokenBudgetRequest &&
      threadId === threadStore.threadId &&
      agentId === agentStore.activeAgentId &&
      !budgetIsRunning.value
    ) {
      tokenBudget.value = response.data ?? null
    }
  } catch (error) {
    if (
      request !== tokenBudgetRequest ||
      threadId !== threadStore.threadId ||
      agentId !== agentStore.activeAgentId ||
      budgetIsRunning.value
    )
      return
    tokenBudget.value = null
    logger.warn('InputBar', __t('logs.frontend.chat', '计算下一轮 Token 预算失败'), error)
  }
}

function scheduleTokenBudgetRefresh(): void {
  if (tokenBudgetTimer) clearTimeout(tokenBudgetTimer)
  tokenBudgetRequest++
  if (budgetIsRunning.value) return
  tokenBudgetTimer = setTimeout(() => void refreshTokenBudget(), 350)
}

async function loadThreadTools(): Promise<void> {
  const request = ++toolsRequest
  const threadId = threadStore.threadId
  if (isGroupChannel.value) {
    threadTools.value = []
    toolsLoading.value = false
    return
  }
  if (!threadId) {
    threadTools.value = []
    disabledToolNames.value = []
    toolsLoading.value = false
    return
  }
  toolsLoading.value = true
  try {
    const response = await threadsApi.getTools(threadId)
    if (request === toolsRequest && threadId === threadStore.threadId && response.data) {
      applyThreadTools(response.data)
    }
  } catch (error) {
    logger.warn('InputBar', __t('logs.frontend.chat', '加载本会话工具配置失败'), error)
    if (request === toolsRequest) threadTools.value = []
  } finally {
    if (request === toolsRequest) toolsLoading.value = false
  }
}

async function switchInteractionMode(mode: InteractionMode): Promise<void> {
  if (skillSettingsBusy.value) return
  if (modeSwitchDisabled.value || threadStore.interactionMode === mode) return
  const previousMode = threadStore.interactionMode
  threadStore.interactionMode = mode
  toolsSaving.value = true
  modeSaving.value = true
  pendingInteractionMode.value = mode
  let request = 0
  let targetThreadId = threadStore.threadId
  try {
    targetThreadId = await ensureThread()
    request = ++toolsRequest
    const response = await threadsApi.updateInteractionMode(targetThreadId, mode)
    if (request !== toolsRequest || targetThreadId !== threadStore.threadId) return
    if (response.data) applyThreadTools(response.data)
    scheduleTokenBudgetRefresh()
  } catch (error) {
    if (request === toolsRequest && targetThreadId === threadStore.threadId) {
      threadStore.interactionMode = previousMode
    }
    notify.toast(error instanceof Error ? error.message : __t('ui.chat', '切换会话模式失败'), {
      type: 'error',
    })
  } finally {
    if (request === toolsRequest || request === 0) {
      modeSaving.value = false
      pendingInteractionMode.value = null
      toolsSaving.value = false
      toolsLoading.value = false
    }
  }
}

async function changeExecutionMode(nextMode: ExecutionMode): Promise<void> {
  if (executionModeDisabled.value || nextMode === executionMode.value) return
  const threadId = threadStore.threadId
  if (!threadId) return
  const previous = executionMode.value
  const request = ++toolsRequest
  executionMode.value = nextMode
  toolsSaving.value = true
  try {
    const response = await threadsApi.updateExecutionMode(threadId, nextMode)
    if (request !== toolsRequest || threadId !== threadStore.threadId) return
    toolsLoading.value = false
    executionMode.value = resolveExecutionMode(
      response.data?.executionMode,
      response.data?.autoExecuteTools,
    )
    notify.toast(
      __t('ui.chat', '已切换为{0}', [
        executionModeOptions.value.find((option) => option.value === executionMode.value)?.label,
      ]),
      { type: 'success' },
    )
  } catch (error) {
    if (request === toolsRequest && threadId === threadStore.threadId) {
      executionMode.value = previous
    }
    notify.toast(error instanceof Error ? error.message : __t('ui.chat', '保存执行模式失败'), {
      type: 'error',
    })
  } finally {
    if (request === toolsRequest) toolsSaving.value = false
  }
}

async function toggleThreadTool(tool: ThreadToolSetting): Promise<void> {
  if (!tool.modeAllowed) return
  if (tool.locked) {
    notify.toast(__t('ui.chat', '{0}属于系统协议，始终启用', [tool.label]), { type: 'info' })
    return
  }
  if (toolsSaving.value || props.isSending || !threadStore.threadId) return
  const threadId = threadStore.threadId
  const previous = tool.userEnabled
  tool.userEnabled = !previous
  tool.enabled = tool.userEnabled
  toolsSaving.value = true
  try {
    const disabled = new Set(disabledToolNames.value)
    if (tool.userEnabled) disabled.delete(tool.name)
    else disabled.add(tool.name)
    const response = await threadsApi.updateTools(threadId, [...disabled])
    if (threadId !== threadStore.threadId) return
    ++toolsRequest
    toolsLoading.value = false
    if (response.data) applyThreadTools(response.data)
    scheduleTokenBudgetRefresh()
    notify.toast(
      __t('ui.chat', '{0}已{1}，仅影响本会话', [
        tool.label,
        tool.enabled ? __t('ui.chat', '启用') : __t('ui.chat', '禁用'),
      ]),
      {
        type: 'success',
      },
    )
  } catch (error) {
    tool.enabled = previous
    tool.userEnabled = previous
    notify.toast(error instanceof Error ? error.message : __t('ui.chat', '保存工具配置失败'), {
      type: 'error',
    })
  } finally {
    toolsSaving.value = false
  }
}

async function toggleToolManager(): Promise<void> {
  toolOpen.value = !toolOpen.value
  if (toolOpen.value) await loadThreadTools()
}

async function loadFlowState(): Promise<void> {
  if (!threadStore.threadId) {
    flowStates.value = []
    return
  }
  flowLoading.value = true
  try {
    const response = await threadsApi.getFlowState(
      threadStore.threadId,
      agentStore.activeAgentId || undefined,
    )
    flowStates.value = response.data ?? []
  } catch (error) {
    logger.warn('InputBar', __t('logs.frontend.chat', '加载会话心流失败'), error)
    flowStates.value = []
  } finally {
    flowLoading.value = false
  }
}

async function toggleFlowPanel(): Promise<void> {
  flowOpen.value = !flowOpen.value
  if (flowOpen.value) await loadFlowState()
}

async function clearFlowState(agentId: string): Promise<void> {
  if (!threadStore.threadId || flowClearing.value) return
  flowClearing.value = true
  try {
    await threadsApi.clearFlowState(threadStore.threadId, agentId)
    await loadFlowState()
    notify.toast(__t('ui.chat', '当前会话心流已清空'), { type: 'success' })
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.chat', '清空心流失败'), {
      type: 'error',
    })
  } finally {
    flowClearing.value = false
  }
}

watch(() => inputText.value, scheduleTokenBudgetRefresh)

watch(
  [() => threadStore.threadId, () => agentStore.activeAgentId],
  () => {
    tokenBudget.value = null
    scheduleTokenBudgetRefresh()
  },
  { immediate: true },
)

watch(
  currentLiveContextBudget,
  (budget) => {
    // 结束到预算预览返回之间沿用最后一轮统计，避免瞬间跳回对话开始前的旧数值。
    if (budget) tokenBudget.value = budget
  },
  { immediate: true },
)

watch(budgetIsRunning, scheduleTokenBudgetRefresh)

watch(
  () => props.isSending,
  (sending, previous) => {
    if (previous && !sending && flowOpen.value) void loadFlowState()
  },
)

watch(
  () => threadStore.threadId,
  () => {
    closeInputPopovers()
    toolOpen.value = false
    flowOpen.value = false
    flowStates.value = []
    toolQuery.value = ''
    threadTools.value = []
    disabledToolNames.value = []
    void loadThreadTools()
  },
  { immediate: true },
)

/** 命令面板：基础操作 + 动态角色切换（不硬编码任何角色名）。 */
const commands = computed(() => [
  {
    id: 'new',
    get label() {
      return __t('ui.chat', '新会话')
    },
    get hint() {
      return __t('ui.chat', '创建当前角色的新会话')
    },
    get keywords() {
      return __t('ui.chat', 'new 新建')
    },
  },
  {
    id: 'clear',
    get label() {
      return __t('ui.chat', '清空输入')
    },
    get hint() {
      return __t('ui.chat', '清除尚未发送的文字')
    },
    get keywords() {
      return __t('ui.chat', 'clear 清除')
    },
  },
  {
    id: 'stop',
    get label() {
      return __t('ui.chat', '停止生成')
    },
    get hint() {
      return __t('ui.chat', '中止当前回复')
    },
    get keywords() {
      return __t('ui.chat', 'stop 停止')
    },
  },
  ...agentStore.agents.map((agent) => ({
    id: agent.id,
    get label() {
      return __t('ui.chat', '切换 {0}', [agent.name || agent.id])
    },
    get hint() {
      return __t('ui.chat', '切换到该角色')
    },
    keywords: `agent 角色 ${agent.name || agent.id}`,
  })),
])

let capabilitiesLoadedKey = ''
let capabilitiesPromise: Promise<void> | null = null

async function loadCapabilities(force = false): Promise<void> {
  // 据点群聊当前仅支持文本，不读取 desktop 模型和语音能力。
  if (isGroupChannel.value) return
  const threadId = threadStore.threadId
  const scopeKey = `${agentStore.activeAgentId}:${threadId}`
  if (!force && capabilitiesLoadedKey === scopeKey) return
  if (!force && capabilitiesPromise && capabilitiesLoadedKey === `pending:${scopeKey}`) {
    return capabilitiesPromise
  }
  const request = ++capabilitiesRequest
  capabilitiesLoadedKey = `pending:${scopeKey}`
  const task = (async () => {
    try {
      const [modelResult, voiceResult, relayResult] = await Promise.allSettled([
        threadId ? threadsApi.getModelSettings(threadId) : Promise.resolve(null),
        voiceApi.getStatus(),
        configApi.batch(['multimodalRelay.enabled', 'multimodalRelay.modelConfigId']),
      ])
      if (request !== capabilitiesRequest || threadId !== threadStore.threadId) return
      const modelRes = modelResult.status === 'fulfilled' ? modelResult.value : null
      const voiceRes = voiceResult.status === 'fulfilled' ? voiceResult.value : null
      const relayRes = relayResult.status === 'fulfilled' ? relayResult.value : null
      const relayConfig = relayRes?.data ?? {}
      if (threadId && modelRes?.data) {
        cacheThreadUsableModel(threadId, Boolean(modelRes.data.effective.modelId))
      }
      relayAvailable.value =
        relayConfig['multimodalRelay.enabled'] === 'true' &&
        Boolean(relayConfig['multimodalRelay.modelConfigId'])
      asrAvailable.value = voiceRes?.data?.asr?.available === true
      enableVision.value = modelRes?.data?.effective.enableVision === true
      enableAudioInput.value = modelRes?.data?.effective.enableAudioInput === true
      nativeAudioAvailable.value = modelRes?.data?.effective.nativeAudioAvailable === true
      capabilitiesLoadedKey = scopeKey
    } catch (error) {
      if (request === capabilitiesRequest) capabilitiesLoadedKey = ''
      logger.error('InputBar', __t('logs.frontend.chat', '读取输入能力状态失败'), error)
    }
  })().finally(() => {
    if (capabilitiesPromise === task) capabilitiesPromise = null
  })
  capabilitiesPromise = task
  return task
}

watch(
  [() => agentStore.activeAgentId, () => threadStore.threadId],
  () => {
    void loadCapabilities()
  },
  { immediate: true },
)

function onModelCapabilitiesChanged(): void {
  capabilitiesLoadedKey = ''
  void loadCapabilities(true)
}

watch(
  [() => threadStore.threadId, () => agentStore.activeAgentId],
  ([_next, agentId], [previous, previousAgentId]) => {
    if (previous || agentId !== previousAgentId) void clearPendingAttachments()
  },
)

function loadInputHistory(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const stored = JSON.parse(localStorage.getItem(INPUT_HISTORY_KEY) ?? '[]') as unknown
    if (!Array.isArray(stored)) return []
    return stored
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(-INPUT_HISTORY_LIMIT)
  } catch {
    return []
  }
}

function saveInputHistory(text: string): void {
  const normalized = text.trim()
  if (!normalized) return
  inputHistory.value = [...inputHistory.value, normalized].slice(-INPUT_HISTORY_LIMIT)
  historyIndex.value = inputHistory.value.length
  historyDraft.value = ''
  try {
    localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(inputHistory.value))
  } catch (error) {
    logger.warn('InputBar', __t('logs.frontend.chat', '保存本地输入历史失败'), error)
  }
}

function showHistory(direction: -1 | 1): void {
  const length = inputHistory.value.length
  if (!length) return
  if (direction === -1) {
    if (historyIndex.value === length) historyDraft.value = inputText.value
    historyIndex.value = Math.max(0, historyIndex.value - 1)
  } else {
    if (historyIndex.value >= length) return
    historyIndex.value += 1
  }
  inputText.value =
    historyIndex.value === length
      ? historyDraft.value
      : (inputHistory.value[historyIndex.value] ?? '')
  mentionOpen.value = false
  nextTick(() => {
    const element = textareaRef.value
    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
    autoResize()
  })
}

function canNavigateHistory(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
    return false
  const element = textareaRef.value
  if (!element || element.selectionStart !== element.selectionEnd) return false
  const caret = element.selectionStart
  if (event.key === 'ArrowUp') return !element.value.slice(0, caret).includes('\n')
  if (event.key === 'ArrowDown') return !element.value.slice(caret).includes('\n')
  return false
}

function autoResize() {
  const element = textareaRef.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 180)}px`
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  // @ 弹窗打开时优先处理选择导航，避免 Enter 直接发送。
  if (mentionOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeMentionIndex.value = (activeMentionIndex.value + 1) % mentionFiltered.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeMentionIndex.value =
        (activeMentionIndex.value - 1 + mentionFiltered.value.length) % mentionFiltered.value.length
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const target = mentionFiltered.value[activeMentionIndex.value]
      if (target) selectMention(target)
      return
    }
    if (event.key === 'Escape') {
      mentionOpen.value = false
      return
    }
  }
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && canNavigateHistory(event)) {
    event.preventDefault()
    showHistory(event.key === 'ArrowUp' ? -1 : 1)
    return
  }
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    (!isMobile.value || event.ctrlKey || event.metaKey)
  ) {
    event.preventDefault()
    send()
  } else if (event.key === 'Escape') {
    commandOpen.value = false
    toolOpen.value = false
  }
}

let creatingThreadPromise: Promise<string> | null = null
async function ensureThread(): Promise<string> {
  if (threadStore.threadId) return threadStore.threadId
  if (!creatingThreadPromise) {
    const task = threadStore
      .createNewThread(agentStore.activeAgentId, 'desktop')
      .finally(() => {
        if (creatingThreadPromise === task) creatingThreadPromise = null
      })
    creatingThreadPromise = task
  }
  await creatingThreadPromise
  return threadStore.threadId
}

function validateFile(file: File): 'image' | 'text' | 'pdf' | 'audio' | 'file' | null {
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    notify.toast(__t('ui.attachments', '附件不能超过 100MB'), { type: 'warning' })
    return null
  }
  return classifyAttachmentUpload(file.name, file.type, file.size)
}

/** 0ms 同步构建待发送缩略图占位，消除粘贴/拖入文件后的无反馈空白期。 */
function stagePendingAttachment(file: File): PendingAttachment | null {
  if (props.disabled || isGroupChannel.value) return null
  const kind = validateFile(file)
  if (!kind) return null
  if (pendingAttachments.value.length >= 5) {
    notify.toast(__t('ui.chat', '每轮最多添加 5 个附件'), { type: 'warning' })
    return null
  }
  const localKey = `${Date.now()}-${Math.random()}`
  const previewUrl = kind === 'image' || kind === 'audio' ? URL.createObjectURL(file) : undefined
  const pending: PendingAttachment = {
    id: '',
    threadId: '',
    messageId: null,
    kind,
    originalName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    contextPolicy: 'once',
    status: 'uploaded',
    uploadState: 'uploading',
    localKey,
    previewUrl,
    sourceFile: file,
  }
  pendingAttachments.value = [...pendingAttachments.value, pending]
  return pending
}

async function uploadStagedAttachment(
  pending: PendingAttachment,
  file: File,
  version: number,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const { localKey, kind } = pending
  const validDraft = () =>
    !signal?.aborted &&
    version === attachmentDraftVersion &&
    agentId === agentStore.activeAgentId &&
    !props.disabled &&
    pendingAttachments.value.some((item) => item.localKey === localKey)
  try {
    if (kind === 'pdf' || file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      await loadPdfCapabilities()
    } else if (kind === 'image') {
      await loadCapabilities()
    }
    if (!validDraft()) {
      if (signal?.aborted || version !== attachmentDraftVersion || agentId !== agentStore.activeAgentId) {
        detachAttachment(pending)
      }
      return
    }
    const referenceOnly =
      kind === 'file' ||
      (kind === 'pdf' && (!pdfAvailable.value || file.size > maxPdfBytes.value)) ||
      (kind === 'image' &&
        ((!enableVision.value && !relayAvailable.value) ||
          (imageMode.value === 'native' && !enableVision.value) ||
          (imageMode.value === 'relay' && !relayAvailable.value)))
    const threadId = await ensureThread()
    if (!validDraft() || threadStore.threadId !== threadId) {
      detachAttachment(pending)
      return
    }
    const response = await attachmentsApi.upload(file, threadId, {
      referenceOnly,
      ...(signal ? { signal } : {}),
    })
    if (!response.data) throw new Error('服务端未返回附件信息')
    if (!validDraft() || threadStore.threadId !== threadId) {
      detachAttachment(pending)
      await cleanupPendingAttachment(response.data)
      return
    }
    Object.assign(pending, response.data, { uploadState: 'success' })
    if (response.data.status === 'processing') {
      pending.uploadState = 'processing'
      pendingAttachments.value = [...pendingAttachments.value]
      void waitForPdf(pending).catch((cause) => failPendingAttachment(pending, cause))
    }
    pendingAttachments.value = [...pendingAttachments.value]
  } catch (error) {
    if (signal?.aborted) {
      detachAttachment(pending)
      return
    }
    failPendingAttachment(pending, error)
  }
}

async function uploadFile(file: File, signal?: AbortSignal) {
  if (signal?.aborted) return
  const version = attachmentDraftVersion
  const agentId = agentStore.activeAgentId
  const pending = stagePendingAttachment(file)
  if (!pending) return
  await uploadStagedAttachment(pending, file, version, agentId, signal)
}

function failPendingAttachment(item: PendingAttachment, cause: unknown): void {
  if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
  item.uploadState = 'failed'
  item.error = cause instanceof Error ? cause.message : '附件处理失败'
  pendingAttachments.value = [...pendingAttachments.value]
  notify.toast(item.error, { type: 'error' })
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement
  await uploadFiles(Array.from(input.files ?? []))
  input.value = ''
}

const UPLOAD_CONCURRENCY = 3
async function uploadFiles(files: File[]): Promise<void> {
  if (props.disabled || isGroupChannel.value || !files.length) return
  const version = attachmentDraftVersion
  const agentId = agentStore.activeAgentId
  // 先在首帧同步推入所有缩略图占位，再按有界并发上传到服务端
  const staged: Array<{ pending: PendingAttachment; file: File }> = []
  for (const file of files) {
    const pending = stagePendingAttachment(file)
    if (!pending) {
      if (pendingAttachments.value.length >= 5) break
      continue
    }
    staged.push({ pending, file })
  }
  if (!staged.length) return
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(UPLOAD_CONCURRENCY, staged.length) },
    async () => {
      while (cursor < staged.length) {
        const entry = staged[cursor++]
        if (!entry) break
        await uploadStagedAttachment(entry.pending, entry.file, version, agentId)
      }
    },
  )
  await Promise.all(workers)
}
const fileDrop = useFileDrop({
  enabled: () => !props.disabled && !isGroupChannel.value,
  files: uploadFiles,
  unavailable: () =>
    notify.toast(__t('ui.attachments', '当前会话暂不支持上传附件'), { type: 'warning' }),
  directory: () =>
    notify.toast(__t('ui.attachments', '请拖入文件，文件夹请先压缩'), { type: 'warning' }),
})

async function onPaste(event: ClipboardEvent) {
  // group 通道目前只接收文本，禁止粘贴文件时隐式创建 desktop Thread。
  if (isGroupChannel.value) return
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  await uploadFiles(files)
}

function releaseAttachmentPreview(item: PendingAttachment): void {
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl)
    item.previewUrl = undefined
  }
}

function detachAttachment(item: PendingAttachment): void {
  pendingAttachments.value = pendingAttachments.value.filter(
    (entry) => entry.localKey !== item.localKey,
  )
  releaseAttachmentPreview(item)
}

async function cleanupPendingAttachment(item: AttachmentInfo): Promise<void> {
  // 已绑定附件归历史消息管理，取消输入区的缩略图不能删除消息中的图片。
  if (!item.id || item.messageId !== null || ['bound', 'deleted'].includes(item.status)) return
  try {
    await attachmentsApi.removeUnbound(item.id)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') return
    logger.warn('InputBar', __t('logs.frontend.chat', '待发送附件已移除，后台清理未完成'), error)
  }
}

async function removeAttachment(item: PendingAttachment): Promise<void> {
  if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
  // 先取消本地引用，避免附件已失效或网络中断时，删除按钮反复报错且无法移除。
  detachAttachment(item)
  await cleanupPendingAttachment(item)
}

async function clearPendingAttachments() {
  attachmentDraftVersion += 1
  const items = [...pendingAttachments.value]
  pendingAttachments.value = []
  items.forEach(releaseAttachmentPreview)
  submittedAttachments.forEach(releaseAttachmentPreview)
  submittedAttachments.clear()
  await Promise.all(items.map(cleanupPendingAttachment))
}

async function reconcileFailedAttachment(item: PendingAttachment): Promise<void> {
  try {
    const response = await attachmentsApi.get(item.id)
    if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
    const current = response.data
    if (!current) throw new Error('附件状态暂时无法读取')
    if (current.messageId !== null || ['bound', 'deleted'].includes(current.status)) {
      detachAttachment(item)
      return
    }
    Object.assign(item, current, {
      uploadState:
        current.status === 'uploaded'
          ? 'success'
          : current.status === 'processing'
            ? 'processing'
            : 'failed',
      error: current.error,
    })
    pendingAttachments.value = [...pendingAttachments.value]
    if (item.uploadState === 'processing')
      void waitForPdf(item).catch((cause) => failPendingAttachment(item, cause))
  } catch (error) {
    if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
    if (error instanceof ApiError && error.code === 'NOT_FOUND') {
      detachAttachment(item)
      return
    }
    // 状态未知时禁止直接重发旧 ID，用户仍可随时移除并重新添加。
    item.uploadState = 'failed'
    item.error = '附件状态确认失败，请移除后重新添加'
    pendingAttachments.value = [...pendingAttachments.value]
  }
}

async function waitForPdf(item: PendingAttachment): Promise<void> {
  const started = Date.now()
  while (pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000))
    if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
    const response = await attachmentsApi.get(item.id)
    if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
    if (!response.data) throw new Error('附件状态暂时无法读取')
    Object.assign(item, response.data)
    if (response.data.status === 'uploaded') {
      item.uploadState = 'success'
      pendingAttachments.value = [...pendingAttachments.value]
      return
    }
    if (response.data.status === 'failed' || response.data.status === 'deleted')
      throw new Error(response.data.error || 'PDF 解析未完成，请重试')
    if (Date.now() - started > 11 * 60_000) throw new Error('PDF 解析等待超时，请稍后重试')
  }
}

async function retryPdf(item: PendingAttachment): Promise<void> {
  try {
    const current = await attachmentsApi.get(item.id)
    const response =
      current.data?.status === 'failed' ? await attachmentsApi.retry(item.id) : current
    if (!response.data) throw new Error('未能重新开始解析')
    if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
    Object.assign(item, response.data, {
      uploadState: response.data.status === 'uploaded' ? 'success' : 'processing',
      error: undefined,
    })
    pendingAttachments.value = [...pendingAttachments.value]
    if (item.uploadState === 'processing') await waitForPdf(item)
  } catch (cause) {
    if (!pendingAttachments.value.some((entry) => entry.localKey === item.localKey)) return
    item.uploadState = 'failed'
    item.error = cause instanceof Error ? cause.message : 'PDF 解析失败'
    pendingAttachments.value = [...pendingAttachments.value]
    notify.toast(item.error, { type: 'error' })
  }
}

// ── @ 提及（group 模式）──

/** @ 弹窗是否打开 */
const mentionOpen = ref(false)
/** 光标前 @ 之后的过滤关键词 */
const mentionQuery = ref('')
/** 弹窗内高亮项索引 */
const activeMentionIndex = ref(0)

/** 「全体成员」置顶的候选列表，按名字过滤。 */
const mentionFiltered = computed<MentionCandidate[]>(() => {
  const query = mentionQuery.value.trim().toLowerCase()
  const agents = props.mentionCandidates.filter(
    (candidate) => !query || candidate.name.toLowerCase().includes(query),
  )
  return [{ agentId: '@all', name: props.mentionAllLabel }, ...agents]
})

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 输入事件：检测光标前是否刚键入 @（或处于 @ 查询中），
 * 满足条件则打开成员候选弹窗。
 */
function onTextInput(event: Event) {
  historyIndex.value = inputHistory.value.length
  historyDraft.value = ''
  autoResize()
  if (!isGroupChannel.value) return
  const element = event.target as HTMLTextAreaElement
  const caret = element.selectionStart ?? element.value.length
  const atIndex = element.value.lastIndexOf('@', caret - 1)
  // 弹窗只在「光标前的 @ 是查询串开头、查询串不含 @ 与空格」时打开。
  // 选中 "@名字 " 后查询串含空格，弹窗自动收起，避免持续干扰后续输入。
  const querySegment = atIndex === -1 ? '' : element.value.slice(atIndex + 1, caret)
  const open =
    atIndex !== -1 &&
    (atIndex === 0 || /\s/.test(element.value[atIndex - 1] ?? '')) &&
    !querySegment.includes('@') &&
    !/\s/.test(querySegment)
  if (open) {
    mentionQuery.value = querySegment
    mentionOpen.value = true
    activeMentionIndex.value = 0
  } else {
    mentionOpen.value = false
  }
}

/** 把 overlay 的滚动位置与 textarea 对齐（两者字体/宽度一致）。 */
function syncOverlayScroll() {
  if (!overlayRef.value || !textareaRef.value) return
  overlayRef.value.scrollTop = textareaRef.value.scrollTop
  overlayRef.value.scrollLeft = textareaRef.value.scrollLeft
}

/** 选中候选：把 [@, 光标) 替换为 "@名字 "，光标移到名字之后。 */
function selectMention(candidate: MentionCandidate) {
  const element = textareaRef.value
  if (!element) return
  const text = element.value
  const caret = element.selectionStart ?? text.length
  const atIndex = text.lastIndexOf('@', caret - 1)
  // 兜底：找不到合法 @ 前缀时直接追加到末尾。
  const next =
    atIndex === -1
      ? `${text}@${candidate.name} `
      : `${text.slice(0, atIndex)}@${candidate.name} ${text.slice(caret)}`
  inputText.value = next
  mentionOpen.value = false
  nextTick(() => {
    const position = atIndex === -1 ? next.length : atIndex + candidate.name.length + 2
    element.focus()
    element.setSelectionRange(position, position)
    autoResize()
  })
}

/** @ 按钮：在光标处插入 @ 并打开成员候选弹窗（房间没有候选时禁用）。 */
function openMentionPicker() {
  if (!isGroupChannel.value || props.disabled || props.mentionCandidates.length === 0) return
  const element = textareaRef.value
  if (!element) return
  const caret = element.selectionStart ?? element.value.length
  const text = element.value
  const next = `${text.slice(0, caret)}@${text.slice(caret)}`
  inputText.value = next
  mentionOpen.value = true
  mentionQuery.value = ''
  activeMentionIndex.value = 0
  nextTick(() => {
    element.focus()
    const position = caret + 1
    element.setSelectionRange(position, position)
    autoResize()
  })
}

/** 从文本中解析被 @ 的成员（名字 → agentId；全体成员 → '@all'），去重保序。 */
function resolveMentions(text: string): string[] {
  if (props.mentionCandidates.length === 0) return []
  const allLabel = props.mentionAllLabel
  const byName = new Map(
    props.mentionCandidates.map((candidate) => [candidate.name, candidate.agentId]),
  )
  const tokens = [...byName.keys(), allLabel].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`@(${tokens.map(escapeRegExp).join('|')})`, 'g')
  const found: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const token = match[1]!
    found.push(token === allLabel ? '@all' : (byName.get(token) ?? token))
  }
  return [...new Set(found)]
}

/** overlay 渲染：把 @名字 高亮为内联 chip，其余文本保持原样。 */
const mentionOverlayHtml = computed(() => {
  const text = inputText.value
  if (!text) return ''
  const escaped = escapeHtml(text)
  const names = [...props.mentionCandidates.map((candidate) => candidate.name)]
  if (names.length > 0) names.push(props.mentionAllLabel)
  names.sort((a, b) => b.length - a.length)
  if (names.length === 0) return escaped
  // 后瞻允许空格与常见中英文标点，让「@名字，」这类紧跟标点的提及也能渲染为 chip。
  const pattern = new RegExp(
    `@(${names.map((name) => escapeRegExp(escapeHtml(name))).join('|')})(?=[\\s，。！？；：,.!?;:]|$)`,
    'g',
  )
  return escaped.replace(
    pattern,
    (_all, name: string) => `<span class="mention-chip-inline">@${name}</span>`,
  )
})

function send() {
  if (
    voiceBusy.value ||
    startingVoice.value ||
    skillSettingsBusy.value ||
    submitting.value ||
    props.submissionBusy ||
    (props.isSending && !props.queueEnabled) ||
    props.disabled
  )
    return
  const text = inputText.value.trim()
  if ((!text && !successfulAttachments.value.length) || hasUploading.value) return
  const audioBytes = successfulAttachments.value
    .filter(
      (item) =>
        item.kind === 'audio' &&
        item.sizeBytes <= MAX_NATIVE_AUDIO_BYTES &&
        item.contextMode !== 'reference',
    )
    .reduce((sum, item) => sum + item.sizeBytes, 0)
  if (nativeAudioAvailable.value && audioBytes > MAX_NATIVE_AUDIO_BYTES) {
    notify.toast(__t('ui.audio-input', '单轮原生音频不能超过 12MB'), { type: 'warning' })
    return
  }
  const mentions = isGroupChannel.value ? resolveMentions(inputText.value) : []
  const ids = successfulAttachments.value.map((item) => item.id)
  const sentAttachments = [...successfulAttachments.value]
  const submissionVersion = ++attachmentDraftVersion
  sentAttachments.forEach((item) => submittedAttachments.add(item))
  let completed = false
  submitting.value = true
  saveInputHistory(text)
  // 提交给流式管道后立刻清空本地输入，避免等待模型完整回复才更新指挥台。
  inputText.value = ''
  // 失败的附件留在输入区供重试，不能显示成已经随消息发送。
  pendingAttachments.value = pendingAttachments.value.filter(
    (item) => item.uploadState === 'failed',
  )
  mentionOpen.value = false
  nextTick(autoResize)
  const resolvedImageMode =
    imageMode.value === 'auto' ? (enableVision.value ? 'native' : 'relay') : imageMode.value
  emit(
    'send',
    text || '请查看本轮附件。',
    mentions,
    ids,
    sentAttachments.map(
      ({
        uploadState: _uploadState,
        localKey: _localKey,
        previewUrl: _previewUrl,
        sourceFile: _sourceFile,
        error: _error,
        ...item
      }) => item,
    ),
    resolvedImageMode,
    (success) => {
      if (completed) return
      completed = true
      submitting.value = false
      sentAttachments.forEach((item) => submittedAttachments.delete(item))
      if (success || submissionVersion !== attachmentDraftVersion) {
        sentAttachments.forEach(releaseAttachmentPreview)
        return
      }
      if (!inputText.value) inputText.value = text
      // 模型失败不代表附件未被接收；确认仍未绑定后才允许再次发送。
      const slots = Math.max(0, 5 - pendingAttachments.value.length)
      const restored = sentAttachments.slice(0, slots)
      restored.forEach((item) => {
        item.uploadState = 'checking'
      })
      pendingAttachments.value = [...pendingAttachments.value, ...restored]
      restored.forEach((item) => {
        void reconcileFailedAttachment(item)
      })
      sentAttachments.slice(slots).forEach((item) => {
        releaseAttachmentPreview(item)
        void cleanupPendingAttachment(item)
      })
      nextTick(autoResize)
    },
  )
}

async function executeCommand(id: string) {
  commandOpen.value = false
  commandQuery.value = ''
  if (id === 'new') emit('newThread')
  else if (id === 'clear') inputText.value = ''
  else if (id === 'stop') emit('stop')
  else {
    const target = agentStore.agents.find((agent) => agent.id.toLowerCase() === id)
    if (target) await agentStore.switchAgent(target.id)
    else notify.toast(__t('ui.chat', '未找到角色「{0}」', [id]), { type: 'warning' })
  }
}

const startingVoice = ref(false)
let recordingRequest = 0

function currentRecordingTarget(target: NonNullable<typeof recordTarget>): boolean {
  return (
    target.agentId === agentStore.activeAgentId &&
    target.threadId === threadStore.threadId &&
    target.version === attachmentDraftVersion &&
    !props.disabled &&
    !isGroupChannel.value
  )
}

async function startRecording(mode: 'asr' | 'native' | 'auto'): Promise<void> {
  if (voiceBusy.value || startingVoice.value || props.disabled || isGroupChannel.value) return
  const request = ++recordingRequest
  const agentId = agentStore.activeAgentId
  startingVoice.value = true
  recordingError.value = ''
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error(__t('ui.audio-input', '麦克风需要 HTTPS 或本地客户端环境'))
    const threadId = await ensureThread()
    await loadCapabilities()
    if (
      request !== recordingRequest ||
      agentId !== agentStore.activeAgentId ||
      threadId !== threadStore.threadId
    )
      return
    const resolvedMode = mode === 'auto' ? preferredRecordingMode.value : mode
    if (resolvedMode === 'native' && !nativeAudioAvailable.value)
      throw new Error(__t('ui.audio-input', '请使用 Gemini 协议并手动开启模型卡片的原生音频输入'))
    if (resolvedMode === 'asr' && !asrAvailable.value)
      throw new Error(__t('ui.audio-input', '语音转文字服务尚未启用'))
    recordTarget = { agentId, threadId, version: attachmentDraftVersion, mode: resolvedMode }
    recordingMode.value = resolvedMode
    await capture.setMode('ptt')
    if (request === recordingRequest && recordTarget && currentRecordingTarget(recordTarget))
      capture.pttDown()
  } catch (cause) {
    if (request === recordingRequest)
      recordingError.value =
        cause instanceof Error ? cause.message : __t('ui.audio-input', '无法开启麦克风')
  } finally {
    if (request === recordingRequest) startingVoice.value = false
  }
}

async function handleVoiceClip(clip: VoiceClip, signal: AbortSignal): Promise<void> {
  const target = recordTarget
  if (!target || signal.aborted || !currentRecordingTarget(target)) return
  if (target.mode === 'native') {
    const audio = await recordingWave(clip.audio, signal)
    if (signal.aborted || !currentRecordingTarget(target)) return
    const file = new File(
      [audio],
      __t('ui.audio-input', '录音 {0}.wav', [new Date().toISOString().replace(/[:.]/g, '-')]),
      { type: 'audio/wav' },
    )
    await uploadFile(file, signal)
  } else {
    const result = await voiceApi.recognize(clip.audio, clip.mimeType, signal)
    if (signal.aborted || !currentRecordingTarget(target)) return
    const text = result.text?.trim()
    if (!text) throw new Error(__t('ui.audio-input', '未识别到有效语音内容'))
    inputText.value = [inputText.value.trim(), text].filter(Boolean).join('\n')
    await nextTick(autoResize)
  }
  if (recordTarget === target) recordTarget = null
}

function cancelRecording(): void {
  recordingRequest++
  recordTarget = null
  startingVoice.value = false
  void capture.setMode('off')
}

watch(inputScope, () => {
  if (recordTarget && !currentRecordingTarget(recordTarget)) cancelRecording()
})
watch(
  () => props.disabled || isGroupChannel.value,
  (disabled) => {
    if (disabled) cancelRecording()
  },
)

function audioAttachmentLabel(item: PendingAttachment): string {
  if (item.sizeBytes > MAX_NATIVE_AUDIO_BYTES)
    return __t('ui.audio-input', '超过 12MB，仅保存原件引用')
  if (item.contextMode === 'reference') return __t('ui.audio-input', '仅保存原件引用')
  if (!enableAudioInput.value) return __t('ui.audio-input', '原生音频输入未开启，本轮仅发送引用')
  if (!nativeAudioAvailable.value)
    return __t('ui.audio-input', '当前连接不是 Gemini 协议，本轮仅发送引用')
  return __t('ui.audio-input', 'Gemini 将直接听取原音')
}

async function retryUpload(item: PendingAttachment): Promise<void> {
  const file = item.sourceFile
  if (!file) return
  detachAttachment(item)
  await cleanupPendingAttachment(item)
  await uploadFile(file)
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

onMounted(() => {
  void loadPdfCapabilities()
  window.addEventListener('infos:integrations-changed', onIntegrationsChanged)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('infos:model-capabilities-changed', onModelCapabilitiesChanged)
  window.addEventListener('infos:input-foldout-open', onFoldoutOpened)
})

onBeforeUnmount(() => {
  window.removeEventListener('infos:integrations-changed', onIntegrationsChanged)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('infos:model-capabilities-changed', onModelCapabilitiesChanged)
  window.removeEventListener('infos:input-foldout-open', onFoldoutOpened)
  if (tokenBudgetTimer) clearTimeout(tokenBudgetTimer)
  tokenBudgetRequest++
  cancelRecording()
  void clearPendingAttachments()
})

/** 先确认附件与当前会话，再接收已由服务端移出派发队列的草稿。 */
async function restoreQueuedDraft(
  item: ConversationQueueItem,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (
    !isCurrent() ||
    props.disabled ||
    submitting.value ||
    threadStore.threadId !== item.input.threadId
  )
    return false
  const version = attachmentDraftVersion
  const ids = item.input.attachmentIds ?? []
  const attachments = await Promise.all(
    ids.map(async (id) => {
      const attachment = (await attachmentsApi.get(id)).data
      if (
        !attachment ||
        attachment.threadId !== item.input.threadId ||
        attachment.messageId !== null ||
        attachment.status !== 'uploaded'
      ) {
        throw new Error('附件暂不可用，编辑草稿已保留')
      }
      return attachment
    }),
  )
  if (
    !isCurrent() ||
    props.disabled ||
    version !== attachmentDraftVersion ||
    threadStore.threadId !== item.input.threadId
  )
    return false
  const additional = attachments.filter(
    (attachment) => !pendingAttachments.value.some((entry) => entry.id === attachment.id),
  )
  if (pendingAttachments.value.length + additional.length > 5)
    throw new Error('附件过多，请先整理输入栏')
  const hadDraft = !!inputText.value.trim() || pendingAttachments.value.length > 0
  if (!restoredQueueDrafts.has(item.id)) {
    inputText.value = [inputText.value, item.input.content].filter(Boolean).join('\n\n')
    restoredQueueDrafts.add(item.id)
    if (!hadDraft && item.input.imageMode) imageMode.value = item.input.imageMode
  }
  pendingAttachments.value.push(
    ...additional.map(
      (attachment): PendingAttachment => ({
        ...attachment,
        uploadState: 'success',
        localKey: `queue:${item.id}:${attachment.id}`,
        previewUrl:
          attachment.kind === 'image' ? attachmentsApi.contentUrl(attachment.id) : undefined,
      }),
    ),
  )
  nextTick(() => {
    autoResize()
    textareaRef.value?.focus()
  })
  return true
}

defineExpose({
  focus: () => textareaRef.value?.focus(),
  clearPendingAttachments,
  restoreQueuedDraft,
  uploadFiles,
})
</script>

<template>
  <div
    class="deck"
    :class="{
      'deck--sending': isSending,
      'deck--compact': compact,
      'deck--file-dragging': fileDrop.dragging.value,
    }"
    @keydown.esc="(voiceBusy || startingVoice || recordingError) && cancelRecording()"
    @dragenter="fileDrop.enter"
    @dragover="fileDrop.over"
    @dragleave="fileDrop.leave"
    @drop="fileDrop.drop"
  >
    <div v-if="isGroupChannel" class="deck-status">
      <span class="deck-chip">
        <PixelIcon name="home" size="xs" />
        {{ contextLabel }}
      </span>
      <span class="deck-chip">
        <PixelIcon name="user" size="xs" />
        {{ participantLabel }}
      </span>
      <span class="deck-chip" :class="{ active: isSending }">
        {{ isSending ? __t('ui.chat', '等待角色回复') : __t('ui.chat', '群聊就绪') }}
      </span>
    </div>

    <div v-if="!isGroupChannel && pendingAttachments.length" class="attachment-list">
      <article
        v-for="item in pendingAttachments"
        :key="item.localKey"
        class="attachment-card"
        :class="{
          'attachment-card--image': item.kind === 'image' && item.previewUrl,
          'attachment-card--audio': item.kind === 'audio',
        }"
      >
        <template v-if="item.kind === 'image' && item.previewUrl">
          <img :src="item.previewUrl" :alt="__t('ui.chat', '待发送图片')" />
          <span
            class="attachment-image-state"
            :class="`attachment-image-state--${item.uploadState}`"
            :title="
              item.error ||
              (item.uploadState === 'uploading'
                ? __t('ui.chat', '上传中')
                : item.uploadState === 'checking'
                  ? __t('ui.chat', '确认附件状态中')
                  : item.uploadState === 'success'
                    ? __t('ui.chat', '已就绪')
                    : __t('ui.chat', '上传失败'))
            "
          />
        </template>
        <div v-else-if="item.kind === 'audio'" class="attachment-audio">
          <ResourceAudioPlayer
            v-if="item.previewUrl || item.id"
            :src="item.previewUrl || attachmentsApi.contentUrl(item.id)"
            :name="item.originalName"
            compact
          />
          <span class="attachment-audio__mode">
            {{
              item.uploadState === 'uploading'
                ? __t('ui.audio-input', '正在上传音频…')
                : audioAttachmentLabel(item)
            }}
          </span>
          <span v-if="item.error" class="attachment-error">{{ item.error }}</span>
        </div>
        <template v-else>
          <PixelIcon name="file" size="md" />
          <div class="attachment-info">
            <strong>{{ item.originalName }}</strong>
            <span>
              {{ formatSize(item.sizeBytes) }} ·
              {{
                item.uploadState === 'uploading'
                  ? __t('ui.chat', '上传中')
                  : item.uploadState === 'checking'
                    ? __t('ui.chat', '确认状态中')
                    : item.uploadState === 'processing'
                      ? __t('ui.chat', '解析中')
                      : item.uploadState === 'success'
                        ? __t('ui.chat', '已就绪')
                        : item.kind === 'pdf'
                          ? __t('ui.chat', '解析失败')
                          : __t('ui.chat', '上传失败')
              }}
            </span>
            <span v-if="item.error" class="attachment-error">{{ item.error }}</span>
            <span
              v-else-if="item.uploadState === 'success' && item.contextMode === 'reference'"
              class="attachment-reference"
            >
              {{ __t('ui.attachments', '已保存原件，可按需读取') }}
            </span>
          </div>
        </template>
        <button
          v-if="item.uploadState === 'failed' && item.sourceFile"
          type="button"
          :aria-label="__t('ui.audio-input', '重新上传')"
          :title="__t('ui.audio-input', '重新上传')"
          @click="retryUpload(item)"
        >
          <PixelIcon name="refresh" size="xs" />
        </button>
        <button
          v-if="item.kind === 'pdf' && item.uploadState === 'failed' && item.id"
          :title="__t('ui.chat', '重试解析')"
          :aria-label="__t('ui.chat', '重试解析')"
          @click="retryPdf(item)"
        >
          <PixelIcon name="refresh" size="xs" />
        </button>
        <button
          :title="__t('ui.chat', '取消附件')"
          :aria-label="__t('ui.chat', '取消附件')"
          @click="removeAttachment(item)"
        >
          <PixelIcon name="close" size="xs" />
        </button>
      </article>
    </div>

    <div class="deck-text-area">
      <!-- group 模式的 @ 内联 chip 叠加层：文字透明 + overlay 高亮渲染 -->
      <div
        v-if="isGroupChannel && inputText"
        ref="overlayRef"
        class="deck-text-overlay"
        v-html="mentionOverlayHtml"
      />
      <textarea
        ref="textareaRef"
        v-model="inputText"
        :placeholder="displayPlaceholder"
        :disabled="disabled"
        rows="1"
        :class="{ 'deck-textarea-transparent': isGroupChannel }"
        @input="onTextInput"
        @scroll="syncOverlayScroll"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <!-- @ 候选弹窗（QQ 风格：@全体成员置顶 + 房间成员） -->
      <Transition name="motion-pop">
        <div v-if="mentionOpen && isGroupChannel" class="deck-popover mention-popover">
          <button
            v-for="(candidate, index) in mentionFiltered"
            :key="candidate.agentId"
            :class="{ active: index === activeMentionIndex }"
            @mousedown.prevent="selectMention(candidate)"
          >
            <span class="mention-avatar">
              <img v-if="candidate.avatarUrl" :src="candidate.avatarUrl" :alt="candidate.name" />
              <PixelIcon v-else :name="candidate.agentId === '@all' ? 'users' : 'user'" size="xs" />
            </span>
            <strong>{{ candidate.name }}</strong>
            <small v-if="candidate.agentId === '@all'">{{ __t('ui.chat', '全体成员') }}</small>
          </button>
          <p v-if="!mentionFiltered.length" class="mention-empty">
            {{ __t('ui.chat', '没有匹配的成员') }}
          </p>
        </div>
      </Transition>
    </div>

    <AudioRecordingHud
      v-if="!isGroupChannel"
      :state="startingVoice ? 'preparing' : recordState"
      :mode="recordingMode"
      :seconds="recordingSeconds"
      :level="audioLevel"
      :error="recordingError"
      @stop="capture.pttUp()"
      @cancel="cancelRecording"
    />

    <div class="deck-footer">
      <div v-if="!isGroupChannel" class="deck-tools">
        <SessionSettingsPanel
          ref="sessionPanel"
          :thread-id="threadStore.threadId"
          :scope-key="inputScope"
          :compact="compact || isMobile"
          :model-disabled="disabled || isSending || modeSaving || skillSettingsBusy || submissionBusy || submitting"
          :interaction-mode="threadStore.interactionMode"
          :pending-interaction-mode="pendingInteractionMode"
          :mode-busy="modeSaving || debugStatus.busy"
          :mode-disabled="modeSwitchDisabled || skillSettingsBusy"
          :execution-mode="executionMode"
          :execution-disabled="executionModeDisabled || skillSettingsBusy"
          :image-mode="imageMode"
          :enable-vision="enableVision"
          :relay-available="relayAvailable"
          :recording-mode="preferredRecordingMode"
          :asr-available="asrAvailable"
          :native-audio-available="nativeAudioAvailable"
          :voice-disabled="disabled || voiceBusy || startingVoice"
          :locked="isSending || threadStore.isGenerating"
          :ensure-thread="ensureThread"
          @open="onFoldoutOpened"
          @model-changed="onThreadModelChanged"
          @model-busy="modelSettingsBusy = $event"
          @select-mode="switchInteractionMode"
          @change-execution="changeExecutionMode"
          @update:image-mode="imageMode = $event"
          @update:recording-mode="recordingMode = $event"
          @debug-state="debugStatus = $event"
          @debug-change="loadThreadTools"
          @reset="resetSessionSettings"
        />
        <ThreadSkillControls
          ref="skillControls"
          :thread-id="threadStore.threadId"
          :compact="compact || isMobile"
          :disabled="modeSwitchDisabled || modeSaving || modelSettingsBusy || threadStore.interactionMode === 'minimal'"
          @open="onFoldoutOpened"
          @busy="skillSettingsBusy = $event"
          @changed="scheduleTokenBudgetRefresh"
        />
        <button
          type="button"
          class="input-tool-trigger input-tool-trigger--chambered"
          :title="__t('ui.chat', '管理本会话可用工具')"
          :aria-label="__t('ui.chat', '管理本会话可用工具')"
          :aria-expanded="toolOpen"
          :disabled="modeSaving || skillSettingsBusy"
          :class="{ 'is-open': toolOpen, 'is-compact': compact || isMobile }"
          @click="toggleToolManager"
        >
          <span class="tool-trigger__emblem" aria-hidden="true">
            <PixelIcon name="tool" size="xs" />
          </span>
          <span v-if="!compact && !isMobile" class="tool-trigger__body">
            <span>{{ __t('ui.chat', '会话工具') }}</span>
            <span v-if="threadTools.length" class="tool-count">
              {{ enabledToolCount }}/{{ availableToolCount }}
            </span>
          </span>
        </button>
        <button
          type="button"
          class="input-tool-trigger input-cmd-trigger"
          :class="{ 'is-open': commandOpen }"
          :title="__t('ui.chat', '命令')"
          :aria-label="__t('ui.chat', '命令')"
          :aria-expanded="commandOpen"
          @click="commandOpen = !commandOpen"
        >
          <PixelIcon v-if="compact || isMobile" name="terminal" size="xs" class="deck-tool-icon" />
          <template v-else>
            <span class="cmd-trigger__slash" aria-hidden="true">/</span>
            <span>{{ __t('ui.chat', '指令') }}</span>
          </template>
        </button>
        <button
          type="button"
          class="deck-add-file input-tool-trigger"
          :title="__t('ui.attachments', '添加文件')"
          :aria-label="__t('ui.attachments', '添加文件')"
          :disabled="disabled"
          @click="fileInputRef?.click()"
        >
          <PixelIcon name="plus" size="xs" aria-hidden="true" />
        </button>
        <slot
          name="session-tools"
          :compact="compact || isMobile"
          :disabled="disabled"
          :dismiss="closeInputPopovers"
        />
      </div>
      <div v-else-if="isGroupChannel" class="group-footer-tools">
        <button
          class="mention-btn"
          :disabled="disabled || !mentionCandidates.length"
          :title="__t('ui.chat', '提及成员：在当前光标处插入 @')"
          @click="openMentionPicker"
        >
          <span class="mention-btn-at">@</span>
          <span>{{ __t('ui.chat', '提及') }}</span>
        </button>
      </div>
      <!-- 右侧角色生活经历、会话心流与像素切角晶环上下文容量指示器 -->
      <div v-if="!isGroupChannel" class="deck-telemetry">
        <ThreadExperiences
          v-if="threadStore.threadKind === 'main' && resolvedAgentId"
          :key="threadStore.threadId"
          :thread-id="threadStore.threadId"
          :generation="threadStore.threadGeneration"
          :agent-id="resolvedAgentId"
          :agent-name="resolvedAgentName"
          :agent-avatar-url="agentAvatarUrl"
          :compact="compact || isMobile"
          :disabled="disabled || !threadStore.threadId || !!threadStore.navigationTarget"
        />
        <button
          type="button"
          class="deck-flow-trigger input-tool-trigger input-tool-trigger--chambered"
          :class="{ 'is-open': flowOpen, 'is-compact': compact || isMobile }"
          :title="__t('ui.chat', '查看当前会话心流')"
          :aria-label="__t('ui.chat', '查看当前会话心流')"
          :aria-expanded="flowOpen"
          @click="toggleFlowPanel"
        >
          <span class="flow-trigger__emblem" aria-hidden="true">
            <PixelIcon name="thought" size="xs" />
          </span>
          <span v-if="!compact && !isMobile" class="flow-trigger__body">
            {{ __t('ui.chat', '心流') }}
          </span>
        </button>

        <div
          class="token-meter"
          :class="[`token-meter--${tokenBudgetTone}`, { 'is-running': budgetIsRunning }]"
          :style="{ '--token-deg': tokenBudgetSweepDeg }"
          tabindex="0"
          :aria-label="tokenBudgetTitle"
        >
          <span class="token-meter__emblem" aria-hidden="true">
            <span class="token-meter__gauge">
              <i class="token-meter__core" />
            </span>
          </span>
          <span class="token-meter__percent">{{ tokenBudgetPercentText }}</span>

          <div class="token-meter__popover" role="tooltip">
            <div class="token-meter__pop-head">
              <span class="token-meter__pop-title">
                <PixelIcon name="crystal" size="xs" />
                {{ __t('ui.chat', '上下文容量') }}
              </span>
              <strong class="token-meter__pop-pct">{{ tokenBudgetPercentText }}</strong>
            </div>
            <div class="token-meter__pop-bar" aria-hidden="true">
              <i :style="{ width: `${Math.max(hasTokenBudget ? 2 : 0, tokenBudgetPercent)}%` }" />
            </div>
            <div class="token-meter__pop-stats">
              <div>
                <small>{{ __t('ui.chat', '现用') }}</small>
                <b>{{ tokenBudgetUsedText }}</b>
              </div>
              <span class="token-meter__pop-sep">/</span>
              <div>
                <small>{{ __t('ui.chat', '上限') }}</small>
                <b>{{ tokenBudgetMaxText }}</b>
              </div>
              <span class="token-meter__pop-unit">Token</span>
            </div>
            <p class="token-meter__pop-note">{{ tokenBudgetStatusNote }}</p>
          </div>
        </div>
      </div>
      <div class="deck-actions">
        <button
          v-if="!isGroupChannel"
          class="record-btn"
          :class="{ 'is-recording': isRecording }"
          type="button"
          :disabled="
            disabled ||
            isTranscribing ||
            startingVoice ||
            preparingRecording ||
            (!isRecording &&
              !nativeAudioAvailable &&
              !asrAvailable &&
              Boolean(threadStore.threadId))
          "
          :aria-pressed="isRecording"
          :aria-label="
            isRecording
              ? __t('ui.audio-input', '停止录音')
              : preferredRecordingMode === 'native'
                ? __t('ui.audio-input', '录制原音')
                : __t('ui.audio-input', '语音转文字')
          "
          :title="
            isRecording
              ? __t('ui.audio-input', '停止录音')
              : preferredRecordingMode === 'native'
                ? __t('ui.audio-input', '录制原音')
                : __t('ui.audio-input', '语音转文字')
          "
          @click="isRecording ? capture.pttUp() : startRecording('auto')"
        >
          <PixelIcon :name="isRecording ? 'square' : 'mic'" size="sm" />
        </button>
        <button
          v-if="isSending && !isGroupChannel"
          type="button"
          class="stop-btn"
          :aria-label="__t('ui.chat', '停止生成')"
          :title="__t('ui.chat', '停止生成')"
          @click="emit('stop')"
        >
          <i class="stop-btn-mark" aria-hidden="true" />
          <span class="action-label">{{ __t('ui.chat', '停止') }}</span>
        </button>
        <button
          v-if="!isSending || queueEnabled"
          type="button"
          class="send-btn"
          :class="{ 'send-btn--queue': queueAction }"
          :aria-label="sendActionLabel"
          :title="sendActionLabel"
          :aria-busy="submitting || submissionBusy"
          :disabled="
            disabled ||
            voiceBusy ||
            startingVoice ||
            (isSending && !queueEnabled) ||
            submitting ||
            submissionBusy ||
            modelSettingsBusy ||
            skillSettingsBusy ||
            modeSaving ||
            hasUploading ||
            (!inputText.trim() && !successfulAttachments.length)
          "
          @click="send"
        >
          <PixelIcon
            :name="submitting || submissionBusy ? 'refresh' : queueAction ? 'list' : 'send'"
            :animation="submitting || submissionBusy ? 'spin' : undefined"
            size="sm"
            aria-hidden="true"
          />
          <span class="action-label">{{ sendActionLabel }}</span>
        </button>
      </div>
    </div>

    <Transition name="motion-pop">
      <div v-if="commandOpen" class="deck-popover command-popover">
        <input v-model="commandQuery" autofocus :placeholder="__t('ui.chat', '搜索命令…')" />
        <button
          v-for="command in filteredCommands"
          :key="command.id"
          @click="executeCommand(command.id)"
        >
          <strong>/ {{ command.label }}</strong>
          <span>{{ command.hint }}</span>
        </button>
        <p v-if="!filteredCommands.length">{{ __t('ui.chat', '没有匹配的命令') }}</p>
      </div>
    </Transition>

    <Transition name="motion-pop">
      <div v-if="flowOpen" class="deck-popover flow-popover">
        <header class="flow-panel__head">
          <div class="flow-panel__title">
            <span class="flow-panel__emblem" aria-hidden="true">
              <PixelIcon name="thought" size="xs" />
            </span>
            <strong>{{ __t('ui.chat', '会话心流') }}</strong>
          </div>
          <div class="flow-panel__actions">
            <button
              type="button"
              :title="__t('ui.chat', '刷新心流')"
              :aria-label="__t('ui.chat', '刷新心流')"
              :disabled="flowLoading"
              @click="loadFlowState"
            >
              <PixelIcon name="refresh" size="xs" :animation="flowLoading ? 'spin' : undefined" />
            </button>
            <button
              type="button"
              :title="__t('ui.chat', '收起心流')"
              :aria-label="__t('ui.chat', '收起心流')"
              @click="flowOpen = false"
            >
              <PixelIcon name="chevron-down" size="xs" />
            </button>
          </div>
        </header>

        <div class="flow-panel__body settings-scrollbar">
          <div v-if="flowLoading && !flowStates.length" class="flow-panel__empty">
            <span class="flow-panel__empty-icon" aria-hidden="true">
              <PixelIcon name="refresh" size="sm" animation="spin" />
            </span>
            <span>{{ __t('ui.chat', '正在读取心流…') }}</span>
          </div>
          <div v-else-if="!flowStates.length" class="flow-panel__empty">
            <span class="flow-panel__empty-icon" aria-hidden="true">
              <PixelIcon name="thought" size="sm" />
            </span>
            <span>{{ __t('ui.chat', '当前会话还没有心流') }}</span>
          </div>
          <article v-for="state in flowStates" v-else :key="state.agentId" class="flow-state-card">
            <header class="flow-state-card__head">
              <div class="flow-state-card__agent">
                <span class="flow-state-card__agent-icon" aria-hidden="true">
                  <PixelIcon name="bot" size="xs" />
                </span>
                <strong>
                  {{
                    agentStore.agents.find((agent) => agent.id === state.agentId)?.name ??
                    state.agentId
                  }}
                </strong>
              </div>
              <time class="flow-state-card__time">
                {{
                  state.updatedAt
                    ? __t('ui.chat', '更新于 {0}', [state.updatedAt])
                    : __t('ui.chat', '尚未更新')
                }}
              </time>
            </header>

            <div class="flow-state-card__sections">
              <section class="flow-state-card__block flow-state-card__block--goal">
                <small>
                  <PixelIcon name="sparkle" size="xs" />
                  <span>{{ __t('ui.chat', '当前目标') }}</span>
                </small>
                <p :class="{ 'is-placeholder': !state.currentGoal }">
                  {{ state.currentGoal || __t('ui.chat', '暂无明确的持续目标。') }}
                </p>
              </section>

              <section class="flow-state-card__block flow-state-card__block--private">
                <small>
                  <PixelIcon name="key" size="xs" />
                  <span>{{ __t('ui.chat', '私有事实') }}</span>
                </small>
                <p :class="{ 'is-placeholder': !state.privateFacts }">
                  {{ state.privateFacts || __t('ui.chat', '暂无需要私下持续记住的事实。') }}
                </p>
              </section>
            </div>

            <footer class="flow-state-card__foot">
              <button
                type="button"
                class="flow-state-card__clear"
                :disabled="flowClearing || (!state.currentGoal && !state.privateFacts)"
                @click="clearFlowState(state.agentId)"
              >
                <PixelIcon name="trash" size="xs" />
                <span>{{ __t('ui.chat', '清空') }}</span>
              </button>
            </footer>
          </article>
        </div>

        <p class="flow-panel__notice">
          <PixelIcon name="info" size="xs" />
          <span>{{ __t('ui.chat', '仅用于当前会话，不存入长期记忆。') }}</span>
        </p>
      </div>
    </Transition>

    <Transition name="motion-pop">
      <div v-if="toolOpen" class="deck-popover tool-popover">
        <header class="tool-manager__head">
          <div>
            <strong>{{ __t('ui.chat', '本会话工具') }}</strong>
            <span>
              {{ channelLabel }} ·
              {{
                threadStore.interactionMode === 'minimal'
                  ? __t('ui.chat', '极简模式')
                  : threadStore.interactionMode === 'chat'
                    ? __t('ui.chat', '聊天模式')
                    : __t('ui.chat', '工作模式')
              }}
            </span>
          </div>
          <b>{{ enabledToolCount }}/{{ availableToolCount }} {{ __t('ui.chat', '启用') }}</b>
        </header>
        <p class="tool-manager__notice">
          {{ __t('ui.chat', '仅影响本会话；系统必需项不可关闭。') }}
        </p>
        <label class="tool-manager__search">
          <PixelIcon name="search" size="xs" />
          <input v-model="toolQuery" :placeholder="__t('ui.chat', '搜索功能名称或用途…')" />
        </label>
        <div class="tool-manager__list">
          <div v-if="toolsLoading" class="tool-manager__empty">
            <PixelIcon name="refresh" size="xs" animation="spin" />
            {{ __t('ui.chat', '正在加载工具权限…') }}
          </div>
          <button
            v-for="tool in visibleThreadTools"
            v-else
            :key="tool.name"
            class="tool-manager__item"
            :class="{
              'is-enabled': tool.enabled,
              'is-locked': tool.locked,
              'is-mode-blocked': !tool.modeAllowed,
            }"
            :disabled="toolsSaving || isSending || !tool.modeAllowed"
            @click="toggleThreadTool(tool)"
          >
            <span class="tool-manager__icon" :style="{ color: toolDisplayColor(tool.display) }">
              <PixelIcon :name="toolDisplayIcon(tool.display)" size="xs" />
            </span>
            <span class="tool-manager__meta">
              <strong>{{ tool.label }}</strong>
              <small>
                {{ tool.description }}
              </small>
              <span class="tool-manager__tooltip" role="tooltip">
                <b>{{ tool.label }}</b>
                <span>
                  {{ tool.description || __t('ui.chat', '暂无工具介绍') }}
                </span>
              </span>
            </span>
            <span v-if="!tool.modeAllowed" class="tool-manager__protocol">
              {{ __t('ui.chat', '模式未开放') }}
            </span>
            <span v-else-if="tool.locked" class="tool-manager__protocol">
              {{ __t('ui.chat', '系统必需') }}
            </span>
            <span
              v-else
              class="tool-manager__switch"
              :aria-label="tool.enabled ? __t('ui.chat', '已启用') : __t('ui.chat', '已禁用')"
            >
              <i />
            </span>
          </button>
          <div v-if="!toolsLoading && !visibleThreadTools.length" class="tool-manager__empty">
            {{ __t('ui.chat', '当前会话没有匹配的功能。') }}
          </div>
        </div>
        <footer v-if="isSending">{{ __t('ui.chat', '助手工作期间暂不能修改功能设置') }}</footer>
      </div>
    </Transition>

    <input ref="fileInputRef" hidden type="file" multiple @change="handleFiles" />
  </div>
</template>

<style scoped src="./input-bar-choices.css"></style>
<style scoped>
.record-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-surface);
  color: var(--ui-text-secondary);
  cursor: pointer;
}
.record-btn:hover:not(:disabled) {
  color: var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
  border-color: var(--ui-accent-sky);
}
.record-btn.is-recording {
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  border-color: var(--ui-danger);
}
.record-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.record-btn:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 3px;
}
.attachment-card--audio {
  width: min(360px, 100%);
  min-width: 0;
  align-items: flex-start;
}
.attachment-audio {
  display: grid;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.attachment-audio__mode {
  font: 11px/1.6 var(--ui-font-sans);
  color: var(--ui-text-tertiary);
}
@media (max-width: 640px) {
  .record-btn {
    width: 42px;
    height: 42px;
  }
}
</style>
<style scoped>
.deck {
  position: relative;
  background: var(--app-panel-fill, var(--ui-bg-surface));
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  box-shadow: var(--ui-shadow-md);
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.deck--file-dragging {
  outline: 2px solid var(--ui-accent-cyan);
  outline-offset: -2px;
}
.attachment-info .attachment-reference {
  color: var(--ui-text-tertiary);
}
.deck:focus-within,
.deck--sending {
  border-color: var(--ui-accent-primary);
  box-shadow: var(--ui-shadow-md), var(--ui-glow-pink);
}
.deck-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  overflow-x: auto;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
  white-space: nowrap;
}
.deck-brand {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 5px;
  color: var(--ui-success);
  font: 800 9px var(--font-mono);
}

/* ── 硬朗分仓晶环 Token 容量指示器 + 悬停详情卡片 ── */
.token-meter {
  --token-accent: var(--ui-accent-sky);
  --token-soft: var(--ui-accent-sky-soft);
  --token-track: rgba(15, 23, 42, 0.14);
  --token-cavity: #f6f7fb;
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0;
  height: 30px;
  padding: 0;
  border: 1px solid var(--mech-border, var(--ui-border-default));
  border-radius: 0;
  background: var(--mech-bg, var(--ui-bg-surface));
  box-shadow: var(--mech-shadow, none);
  color: var(--ui-text-secondary);
  font: 700 10.5px/1 var(--ui-font-mono);
  font-variant-numeric: tabular-nums;
  cursor: default;
  user-select: none;
  outline: none;
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard);
}
[data-theme='dark'] .token-meter {
  --token-track: rgba(255, 255, 255, 0.14);
  --token-cavity: #141720;
}
.token-meter--idle {
  --token-accent: var(--ui-text-tertiary);
  --token-soft: transparent;
}
.token-meter--warn {
  --token-accent: var(--ui-warning);
  --token-soft: var(--ui-warning-soft);
  border-color: color-mix(in srgb, var(--ui-warning) 44%, var(--ui-border-default));
}
.token-meter--danger {
  --token-accent: var(--ui-danger);
  --token-soft: var(--ui-danger-soft);
  border-color: color-mix(in srgb, var(--ui-danger) 50%, var(--ui-border-default));
}
.token-meter:hover,
.token-meter:focus-visible {
  border-color: var(--token-accent);
  background: color-mix(in srgb, var(--token-accent) 7%, var(--mech-bg, var(--ui-bg-surface)));
}
.token-meter__emblem {
  display: grid;
  flex: 0 0 28px;
  align-self: stretch;
  place-items: center;
  border-right: 1px solid var(--mech-divider, var(--ui-border-subtle));
  background: color-mix(in srgb, var(--token-accent) 6%, transparent);
}
/* 八角切角像素晶环：顺时针扇形表示“已占用容量”，空槽表示剩余空间 */
.token-meter__gauge {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  background: conic-gradient(
    from 0deg,
    var(--token-accent) 0deg var(--token-deg, 0deg),
    var(--token-track) var(--token-deg, 0deg) 360deg
  );
  clip-path: polygon(
    3px 0,
    calc(100% - 3px) 0,
    100% 3px,
    100% calc(100% - 3px),
    calc(100% - 3px) 100%,
    3px 100%,
    0 calc(100% - 3px),
    0 3px
  );
}
.token-meter__gauge::before {
  content: '';
  position: absolute;
  inset: 3px;
  background: var(--token-cavity);
  clip-path: polygon(
    2px 0,
    calc(100% - 2px) 0,
    100% 2px,
    100% calc(100% - 2px),
    calc(100% - 2px) 100%,
    2px 100%,
    0 calc(100% - 2px),
    0 2px
  );
}
.token-meter__core {
  position: relative;
  z-index: 1;
  display: block;
  width: 2px;
  height: 2px;
  background: var(--token-accent);
  opacity: 0.85;
}
.token-meter--idle .token-meter__core {
  opacity: 0.4;
}
.token-meter.is-running .token-meter__core {
  animation: token-core-pulse 1.1s ease-in-out infinite;
}
@keyframes token-core-pulse {
  50% {
    opacity: 0.25;
    transform: scale(1.35);
  }
}
.token-meter__percent {
  padding: 0 8px;
  color: var(--token-accent);
  letter-spacing: 0.01em;
}
.token-meter--normal .token-meter__percent {
  color: var(--ui-text-secondary);
}
.token-meter:hover .token-meter__percent,
.token-meter:focus-visible .token-meter__percent {
  color: var(--token-accent);
}
.token-meter__popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 9px);
  z-index: 35;
  width: 224px;
  padding: 10px 11px;
  border: 1px solid var(--ui-border-strong);
  border-top: 2px solid var(--token-accent);
  border-radius: 0;
  background: var(--ui-bg-elevated);
  box-shadow: var(--ui-shadow-lg);
  color: var(--ui-text-primary);
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  pointer-events: none;
  transition:
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-emphasized),
    visibility var(--ui-duration-fast);
}
[data-theme='dark'] .token-meter__popover {
  background: #171a25;
}
.token-meter:hover .token-meter__popover,
.token-meter:focus-visible .token-meter__popover {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
.token-meter__pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
}
.token-meter__pop-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-secondary);
  font: 700 11px/1.2 var(--ui-font-pixel);
}
.token-meter__pop-title :deep(.pixel-icon) {
  color: var(--token-accent);
}
.token-meter__pop-pct {
  color: var(--token-accent);
  font: 800 12px/1 var(--ui-font-mono);
}
.token-meter__pop-bar {
  height: 5px;
  margin-bottom: 8px;
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  background: color-mix(in srgb, var(--ui-bg-canvas) 80%, transparent);
}
.token-meter__pop-bar > i {
  display: block;
  height: 100%;
  background: var(--token-accent);
  transition: width var(--ui-duration-normal) var(--ui-ease-standard);
}
.token-meter__pop-stats {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
  font-family: var(--ui-font-mono);
}
.token-meter__pop-stats > div {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.token-meter__pop-stats small {
  color: var(--ui-text-tertiary);
  font: 10px/1 var(--ui-font-sans);
}
.token-meter__pop-stats b {
  color: var(--ui-text-primary);
  font-size: 11.5px;
  font-weight: 700;
}
.token-meter__pop-sep {
  color: var(--ui-text-disabled);
  font-size: 11px;
}
.token-meter__pop-unit {
  margin-left: auto;
  color: var(--ui-text-tertiary);
  font-size: 9.5px;
}
.token-meter__pop-note {
  margin: 6px 0 0 !important;
  color: var(--ui-text-tertiary);
  font: 10.5px/1.35 var(--ui-font-sans);
}
.deck-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 2px;
  color: var(--ui-success);
  font: 800 9px var(--font-mono);
}
.deck-flow-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border: 1px solid var(--ui-accent-purple);
  border-radius: 2px;
  background: transparent;
  color: var(--ui-accent-purple);
  font: 800 9px var(--font-mono);
  cursor: pointer;
}
.deck-flow-chip:hover,
.deck-flow-chip.active {
  background: var(--ui-accent-purple-soft);
  box-shadow: 2px 2px 0 color-mix(in srgb, var(--ui-accent-purple) 18%, transparent);
}
.deck-chip.off {
  color: var(--ui-text-disabled);
}
.deck-chip.active {
  color: var(--ui-accent-primary);
  animation: pulse 1s infinite;
}
.deck textarea {
  display: block;
  width: 100%;
  min-height: 60px;
  max-height: 180px;
  padding: 14px 16px;
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ui-text-primary);
  font: 500 14px/1.6 var(--font-sans);
}
/* ── @ 提及：输入区叠加层（group 模式） ── */
.deck-text-area {
  position: relative;
}
.deck-text-overlay {
  position: absolute;
  inset: 0;
  padding: 14px 16px;
  overflow: hidden;
  pointer-events: none;
  color: var(--ui-text-primary);
  font: 500 14px/1.6 var(--font-sans);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 文字透明 + 光标可见 + 隐藏滚动条，保证与 overlay 宽度/换行一致 */
.deck-textarea-transparent {
  color: transparent;
  caret-color: var(--ui-text-primary);
  scrollbar-width: none;
  word-break: break-word;
}
.deck-textarea-transparent::-webkit-scrollbar {
  display: none;
}
.deck-textarea-transparent::placeholder {
  color: var(--ui-text-disabled);
}
.mention-chip-inline {
  display: inline;
  padding: 1px 4px;
  margin: 0 1px;
  border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 40%, transparent);
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
  font-weight: 800;
}
.mention-popover {
  left: 10px;
  bottom: 48px;
  max-height: 240px;
  overflow-y: auto;
  z-index: 30;
}
.mention-popover button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: transparent;
  color: var(--ui-text-primary);
  text-align: left;
  font-size: 12px;
}
.mention-popover button:hover,
.mention-popover button.active {
  background: var(--ui-bg-hover);
}
.mention-popover small {
  margin-left: auto;
  font-size: 9px;
  color: var(--ui-text-tertiary);
}
.mention-avatar {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
  overflow: hidden;
}
.mention-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mention-empty {
  margin: 0;
  padding: 8px;
  font-size: 10px;
  color: var(--ui-text-tertiary);
}
.attachment-info .attachment-error {
  color: var(--ui-danger);
  white-space: normal;
  font-size: 10px;
}
.attachment-list {
  display: flex;
  gap: 8px;
  padding: 10px;
  overflow-x: auto;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.attachment-card {
  position: relative;
  display: grid;
  grid-template-columns: 42px minmax(110px, 180px) 20px;
  align-items: center;
  gap: 8px;
  padding: 7px;
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-subtle);
  border-radius: 4px;
}
.attachment-card--image {
  display: block;
  width: 84px;
  height: 84px;
  flex: 0 0 84px;
  padding: 4px;
  background:
    linear-gradient(var(--ui-bg-surface), var(--ui-bg-surface)) padding-box,
    linear-gradient(135deg, var(--ui-accent-sky), var(--ui-accent-purple), var(--ui-accent-primary))
      border-box;
  border: 2px solid transparent;
  border-radius: 12px 5px 12px 5px;
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--ui-accent-sky) 20%, transparent);
  transform: rotate(-0.5deg);
}
.attachment-card img {
  width: 42px;
  height: 42px;
  object-fit: cover;
}
.attachment-card--image img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 8px 3px 8px 3px;
}
.attachment-info {
  min-width: 0;
}
.attachment-info strong,
.attachment-info span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachment-info strong {
  font-size: 11px;
  color: var(--ui-text-primary);
}
.attachment-info span {
  font-size: 9px;
  color: var(--ui-text-tertiary);
}
button {
  cursor: pointer;
}
.attachment-card button {
  border: 0;
  background: none;
  color: var(--ui-text-tertiary);
}
.attachment-card--image button {
  position: absolute;
  top: -7px;
  right: -7px;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 42%, var(--ui-border-default));
  border-radius: 50%;
  background: var(--ui-bg-elevated);
  box-shadow: 0 3px 8px color-mix(in srgb, var(--ui-accent-purple) 20%, transparent);
  color: var(--ui-text-primary);
}
.attachment-image-state {
  position: absolute;
  right: 7px;
  bottom: 7px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--ui-bg-surface);
  border-radius: 50%;
  background: var(--ui-success, #4cc38a);
  box-shadow: 0 2px 6px color-mix(in srgb, var(--ui-text-primary) 25%, transparent);
}
.attachment-image-state--uploading,
.attachment-image-state--checking {
  background: var(--ui-accent-sky);
  animation: attachment-state-pulse 0.9s ease-in-out infinite alternate;
}
.attachment-image-state--failed {
  background: var(--ui-danger, #ef5b72);
}
@keyframes attachment-state-pulse {
  to {
    opacity: 0.45;
    transform: scale(0.72);
  }
}
.deck-footer {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 6px;
  border-top: 1px solid var(--ui-border-subtle);
}
.deck-tools {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.deck-telemetry {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
/* 硬朗哑光机械键基础形态（分仓与阴影变量由 input-toolbar.css 统一提供） */
.deck-footer :deep(.input-tool-trigger) {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 30px;
  height: 30px;
  min-height: 30px;
  margin: 0;
  padding: 0 9px;
  border: 1px solid var(--mech-border, var(--ui-border-default));
  border-radius: 0;
  background: var(--mech-bg, var(--ui-bg-surface));
  color: var(--ui-text-secondary);
  box-shadow: var(--mech-shadow, none);
  font: 11px/1 var(--ui-font-pixel);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color 140ms ease,
    background-color 140ms ease,
    border-color 140ms ease;
}
.deck-footer :deep(.input-tool-trigger:hover:not(:disabled)),
.deck-footer :deep(.input-tool-trigger.is-open) {
  background: color-mix(
    in srgb,
    var(--ui-accent-primary) 7%,
    var(--mech-bg, var(--ui-bg-surface))
  );
  border-color: var(--ui-accent-primary);
  color: var(--ui-accent-primary);
}
.deck-footer :deep(.input-tool-trigger:active:not(:disabled)) {
  transform: translate(1px, 1px);
  box-shadow: var(--mech-shadow-active, none);
}
.deck-footer :deep(.input-tool-trigger:disabled) {
  cursor: not-allowed;
  opacity: 0.45;
}
.deck-footer :deep(.input-tool-trigger:focus-visible) {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 2px;
}
.deck-footer :deep(.input-tool-trigger .pixel-icon) {
  flex: 0 0 auto;
}
.deck--compact .deck-footer :deep(.input-tool-trigger),
.deck-tools .deck-add-file {
  width: 30px;
  min-width: 30px;
  padding: 0;
}
@media (prefers-reduced-motion: reduce) {
  .deck-footer :deep(.input-tool-trigger),
  .token-meter,
  .token-meter__popover,
  .token-meter__pop-bar > i {
    transition: none;
  }
  .token-meter.is-running .token-meter__core {
    animation: none;
  }
}
[data-motion='off'] .deck-footer :deep(.input-tool-trigger),
[data-motion='reduced'] .deck-footer :deep(.input-tool-trigger),
[data-motion='off'] .token-meter,
[data-motion='reduced'] .token-meter,
[data-motion='off'] .token-meter__popover,
[data-motion='reduced'] .token-meter__popover,
[data-motion='off'] .token-meter__pop-bar > i,
[data-motion='reduced'] .token-meter__pop-bar > i {
  transition: none;
}
[data-motion='off'] .token-meter.is-running .token-meter__core,
[data-motion='reduced'] .token-meter.is-running .token-meter__core {
  animation: none;
}
.stop-btn,
.send-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  min-height: 30px;
  padding: 0 11px;
  white-space: nowrap;
  background: var(--mech-bg, var(--ui-bg-surface));
  color: var(--ui-text-secondary);
  border: 1px solid var(--mech-border, var(--ui-border-default));
  border-radius: 0;
  font-size: 11px;
  font-weight: 600;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
/* 据点群聊的 @ 提及按钮：哑光机械底座 + 品牌色 @ 符号 */
.group-footer-tools {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}
.mention-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  min-height: 30px;
  padding: 0 10px;
  white-space: nowrap;
  background: var(--mech-bg, var(--ui-bg-surface));
  color: var(--ui-text-secondary);
  border: 1px solid var(--mech-border, var(--ui-border-default));
  border-radius: 0;
  box-shadow: var(--mech-shadow, none);
  font: 11px/1 var(--ui-font-pixel);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard);
}
.mention-btn:hover:not(:disabled) {
  background: color-mix(
    in srgb,
    var(--ui-accent-primary) 7%,
    var(--mech-bg, var(--ui-bg-surface))
  );
  border-color: var(--ui-accent-primary);
  color: var(--ui-accent-primary);
}
.mention-btn:active:not(:disabled) {
  transform: translate(1px, 1px);
  box-shadow: var(--mech-shadow-active, none);
}
.mention-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.mention-btn-at {
  color: var(--ui-accent-primary);
  font-family: var(--font-pixel), monospace;
  font-size: 12px;
  line-height: 1;
}
.deck-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
/* 普通对话已有 flex:1 工具轨与右侧状态组，操作组紧贴其右侧 */
.deck-telemetry + .deck-actions {
  margin-left: 0;
}
.deck-actions > button {
  min-height: 30px;
  height: 30px;
  gap: 6px;
  padding: 0 11px;
  border-radius: 0;
  font-family: var(--ui-font-pixel);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.deck-actions > .record-btn {
  width: 30px;
  min-width: 30px;
  padding: 0;
  border: 1px solid var(--mech-border, var(--ui-border-default));
  background: var(--mech-bg, var(--ui-bg-surface));
  color: var(--ui-text-secondary);
  box-shadow: var(--mech-shadow, none);
}
.deck-actions > .record-btn:hover:not(:disabled) {
  border-color: var(--ui-accent-sky);
  background: color-mix(in srgb, var(--ui-accent-sky) 7%, var(--mech-bg, var(--ui-bg-surface)));
  color: var(--ui-accent-sky);
}
.deck-actions > .record-btn.is-recording {
  border-color: var(--ui-danger);
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
}
.deck-actions > button:active:not(:disabled) {
  transform: translate(1px, 1px);
  box-shadow: var(--mech-shadow-active, none);
}
.deck-actions > button:focus-visible {
  outline: 2px solid var(--ui-focus-color);
  outline-offset: 2px;
}
.deck-actions :deep(.pixel-icon) {
  flex-shrink: 0;
}
.send-btn {
  --ui-focus-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
  color: var(--ui-text-inverse);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    2px 2px 0 var(--mech-step, rgba(0, 0, 0, 0.28));
}
.send-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent-primary) 88%, var(--ui-text-primary));
  border-color: var(--ui-accent-primary);
}
.send-btn--queue {
  background: var(--mech-bg, var(--ui-bg-surface));
  border-color: color-mix(in srgb, var(--ui-accent-primary) 42%, var(--ui-border-default));
  color: var(--ui-accent-primary);
  box-shadow: var(--mech-shadow, none);
}
.send-btn--queue:hover:not(:disabled) {
  background: color-mix(
    in srgb,
    var(--ui-accent-primary) 10%,
    var(--mech-bg, var(--ui-bg-surface))
  );
  border-color: var(--ui-accent-primary);
}
.deck-actions .send-btn:disabled {
  background: var(--mech-bg-soft, var(--ui-bg-surface-soft));
  border-color: var(--mech-divider, var(--ui-border-subtle));
  color: var(--ui-text-disabled);
  box-shadow: none;
  cursor: not-allowed;
}
.deck-actions .record-btn:disabled {
  background: var(--mech-bg-soft, var(--ui-bg-surface-soft));
  border-color: var(--mech-divider, var(--ui-border-subtle));
  color: var(--ui-text-disabled);
  box-shadow: none;
  opacity: 0.65;
  cursor: not-allowed;
}
.stop-btn {
  --ui-focus-color: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 42%, var(--ui-border-default));
  background: color-mix(in srgb, var(--ui-danger) 10%, var(--mech-bg, var(--ui-bg-surface)));
  color: var(--ui-danger);
  box-shadow: var(--mech-shadow, none);
}
.stop-btn:hover {
  border-color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 16%, var(--mech-bg, var(--ui-bg-surface)));
}
.stop-btn-mark {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: 1px;
  background: currentColor;
}
/* ── 会话心流展开卡片（硬朗哑光 HUD 检视器） ── */
.flow-popover {
  --flow-surface: #ffffff;
  --flow-head-bg: #f6f8fb;
  --flow-inset-bg: #eef1f6;
  --flow-border: rgba(15, 23, 42, 0.14);
  --flow-border-strong: rgba(15, 23, 42, 0.24);
  --flow-key-bg: #ffffff;
  --flow-key-hover: #f2f5fa;
  --flow-step-shadow: rgba(15, 23, 42, 0.08);

  --motion-origin: bottom right;
  right: 10px;
  width: min(440px, calc(100% - 20px));
  padding: 0;
  overflow: hidden;
  border-radius: 0;
  border: 1px solid var(--flow-border-strong);
  border-top: 2px solid var(--ui-accent-purple);
  background: var(--flow-surface);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    4px 4px 0 rgba(15, 23, 42, 0.12),
    0 16px 36px rgba(15, 23, 42, 0.16);
}

[data-theme='dark'] .flow-popover {
  --flow-surface: #161922;
  --flow-head-bg: #12151e;
  --flow-inset-bg: #0d1017;
  --flow-border: rgba(255, 255, 255, 0.11);
  --flow-border-strong: rgba(255, 255, 255, 0.22);
  --flow-key-bg: #181b24;
  --flow-key-hover: #202533;
  --flow-step-shadow: rgba(0, 0, 0, 0.46);

  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    4px 4px 0 rgba(0, 0, 0, 0.52),
    0 18px 42px rgba(0, 0, 0, 0.56);
}

.flow-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--flow-border);
  background: var(--flow-head-bg);
}

.flow-panel__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.flow-panel__emblem {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border: 1px solid var(--flow-border);
  border-left: 2px solid var(--ui-accent-purple);
  background: color-mix(in srgb, var(--ui-accent-purple) 8%, var(--flow-inset-bg));
  color: var(--ui-accent-purple);
}

.flow-panel__head strong {
  color: var(--ui-text-primary);
  font: 800 12.5px/1 var(--ui-font-pixel);
  letter-spacing: 0.03em;
}

.flow-panel__actions {
  display: flex;
  align-items: center;
  gap: 5px;
}

.flow-panel__actions > button {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid var(--flow-border);
  border-radius: 0;
  background: var(--flow-key-bg);
  box-shadow: 1px 1px 0 var(--flow-step-shadow);
  color: var(--ui-text-secondary);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.flow-panel__actions > button:hover:not(:disabled) {
  border-color: var(--flow-border-strong);
  background: var(--flow-key-hover);
  color: var(--ui-text-primary);
}

.flow-panel__actions > button:active:not(:disabled) {
  transform: translate(1px, 1px);
  box-shadow: none;
}

.flow-panel__actions > button:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 1px;
}

.flow-panel__actions > button:disabled {
  opacity: 0.45;
  cursor: default;
}

.flow-panel__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(420px, 58vh);
  overflow-y: auto;
  padding: 12px;
}

.flow-panel__empty {
  display: flex;
  flex-direction: column;
  min-height: 112px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 18px 14px;
  border: 1px solid var(--flow-border);
  background-color: var(--flow-inset-bg);
  background-image: radial-gradient(
    color-mix(in srgb, var(--ui-text-primary) 8%, transparent) 1px,
    transparent 1px
  );
  background-size: 12px 12px;
  color: var(--ui-text-tertiary);
  font-size: 12px;
}

.flow-panel__empty-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--flow-border);
  background: var(--flow-surface);
  color: var(--ui-text-tertiary);
}

.flow-state-card {
  border: 1px solid var(--flow-border);
  background: var(--flow-surface);
  box-shadow: 2px 2px 0 var(--flow-step-shadow);
}

.flow-state-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  border-bottom: 1px solid var(--flow-border);
  background: var(--flow-head-bg);
}

.flow-state-card__agent {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.flow-state-card__agent-icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: 1px solid var(--flow-border);
  background: var(--flow-inset-bg);
  color: var(--ui-accent-purple);
}

.flow-state-card__agent strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-primary);
  font: 700 12px/1.2 var(--ui-font-pixel);
}

.flow-state-card__time {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
  font: 500 11px/1 var(--ui-font-mono);
  font-variant-numeric: tabular-nums;
}

.flow-state-card__sections {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

.flow-state-card__block {
  padding: 9px 11px;
  border: 1px solid var(--flow-border);
  border-left: 2px solid var(--ui-accent-sky);
  background: var(--flow-inset-bg);
}

.flow-state-card__block--private {
  border-left-color: var(--ui-accent-purple);
}

.flow-state-card__block small {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 6px;
  color: var(--ui-accent-sky);
  font: 700 11px/1.2 var(--ui-font-pixel);
  letter-spacing: 0.03em;
}

.flow-state-card__block--private small {
  color: var(--ui-accent-purple);
}

.flow-state-card__block p {
  max-height: 132px;
  margin: 0;
  overflow: auto;
  color: var(--ui-text-primary);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.flow-state-card__block p.is-placeholder {
  color: var(--ui-text-tertiary);
  font-size: 12px;
}

.flow-state-card__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 7px 10px;
  border-top: 1px solid var(--flow-border);
  background: var(--flow-head-bg);
}

.flow-state-card__clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--flow-border);
  border-radius: 0;
  background: var(--flow-key-bg);
  color: var(--ui-text-secondary);
  font: 600 11px/1 var(--ui-font-pixel);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.flow-state-card__clear:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ui-danger) 55%, var(--flow-border-strong));
  background: color-mix(in srgb, var(--ui-danger) 10%, var(--flow-key-bg));
  color: var(--ui-danger);
}

.flow-state-card__clear:disabled {
  opacity: 0.42;
  cursor: default;
}

.flow-panel__notice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--flow-border);
  background: var(--flow-head-bg);
  color: var(--ui-text-tertiary);
  font-size: 11px;
  line-height: 1.4;
}

.deck-popover {
  /* 自输入栏向上弹出 */
  --motion-origin: bottom left;
  --motion-pop-direction: 1;
  position: absolute;
  z-index: 20;
  bottom: 52px;
  width: min(360px, calc(100% - 20px));
  padding: 8px;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  box-shadow: var(--ui-shadow-lg);
}
.command-popover {
  left: 10px;
  /* 命令多、窗口矮时内部滚动，否则顶上的搜索框会顶出窗口。 */
  max-height: min(520px, 70vh);
  overflow-y: auto;
}
.command-popover input {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
  outline: none;
  caret-color: var(--ui-accent-primary);
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.command-popover input:focus {
  border-color: var(--ui-accent-primary);
  box-shadow: 0 0 0 2px var(--ui-accent-primary-soft);
}
.command-popover button {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 8px;
  border: 0;
  border-bottom: 1px solid var(--ui-border-subtle);
  text-align: left;
  background: transparent;
  color: var(--ui-text-primary);
}
.command-popover button:hover {
  background: var(--ui-bg-hover);
}
.command-popover span,
.deck-popover p {
  font-size: 10px;
  color: var(--ui-text-tertiary);
}
.tool-count {
  margin-left: 1px;
  padding-left: 6px;
  border-left: 1px solid var(--mech-divider, var(--ui-border-subtle));
  color: var(--ui-text-tertiary);
  font: 700 9.5px/1 var(--ui-font-mono);
}
.tool-popover {
  display: flex;
  flex-direction: column;
  left: 10px;
  width: min(430px, calc(100% - 20px));
  max-height: min(520px, 70vh);
  overflow: hidden;
  padding: 0;
  border-radius: 2px;
}
.tool-manager__head {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}
.tool-manager__head div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tool-manager__head strong {
  color: var(--ui-text-primary);
  font-size: 11px;
}
.tool-manager__head span {
  color: var(--ui-text-tertiary);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.tool-manager__head b {
  color: var(--ui-accent-primary);
  font: 800 9px var(--ui-font-mono);
}
.tool-manager__head,
.tool-manager__notice,
.tool-manager__search,
.tool-popover > footer {
  flex-shrink: 0;
}
.tool-manager__notice {
  margin: 0 !important;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
  line-height: 1.5;
}
.tool-manager__search {
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border-bottom: 1px solid var(--ui-border-default);
  color: var(--ui-text-tertiary);
}
.tool-manager__search:focus-within {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary);
}
.tool-manager__search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ui-text-primary);
  font-size: 10px;
}
.tool-manager__list {
  min-height: 0;
  max-height: 350px;
  overflow: auto;
}
.tool-manager__item {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 48px;
  grid-template-columns: 30px minmax(0, 1fr) 34px;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border: 0;
  border-bottom: 1px solid var(--ui-border-subtle);
  border-left: 2px solid transparent;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.tool-manager__item:hover {
  border-left-color: var(--ui-text-disabled);
  background: var(--ui-bg-hover);
}
.tool-manager__item.is-enabled {
  border-left-color: var(--ui-accent-primary);
}
.tool-manager__item.is-mode-blocked:disabled {
  opacity: 0.65;
}
.tool-manager__item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.tool-manager__icon {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid currentColor;
}
.tool-manager__meta {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.tool-manager__meta strong {
  color: var(--ui-text-primary);
  font-size: 10px;
}
.tool-manager__meta small {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font-size: 9px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-manager__tooltip {
  display: none;
  margin-top: 5px;
  padding: 7px 8px;
  border: 1px solid var(--ui-border-default);
  border-left: 2px solid var(--ui-accent-primary);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-secondary);
  font-size: 9px;
  line-height: 1.55;
  white-space: normal;
}
.tool-manager__tooltip b {
  display: block;
  margin-bottom: 3px;
  color: var(--ui-text-primary);
  font-size: 9px;
}
.tool-manager__tooltip span {
  display: block;
}
.tool-manager__item:hover .tool-manager__tooltip,
.tool-manager__item:focus-visible .tool-manager__tooltip {
  display: block;
}
.tool-manager__item:hover .tool-manager__meta > small,
.tool-manager__item:focus-visible .tool-manager__meta > small {
  display: none;
}
.tool-manager__item.is-locked {
  cursor: default;
  border-left-color: var(--ui-success);
}
.tool-manager__protocol {
  display: grid;
  min-width: 52px;
  height: 18px;
  padding: 0 5px;
  place-items: center;
  border: 1px solid var(--ui-success);
  color: var(--ui-success);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.06em;
}
.tool-manager__switch {
  position: relative;
  width: 30px;
  height: 16px;
  border: 1px solid var(--ui-border-strong);
  background: var(--ui-bg-surface-soft);
}
.tool-manager__switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  background: var(--ui-text-disabled);
  transition:
    transform var(--ui-duration-fast),
    background var(--ui-duration-fast);
}
.is-enabled .tool-manager__switch {
  border-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.is-enabled .tool-manager__switch i {
  background: var(--ui-accent-primary);
  transform: translateX(14px);
}
.tool-manager__empty {
  display: flex;
  min-height: 80px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 12px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.tool-popover > footer {
  min-height: 28px;
  padding: 0 9px;
  border-top: 1px solid var(--ui-warning);
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
  font: 800 8px/28px var(--ui-font-mono);
  letter-spacing: 0.06em;
}
@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}
.deck--compact .deck-status {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  overflow-x: hidden;
  scrollbar-width: none;
}
.deck--compact .deck-status::-webkit-scrollbar,
.deck--compact .deck-tools::-webkit-scrollbar {
  display: none;
}
/* 紧凑下只保留「品牌 + Agent + 工具状态」，隐藏 DESKTOP/视觉/ASR 次要状态 */
.deck--compact .deck-status .deck-chip:nth-of-type(3),
.deck--compact .deck-status .deck-chip:nth-of-type(4),
.deck--compact .deck-status .deck-chip:nth-of-type(5) {
  display: none;
}
.deck--compact .deck-status .deck-chip {
  min-width: 0;
  max-width: 132px;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}
.deck--compact .deck-status .deck-chip:last-child {
  margin-left: auto;
}
/* 紧凑模式下 footer 仍保持同一条基线，避免会话工具计数把按钮顶偏。 */
.deck--compact .deck-footer {
  align-items: center;
}
.deck--compact .deck-tools {
  align-items: center;
}
/* ── 紧凑模式：等宽图标按钮，自然换行，不拉伸、不横向滚动 ── */
.deck--compact .deck-tools {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px;
  overflow: visible;
}
.deck--compact .deck-actions > button {
  width: 30px;
  min-width: 30px;
  padding: 0;
  justify-content: center;
}
.deck--compact .deck-actions .action-label {
  display: none;
}

@media (max-width: 700px) {
  .deck-status {
    padding: 6px;
  }
  .deck-footer {
    align-items: center;
  }
  .deck-actions .action-label {
    display: none;
  }
  .deck-actions > button {
    width: 30px;
    min-width: 30px;
    padding: 0;
  }
}
[data-theme='dark'] .deck {
  background: var(--app-panel-fill, rgba(20, 23, 31, 0.94));
  border-color: var(--ui-border-default);
}
</style>

<style scoped src="./input-toolbar.css"></style>
