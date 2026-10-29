<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * ModelConfigTab — 模型配置 Tab (F1-1)
 *
 * 双面板设计: LLM 模型网格 + 向量模型配置
 * 功能: 模型 CRUD, 主模型指定 + 任务指派, Embedding/Reranker 配置
 *
 * @see 06_FILE_SIZE_LIMITS.md — 逻辑抽到 useModelConfig composable
 */
import {
  PixelIcon,
  PButton,
  PInput,
  PSelect,
  PInputNumber,
  PSlider,
  PSwitch,
  PTooltip,
  PDialog,
  PCheckbox,
  PCard,
} from '../../pixel'
import { watch, computed, ref, nextTick } from 'vue'
import { modelEditorFieldLabel } from '../../../lib/modelEditor'
import {
  useModelConfig,
  TASK_SLOTS,
  type LlmModel,
} from '../../../composables/dashboard/useModelConfig'
import BrandIcon from '../../brands/BrandIcon.vue'
import BrandSelect, { type BrandSelectOption } from '../../brands/BrandSelect.vue'
import { resolveModelBrand, resolveProviderBrand } from '../../../lib/modelBrands'
import { useDashboardContext } from '../../../composables/dashboard'
import { useAgentStore } from '../../../stores/useAgentStore'
import { getApiBaseUrl } from '../../../api/transport'
import IndexMaintenancePanel from '../IndexMaintenancePanel.vue'
import ModelFallbackDialog from '../ModelFallbackDialog.vue'
import ProviderConnectionsDialog from '../ProviderConnectionsDialog.vue'
import {
  DEFAULT_DESKTOP_REACT_MAX_TURNS,
  usesReasoningLevels,
  reasoningEffortOptions as getReasoningEffortOptions,
} from '@infos/shared'

const ctx = useDashboardContext()
const agentStore = useAgentStore()
const fallbackModel = ref<LlmModel | null>(null)

const {
  models,
  modelTests,
  testModel,
  setModelConnection,
  switchingConnections,
  currentTab,
  mainModelId,
  taskAssignments,
  agentAssignments,
  isTaskAssignOpen,
  isAgentAssignOpen,
  providerOptions,
  isEditorOpen,
  editingModel,
  editorForm,
  editorErrors,
  isSavingModel,
  isReadingConnection,
  openEditor,
  saveModel,
  deleteModel,
  setModelToggle,
  setMainModel,
  setTaskAssignment,
  setAgentAssignment,
  fetchAgentAssignments,
  isGlobalOpen,
  providerConnections,
  selectedConnection,
  loadConnections,
  handleConnectionChange,
  handleProviderChange,
  setConnectionOverride,
  embeddingProvider,
  embeddingEnabled,
  embeddingSwitchReady,
  embeddingSwitchSaving,
  setEmbeddingEnabled,
  embeddingModelId,
  embeddingDimension,
  embeddingActivationRevision,
  embeddingApiBase,
  embeddingApiKey,
  rerankerEnabled,
  rerankerModelId,
  rerankerApiBase,
  rerankerApiKey,
  isSavingVector,
  embeddingActivationResult,
  saveVectorConfig,
  fetchModels,
  // 远程模型列表
  remoteModels,
  isFetchingRemote,
  fetchRemoteModels,
  customProviderTypeOptions,
  providerDefaults,
  // 向量远程模型列表
  remoteEmbeddingModels,
  isFetchingEmbedding,
  fetchRemoteEmbeddingModels,
  remoteRerankerModels,
  isFetchingReranker,
  fetchRemoteRerankerModels,
  relayEnabled,
  relayModelConfigId,
  relayDetail,
  isSavingRelay,
  visionModels,
  saveRelayConfig,
} = useModelConfig()

const editorErrorPanel = ref<HTMLElement | null>(null)
watch(editorErrors, async (errors) => {
  if (Object.keys(errors).length === 0) return
  await nextTick()
  editorErrorPanel.value?.focus({ preventScroll: true })
  editorErrorPanel.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})

/** 参数是否应写入 Provider 请求；关闭时统一保存为 null，即完全不传。 */
const sendTemperature = computed({
  get: () => editorForm.value.temperature !== null,
  set: (enabled: boolean) => {
    editorForm.value.temperature = enabled ? 1 : null
  },
})
const sendTopP = computed({
  get: () => editorForm.value.topP !== null,
  set: (enabled: boolean) => {
    editorForm.value.topP = enabled ? 1 : null
  },
})
const sendMaxTokens = computed({
  get: () => editorForm.value.maxTokens !== null,
  set: (enabled: boolean) => {
    editorForm.value.maxTokens = enabled ? 4096 : null
  },
})
const temperatureValue = computed({
  get: () => editorForm.value.temperature ?? 1,
  set: (value: number) => {
    editorForm.value.temperature = value
  },
})
const topPValue = computed({
  get: () => editorForm.value.topP ?? 1,
  set: (value: number) => {
    editorForm.value.topP = value
  },
})
const wireApiOptions = [
  { label: 'Chat Completions', value: 'chat_completions' },
  { label: 'Responses', value: 'responses' },
]
const editorProtocol = computed(() =>
  selectedConnection.value && !editorForm.value.connectionOverride
    ? selectedConnection.value.protocol
    : editorForm.value.connectionProtocol,
)
const connectionProtocolLabel = computed(
  () =>
    ({
      get openai() {
        return __t('ui.settings', 'OpenAI 兼容')
      },
      anthropic: 'Anthropic',
      gemini: 'Gemini',
    })[editorProtocol.value] ?? editorProtocol.value,
)
const connectionApiBase = computed(() =>
  editorForm.value.connectionOverride
    ? (editorForm.value.apiBase ?? '')
    : (selectedConnection.value?.apiBase ?? ''),
)
const connectionSummaryBrand = computed(() =>
  resolveProviderBrand(selectedConnection.value?.brand, connectionApiBase.value),
)
const connectionAuthStatus = computed(() => {
  const override = editorForm.value.connectionOverride
  const noAuth =
    (override ? editorForm.value.connectionAuthMode : selectedConnection.value?.authMode) === 'none'
  const hasKey = override
    ? !!editorForm.value.apiKey?.trim()
    : !!selectedConnection.value?.hasApiKey
  return {
    label: noAuth
      ? __t('ui.settings', '无需认证')
      : hasKey
        ? __t('ui.settings', '密钥已配置')
        : __t('ui.settings', '缺少密钥'),
    icon: noAuth ? 'shield' : hasKey ? 'check' : 'alert',
    ready: !noAuth && hasKey,
    missing: !noAuth && !hasKey,
  }
})
const reasoningDialectOptions = [
  {
    get label() {
      return __t('ui.settings', '自动识别')
    },
    value: 'auto',
  },
  {
    get label() {
      return __t('ui.settings', 'OpenAI官方')
    },
    value: 'openai',
  },
  {
    get label() {
      return __t('ui.settings', 'DeepSeek兼容')
    },
    value: 'deepseek',
  },
  {
    get label() {
      return __t('ui.settings', 'OpenRouter兼容')
    },
    value: 'openrouter',
  },
  {
    get label() {
      return __t('ui.settings', '通用兼容')
    },
    value: 'generic',
  },
]
const geminiThinkingLevels = computed(() => usesReasoningLevels(editorForm.value.modelId))
const reasoningEffortOptions = computed(() =>
  getReasoningEffortOptions(editorForm.value.modelId).map((option) => ({
    ...option,
    label: __t('common.interface', option.label),
  })),
)
const legacyGeminiEffort = computed(() =>
  geminiThinkingLevels.value &&
  ['off', 'xhigh', 'max'].includes(editorForm.value.reasoningEffort || '')
    ? editorForm.value.reasoningEffort
    : '',
)
const reasoningEffortValue = computed({
  get: () =>
    legacyGeminiEffort.value
      ? legacyGeminiEffort.value === 'off'
        ? 'low'
        : 'high'
      : (editorForm.value.reasoningEffort ?? ''),
  set: (value: string) => {
    editorForm.value.reasoningEffort = value
      ? (value as NonNullable<typeof editorForm.value.reasoningEffort>)
      : null
  },
})

// 监听全局刷新
watch(
  () => ctx.refreshKey.value,
  () => refreshConnections(),
)

async function refreshConnections() {
  await loadConnections()
  await fetchModels()
}

function avatarUrlOf(avatarUrl?: string): string {
  if (!avatarUrl) return ''
  return /^https?:\/\//i.test(avatarUrl) ? avatarUrl : `${getApiBaseUrl()}${avatarUrl}`
}

async function openAgentAssignment(): Promise<void> {
  if (agentStore.agents.length === 0) await agentStore.fetchAgents()
  await fetchAgentAssignments(agentStore.enabledAgents.map((agent) => agent.id))
  isAgentAssignOpen.value = true
}

function assignedModelName(agentId: string): string {
  const modelId = agentAssignments.value[agentId]
  return (
    models.value.find((model) => model.id === modelId)?.name ?? __t('ui.settings', '跟随主模型')
  )
}

function formatTokens(tokens: number | null): string {
  if (!tokens) return __t('ui.settings', '不传')
  if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M'
  return (tokens / 1000).toFixed(0) + 'K'
}

const providerLabels: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  xai: 'xAI (Grok)',
  mistral: 'Mistral',
  groq: 'Groq',
  get siliconflow() {
    return __t('ui.settings', '硅基流动')
  },
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot (Kimi)',
  get dashscope() {
    return __t('ui.settings', '阿里百炼')
  },
  get volcengine() {
    return __t('ui.settings', '火山引擎')
  },
  get zhipu() {
    return __t('ui.settings', '智谱 GLM')
  },
  minimax: 'MiniMax',
  get yi() {
    return __t('ui.settings', '01.AI 零一万物')
  },
  get stepfun() {
    return __t('ui.settings', '阶跃星辰')
  },
  get hunyuan() {
    return __t('ui.settings', '腾讯混元')
  },
  ollama: 'Ollama',
  get custom() {
    return __t('ui.settings', '自定义')
  },
}

const connectionChoices = computed<BrandSelectOption[]>(() =>
  providerConnections.value.map((connection) => ({
    label: `${connection.name} · ${connection.protocol}`,
    value: connection.id,
    brand: resolveProviderBrand(connection.brand, connection.apiBase),
  })),
)
const editorConnectionChoices = computed<BrandSelectOption[]>(() => [
  { label: __t('ui.settings', '独立配置'), value: '' },
  ...connectionChoices.value,
])
const modelChoices = computed<BrandSelectOption[]>(() =>
  models.value.map((model) => ({
    label: model.name,
    value: model.id,
    brand: resolveModelBrand(model.modelId),
  })),
)
const mainModelBrand = computed(() =>
  resolveModelBrand(models.value.find((model) => model.id === mainModelId.value)?.modelId),
)
const taskModelChoices = computed<BrandSelectOption[]>(() => [
  {
    get label() {
      return __t('ui.settings', '跟随主模型')
    },
    value: '',
    brand: mainModelBrand.value,
  },
  ...modelChoices.value,
])
const agentModelChoices = computed<BrandSelectOption[]>(() => [
  {
    get label() {
      return __t('ui.settings', '跟随主模型')
    },
    value: '',
    brand: mainModelBrand.value,
  },
  ...modelChoices.value,
])
const visionModelChoices = computed<BrandSelectOption[]>(() =>
  visionModels.value.map((model) => ({
    label: `${model.name} · ${model.modelId}`,
    value: model.id,
    brand: resolveModelBrand(model.modelId),
  })),
)
function choicesForModelIds(ids: string[]): BrandSelectOption[] {
  return ids.map((modelId) => ({
    label: modelId,
    value: modelId,
    brand: resolveModelBrand(modelId),
  }))
}
const remoteModelChoices = computed(() => choicesForModelIds(remoteModels.value))
const embeddingModelChoices = computed(() => choicesForModelIds(remoteEmbeddingModels.value))
const rerankerModelChoices = computed(() => choicesForModelIds(remoteRerankerModels.value))

function providerBrandForModel(model: LlmModel) {
  const connection = providerConnections.value.find(
    (item) => item.id === model.providerConnectionId,
  )
  return resolveProviderBrand(
    connection && !model.connectionOverride ? connection.brand : model.provider,
    connection && !model.connectionOverride ? connection.apiBase : model.apiBase,
  )
}
function connectionName(model: LlmModel) {
  const connection = providerConnections.value.find(
    (item) => item.id === model.providerConnectionId,
  )
  return connection
    ? `${connection.name}${model.connectionOverride ? __t('ui.settings', ' · 自定义连接') : ''}`
    : (providerLabels[model.provider] ?? model.provider)
}
</script>

<template>
  <div class="model-config-layout p-8 h-full flex flex-col overflow-hidden">
    <!-- 头部 + 子选项卡 -->
    <div class="flex items-start justify-between gap-4 mb-6 flex-shrink-0 relative group/header">
      <!-- 背景氛围光晕 -->
      <div
        class="absolute -right-20 -top-10 w-40 h-40 bg-sky-400/5 blur-[60px] rounded-full pointer-events-none group-hover/header:bg-sky-400/15 transition-all duration-1000"
      />
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <button
            :class="[
              'flex items-center gap-2 text-xl font-black bg-none border-none cursor-pointer p-0 transition-all',
              currentTab === 'llm'
                ? 'text-slate-800 scale-[1.02]'
                : 'text-slate-400 hover:text-slate-500',
            ]"
            @click="currentTab = 'llm'"
          >
            <PixelIcon name="cpu" size="sm" />
            <span class="font-pixel">{{ __t('ui.settings', '模型配置') }}</span>
          </button>
          <span class="text-slate-200 text-xl font-light">/</span>
          <button
            :class="[
              'flex items-center gap-2 text-xl font-black bg-none border-none cursor-pointer p-0 transition-all',
              currentTab === 'vector'
                ? 'text-slate-800 scale-[1.02]'
                : 'text-slate-400 hover:text-slate-500',
            ]"
            @click="currentTab = 'vector'"
          >
            <PixelIcon name="brain" size="sm" />
            <span class="font-pixel">{{ __t('ui.settings', '向量模型') }}</span>
          </button>
        </div>
        <p class="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 ml-7 font-pixel">
          {{ currentTab === 'llm' ? 'LLM MODEL MANAGEMENT' : 'VECTOR CONFIGURATION' }}
        </p>
      </div>
      <div class="flex gap-2 items-center">
        <template v-if="currentTab === 'llm'">
          <PButton variant="ghost" @click="isGlobalOpen = true">
            <PixelIcon name="settings" size="xs" />
            <span>{{ __t('ui.settings', '服务商连接') }}</span>
          </PButton>
          <PButton variant="ghost" @click="isTaskAssignOpen = true">
            <PixelIcon name="brain" size="xs" />
            <span>{{ __t('ui.settings', '任务指派') }}</span>
          </PButton>
          <PButton variant="ghost" class="agent-assign-trigger" @click="openAgentAssignment">
            <PixelIcon name="users" size="xs" />
            <span>{{ __t('ui.settings', '角色指派') }}</span>
          </PButton>
          <PButton variant="primary" @click="openEditor(null)">
            <PixelIcon name="plus" size="xs" />
            <span>{{ __t('ui.settings', '添加模型') }}</span>
          </PButton>
        </template>
        <template v-else>
          <PButton
            variant="primary"
            :loading="isSavingVector"
            :disabled="
              isSavingVector || !embeddingSwitchReady || !embeddingEnabled || embeddingSwitchSaving
            "
            @click="saveVectorConfig"
          >
            {{
              isSavingVector
                ? __t('ui.settings', '激活中')
                : __t('ui.index-maintenance', '保存并激活')
            }}
          </PButton>
        </template>
      </div>
    </div>

    <!-- LLM 模型网格 -->
    <div
      v-if="currentTab === 'llm'"
      class="model-card-grid grid content-start flex-1 overflow-y-auto pr-1 pt-2 model-scrollbar"
    >
      <PCard v-for="model in models" :key="model.id" pixel hoverable class="model-config-card">
        <!-- 卡片头部 -->
        <div class="model-card-header">
          <div class="model-card-identity">
            <BrandIcon :brand="resolveModelBrand(model.modelId)" size="md" framed />
            <div class="flex flex-col gap-0.5 min-w-0">
              <h3 class="model-card-name" :title="model.name">{{ model.name }}</h3>
              <span
                class="model-provider-line text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                <BrandIcon :brand="providerBrandForModel(model)" size="xs" fallback="provider" />
                <span>{{ connectionName(model) }}</span>
              </span>
            </div>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <!-- 主模型徽章（淡蓝色像素风） -->
            <span
              v-if="mainModelId === model.id"
              class="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold text-sky-700 bg-sky-100 border-2 border-sky-300 shadow-[1px_1px_0_#7dd3fc] font-pixel"
            >
              <PixelIcon name="star" size="xs" />
              <span>{{ __t('ui.settings', '主模型') }}</span>
            </span>
          </div>
        </div>

        <!-- 模型详情 -->
        <div class="model-connection-picker">
          <label class="text-[11px] text-slate-400">
            {{ __t('ui.settings', '服务商连接')
            }}{{
              model.providerConnectionId && model.connectionOverride
                ? __t('ui.settings', '（已自定义）')
                : ''
            }}
          </label>
          <BrandSelect
            size="sm"
            :model-value="model.providerConnectionId || ''"
            :options="connectionChoices"
            fallback="provider"
            teleport
            :disabled="switchingConnections[model.id] || modelTests[model.id]?.loading"
            :placeholder="
              model.providerConnectionId
                ? __t('ui.settings', '选择服务商连接')
                : __t('ui.settings', '独立配置')
            "
            @change="(value: string | number) => setModelConnection(model, String(value))"
          />
        </div>
        <dl class="model-detail-grid">
          <div class="model-detail-id">
            <dt>{{ __t('ui.settings', '模型 ID') }}</dt>
            <dd :title="model.modelId">{{ model.modelId }}</dd>
          </div>
          <div>
            <dt>{{ __t('ui.settings', '思考等级') }}</dt>
            <dd>{{ model.reasoningEffort ?? __t('ui.settings', '不传') }}</dd>
          </div>
          <div>
            <dt>{{ __t('ui.settings', '最大轮次') }}</dt>
            <dd>{{ model.maxReActTurns ?? DEFAULT_DESKTOP_REACT_MAX_TURNS }}</dd>
          </div>
          <div>
            <dt>{{ __t('ui.settings', '最大输出 Token') }}</dt>
            <dd>{{ formatTokens(model.maxTokens) }}</dd>
          </div>
        </dl>

        <!-- 能力开关收成一排，避免重复展示开关状态。 -->
        <section class="model-capability-panel">
          <div class="model-capability-list">
            <label class="model-capability-toggle" :class="{ 'is-enabled': model.stream }">
              <strong :title="__t('ui.settings', '流式输出')">
                {{ __t('ui.settings', '流式输出') }}
              </strong>
              <PSwitch
                size="sm"
                :model-value="model.stream"
                :aria-label="__t('ui.settings', '流式输出')"
                @update:model-value="(enabled: boolean) => setModelToggle(model, 'stream', enabled)"
              />
            </label>
            <label class="model-capability-toggle" :class="{ 'is-enabled': model.enableVision }">
              <strong :title="__t('ui.settings', '图片输入')">
                {{ __t('ui.settings', '图片输入') }}
              </strong>
              <PSwitch
                size="sm"
                :model-value="model.enableVision"
                :aria-label="__t('ui.settings', '图片输入')"
                @update:model-value="
                  (enabled: boolean) => setModelToggle(model, 'enableVision', enabled)
                "
              />
            </label>
            <label
              class="model-capability-toggle model-capability-toggle-audio"
              :class="{ 'is-enabled': model.enableAudioInput }"
            >
              <strong :title="__t('ui.audio-input', '手动开启后，Gemini 协议连接可接收原生音频')">
                {{ __t('ui.settings', '音频输入') }}
              </strong>
              <PSwitch
                size="sm"
                :model-value="model.enableAudioInput"
                :aria-label="__t('ui.settings', '音频输入')"
                @update:model-value="
                  (enabled: boolean) => setModelToggle(model, 'enableAudioInput', enabled)
                "
              />
            </label>
          </div>
        </section>

        <!-- 操作按钮 -->
        <div
          class="model-card-actions flex justify-between items-center pt-3 border-t border-slate-100 mt-auto"
        >
          <!-- 主模型按钮（像素风立体感：3px偏移阴影，按下位移+阴影缩小） -->
          <button
            :class="[
              'main-model-button flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold font-pixel border-2 cursor-pointer select-none transition-all duration-100',
              mainModelId === model.id ? 'main-model-button--active' : '',
            ]"
            @click="setMainModel(model.id)"
          >
            <PixelIcon name="star" size="xs" />
            <span>
              {{
                mainModelId === model.id
                  ? __t('ui.settings', '主模型')
                  : __t('ui.settings', '设为主模型')
              }}
            </span>
          </button>
          <div class="model-card-secondary-actions">
            <PButton
              size="sm"
              variant="ghost"
              :loading="modelTests[model.id]?.loading"
              :disabled="switchingConnections[model.id]"
              @click="testModel(model.id)"
            >
              {{ __t('ui.settings', '测试') }}
            </PButton>
            <PButton size="sm" variant="ghost" @click="fallbackModel = model">
              {{ __t('ui.settings', '回退') }}
            </PButton>
            <PTooltip :content="__t('ui.settings', '编辑')" placement="top">
              <button
                class="p-1.5 bg-none border-none cursor-pointer text-slate-400 hover:text-sky-500 transition-all"
                :aria-label="__t('ui.settings', '编辑')"
                @click="openEditor(model)"
              >
                <PixelIcon name="pencil" size="xs" />
              </button>
            </PTooltip>
            <PTooltip :content="__t('ui.settings', '删除')" placement="top">
              <button
                class="p-1.5 bg-none border-none cursor-pointer text-slate-400 hover:text-rose-500 transition-all"
                :aria-label="__t('ui.settings', '删除')"
                @click="deleteModel(model.id)"
              >
                <PixelIcon name="trash" size="xs" />
              </button>
            </PTooltip>
          </div>
        </div>
        <p
          v-if="modelTests[model.id]"
          class="model-test-result"
          :class="{ 'is-error': modelTests[model.id]?.success === false }"
          role="status"
        >
          {{ modelTests[model.id]?.message }}
        </p>
      </PCard>
    </div>

    <!-- 向量模型配置 -->
    <div v-else class="flex-1 overflow-y-auto flex flex-col gap-6">
      <PCard pixel padding="lg">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h4 class="font-pixel font-bold">{{ __t('ui.settings', '向量功能') }}</h4>
            <p class="text-xs text-slate-400 mt-1">
              {{ __t('ui.settings', '生成向量并用于检索') }}
            </p>
          </div>
          <PSwitch
            :model-value="embeddingEnabled"
            :disabled="!embeddingSwitchReady || embeddingSwitchSaving || isSavingVector"
            :aria-label="__t('ui.settings', '向量功能')"
            @update:model-value="setEmbeddingEnabled"
          />
        </div>
      </PCard>
      <IndexMaintenancePanel
        :candidate-model="embeddingModelId"
        :candidate-dimension="embeddingDimension"
        :activation-revision="embeddingActivationRevision"
      />
      <!-- Embedding -->
      <PCard pixel padding="lg" overflow-visible>
        <div class="flex items-center gap-4 mb-5">
          <div
            class="w-12 h-12 flex items-center justify-center bg-sky-500 text-white flex-shrink-0"
          >
            <PixelIcon name="brain" size="sm" />
          </div>
          <div>
            <h4 class="text-base font-black text-slate-800 font-pixel">
              {{ __t('ui.settings', 'Embedding 嵌入模型') }}
            </h4>
            <p class="text-xs text-slate-400 mt-0.5">{{ __t('ui.settings', '用于语义检索') }}</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-1.5">
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '模型来源 Provider') }}
            </label>
            <PSelect
              v-model="embeddingProvider"
              :options="[
                {
                  label: __t('ui.settings', '本地内置 (BGE-512) — 待实现'),
                  value: 'local',
                  disabled: true,
                },
                { label: __t('ui.settings', '在线 API (OpenAI 兼容)'), value: 'api' },
              ]"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '向量维度 Dimension') }}
            </label>
            <PInputNumber
              v-model="embeddingDimension"
              :min="1"
              :max="4096"
              :disabled="embeddingProvider === 'local'"
            />
            <p v-if="embeddingProvider === 'local'" class="text-[10px] text-slate-400 italic">
              {{ __t('ui.settings', '* 本地模型固定为 512 维') }}
            </p>
          </div>
          <template v-if="embeddingProvider === 'api'">
            <div class="flex flex-col gap-1.5 col-span-2">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel flex items-center justify-between"
              >
                <span class="model-id-label">
                  <BrandIcon :brand="resolveModelBrand(embeddingModelId)" size="xs" />
                  {{ __t('ui.settings', '模型 ID') }}
                </span>
                <PButton
                  variant="ghost"
                  size="sm"
                  :loading="isFetchingEmbedding"
                  @click="fetchRemoteEmbeddingModels"
                >
                  <PixelIcon name="refresh" size="xs" />
                  {{ __t('ui.settings', '获取模型列表') }}
                </PButton>
              </label>
              <BrandSelect
                v-if="remoteEmbeddingModels.length > 0"
                v-model="embeddingModelId"
                :options="embeddingModelChoices"
                :placeholder="__t('ui.settings', '从列表中选择...')"
              />
              <PInput
                v-else
                v-model="embeddingModelId"
                :placeholder="__t('ui.settings', '例如: text-embedding-3-small')"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                {{ __t('ui.settings', 'API Base URL (可选)') }}
              </label>
              <PInput
                v-model="embeddingApiBase"
                :placeholder="__t('ui.settings', 'API 地址（留空保留）')"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                {{ __t('ui.settings', 'API Key (可选)') }}
              </label>
              <PInput
                v-model="embeddingApiKey"
                type="password"
                :placeholder="__t('ui.settings', 'API Key（留空保留）')"
              />
            </div>
          </template>
        </div>
        <div
          v-if="embeddingActivationResult"
          :class="[
            'mt-5 flex items-center gap-2 border-2 px-4 py-3 text-xs font-bold',
            embeddingActivationResult.status === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-rose-300 bg-rose-50 text-rose-700',
          ]"
          role="status"
        >
          <PixelIcon
            :name="embeddingActivationResult.status === 'success' ? 'check' : 'alert'"
            size="xs"
          />
          <span>{{ embeddingActivationResult.message }}</span>
        </div>
      </PCard>

      <!-- Reranker -->
      <PCard pixel padding="lg" overflow-visible :class="{ 'opacity-65': !rerankerEnabled }">
        <div class="flex items-center gap-4 mb-5">
          <div
            :class="[
              'w-12 h-12 flex items-center justify-center text-white flex-shrink-0',
              rerankerEnabled ? 'bg-amber-500' : 'bg-slate-400',
            ]"
          >
            <PixelIcon name="sparkle" size="sm" />
          </div>
          <div class="flex-1">
            <h4 class="text-base font-black text-slate-800 font-pixel">
              {{ __t('ui.settings', 'Reranker 重排序模型') }}
            </h4>
            <p class="text-xs text-slate-400 mt-0.5">{{ __t('ui.settings', '优化检索排序') }}</p>
          </div>
          <PSwitch v-model="rerankerEnabled" class="flex-shrink-0" />
        </div>
        <template v-if="rerankerEnabled">
          <div class="grid grid-cols-2 gap-4">
            <div class="flex flex-col gap-1.5 col-span-2">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel flex items-center justify-between"
              >
                <span class="model-id-label">
                  <BrandIcon :brand="resolveModelBrand(rerankerModelId)" size="xs" />
                  {{ __t('ui.settings', '模型 ID') }}
                </span>
                <PButton
                  variant="ghost"
                  size="sm"
                  :loading="isFetchingReranker"
                  @click="fetchRemoteRerankerModels"
                >
                  <PixelIcon name="refresh" size="xs" />
                  {{ __t('ui.settings', '获取模型列表') }}
                </PButton>
              </label>
              <BrandSelect
                v-if="remoteRerankerModels.length > 0"
                v-model="rerankerModelId"
                :options="rerankerModelChoices"
                :placeholder="__t('ui.settings', '从列表中选择...')"
              />
              <PInput
                v-else
                v-model="rerankerModelId"
                :placeholder="__t('ui.settings', '例如: bge-reranker-v2-m3')"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                {{ __t('ui.settings', 'API Base URL (可选)') }}
              </label>
              <PInput
                v-model="rerankerApiBase"
                :placeholder="__t('ui.settings', 'Reranker API 地址')"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                {{ __t('ui.settings', 'API Key (可选)') }}
              </label>
              <PInput
                v-model="rerankerApiKey"
                type="password"
                :placeholder="__t('ui.settings', 'Reranker 专用密钥')"
              />
            </div>
          </div>
        </template>
        <div
          v-else
          class="p-4 bg-slate-50 border border-slate-200 text-center text-[13px] text-slate-400"
        >
          <p>{{ __t('ui.settings', 'Reranker 已关闭') }}</p>
        </div>
      </PCard>
    </div>

    <!-- 模型编辑弹窗 -->
    <ModelFallbackDialog :model="fallbackModel" :models="models" @close="fallbackModel = null" />
    <PDialog
      v-model="isEditorOpen"
      :title="editingModel ? __t('ui.settings', '编辑模型') : __t('ui.settings', '添加模型')"
      width="560px"
      :loading="isSavingModel || isReadingConnection"
    >
      <div class="model-dialog-body flex flex-col gap-4">
        <div
          v-if="Object.keys(editorErrors).length"
          ref="editorErrorPanel"
          class="model-editor-errors"
          role="alert"
          tabindex="-1"
        >
          <strong>
            <PixelIcon name="alert" size="sm" />
            {{ __t('ui.settings', '请检查以下配置') }}
          </strong>
          <ul>
            <li v-for="(message, field) in editorErrors" :key="field">
              {{
                field === '_root'
                  ? message
                  : __t('ui.settings', '{0}：{1}', [modelEditorFieldLabel(String(field)), message])
              }}
            </li>
          </ul>
        </div>
        <fieldset class="model-editor-fields" :disabled="isSavingModel || isReadingConnection">
          <div class="flex flex-col gap-1.5">
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '模型名称') }}
            </label>
            <PInput
              v-model="editorForm.name"
              :placeholder="__t('ui.settings', '留空使用模型 ID')"
              :aria-invalid="!!editorErrors.name"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '服务商连接') }}
            </label>
            <BrandSelect
              :model-value="editorForm.providerConnectionId || ''"
              :options="editorConnectionChoices"
              fallback="provider"
              :placeholder="__t('ui.settings', '选择服务商连接')"
              @change="(v: string | number) => handleConnectionChange(String(v))"
            />
            <div class="flex items-center justify-between gap-2">
              <PButton size="sm" variant="ghost" @click="isGlobalOpen = true">
                {{ __t('ui.settings', '管理服务商连接') }}
              </PButton>
            </div>
          </div>
          <div v-if="!editorForm.providerConnectionId" class="flex flex-col gap-1.5">
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '品牌模板') }}
            </label>
            <PSelect
              :model-value="editorForm.provider"
              :options="providerOptions"
              @change="(value: string | number) => handleProviderChange(String(value))"
            />
          </div>
          <div v-if="selectedConnection" class="connection-summary">
            <div class="connection-summary__header">
              <span class="connection-summary__brand">
                <BrandIcon :brand="connectionSummaryBrand" size="md" fallback="provider" />
              </span>
              <div class="connection-summary__identity">
                <strong :title="selectedConnection.name">{{ selectedConnection.name }}</strong>
                <span>{{ connectionProtocolLabel }}</span>
              </div>
              <span
                class="connection-summary__auth"
                :class="{
                  'is-ready': connectionAuthStatus.ready,
                  'is-missing': connectionAuthStatus.missing,
                }"
              >
                <PixelIcon :name="connectionAuthStatus.icon" size="xs" aria-hidden="true" />
                {{ connectionAuthStatus.label }}
              </span>
            </div>
            <div class="connection-summary__endpoint">
              <PixelIcon name="link" size="xs" aria-hidden="true" />
              <code>{{ connectionApiBase || __t('ui.settings', '未设置地址') }}</code>
            </div>
            <div class="connection-summary__override">
              <span>{{ __t('ui.settings', '自定义此模型的连接') }}</span>
              <PSwitch
                size="sm"
                :aria-label="__t('ui.settings', '自定义此模型的连接')"
                :model-value="editorForm.connectionOverride"
                @update:model-value="setConnectionOverride"
              />
            </div>
          </div>
          <div
            v-if="editorForm.connectionOverride || !editorForm.providerConnectionId"
            class="flex flex-col gap-1.5"
          >
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '协议格式') }}
            </label>
            <PSelect v-model="editorForm.connectionProtocol" :options="customProviderTypeOptions" />
            <p class="text-[10px] text-slate-400">{{ __t('ui.settings', '按服务商文档选择。') }}</p>
          </div>
          <div
            v-if="editorForm.connectionOverride || !editorForm.providerConnectionId"
            class="flex flex-col gap-1.5"
          >
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '独立 API 地址') }}
            </label>
            <PInput v-model="editorForm.apiBase" placeholder="https://api.example.com/v1" />
          </div>
          <div
            v-if="editorForm.connectionOverride || !editorForm.providerConnectionId"
            class="flex flex-col gap-1.5"
          >
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '认证方式') }}
            </label>
            <PSelect
              v-model="editorForm.connectionAuthMode"
              :options="[
                { value: 'api_key', label: 'API Key' },
                { value: 'none', label: __t('ui.settings', '无需认证') },
              ]"
            />
          </div>
          <div
            v-if="
              (editorForm.connectionOverride || !editorForm.providerConnectionId) &&
              editorForm.connectionAuthMode !== 'none'
            "
            class="flex flex-col gap-1.5"
          >
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel">
              {{ __t('ui.settings', '独立 API Key') }}
            </label>
            <PInput
              v-model="editorForm.apiKey"
              type="password"
              :placeholder="__t('ui.settings', 'API Key（留空清除）')"
            />
          </div>
          <!-- 模型 ID + 获取列表 -->
          <div class="flex flex-col gap-1.5">
            <label
              class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel flex items-center justify-between"
            >
              <span class="model-id-label">
                <BrandIcon :brand="resolveModelBrand(editorForm.modelId)" size="xs" />
                {{ __t('ui.settings', '模型 ID') }}
              </span>
              <PButton
                variant="ghost"
                size="sm"
                :loading="isFetchingRemote"
                @click="fetchRemoteModels"
              >
                <PixelIcon name="refresh" size="xs" />
                {{ __t('ui.settings', '获取模型列表') }}
              </PButton>
            </label>
            <BrandSelect
              v-if="remoteModels.length > 0"
              v-model="editorForm.modelId"
              :options="remoteModelChoices"
              :placeholder="__t('ui.settings', '从列表中选择...')"
            />
            <PInput
              v-model="editorForm.modelId"
              :placeholder="__t('ui.settings', '模型 ID，如 gpt-4o')"
              :aria-invalid="!!editorErrors.modelId"
            />
          </div>
          <!-- 请求参数：每项先决定是否传参，再显示匹配的编辑控件。 -->
          <div class="model-params flex flex-col gap-3 rounded border-2 p-3">
            <div class="flex items-center justify-between border-b border-slate-200 pb-2">
              <div>
                <h4 class="text-[11px] font-bold text-slate-700 font-pixel">
                  {{ __t('ui.settings', '请求参数') }}
                </h4>
                <p class="mt-0.5 text-[10px] text-slate-400">
                  {{ __t('ui.settings', '关闭的参数使用服务商默认值。') }}
                </p>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">OPTIONAL</span>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '流式输出') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '逐字显示回复') }}
                </span>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">STREAM</span>
              <div class="model-param-control flex justify-end">
                <PSwitch v-model="editorForm.stream" />
              </div>
            </div>

            <div v-if="editorProtocol === 'openai'" class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">Wire API</span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '按服务商支持的接口选择') }}
                </span>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">ENDPOINT</span>
              <div class="model-param-control">
                <PSelect v-model="editorForm.wireApi" :options="wireApiOptions" />
              </div>
            </div>

            <div
              v-if="editorProtocol === 'openai' && editorForm.wireApi === 'chat_completions'"
              class="model-param-row"
            >
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '思考兼容模式') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '通常选择自动') }}
                </span>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">DIALECT</span>
              <div class="model-param-control">
                <PSelect v-model="editorForm.reasoningDialect" :options="reasoningDialectOptions" />
              </div>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '显示原生思考') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '显示模型提供的思考摘要') }}
                </span>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">NATIVE</span>
              <div class="model-param-control flex justify-end">
                <PSwitch v-model="editorForm.returnNativeReasoning" />
              </div>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '思考等级') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{
                    legacyGeminiEffort
                      ? __t('ui.settings', '旧档位 {0} 按 {1} 发送', [
                          legacyGeminiEffort,
                          reasoningEffortValue,
                        ])
                      : geminiThinkingLevels
                        ? __t('ui.settings', '此模型不支持关闭思考')
                        : __t('ui.settings', '模型的思考强度')
                  }}
                </span>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">REASONING</span>
              <div class="model-param-control">
                <PSelect v-model="reasoningEffortValue" :options="reasoningEffortOptions" />
              </div>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '温度 Temperature') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '控制回复随机性，范围 0–2') }}
                </span>
              </div>
              <PSwitch v-model="sendTemperature" />
              <div v-if="sendTemperature" class="model-param-control">
                <PSlider v-model="temperatureValue" :min="0" :max="2" :step="0.1" show-input />
              </div>
              <span v-else class="model-param-off">{{ __t('ui.settings', '不传') }}</span>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">Top P</span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '核采样概率阈值，范围 0–1') }}
                </span>
              </div>
              <PSwitch v-model="sendTopP" />
              <div v-if="sendTopP" class="model-param-control">
                <PSlider v-model="topPValue" :min="0" :max="1" :step="0.05" show-input />
              </div>
              <span v-else class="model-param-off">{{ __t('ui.settings', '不传') }}</span>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '上下文窗口 Token') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '填写模型支持的上下文长度') }}
                </span>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">CONTEXT</span>
              <div class="model-param-control">
                <PInputNumber
                  v-model="editorForm.contextWindowTokens"
                  :min="1"
                  :max="2000000"
                  :step="1024"
                />
              </div>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '最大轮次') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '桌面对话，留空使用默认值') }}
                </span>
              </div>
              <span class="text-[9px] text-slate-400 font-mono">ReAct</span>
              <div class="model-param-control">
                <PInputNumber
                  v-model="editorForm.maxReActTurns"
                  :min="1"
                  :max="Number.MAX_SAFE_INTEGER"
                  :step="1"
                  :placeholder="String(DEFAULT_DESKTOP_REACT_MAX_TURNS)"
                />
              </div>
            </div>

            <div class="model-param-row">
              <div class="model-param-heading">
                <span class="text-xs font-bold text-slate-700">
                  {{ __t('ui.settings', '最大输出 Token') }}
                </span>
                <span class="text-[10px] text-slate-400">
                  {{ __t('ui.settings', '单次回复的长度上限') }}
                </span>
              </div>
              <PSwitch v-model="sendMaxTokens" />
              <div v-if="sendMaxTokens" class="model-param-control">
                <PInputNumber v-model="editorForm.maxTokens" :min="1" :max="2000000" :step="256" />
              </div>
              <span v-else class="model-param-off">{{ __t('ui.settings', '不传') }}</span>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 pt-1">
            <div class="capability-editor rounded border p-3">
              <PCheckbox
                v-model="editorForm.enableVision"
                :label="__t('ui.settings', '图片视觉 (Vision)')"
              />
              <p class="mt-1 text-[10px] leading-relaxed text-slate-400">
                {{ __t('ui.settings', '支持识图') }}
              </p>
            </div>
            <div class="capability-editor rounded border p-3">
              <PCheckbox
                v-model="editorForm.enableAudioInput"
                :label="__t('ui.settings', '音频输入 (Audio)')"
              />
              <p class="mt-1 text-[10px] leading-relaxed text-slate-400">
                {{ __t('ui.audio-input', '手动开启后，Gemini 协议连接可接收原生音频') }}
              </p>
            </div>
          </div>
        </fieldset>
      </div>
      <template #footer>
        <PButton
          variant="ghost"
          :disabled="isSavingModel || isReadingConnection"
          @click="isEditorOpen = false"
        >
          {{ __t('ui.settings', '取消') }}
        </PButton>
        <PButton
          variant="primary"
          :loading="isSavingModel"
          :disabled="isReadingConnection"
          @click="saveModel"
        >
          {{ editingModel ? __t('ui.settings', '保存') : __t('ui.settings', '添加') }}
        </PButton>
      </template>
    </PDialog>

    <ProviderConnectionsDialog
      v-model="isGlobalOpen"
      :connections="providerConnections"
      :templates="providerOptions"
      :defaults="providerDefaults"
      @changed="refreshConnections"
    />

    <!-- 任务指派弹窗 -->
    <PDialog
      v-model="isTaskAssignOpen"
      :title="__t('ui.settings', '任务指派')"
      width="min(780px, calc(100vw - 32px))"
    >
      <div class="model-dialog-body task-assignment-dialog">
        <section class="task-assignment-section">
          <div class="task-assignment-heading">
            <span class="task-assignment-heading-icon">
              <PixelIcon name="brain" size="sm" />
            </span>
            <div class="task-assignment-heading-copy">
              <h4>{{ __t('ui.settings', '系统任务') }}</h4>
              <p>{{ __t('ui.settings', '默认使用主模型，选择后自动保存。') }}</p>
            </div>
          </div>
          <div v-for="slot in TASK_SLOTS" :key="slot.key" class="task-assignment-row">
            <span class="task-assignment-row-icon" aria-hidden="true">
              <PixelIcon :name="slot.icon" size="sm" />
            </span>
            <div class="task-assignment-copy">
              <strong>{{ slot.label }}</strong>
              <p>{{ slot.description }}</p>
            </div>
            <BrandSelect
              teleport
              :model-value="taskAssignments[slot.key] || ''"
              :options="taskModelChoices"
              :aria-label="slot.label"
              class="task-assignment-select"
              @update:model-value="
                (v: string | number) => setTaskAssignment(slot.key, v ? String(v) : null)
              "
            />
          </div>
        </section>
        <section class="task-assignment-section">
          <div class="task-assignment-heading">
            <span class="task-assignment-heading-icon">
              <PixelIcon name="image" size="sm" />
            </span>
            <div class="task-assignment-heading-copy">
              <h4>{{ __t('ui.settings', '多模态转述') }}</h4>
              <p>{{ __t('ui.settings', '将图片转为文字，便于后续对话引用。') }}</p>
            </div>
            <PSwitch
              v-model="relayEnabled"
              :disabled="isSavingRelay"
              :aria-label="__t('ui.settings', '启用多模态转述')"
            />
          </div>
          <div class="task-assignment-fields" :class="{ 'is-disabled': !relayEnabled }">
            <div class="task-assignment-field">
              <span>{{ __t('ui.settings', '转述模型') }}</span>
              <BrandSelect
                v-model="relayModelConfigId"
                teleport
                :disabled="!relayEnabled || isSavingRelay"
                :options="visionModelChoices"
                :placeholder="__t('ui.settings', '选择已启用图片输入的模型')"
              />
              <p v-if="!visionModels.length" class="text-xs text-amber-600">
                {{ __t('ui.settings', '请先为至少一个模型开启“图片输入”。') }}
              </p>
            </div>
            <div class="task-assignment-field">
              <span>{{ __t('ui.settings', '转述详细度') }}</span>
              <PSelect
                v-model="relayDetail"
                teleport
                :disabled="!relayEnabled || isSavingRelay"
                :options="[
                  { label: __t('ui.settings', '简洁 · 快速概括'), value: 'brief' },
                  { label: __t('ui.settings', '标准 · 主体、状态与可见文字'), value: 'standard' },
                  {
                    label: __t('ui.settings', '详细 · 布局、对象关系与文字识别'),
                    value: 'detailed',
                  },
                ]"
              />
            </div>
          </div>
          <div class="task-assignment-footer">
            <p class="task-assignment-rules">
              <PixelIcon name="info" size="xs" aria-hidden="true" />
              {{ __t('ui.settings', '后续对话保留转述文字，不重复发送原图。') }}
            </p>
            <PButton
              size="sm"
              :loading="isSavingRelay"
              :disabled="isSavingRelay"
              @click="saveRelayConfig"
            >
              {{ __t('ui.settings', '保存转述配置') }}
            </PButton>
          </div>
        </section>
      </div>
      <template #footer>
        <PButton variant="primary" @click="isTaskAssignOpen = false">
          {{ __t('ui.settings', '完成') }}
        </PButton>
      </template>
    </PDialog>

    <!-- 角色模型指派弹窗 -->
    <PDialog v-model="isAgentAssignOpen" :title="__t('ui.settings', '角色指派')" width="680px">
      <div class="model-dialog-body agent-assignment-dialog">
        <div class="agent-assignment-intro">
          <div class="agent-assignment-intro__icon">
            <PixelIcon name="sparkles" size="sm" />
          </div>
          <div>
            <strong>{{ __t('ui.settings', '选择角色使用的模型') }}</strong>
            <p>{{ __t('ui.settings', '未指派时使用主模型。') }}</p>
          </div>
        </div>

        <div v-if="agentStore.enabledAgents.length" class="agent-assignment-list">
          <article
            v-for="(agent, index) in agentStore.enabledAgents"
            :key="agent.id"
            class="agent-assignment-card"
            :style="{ '--agent-delay': `${index * 45}ms` }"
          >
            <div class="agent-assignment-card__identity">
              <div class="agent-assignment-avatar">
                <img
                  v-if="avatarUrlOf(agent.avatarUrl)"
                  :src="avatarUrlOf(agent.avatarUrl)"
                  :alt="agent.name"
                />
                <span v-else>{{ (agent.name || agent.id).slice(0, 1).toUpperCase() }}</span>
                <i class="agent-assignment-avatar__status" />
              </div>
              <div class="agent-assignment-card__copy">
                <div class="agent-assignment-card__title">
                  <strong>{{ agent.name || agent.id }}</strong>
                  <span>@{{ agent.id }}</span>
                </div>
                <p>{{ assignedModelName(agent.id) }}</p>
              </div>
            </div>

            <div class="agent-assignment-card__selector">
              <span class="agent-assignment-card__label">{{ __t('ui.settings', '对话模型') }}</span>
              <BrandSelect
                teleport
                :model-value="agentAssignments[agent.id] || ''"
                :options="agentModelChoices"
                class="w-56"
                @update:model-value="
                  (value: string | number) =>
                    setAgentAssignment(agent.id, value ? String(value) : null)
                "
              />
            </div>
          </article>
        </div>

        <div v-else class="agent-assignment-empty">
          <PixelIcon name="users" size="md" />
          <strong>{{ __t('ui.settings', '还没有可指派的角色') }}</strong>
          <span>{{ __t('ui.settings', '请先在角色配置中启用至少一个角色。') }}</span>
        </div>
      </div>
      <template #footer>
        <PButton variant="primary" @click="isAgentAssignOpen = false">
          {{ __t('ui.settings', '完成') }}
        </PButton>
      </template>
    </PDialog>
  </div>
</template>

<style scoped>
.model-editor-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.model-editor-fields[disabled] {
  pointer-events: none;
  opacity: 0.75;
}
.model-editor-fields :deep(input[aria-invalid='true']) {
  border-color: var(--ui-danger);
}
.model-editor-errors {
  padding: 12px;
  border: 1px solid var(--ui-danger);
  border-radius: 6px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.model-editor-errors strong {
  display: flex;
  align-items: center;
  gap: 6px;
}
.model-editor-errors ul {
  margin: 4px 0 0;
  padding-left: 18px;
  list-style: disc;
}
.model-connection-picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.model-test-result {
  font-size: 11px;
  line-height: 1.8;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.model-test-result.is-error {
  color: var(--ui-accent-rose);
}
.connection-summary {
  padding: 12px 14px 8px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 4px;
  background:
    linear-gradient(
      125deg,
      color-mix(in srgb, var(--ui-accent-purple) 5%, transparent),
      transparent 65%
    ),
    var(--ui-bg-surface-soft);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ui-text-primary) 3%, transparent);
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.connection-summary__header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.connection-summary__brand {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 4px;
  background: var(--ui-bg-surface);
}
.connection-summary__identity {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 2px;
}
.connection-summary__identity strong {
  overflow: hidden;
  color: var(--ui-text-primary);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-summary__identity > span {
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.connection-summary__auth {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  white-space: nowrap;
}
.connection-summary__auth.is-ready {
  color: var(--ui-success);
}
.connection-summary__auth.is-missing {
  color: var(--ui-warning);
}
.connection-summary__endpoint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  color: var(--ui-text-secondary);
}
.connection-summary__endpoint > .pixel-icon {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--ui-text-tertiary);
}
.connection-summary__endpoint code {
  min-width: 0;
  background: transparent;
  color: inherit;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  user-select: text;
}
.connection-summary__override {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  padding-top: 6px;
  border-top: 1px solid var(--ui-border-subtle);
  font-size: 11px;
}
.task-assignment-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: var(--ui-font-sans);
}
.task-assignment-section {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0;
  padding: 16px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 8px;
  background: var(--dash-panel-soft);
}
.task-assignment-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
}
.task-assignment-heading-icon {
  display: grid;
  flex: 0 0 34px;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 20%, var(--ui-border-subtle));
  border-radius: 7px;
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
}
/* 单独约束文字容器，避免将 PixelIcon 的外层 div 一并拉伸。 */
.task-assignment-heading-copy {
  flex: 1;
  min-width: 0;
}
.task-assignment-heading h4,
.task-assignment-copy strong,
.task-assignment-field > span {
  color: var(--ui-text-primary);
  font-size: 13px;
  font-weight: 700;
  margin: 0;
}
.task-assignment-heading p,
.task-assignment-copy p,
.task-assignment-rules {
  margin: 4px 0 0;
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.8;
}
.task-assignment-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) minmax(0, 252px);
  align-items: center;
  gap: 12px;
  min-height: 70px;
  padding: 12px 0;
  border-top: 1px solid var(--ui-border-subtle);
}
.task-assignment-row-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--ui-text-tertiary);
  background: var(--ui-bg-hover);
}
.task-assignment-select :deep(.p-select-trigger) {
  min-height: 38px;
}
.task-assignment-copy,
.task-assignment-select {
  min-width: 0;
}
.task-assignment-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task-assignment-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--ui-border-subtle);
}
.task-assignment-fields.is-disabled {
  opacity: 0.6;
}
.task-assignment-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 16px;
}
.task-assignment-footer > .p-btn {
  margin-left: auto;
  flex-shrink: 0;
}
.task-assignment-rules {
  display: flex;
  align-items: flex-start;
  flex: 1 1 260px;
  gap: 6px;
  margin: 0;
  color: var(--ui-text-tertiary);
}
.task-assignment-rules > .pixel-icon {
  flex-shrink: 0;
  margin-top: 3px;
}
@media (max-width: 620px) {
  .task-assignment-row {
    grid-template-columns: 28px minmax(0, 1fr);
    gap: 8px;
  }
  .task-assignment-select {
    grid-column: 2 / -1;
  }
  .task-assignment-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .task-assignment-section {
    padding: 12px;
  }
}
.model-card-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
  margin-right: 10px;
}
.model-provider-line,
.model-id-label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}
.model-provider-line > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 模型配置业务区使用主题语义色，语义色仅承担状态强调。 */
.model-config-tab {
  color: var(--ui-text-primary);
}
.model-config-tab :is(.text-slate-800, .text-slate-700, .text-slate-600) {
  color: var(--ui-text-primary);
}
/* 弹窗内容（Teleport 到 body，不受 .model-config-tab 祖先兜底影响） */
.model-dialog-body :is(.text-slate-800, .text-slate-700, .text-slate-600) {
  color: var(--ui-text-primary);
}
.model-dialog-body :is(.text-slate-500, .text-slate-400) {
  color: var(--ui-text-secondary);
}
.model-dialog-body :is(.text-slate-300) {
  color: var(--ui-text-tertiary);
}
.model-dialog-body [class*='border-slate-'] {
  border-color: var(--ui-border-default);
}
.model-config-tab :is(.text-slate-500, .text-slate-400) {
  color: var(--ui-text-secondary);
}
.capability-group,
.model-params,
.capability-editor,
.reranker-disabled {
  border-color: var(--ui-border-default);
  background: var(--dash-panel-soft);
  color: var(--ui-text-secondary);
}
.main-model-badge {
  border: 2px solid var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  box-shadow: 1px 1px 0 var(--ui-accent-sky);
}
.main-model-button {
  border-color: var(--ui-accent-sky);
  background: var(--dash-panel-soft);
  color: var(--ui-accent-sky);
  box-shadow: 3px 3px 0 var(--ui-border-strong);
}
.main-model-button:hover {
  background: var(--ui-accent-sky-soft);
}
.main-model-button--active {
  background: var(--ui-accent-sky);
  color: var(--ui-text-inverse);
  box-shadow: 3px 3px 0 var(--ui-border-strong);
}
.main-model-button:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 var(--ui-border-strong);
}

.agent-assign-trigger {
  position: relative;
  overflow: hidden;
}
.agent-assign-trigger::after {
  content: '';
  position: absolute;
  inset: -40% auto -40% -35%;
  width: 22%;
  transform: skewX(-18deg);
  background: color-mix(in srgb, var(--ui-accent-sky) 22%, transparent);
  transition: left 360ms ease;
  pointer-events: none;
}
.agent-assign-trigger:hover::after {
  left: 112%;
}
.agent-assignment-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: min(68vh, 620px);
}
.agent-assignment-intro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border: 2px solid color-mix(in srgb, var(--ui-accent-sky) 46%, var(--ui-border-default));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--ui-accent-sky-soft) 75%, transparent),
      transparent 68%
    ),
    var(--dash-panel-soft);
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--ui-border-strong) 72%, transparent);
}
.agent-assignment-intro__icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  color: var(--ui-accent-sky);
  border: 2px solid currentColor;
  background: var(--ui-bg-surface);
  animation: agent-sparkle 2.8s ease-in-out infinite;
}
.agent-assignment-intro strong {
  display: block;
  color: var(--ui-text-primary);
  font-size: 13px;
}
.agent-assignment-intro p {
  margin: 3px 0 0;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.agent-assignment-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 5px 5px 2px;
}
.agent-assignment-card {
  --agent-delay: 0ms;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 13px 14px;
  border: 2px solid var(--ui-border-default);
  background: var(--ui-bg-surface);
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--ui-border-strong) 76%, transparent);
  animation: agent-card-in 320ms steps(4, end) both;
  animation-delay: var(--agent-delay);
  transition:
    transform 140ms ease,
    border-color 140ms ease,
    box-shadow 140ms ease;
}
.agent-assignment-card::before {
  content: '';
  position: absolute;
  left: -2px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  background: var(--ui-accent-sky);
  opacity: 0.68;
}
.agent-assignment-card:hover {
  transform: translate(-1px, -2px);
  border-color: color-mix(in srgb, var(--ui-accent-sky) 58%, var(--ui-border-default));
  box-shadow: 5px 5px 0 color-mix(in srgb, var(--ui-accent-sky) 24%, var(--ui-border-strong));
}
.agent-assignment-card__identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.agent-assignment-avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  overflow: visible;
  color: var(--ui-accent-sky);
  border: 2px solid color-mix(in srgb, var(--ui-accent-sky) 68%, var(--ui-border-strong));
  background: var(--ui-accent-sky-soft);
  box-shadow: 2px 2px 0 var(--ui-border-strong);
}
.agent-assignment-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  image-rendering: auto;
}
.agent-assignment-avatar > span {
  font-family: var(--font-pixel, monospace);
  font-weight: 900;
}
.agent-assignment-avatar__status {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 11px;
  height: 11px;
  border: 2px solid var(--ui-bg-surface);
  background: var(--ui-accent-mint, #34d399);
  box-shadow: 1px 1px 0 var(--ui-border-strong);
}
.agent-assignment-card__copy {
  min-width: 0;
}
.agent-assignment-card__title {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.agent-assignment-card__title strong {
  color: var(--ui-text-primary);
  font-size: 14px;
}
.agent-assignment-card__title span,
.agent-assignment-card__copy p,
.agent-assignment-card__label {
  color: var(--ui-text-secondary);
  font-size: 10px;
}
.agent-assignment-card__copy p {
  margin: 4px 0 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-accent-sky);
  font-weight: 700;
}
.agent-assignment-card__selector {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  flex: 0 0 auto;
}
.agent-assignment-card__label {
  letter-spacing: 0.12em;
  font-family: var(--font-pixel, monospace);
}
.agent-assignment-empty {
  display: grid;
  place-items: center;
  gap: 7px;
  min-height: 180px;
  color: var(--ui-text-secondary);
  border: 2px dashed var(--ui-border-default);
  background: var(--dash-panel-soft);
  text-align: center;
}
.agent-assignment-empty strong {
  color: var(--ui-text-primary);
}
.agent-assignment-empty span {
  font-size: 11px;
}
@keyframes agent-card-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes agent-sparkle {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  50% {
    transform: translateY(-2px) rotate(3deg);
  }
}
@media (max-width: 720px) {
  .agent-assignment-card {
    align-items: stretch;
    flex-direction: column;
  }
  .agent-assignment-card__selector {
    align-items: stretch;
  }
  .agent-assignment-card__selector :deep(.p-select) {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-assignment-card,
  .agent-assignment-intro__icon {
    animation: none;
  }
  .agent-assign-trigger::after {
    display: none;
  }
}

/* 模型卡片按实际内容宽度排成三列，窄屏逐级收为两列和单列。 */
.model-config-layout {
  min-width: 0;
  container: model-config / inline-size;
}
.model-card-grid {
  min-height: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: max-content;
  gap: 16px;
  padding-left: 2px;
  padding-bottom: 6px;
  scroll-padding-top: 8px;
}
.model-card-grid .model-config-card {
  min-width: 0;
  min-height: min-content;
  padding: 14px;
  border-width: 2px;
  border-color: color-mix(in srgb, var(--ui-border-strong) 82%, transparent);
  background:
    linear-gradient(90deg, var(--ui-accent-sky) 0 26px, transparent 26px) top left / 56px 2px
      no-repeat,
    var(--ui-bg-surface);
  box-shadow: 2px 2px 0 color-mix(in srgb, var(--ui-border-strong) 88%, transparent);
}
.model-config-card :deep(.p-card-body) {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.model-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.model-card-header .model-card-identity {
  flex: 1;
  gap: 9px;
  margin-right: 0;
}
.model-card-name {
  overflow: hidden;
  color: var(--ui-text-primary);
  font-size: 14px;
  font-weight: 800;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-card-actions {
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-color: var(--ui-border-subtle);
}
.model-card-actions .main-model-button {
  min-height: 28px;
  padding: 3px 7px;
  font-size: 10px;
  white-space: nowrap;
}
.model-card-secondary-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.model-card-secondary-actions :deep(.p-btn-sm) {
  padding: 5px 6px;
  font-size: 11px;
}
.model-detail-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 8px;
  margin: 0;
  padding: 10px;
  border: 1px solid var(--ui-border-subtle);
  background: color-mix(in srgb, var(--ui-bg-hover) 48%, transparent);
}
.model-detail-grid > div {
  min-width: 0;
}
.model-detail-grid dt {
  color: var(--ui-text-secondary);
  font-size: 10px;
  line-height: 1.5;
}
.model-detail-grid dd {
  overflow: hidden;
  margin: 4px 0 0;
  color: var(--ui-text-primary);
  font: 600 11px/1.5 var(--ui-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: uppercase;
}
.model-detail-grid .model-detail-id {
  display: flex;
  align-items: baseline;
  gap: 12px;
  grid-column: 1 / -1;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.model-detail-id dt {
  flex-shrink: 0;
}
.model-detail-id dd {
  flex: 1;
  margin: 0;
  text-align: right;
  text-transform: none;
}
.model-capability-panel {
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface);
}
.model-capability-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.model-capability-toggle {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px;
  cursor: pointer;
  transition: background-color 120ms;
}
.model-capability-toggle + .model-capability-toggle {
  border-left: 1px solid var(--ui-border-subtle);
}
.model-capability-toggle:hover,
.model-capability-toggle:focus-within {
  background: var(--ui-bg-hover);
}
.model-capability-toggle.is-enabled {
  background: color-mix(in srgb, var(--ui-accent-sky-soft) 24%, transparent);
}
.model-capability-toggle-audio.is-enabled {
  background: color-mix(in srgb, var(--ui-accent-purple-soft) 24%, transparent);
}
.model-capability-toggle-audio :deep(.p-switch-wrapper) {
  --switch-accent: var(--ui-accent-purple);
}
.model-capability-toggle strong {
  max-width: 100%;
  overflow: hidden;
  color: var(--ui-text-secondary);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@container model-config (max-width: 900px) {
  .model-card-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container model-config (max-width: 600px) {
  .model-card-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  .model-capability-toggle {
    transition: none;
  }
}

/* 模型参数卡：开关决定字段是否进入请求，控件仅在启用后可见。 */
.model-param-row {
  display: grid;
  grid-template-columns: minmax(144px, 1fr) auto minmax(220px, 1.6fr);
  align-items: center;
  gap: 12px;
  min-height: 48px;
}

.model-param-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-param-control {
  min-width: 0;
}

.model-param-off {
  justify-self: end;
  color: var(--ui-text-tertiary);
  font-family: var(--font-pixel), monospace;
  font-size: 10px;
}

@media (max-width: 620px) {
  .model-param-row {
    grid-template-columns: 1fr auto;
  }

  .model-param-control {
    grid-column: 1 / -1;
  }
}
</style>
