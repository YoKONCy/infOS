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
import { attachmentsApi, type AttachmentInfo } from '../../api/modules/attachmentsApi'
import { ApiError } from '../../api/errors'
import { configApi } from '../../api/modules/configApi'
import ThreadModelControls from './ThreadModelControls.vue'
import RuntimeDebugToggle from './RuntimeDebugToggle.vue'
import InputBarFoldout from './InputBarFoldout.vue'
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
async function loadPdfCapabilities(): Promise<void> {
  try {
    const response = await attachmentsApi.capabilities()
    pdfAvailable.value = response.data?.pdf ?? false
    maxPdfBytes.value = response.data?.maxPdfBytes ?? 0
  } catch {
    pdfAvailable.value = false
    maxPdfBytes.value = 0
  }
}
function onIntegrationsChanged(): void {
  void loadPdfCapabilities()
  if (!toolsSaving.value) void loadThreadTools()
}
const textareaRef = ref<HTMLTextAreaElement | null>(null)
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
const interactionModeOptions: Array<{
  value: InteractionMode
  label: string
  icon: string
  title: string
}> = [
  {
    value: 'minimal',
    get label() {
      return __t('ui.chat', '极简')
    },
    icon: 'leaf',
    get title() {
      return __t('ui.chat', '极简模式：仅保留日常工具')
    },
  },
  {
    value: 'chat',
    get label() {
      return __t('ui.chat', '聊天')
    },
    icon: 'chat',
    get title() {
      return __t('ui.chat', '聊天模式')
    },
  },
  {
    value: 'work',
    get label() {
      return __t('ui.chat', '工作')
    },
    icon: 'tool',
    get title() {
      return __t('ui.chat', '工作模式')
    },
  },
]
const currentInteractionMode = computed(
  () =>
    interactionModeOptions.find(
      (option) => option.value === (pendingInteractionMode.value ?? threadStore.interactionMode),
    ) ?? interactionModeOptions[1]!,
)
const interactionAccent = computed(
  () =>
    ({
      minimal: 'var(--ui-success)',
      chat: 'var(--ui-accent-primary)',
      work: 'var(--ui-accent-sky)',
    })[currentInteractionMode.value.value],
)
const debugStatus = ref({ enabled: false, busy: false })
const sessionModeMenu = ref<InstanceType<typeof InputBarFoldout> | null>(null)
const mediaInputMenu = ref<InstanceType<typeof InputBarFoldout> | null>(null)
const inputScope = computed(
  () => `${agentStore.activeAgentId}:${threadStore.threadId}:${props.channel}`,
)
const modeStatusLabel = computed(() => {
  const option = interactionModeOptions.find(
    (item) => item.value === (pendingInteractionMode.value ?? threadStore.interactionMode),
  )
  return __t('ui.chat', '{0}{1}模式', [
    modeSaving.value ? __t('ui.chat', '正在切换为') : __t('ui.chat', '当前为'),
    option?.label ?? __t('ui.chat', '聊天'),
  ])
})
const disabledToolNames = ref<string[]>([])
let toolsRequest = 0
const executionMode = computed<ExecutionMode>({
  get: () => threadStore.executionMode,
  set: (value) => {
    threadStore.executionMode = value
  },
})
const executionModeIcons: Record<ExecutionMode, string> = {
  manual: 'shield',
  auto: 'flash',
  auto_approve: 'check',
  full: 'sparkle',
}
const toolQuery = ref('')
const imageMode = ref<'auto' | 'native' | 'relay'>('auto')
const relayAvailable = ref(false)

function closeInputPopovers() {
  sessionModeMenu.value?.close()
  mediaInputMenu.value?.close()
}

function onFoldoutOpened(): void {
  commandOpen.value = false
  toolOpen.value = false
  flowOpen.value = false
}

async function selectInteractionMode(mode: InteractionMode): Promise<void> {
  if (modeSwitchDisabled.value) return
  await switchInteractionMode(mode)
  if (threadStore.interactionMode === mode) sessionModeMenu.value?.close(true)
}

async function selectAudioInput(mode: 'asr' | 'native') {
  mediaInputMenu.value?.close(true)
  recordingMode.value = mode
  await startRecording(mode)
}

/** 识图方式按钮文案：跟随当前选择实时切换。 */
const imageModeLabel = computed(() => {
  if (imageMode.value === 'native') return __t('ui.chat', '原生多模态')
  if (imageMode.value === 'relay') return __t('ui.chat', '多模态转述')
  return __t('ui.chat', '自动识图')
})

/** 选择某个识图方式后：更新模式并收起弹层。 */
function selectImageMode(mode: 'auto' | 'native' | 'relay') {
  imageMode.value = mode
  mediaInputMenu.value?.close(true)
}

const commandQuery = ref('')
const enableVision = ref(false)
const enableAudioInput = ref(false)
const nativeAudioAvailable = ref(false)
const modelSettingsBusy = ref(false)
let capabilitiesRequest = 0

function onThreadModelChanged(settings: ThreadModelSettings): void {
  if (settings.threadId !== threadStore.threadId) return
  enableVision.value = settings.effective.enableVision
  enableAudioInput.value = settings.effective.enableAudioInput
  nativeAudioAvailable.value = settings.effective.nativeAudioAvailable === true
  tokenBudget.value = null
  scheduleTokenBudgetRefresh()
  void loadCapabilities()
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

const activeAgent = computed(() => agentStore.currentAgent)
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
    toolsLoading.value ||
    toolsSaving.value ||
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
const tokenBudgetDegrees = computed(() => `${tokenBudgetRatio.value * 360}deg`)
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
  if (modeSwitchDisabled.value || threadStore.interactionMode === mode) return
  toolsSaving.value = true
  modeSaving.value = true
  pendingInteractionMode.value = mode
  let request = 0
  try {
    const threadId = await ensureThread()
    request = ++toolsRequest
    const response = await threadsApi.updateInteractionMode(threadId, mode)
    if (threadId !== threadStore.threadId) return
    request = ++toolsRequest
    if (response.data) applyThreadTools(response.data)
    scheduleTokenBudgetRefresh()
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.chat', '切换会话模式失败'), {
      type: 'error',
    })
  } finally {
    modeSaving.value = false
    pendingInteractionMode.value = null
    toolsSaving.value = false
    if (request === toolsRequest) toolsLoading.value = false
  }
}

async function changeExecutionMode(nextMode: ExecutionMode): Promise<void> {
  if (executionModeDisabled.value || nextMode === executionMode.value) return
  const threadId = threadStore.threadId
  if (!threadId) return
  const previous = executionMode.value
  ++toolsRequest
  executionMode.value = nextMode
  toolsSaving.value = true
  try {
    const response = await threadsApi.updateExecutionMode(threadId, nextMode)
    if (threadId !== threadStore.threadId) return
    ++toolsRequest
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
    if (threadId === threadStore.threadId) executionMode.value = previous
    notify.toast(error instanceof Error ? error.message : __t('ui.chat', '保存执行模式失败'), {
      type: 'error',
    })
  } finally {
    toolsSaving.value = false
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

async function loadCapabilities(): Promise<void> {
  // 据点群聊当前仅支持文本，不读取 desktop 模型和语音能力。
  if (isGroupChannel.value) return
  const threadId = threadStore.threadId
  const request = ++capabilitiesRequest
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
    relayAvailable.value =
      relayConfig['multimodalRelay.enabled'] === 'true' &&
      Boolean(relayConfig['multimodalRelay.modelConfigId'])
    asrAvailable.value = voiceRes?.data?.asr?.available === true
    enableVision.value = modelRes?.data?.effective.enableVision === true
    enableAudioInput.value = modelRes?.data?.effective.enableAudioInput === true
    nativeAudioAvailable.value = modelRes?.data?.effective.nativeAudioAvailable === true
  } catch (error) {
    logger.error('InputBar', __t('logs.frontend.chat', '读取输入能力状态失败'), error)
  }
}

watch([() => agentStore.activeAgentId, () => threadStore.threadId], loadCapabilities, {
  immediate: true,
})

function onModelCapabilitiesChanged(): void {
  void loadCapabilities()
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

async function ensureThread(): Promise<string> {
  if (!threadStore.threadId) await threadStore.createNewThread(agentStore.activeAgentId, 'desktop')
  return threadStore.threadId
}

function validateFile(file: File): 'image' | 'text' | 'pdf' | 'audio' | 'file' | null {
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    notify.toast(__t('ui.attachments', '附件不能超过 100MB'), { type: 'warning' })
    return null
  }
  return classifyAttachmentUpload(file.name, file.type, file.size)
}

async function uploadFile(file: File, signal?: AbortSignal) {
  if (props.disabled || isGroupChannel.value) return
  const version = attachmentDraftVersion,
    agentId = agentStore.activeAgentId
  const validDraft = () =>
    !signal?.aborted &&
    version === attachmentDraftVersion &&
    agentId === agentStore.activeAgentId &&
    !props.disabled
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) await loadPdfCapabilities()
  const kind = validateFile(file)
  if (!kind) return
  // 模型配置可能由设置页或其他窗口刚刚更新；上传前复核权威能力，避免使用陈旧快照。
  if (kind === 'image') await loadCapabilities()
  if (!validDraft()) return
  const referenceOnly =
    kind === 'file' ||
    (kind === 'pdf' && (!pdfAvailable.value || file.size > maxPdfBytes.value)) ||
    (kind === 'image' &&
      ((!enableVision.value && !relayAvailable.value) ||
        (imageMode.value === 'native' && !enableVision.value) ||
        (imageMode.value === 'relay' && !relayAvailable.value)))
  if (pendingAttachments.value.length >= 5) {
    notify.toast(__t('ui.chat', '每轮最多添加 5 个附件'), { type: 'warning' })
    return
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
  pendingAttachments.value.push(pending)
  try {
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
    if (
      !validDraft() ||
      threadStore.threadId !== threadId ||
      !pendingAttachments.value.some((item) => item.localKey === localKey)
    ) {
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

let uploadQueue = Promise.resolve()
function uploadFiles(files: File[]): Promise<void> {
  const version = attachmentDraftVersion,
    agentId = agentStore.activeAgentId
  const operation = uploadQueue
    .catch(() => undefined)
    .then(async () => {
      for (const file of files) {
        if (
          version !== attachmentDraftVersion ||
          agentId !== agentStore.activeAgentId ||
          props.disabled ||
          isGroupChannel.value
        )
          break
        if (pendingAttachments.value.length >= 5) {
          notify.toast(__t('ui.chat', '每轮最多添加 5 个附件'), { type: 'warning' })
          break
        }
        await uploadFile(file)
      }
    })
  uploadQueue = operation
  return operation
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
    modelSettingsBusy.value ||
    modeSaving.value ||
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
  window.addEventListener('focus', onIntegrationsChanged)
  window.addEventListener('infos:model-capabilities-changed', onModelCapabilitiesChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('infos:integrations-changed', onIntegrationsChanged)
  window.removeEventListener('focus', onIntegrationsChanged)
  window.removeEventListener('infos:model-capabilities-changed', onModelCapabilitiesChanged)
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
    <div class="deck-status">
      <span class="deck-brand">CHAR OPS</span>
      <template v-if="isGroupChannel">
        <span class="deck-chip">
          <PixelIcon name="home" size="xs" />
          {{ contextLabel }}
        </span>
        <span class="deck-chip">GROUP</span>
        <span class="deck-chip">
          <PixelIcon name="user" size="xs" />
          {{ participantLabel }}
        </span>
        <span class="deck-chip" :class="{ active: isSending }">
          {{ isSending ? __t('ui.chat', '等待角色回复') : __t('ui.chat', '群聊就绪') }}
        </span>
      </template>
      <template v-else>
        <span class="deck-chip">
          <PixelIcon name="user" size="xs" />
          {{ activeAgent?.name ?? __t('ui.chat', '角色') }}
        </span>
        <span class="deck-chip">DESKTOP</span>
        <span class="deck-chip" :class="{ off: !enableVision }">
          {{ __t('ui.chat', '视觉') }} {{ enableVision ? 'ON' : 'OFF' }}
        </span>
        <span class="deck-chip" :class="{ off: !asrAvailable }">
          ASR {{ asrAvailable ? 'READY' : 'OFF' }}
        </span>
        <span class="deck-chip" :class="{ active: isSending }">
          {{ __t('ui.chat', '工具') }} {{ isSending ? 'BUSY' : 'STANDBY' }}
        </span>
        <button
          class="deck-flow-chip"
          :class="{ active: flowOpen }"
          :title="__t('ui.chat', '查看当前会话心流')"
          @click="toggleFlowPanel"
        >
          <PixelIcon name="thought" size="xs" />
          {{ __t('ui.chat', '心流') }}
        </button>
      </template>
      <span v-if="!isGroupChannel" class="token-capacitor" :title="tokenBudgetTitle">
        <span
          class="token-capacitor-ring"
          :style="{ '--token-capacitor-angle': tokenBudgetDegrees }"
        >
          <span class="token-capacitor-core" />
        </span>
        <span class="token-capacitor-value">{{ tokenBudgetLabel }}</span>
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
        <ThreadModelControls
          :compact="compact"
          :thread-id="threadStore.threadId"
          :disabled="disabled || isSending || modeSaving || submissionBusy || submitting"
          @changed="onThreadModelChanged"
          @busy="modelSettingsBusy = $event"
          @open="onFoldoutOpened"
        />
        <InputBarFoldout
          ref="sessionModeMenu"
          :label="currentInteractionMode.label"
          :title="__t('ui.chat', '会话模式')"
          :icon="currentInteractionMode.icon"
          :accent="interactionAccent"
          :busy="modeSaving || debugStatus.busy"
          :badge="
            debugStatus.enabled && threadStore.interactionMode === 'work'
              ? __t('ui.runtime-debug', '调试')
              : undefined
          "
          :compact="compact"
          :scope-key="inputScope"
          @open="onFoldoutOpened"
        >
          <div
            class="input-choice-list session-mode-choices"
            role="group"
            :aria-label="__t('ui.chat', '会话模式')"
            :aria-busy="modeSaving"
          >
            <button
              v-for="mode in interactionModeOptions"
              :key="mode.value"
              type="button"
              class="input-choice"
              :class="{
                'is-selected':
                  !pendingInteractionMode && threadStore.interactionMode === mode.value,
                'is-pending': pendingInteractionMode === mode.value,
              }"
              :data-interaction-mode="mode.value"
              :aria-pressed="threadStore.interactionMode === mode.value"
              :disabled="modeSwitchDisabled"
              :title="mode.title"
              @click="selectInteractionMode(mode.value)"
            >
              <span class="input-choice__icon" aria-hidden="true">
                <PixelIcon
                  :name="pendingInteractionMode === mode.value ? 'refresh' : mode.icon"
                  :animation="pendingInteractionMode === mode.value ? 'spin' : undefined"
                  size="xs"
                  aria-hidden="true"
                />
              </span>
              <span class="input-choice__copy">
                <strong>{{ mode.label }}</strong>
                <small>
                  {{
                    __t(
                      'ui.input-controls',
                      mode.value === 'minimal'
                        ? '轻量对话与日常工具'
                        : mode.value === 'chat'
                          ? '自然交流与角色互动'
                          : '使用工具处理任务',
                    )
                  }}
                </small>
              </span>
              <span class="input-choice__check" aria-hidden="true">
                <PixelIcon
                  v-if="!pendingInteractionMode && threadStore.interactionMode === mode.value"
                  name="check"
                  size="xs"
                />
              </span>
            </button>
          </div>
          <div class="input-debug-section">
            <RuntimeDebugToggle
              layout="menu"
              :thread-id="threadStore.threadId"
              :mode="threadStore.interactionMode"
              :disabled="modeSwitchDisabled"
              :ensure-thread="ensureThread"
              @state="debugStatus = $event"
              @change="loadThreadTools"
            />
          </div>
          <span class="sr-only" role="status">{{ modeStatusLabel }}</span>
        </InputBarFoldout>
        <InputBarFoldout
          ref="mediaInputMenu"
          :label="__t('ui.input-controls', '输入')"
          :title="__t('ui.input-controls', '图片与语音输入')"
          :summary="imageModeLabel"
          :compact="compact"
          :scope-key="inputScope"
          icon="image"
          accent="var(--ui-accent-sky)"
          :width="340"
          @open="onFoldoutOpened"
        >
          <section class="input-choice-section" :aria-label="__t('ui.chat', '识图方式')">
            <header class="input-choice-section__head">
              <span>
                <PixelIcon name="image" size="xs" />
                {{ __t('ui.chat', '识图方式') }}
              </span>
              <small>{{ imageModeLabel }}</small>
            </header>
            <div class="input-choice-list" role="group" :aria-label="__t('ui.chat', '识图方式')">
              <button
                v-for="option in [
                  {
                    value: 'auto',
                    label: __t('ui.chat', '自动选择'),
                    hint: enableVision
                      ? __t('ui.chat', '优先主模型原生识图')
                      : relayAvailable
                        ? __t('ui.chat', '使用多模态转述')
                        : __t('ui.chat', '暂无可用能力'),
                  },
                  {
                    value: 'native',
                    label: __t('ui.chat', '原生多模态'),
                    hint: enableVision
                      ? __t('ui.chat', '当前可用')
                      : __t('ui.chat', '当前模型不支持'),
                  },
                  {
                    value: 'relay',
                    label: __t('ui.chat', '多模态转述'),
                    hint: relayAvailable ? __t('ui.chat', '当前可用') : __t('ui.chat', '尚未配置'),
                  },
                ]"
                :key="option.value"
                type="button"
                class="input-choice"
                :class="{ 'is-selected': imageMode === option.value }"
                :aria-pressed="imageMode === option.value"
                :data-image-mode="option.value"
                :disabled="
                  (option.value === 'native' && !enableVision) ||
                  (option.value === 'relay' && !relayAvailable)
                "
                @click="selectImageMode(option.value as 'auto' | 'native' | 'relay')"
              >
                <span class="input-choice__icon" aria-hidden="true">
                  <PixelIcon
                    :name="
                      option.value === 'auto'
                        ? 'sparkle'
                        : option.value === 'native'
                          ? 'eye'
                          : 'network'
                    "
                    size="xs"
                  />
                </span>
                <span class="input-choice__copy">
                  <strong>{{ option.label }}</strong>
                  <small>{{ option.hint }}</small>
                </span>
                <span class="input-choice__check" aria-hidden="true">
                  <PixelIcon v-if="imageMode === option.value" name="check" size="xs" />
                </span>
              </button>
            </div>
          </section>
          <section
            class="input-choice-section input-choice-section--voice"
            :aria-label="__t('ui.chat', '语音输入')"
          >
            <header class="input-choice-section__head">
              <span>
                <PixelIcon name="mic" size="xs" />
                {{ __t('ui.chat', '语音输入') }}
              </span>
              <small>{{ __t('ui.input-controls', '录音') }}</small>
            </header>
            <button
              type="button"
              class="input-choice"
              data-audio-input="asr"
              :disabled="disabled || voiceBusy || startingVoice"
              @click="selectAudioInput('asr')"
            >
              <span class="input-choice__icon" aria-hidden="true">
                <PixelIcon name="mic" size="xs" />
              </span>
              <span class="input-choice__copy">
                <strong>
                  {{ __t('ui.chat', '语音转写') }}
                  <em v-if="!asrAvailable">{{ __t('ui.chat', '未配置') }}</em>
                </strong>
                <small>{{ __t('ui.chat', '录音转成文字，可编辑后发送') }}</small>
              </span>
              <PixelIcon
                name="chevron-right"
                size="xs"
                class="input-choice__arrow"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="input-choice"
              data-audio-input="native"
              :disabled="
                disabled ||
                voiceBusy ||
                startingVoice ||
                (!nativeAudioAvailable && Boolean(threadStore.threadId))
              "
              @click="selectAudioInput('native')"
            >
              <span class="input-choice__icon" aria-hidden="true">
                <PixelIcon name="volume" size="xs" />
              </span>
              <span class="input-choice__copy">
                <strong>
                  {{ __t('ui.chat', '原生音频') }}
                  <em>Gemini</em>
                </strong>
                <small>
                  {{
                    nativeAudioAvailable
                      ? __t('ui.audio-input', '录制原音，试听后发送')
                      : __t('ui.audio-input', '请在 Gemini 模型卡片中手动开启音频输入')
                  }}
                </small>
              </span>
              <PixelIcon name="info" size="xs" class="input-choice__arrow" aria-hidden="true" />
            </button>
          </section>
        </InputBarFoldout>
        <button
          :title="__t('ui.chat', '管理本会话可用工具')"
          :disabled="modeSaving"
          :class="{ reserved: toolOpen }"
          @click="toggleToolManager"
        >
          <PixelIcon name="tool" size="xs" />
          {{ __t('ui.chat', '会话工具') }}
          <span v-if="threadTools.length" class="tool-count">
            {{ enabledToolCount }}/{{ availableToolCount }}
          </span>
        </button>
        <button :title="__t('ui.chat', '命令')" @click="commandOpen = !commandOpen">
          <PixelIcon name="terminal" size="xs" class="deck-tool-icon" />
          <span class="pixel-label">/ CMD</span>
        </button>
        <button
          type="button"
          class="deck-add-file"
          :title="__t('ui.attachments', '添加文件')"
          :aria-label="__t('ui.attachments', '添加文件')"
          :disabled="disabled"
          @click="fileInputRef?.click()"
        >
          <PixelIcon name="plus" size="sm" aria-hidden="true" />
        </button>
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

    <div v-if="flowOpen" class="deck-popover flow-popover">
      <header class="flow-panel__head">
        <div>
          <strong>{{ __t('ui.chat', '私有临时心流') }}</strong>
          <span>{{ __t('ui.chat', '当前会话 · Agent 自维护') }}</span>
        </div>
        <div class="flow-panel__actions">
          <button
            :title="__t('ui.chat', '刷新心流')"
            :disabled="flowLoading"
            @click="loadFlowState"
          >
            <PixelIcon name="refresh" size="xs" :animation="flowLoading ? 'spin' : undefined" />
          </button>
          <button :title="__t('ui.chat', '收起心流')" @click="flowOpen = false">
            <PixelIcon name="chevron-down" size="xs" />
          </button>
        </div>
      </header>
      <div v-if="flowLoading && !flowStates.length" class="flow-panel__empty">
        <PixelIcon name="refresh" size="xs" animation="spin" />
        {{ __t('ui.chat', '正在读取心流…') }}
      </div>
      <div v-else-if="!flowStates.length" class="flow-panel__empty">
        {{ __t('ui.chat', '当前会话还没有心流') }}
      </div>
      <article v-for="state in flowStates" v-else :key="state.agentId" class="flow-state-card">
        <header>
          <span>
            {{
              agentStore.agents.find((agent) => agent.id === state.agentId)?.name ?? state.agentId
            }}
          </span>
          <b>REV.{{ state.revision }}</b>
        </header>
        <section>
          <small>{{ __t('ui.chat', '当前目标') }}</small>
          <p>{{ state.currentGoal || __t('ui.chat', '暂无明确的持续目标。') }}</p>
        </section>
        <section class="flow-state-card__private">
          <small>{{ __t('ui.chat', '私有事实') }}</small>
          <p>{{ state.privateFacts || __t('ui.chat', '暂无需要私下持续记住的事实。') }}</p>
        </section>
        <footer>
          <time>
            {{
              state.updatedAt
                ? __t('ui.chat', '更新于 {0}', [state.updatedAt])
                : __t('ui.chat', '尚未更新')
            }}
          </time>
          <button
            :disabled="flowClearing || (!state.currentGoal && !state.privateFacts)"
            @click="clearFlowState(state.agentId)"
          >
            <PixelIcon name="trash" size="xs" />
            {{ __t('ui.chat', '清空') }}
          </button>
        </footer>
      </article>
      <p class="flow-panel__notice">{{ __t('ui.chat', '仅用于当前会话，不存入长期记忆。') }}</p>
    </div>

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
      <section
        class="execution-policy"
        :aria-label="__t('ui.chat', '本会话执行权限')"
        :aria-busy="toolsSaving"
      >
        <div class="execution-policy__head">
          <span>
            <PixelIcon name="shield" size="xs" />
            {{ __t('ui.chat', '执行权限') }}
          </span>
          <small>{{ __t('ui.chat', '仅当前会话') }}</small>
        </div>
        <div
          class="execution-policy__options"
          role="group"
          :aria-label="__t('ui.chat', '选择执行权限')"
        >
          <button
            v-for="option in executionModeOptions"
            :key="option.value"
            type="button"
            class="execution-policy__option"
            :class="{
              'is-selected': executionMode === option.value,
              'is-full': option.value === 'full',
            }"
            :aria-pressed="executionMode === option.value"
            :disabled="executionModeDisabled"
            @click="changeExecutionMode(option.value)"
          >
            <span class="execution-policy__label">
              <PixelIcon :name="executionModeIcons[option.value]" size="xs" />
              <strong>{{ option.label }}</strong>
              <span class="execution-policy__marker" aria-hidden="true">
                <PixelIcon v-if="executionMode === option.value" name="check" size="xs" />
              </span>
            </span>
            <small>{{ option.description }}</small>
          </button>
        </div>
      </section>
      <p class="tool-manager__notice">{{ __t('ui.chat', '仅影响本会话；系统必需项不可关闭。') }}</p>
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

    <input ref="fileInputRef" hidden type="file" multiple @change="handleFiles" />
  </div>
</template>

<style scoped src="./input-bar-choices.css"></style>
<style scoped>
.record-btn {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-xs);
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
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-md);
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
.deck-brand,
.pixel-label {
  font-family: var(--font-pixel);
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.1em;
  color: var(--ui-accent-primary);
}
.token-capacitor {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 5px;
  margin-left: auto;
  padding-left: 10px;
  color: var(--ui-success);
  font: 800 9px var(--font-mono);
}
.token-capacitor-ring {
  --token-capacitor-angle: 0deg;
  position: relative;
  display: inline-grid;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  place-items: center;
  border-radius: 50%;
  background: conic-gradient(
    var(--ui-success) var(--token-capacitor-angle),
    color-mix(in srgb, var(--ui-success) 16%, transparent) 0
  );
  box-shadow: 0 0 6px color-mix(in srgb, var(--ui-success) 58%, transparent);
}
.token-capacitor-ring::before {
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--ui-bg-surface-soft);
  content: '';
}
.token-capacitor-core {
  position: relative;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--ui-success);
  box-shadow: 0 0 5px var(--ui-success);
}
.token-capacitor-value {
  font-variant-numeric: tabular-nums;
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
  padding: 8px 10px;
  border-top: 1px solid var(--ui-border-subtle);
}
.deck-tools {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 5px;
  overflow-x: auto;
}
.deck-tools button,
.stop-btn,
.send-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  min-height: 30px;
  padding: 0 8px;
  white-space: nowrap;
  background: var(--ui-bg-surface);
  color: var(--ui-text-secondary);
  border: 1px solid var(--ui-border-subtle);
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.deck-tools button:hover:not(:disabled) {
  color: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
}
.deck-tools button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.deck-tools .reserved {
  color: var(--ui-accent-purple);
}
.deck-tools > .deck-add-file {
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 0;
  border-color: var(--ui-border-default);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ui-text-primary) 5%, transparent);
}
/* 据点群聊的 @ 提及按钮：品牌色描边，突出 @ 符号 */
.group-footer-tools {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}
.mention-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  padding: 0 10px;
  white-space: nowrap;
  background: var(--ui-bg-surface);
  color: var(--ui-accent-primary);
  border: 1px solid var(--ui-accent-primary);
  border-radius: 3px;
  font-size: 11px;
  font-weight: 800;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.mention-btn:hover:not(:disabled) {
  background: var(--ui-accent-primary-soft);
  box-shadow: var(--ui-glow-pink);
}
.mention-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.mention-btn-at {
  font-family: var(--font-pixel), monospace;
  font-size: 13px;
  line-height: 1;
}
[data-theme='dark'] .mention-btn {
  border-color: var(--ui-accent-purple);
  color: var(--ui-accent-purple);
}
[data-theme='dark'] .mention-btn:hover:not(:disabled) {
  background: var(--ui-accent-purple-soft);
  box-shadow: 0 0 12px rgba(139, 92, 246, 0.3);
}
.deck-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  margin-left: auto;
}
.deck-actions > button {
  min-height: 32px;
  gap: 7px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ui-text-inverse) 8%, transparent);
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-instant) var(--ui-ease-standard);
}
.deck-actions > button:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: none;
}
.deck-actions > button:focus-visible {
  outline: 2px solid var(--ui-focus-color);
  outline-offset: 3px;
}
.deck-actions :deep(.pixel-icon) {
  flex-shrink: 0;
}
.send-btn {
  --ui-focus-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
  color: var(--ui-text-inverse);
}
.send-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent-primary) 88%, var(--ui-text-primary));
  border-color: var(--ui-accent-primary);
}
.send-btn--queue {
  background: var(--ui-accent-primary-soft);
  border-color: color-mix(in srgb, var(--ui-accent-primary) 30%, transparent);
  color: var(--ui-accent-primary);
}
.send-btn--queue:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent-primary) 18%, var(--ui-bg-surface));
  border-color: var(--ui-accent-primary);
}
.deck-actions .send-btn:disabled {
  background: var(--ui-bg-surface-soft);
  border-color: var(--ui-border-subtle);
  color: var(--ui-text-disabled);
  box-shadow: none;
  cursor: not-allowed;
}
.stop-btn {
  --ui-focus-color: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 30%, transparent);
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
}
.stop-btn:hover {
  border-color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 18%, var(--ui-bg-surface));
}
.stop-btn-mark {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: 2px;
  background: currentColor;
}
.flow-popover {
  width: min(430px, calc(100% - 20px));
  padding: 0;
  overflow: hidden;
  border-top: 3px solid var(--ui-accent-purple);
}
.flow-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-accent-purple-soft);
}
.flow-panel__head > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.flow-panel__head strong {
  color: var(--ui-text-primary);
  font-size: 12px;
}
.flow-panel__head span {
  color: var(--ui-text-tertiary);
  font: 800 8px var(--ui-font-mono);
}
.flow-panel__actions {
  display: flex;
  align-items: center;
  gap: 5px;
}
.flow-panel__actions > button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface);
  color: var(--ui-accent-purple);
  cursor: pointer;
}
.flow-panel__actions > button:hover:not(:disabled) {
  border-color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
}
.flow-panel__actions > button:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 2px;
}
.flow-panel__actions > button:disabled {
  opacity: 0.5;
  cursor: default;
}
.flow-panel__empty {
  display: flex;
  min-height: 90px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.flow-state-card {
  margin: 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  box-shadow: 3px 3px 0 var(--ui-border-subtle);
}
.flow-state-card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 9px;
  border-bottom: 1px solid var(--ui-border-default);
}
.flow-state-card > header span {
  color: var(--ui-accent-purple);
  font: 900 9px var(--ui-font-mono);
}
.flow-state-card > header b {
  color: var(--ui-text-disabled);
  font: 800 8px var(--ui-font-mono);
}
.flow-state-card section {
  padding: 9px;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.flow-state-card section small {
  display: block;
  margin-bottom: 5px;
  color: var(--ui-accent-sky);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.flow-state-card__private small {
  color: var(--ui-accent-purple) !important;
}
.flow-state-card section p {
  max-height: 110px;
  margin: 0;
  overflow: auto;
  color: var(--ui-text-secondary);
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.flow-state-card__work {
  border-left: 3px solid #8b5cf6;
  background: color-mix(in srgb, #8b5cf6 7%, var(--ui-bg-elevated));
}

.flow-work-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-size: 10px;
  color: var(--ui-text-tertiary);
}

.flow-work-meta button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-accent-purple, #8b5cf6);
}
.flow-state-card > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  background: var(--ui-bg-surface-soft);
}
.flow-state-card time {
  color: var(--ui-text-disabled);
  font: 7px var(--ui-font-mono);
}
.flow-state-card footer button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 7px;
  border: 1px solid var(--ui-danger);
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  font-size: 8px;
  font-weight: 800;
  cursor: pointer;
}
.flow-state-card footer button:disabled {
  opacity: 0.4;
  cursor: default;
}
.flow-panel__notice {
  margin: 0;
  padding: 8px 10px;
  border-top: 1px solid var(--ui-warning);
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
  font-size: 8px;
}
:global([data-theme='dark']) .flow-state-card {
  background: color-mix(in srgb, var(--ui-accent-purple) 5%, var(--ui-bg-elevated));
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.36);
}

.deck-popover {
  position: absolute;
  z-index: 20;
  bottom: 50px;
  width: min(360px, calc(100% - 20px));
  padding: 8px;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  border-radius: 4px;
  box-shadow: var(--ui-shadow-lg);
}
.command-popover {
  left: 10px;
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
  margin-left: 2px;
  padding-left: 6px;
  border-left: 1px solid var(--ui-border-default);
  color: var(--ui-text-tertiary);
  font: 800 8px var(--ui-font-mono);
}
.tool-popover {
  display: flex;
  flex-direction: column;
  right: 10px;
  width: min(430px, calc(100% - 20px));
  max-height: min(520px, 70vh);
  overflow: hidden;
  padding: 0;
  border-radius: 0;
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
.execution-policy {
  flex-shrink: 0;
  padding: 10px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}
.execution-policy__head,
.execution-policy__head > span,
.execution-policy__label {
  display: flex;
  align-items: center;
  gap: 7px;
}
.execution-policy__head {
  justify-content: space-between;
  margin-bottom: 8px;
}
.execution-policy__head > span {
  color: var(--ui-text-secondary);
  font-size: 10px;
  font-weight: 800;
}
.execution-policy__head > small {
  color: var(--ui-text-tertiary);
  font-size: 9px;
}
.execution-policy__options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.execution-policy__option {
  --policy-accent: var(--ui-accent-purple);
  position: relative;
  min-width: 0;
  padding: 9px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-secondary);
  text-align: left;
  cursor: pointer;
  transition:
    background 140ms ease,
    border-color 140ms ease,
    box-shadow 140ms ease;
}
.execution-policy__option.is-full {
  --policy-accent: var(--ui-accent-pink);
}
.execution-policy__option:hover:not(:disabled) {
  border-color: var(--policy-accent);
  background: var(--ui-bg-hover);
}
.execution-policy__option.is-selected {
  border-color: color-mix(in srgb, var(--policy-accent) 65%, var(--ui-border-default));
  background: color-mix(in srgb, var(--policy-accent) 9%, var(--ui-bg-elevated));
  box-shadow:
    inset 2px 0 0 var(--policy-accent),
    2px 2px 0 var(--ui-border-subtle);
}
.execution-policy__option.is-selected::after {
  content: '';
  position: absolute;
  top: -1px;
  left: -1px;
  width: 5px;
  height: 5px;
  background: var(--policy-accent);
}
.execution-policy__option:focus-visible {
  outline: 2px solid var(--policy-accent);
  outline-offset: 2px;
}
.execution-policy__option:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.execution-policy__label {
  margin-bottom: 5px;
}
.execution-policy__label > :first-child {
  color: var(--policy-accent);
}
.execution-policy__label strong {
  flex: 1;
  font-size: 11px;
  font-weight: 800;
}
.execution-policy__marker {
  display: grid;
  width: 14px;
  height: 14px;
  place-items: center;
  color: var(--policy-accent);
}
.execution-policy__option > small {
  display: block;
  color: var(--ui-text-tertiary);
  font-size: 9px;
  line-height: 1.5;
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
.deck--compact .deck-footer {
  align-items: flex-end;
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
/* / CMD 在紧凑下只显示图标 */
.deck-tool-icon {
  display: none;
}
.deck--compact .deck-tool-icon {
  display: inline-flex;
}
.deck--compact .pixel-label {
  display: none;
}
/* 工具按钮统一收窄为 30px 等宽图标钮 */
.deck--compact .deck-tools > button {
  width: 30px;
  min-width: 30px;
  height: 30px;
  padding: 0;
  justify-content: center;
  font-size: 0;
  overflow: visible;
  white-space: nowrap;
}
.deck--compact .deck-tools > button {
  position: relative;
}
.deck--compact .deck-tools > button .tool-count {
  position: absolute;
  right: -3px;
  bottom: -5px;
  margin: 0;
  padding: 1px 2px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface);
  color: var(--ui-accent-primary);
  font-size: 7px;
  line-height: 1;
  letter-spacing: -0.04em;
  transform: scale(0.82);
  transform-origin: right bottom;
}
.deck--compact .deck-tools button :deep(.pixel-icon) {
  flex-shrink: 0;
  font-size: initial;
}
.deck--compact .deck-actions > button {
  width: 34px;
  min-width: 34px;
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
    align-items: flex-end;
  }
  .deck-tools button {
    padding: 0 6px;
  }
  .deck-tools button:not(:first-child) {
    font-size: 0;
  }
  .deck-tools button :deep(.pixel-icon) {
    font-size: initial;
  }
  .deck-actions .action-label {
    display: none;
  }
  .deck-actions > button {
    width: 34px;
    min-width: 34px;
    padding: 0;
  }
}
[data-theme='dark'] .deck {
  background: rgba(30, 27, 45, 0.92);
  border-color: rgba(139, 92, 246, 0.25);
}
</style>
