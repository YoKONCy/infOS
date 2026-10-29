import { t as __t } from '../../i18n/index'
/**
 * useModelConfig — 模型配置 composable
 *
 * 管理 LLM 模型列表的 CRUD + 任务指派 (主模型 + 任务槽)
 * 以及向量模型 (Embedding / Reranker) 配置。
 *
 * F3: 已对接 modelApi + configApi 真实后端。
 *
 * @module packages/frontend/src/composables/dashboard/useModelConfig
 */
import { ref, shallowRef, computed, onMounted, watch } from 'vue'
import { modelApi } from '../../api/modules/modelApi'
import type { ModelConfigItem, ReasoningEffort } from '../../api/modules/modelApi'
import { configApi } from '../../api/modules/configApi'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { logger } from '../../lib/logger'
import { ApiError } from '../../api/errors'
import { prepareModelPayload, type ModelEditorErrors } from '../../lib/modelEditor'
import { EMBEDDING_ENABLED_KEY } from '@infos/shared'
import { useConfigSwitch } from './useConfigSwitch'
import {
  providerApi,
  type ProviderConnectionItem,
  type ProviderProtocol,
  type ProviderAuthMode,
} from '../../api/modules/providerApi'

// ── 类型 ──

export interface LlmModel {
  id: string
  name: string
  provider: string
  modelId: string
  maxTokens: number | null
  contextWindowTokens: number | null
  maxReActTurns: number | null
  reasoningEffort: ReasoningEffort | null
  returnNativeReasoning: boolean
  wireApi: 'chat_completions' | 'responses'
  reasoningDialect: 'auto' | 'openai' | 'deepseek' | 'openrouter' | 'generic'
  stream: boolean
  enableVision: boolean
  enableAudioInput: boolean
  temperature: number | null
  topP: number | null
  apiBase?: string
  apiKey?: string
  /** 旧版模型用途字段；请求协议由 connectionProtocol 单独保存。 */
  providerType: string
  providerConnectionId: string | null
  connectionOverride: boolean
  connectionProtocol: ProviderProtocol
  connectionAuthMode: ProviderAuthMode
}

export type ModelTab = 'llm' | 'vector'

/** 任务槽元数据（供前端 UI 使用） */
export const TASK_SLOTS = [
  {
    key: 'approval',
    get label() {
      return __t('ui.settings', '工具审批')
    },
    get description() {
      return __t('ui.settings', '自动审批终端操作与工作区外删除；未指派时跟随主模型')
    },
    icon: 'check',
  },
  {
    key: 'knowledge',
    get label() {
      return __t('ui.settings', '知识整理')
    },
    get description() {
      return __t('ui.settings', '整理文档摘要、关键词与内容切片')
    },
    icon: 'book',
  },
  {
    key: 'scorer',
    get label() {
      return __t('ui.settings', '整理长期记忆')
    },
    get description() {
      return __t('ui.settings', '从对话中找出以后仍值得记住的内容')
    },
    icon: 'brain',
  },
  {
    key: 'reflection',
    get label() {
      return __t('ui.settings', '整理记忆关系')
    },
    get description() {
      return __t('ui.settings', '关联相近经历、修正内容并减少重复记忆')
    },
    icon: 'link',
  },
  {
    key: 'social_scorer',
    get label() {
      return __t('ui.settings', '整理社交记忆')
    },
    get description() {
      return __t('ui.settings', '从社交互动中保留重要的人物印象与经历')
    },
    icon: 'chat',
  },
  {
    key: 'butler',
    get label() {
      return __t('ui.settings', '据点管家')
    },
    get description() {
      return __t('ui.settings', '理解房间管理请求，并协助安排角色与环境')
    },
    icon: 'home',
  },
] as const

// ── 辅助函数 ──

/** 后端 DTO → 前端 LlmModel */
function toLlmModel(item: ModelConfigItem): LlmModel {
  return {
    id: String(item.id),
    name: item.name,
    provider: item.provider,
    modelId: item.modelId,
    maxTokens: item.maxTokens,
    contextWindowTokens: item.contextWindowTokens,
    maxReActTurns: item.maxReActTurns ?? null,
    reasoningEffort: item.reasoningEffort,
    returnNativeReasoning: item.returnNativeReasoning ?? false,
    wireApi: item.wireApi ?? 'chat_completions',
    reasoningDialect: item.reasoningDialect ?? 'auto',
    stream: item.stream ?? true,
    enableVision: item.enableVision ?? false,
    enableAudioInput: item.enableAudioInput ?? false,
    temperature: item.temperature,
    topP: item.topP,
    apiBase: item.apiBase,
    apiKey: item.apiKey, // 后端已遮蔽
    providerType: item.providerType ?? 'openai',
    providerConnectionId: item.providerConnectionId ?? null,
    connectionOverride: item.connectionOverride ?? false,
    connectionProtocol:
      item.connectionProtocol ??
      (item.provider === 'gemini'
        ? 'gemini'
        : ['anthropic', 'claude'].includes(item.provider)
          ? 'anthropic'
          : 'openai'),
    connectionAuthMode: item.connectionAuthMode ?? 'api_key',
  }
}

// ── Composable ──

export function useModelConfig() {
  const {
    enabled: embeddingEnabled,
    ready: embeddingSwitchReady,
    saving: embeddingSwitchSaving,
    setEnabled: setEmbeddingEnabled,
  } = useConfigSwitch(EMBEDDING_ENABLED_KEY, '向量功能', false)
  const notify = useNotificationStore()
  // ── LLM 模型列表 ──
  const models = shallowRef<LlmModel[]>([])
  const currentTab = ref<ModelTab>('llm')
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const modelTests = ref<Record<string, { loading: boolean; success?: boolean; message: string }>>(
    {},
  )
  const switchingConnections = ref<Record<string, boolean>>({})

  async function testModel(id: string): Promise<void> {
    if (modelTests.value[id]?.loading) return
    modelTests.value[id] = {
      loading: true,
      get message() {
        return __t('ui.settings', '测试中…')
      },
    }
    try {
      const result = (await modelApi.test(id)).data
      if (!result) throw new Error('模型测试未返回结果')
      modelTests.value[id] = {
        loading: false,
        success: result.success,
        get message() {
          return __t('ui.settings', '推理成功 · {0} ms{1}', [
            result.durationMs,
            result.response ? ` · ${result.response}` : '',
          ])
        },
      }
    } catch (failure) {
      modelTests.value[id] = { loading: false, success: false, message: (failure as Error).message }
    }
  }

  async function setModelConnection(model: LlmModel, connectionId: string): Promise<void> {
    if (switchingConnections.value[model.id]) return
    const connection = providerConnections.value.find((item) => item.id === connectionId)
    if (!connection) return
    switchingConnections.value[model.id] = true
    try {
      await modelApi.update(model.id, {
        providerConnectionId: connectionId,
        connectionOverride: false,
        provider: connection.brand,
        connectionProtocol: connection.protocol,
        connectionAuthMode: connection.authMode,
      })
      delete modelTests.value[model.id]
      await fetchModels()
      notify.toast(__t('ui.settings', '已切换到「{0}」', [connection.name]), 'success')
      window.dispatchEvent(new CustomEvent('infos:model-capabilities-changed'))
    } catch (failure) {
      notify.toast(__t('ui.settings', '切换服务商失败：') + (failure as Error).message, 'error')
    } finally {
      switchingConnections.value[model.id] = false
    }
  }

  // ── 主模型 + 任务指派 ──
  const mainModelId = ref<string | null>(null)
  const taskAssignments = ref<Record<string, string | null>>({})
  const agentAssignments = ref<Record<string, string | null>>({})
  // 指派弹窗
  const isTaskAssignOpen = ref(false)
  const isAgentAssignOpen = ref(false)

  // ── 编辑弹窗 ──
  const isEditorOpen = ref(false)
  const isSavingModel = ref(false)
  const isReadingConnection = ref(false)
  const editorErrors = ref<ModelEditorErrors>({})
  const editingModel = ref<LlmModel | null>(null)
  const editorForm = ref<LlmModel>({
    id: '',
    name: '',
    provider: 'openai',
    modelId: '',
    maxTokens: null,
    contextWindowTokens: null,
    maxReActTurns: null,
    reasoningEffort: null,
    returnNativeReasoning: false,
    wireApi: 'chat_completions',
    reasoningDialect: 'auto',
    stream: true,
    enableVision: false,
    enableAudioInput: false,
    temperature: null,
    topP: null,
    apiBase: '',
    apiKey: '',
    providerType: 'openai',
    providerConnectionId: null,
    connectionOverride: false,
    connectionProtocol: 'openai',
    connectionAuthMode: 'api_key',
  })

  // ── 全局配置弹窗 ──
  const isGlobalOpen = ref(false)
  const providerConnections = ref<ProviderConnectionItem[]>([])
  const selectedConnection = computed(() =>
    providerConnections.value.find(
      (connection) => connection.id === editorForm.value.providerConnectionId,
    ),
  )
  watch(isGlobalOpen, (visible) => {
    if (visible) void loadConnections()
  })

  async function loadConnections(): Promise<void> {
    try {
      providerConnections.value = (await providerApi.list()).data ?? []
    } catch (e) {
      notify.toast(__t('ui.settings', '加载服务商连接失败：') + (e as Error).message, 'error')
    }
  }

  async function handleConnectionChange(id: string): Promise<void> {
    if (isReadingConnection.value || isSavingModel.value) return
    if (!id) {
      const previousId = editorForm.value.providerConnectionId
      if (previousId && !editorForm.value.connectionOverride) {
        await setConnectionOverride(true)
        if (
          !isEditorOpen.value ||
          editorForm.value.providerConnectionId !== previousId ||
          !editorForm.value.connectionOverride
        )
          return
      }
      editorForm.value.providerConnectionId = null
      editorForm.value.connectionOverride = true
      remoteModels.value = []
      editorErrors.value = {}
      return
    }
    const connection = providerConnections.value.find((item) => item.id === id)
    if (!connection) return
    Object.assign(editorForm.value, {
      providerConnectionId: id,
      provider: connection.brand,
      connectionProtocol: connection.protocol,
      connectionAuthMode: connection.authMode,
      connectionOverride: false,
      apiBase: '',
      apiKey: '',
    })
    remoteModels.value = []
    editorErrors.value = {}
  }

  async function setConnectionOverride(enabled: boolean): Promise<void> {
    if (isReadingConnection.value || isSavingModel.value) return
    if (!enabled) {
      editorForm.value.connectionOverride = false
      return
    }
    const id = editorForm.value.providerConnectionId
    if (!id) return
    isReadingConnection.value = true
    try {
      const connection = (await providerApi.get(id)).data
      if (!connection) throw new Error('服务商连接不存在')
      if (!isEditorOpen.value || editorForm.value.providerConnectionId !== id) return
      Object.assign(editorForm.value, {
        connectionOverride: true,
        apiBase: connection.apiBase,
        apiKey: connection.apiKey,
        provider: connection.brand,
        connectionProtocol: connection.protocol,
        connectionAuthMode: connection.authMode,
      })
    } catch (e) {
      notify.toast(__t('ui.settings', '读取连接配置失败：') + (e as Error).message, 'error')
    } finally {
      isReadingConnection.value = false
    }
  }

  /** 独立卡片可直接选择模板，地址与协议仍允许自行修改。 */
  function handleProviderChange(provider: string): void {
    Object.assign(editorForm.value, {
      provider,
      connectionProtocol:
        provider === 'gemini' ? 'gemini' : provider === 'anthropic' ? 'anthropic' : 'openai',
      connectionAuthMode: provider === 'ollama' ? 'none' : 'api_key',
      apiBase: providerDefaults[provider] || '',
      apiKey: '',
    })
    remoteModels.value = []
    editorErrors.value = {}
  }

  // ── 向量配置 ──
  const embeddingProvider = ref<'local' | 'api'>('api')
  const embeddingModelId = ref('text-embedding-3-small')
  const embeddingDimension = ref(1536)
  const embeddingApiBase = ref('')
  const embeddingApiKey = ref('')
  const rerankerEnabled = ref(false)
  const rerankerModelId = ref('')
  const rerankerApiBase = ref('')
  const rerankerApiKey = ref('')
  const isSavingVector = ref(false)
  const embeddingActivationRevision = ref(0)
  const embeddingActivationResult = ref<{
    status: 'success' | 'error'
    message: string
    durationMs?: number
  } | null>(null)
  watch([embeddingModelId, embeddingDimension], () => {
    embeddingActivationResult.value = null
  })

  // ── 多模态转述配置 ──
  const relayEnabled = ref(false)
  const relayModelConfigId = ref<string>('')
  const relayDetail = ref<'brief' | 'standard' | 'detailed'>('standard')
  const isSavingRelay = ref(false)
  const visionModels = computed(() => models.value.filter((model) => model.enableVision))

  // ── 计算属性 ──
  const providerOptions = computed(() => [
    // 国际主流
    { label: 'OpenAI', value: 'openai' },
    { label: 'Anthropic (Claude)', value: 'anthropic' },
    { label: 'Google (Gemini)', value: 'gemini' },
    { label: 'xAI (Grok)', value: 'xai' },
    { label: 'Mistral', value: 'mistral' },
    { label: 'Groq', value: 'groq' },
    // 国内服务商
    {
      get label() {
        return __t('ui.settings', 'SiliconFlow (硅基流动)')
      },
      value: 'siliconflow',
    },
    {
      get label() {
        return __t('ui.settings', 'DeepSeek (深度求索)')
      },
      value: 'deepseek',
    },
    { label: 'Moonshot (Kimi)', value: 'moonshot' },
    {
      get label() {
        return __t('ui.settings', 'DashScope (阿里百炼)')
      },
      value: 'dashscope',
    },
    {
      get label() {
        return __t('ui.settings', 'Volcengine (火山引擎)')
      },
      value: 'volcengine',
    },
    {
      get label() {
        return __t('ui.settings', 'Zhipu (智谱GLM)')
      },
      value: 'zhipu',
    },
    { label: 'MiniMax', value: 'minimax' },
    {
      get label() {
        return __t('ui.settings', '01.AI (零一万物)')
      },
      value: 'yi',
    },
    {
      get label() {
        return __t('ui.settings', 'StepFun (阶跃星辰)')
      },
      value: 'stepfun',
    },
    {
      get label() {
        return __t('ui.settings', 'Hunyuan (腾讯混元)')
      },
      value: 'hunyuan',
    },
    // 本地
    {
      get label() {
        return __t('ui.settings', 'Ollama (本地部署)')
      },
      value: 'ollama',
    },
    // 自定义
    {
      get label() {
        return __t('ui.settings', '自定义')
      },
      value: 'custom',
    },
  ])

  /**
   * 供应商默认 API Base 表
   *
   * 在用户切换 provider 时自动填充，减少配置成本。
   * 对齐后端 LlmService.DEFAULT_API_BASES。
   */
  const providerDefaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    siliconflow: 'https://api.siliconflow.cn/v1',
    deepseek: 'https://api.deepseek.com/v1',
    moonshot: 'https://api.moonshot.cn/v1',
    dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
    groq: 'https://api.groq.com/openai/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    minimax: 'https://api.minimax.chat/v1',
    mistral: 'https://api.mistral.ai/v1',
    yi: 'https://api.lingyiwanwu.com/v1',
    xai: 'https://api.x.ai/v1',
    stepfun: 'https://api.stepfun.com/v1',
    hunyuan: 'https://api.hunyuan.cloud.tencent.com/v1',
    ollama: 'http://localhost:11434/v1',
  }

  /** 自定义 provider 的协议格式选项 */
  const customProviderTypeOptions = computed(() => [
    {
      get label() {
        return __t('ui.settings', 'OpenAI 兼容')
      },
      value: 'openai',
    },
    {
      get label() {
        return __t('ui.settings', 'Anthropic 兼容')
      },
      value: 'anthropic',
    },
    {
      get label() {
        return __t('ui.settings', 'Gemini 兼容')
      },
      value: 'gemini',
    },
  ])

  // ── 远程模型列表 ──
  const remoteModels = ref<string[]>([])
  const isFetchingRemote = ref(false)
  const remoteEmbeddingModels = ref<string[]>([])
  const isFetchingEmbedding = ref(false)
  const remoteRerankerModels = ref<string[]>([])
  const isFetchingReranker = ref(false)

  // ── API 操作 ──

  /** 从后端加载模型列表 */
  async function fetchModels(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const res = await modelApi.list()
      models.value = (res.data ?? []).map(toLlmModel)
    } catch (e) {
      error.value = (e as Error).message
      notify.toast(__t('ui.settings', '加载模型列表失败: ') + (e as Error).message, 'error')
      logger.error('ModelConfig', __t('logs.frontend.settings', '加载模型列表失败'), e)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 获取远程服务商可用模型列表
   *
   * 默认使用已保存连接；开启独立覆盖时，使用当前表单中的完整连接参数。
   */
  async function fetchRemoteModels(): Promise<void> {
    const form = editorForm.value

    isFetchingRemote.value = true
    remoteModels.value = []
    error.value = null
    try {
      const res = await modelApi.listRemote({
        provider: form.provider,
        protocol: form.connectionProtocol,
        apiKey: form.connectionAuthMode === 'none' ? '' : form.apiKey || '',
        apiBase: form.apiBase,
        providerConnectionId: form.providerConnectionId || undefined,
        connectionOverride: form.connectionOverride,
      })
      remoteModels.value = res.data ?? []
      if (remoteModels.value.length > 0) {
        notify.toast(
          __t('ui.settings', '已获取 {0} 个可用模型', [remoteModels.value.length]),
          'success',
        )
      } else {
        notify.toast(__t('ui.settings', '列表为空，可手动填写模型 ID'), 'info')
      }
    } catch (e) {
      error.value = (e as Error).message
      notify.toast(__t('ui.settings', '获取列表失败：') + (e as Error).message, 'warning')
      logger.error('ModelConfig', __t('logs.frontend.settings', '获取远程模型列表失败'), e)
    } finally {
      isFetchingRemote.value = false
    }
  }

  /** 从后端加载主模型配置 (config KV: model.main) */
  async function fetchMainModel(): Promise<void> {
    try {
      const res = await configApi.get('model.main')
      mainModelId.value = (res.data?.value as string) || null
    } catch {
      // 首次使用可能不存在配置，保持默认
    }
  }

  /** 从后端批量加载任务指派 (config KV: model.task.*) */
  async function fetchTaskAssignments(): Promise<void> {
    try {
      const keys = TASK_SLOTS.map((s) => `model.task.${s.key}`)
      const res = await configApi.batch(keys)
      const data = res.data ?? {}
      const next: Record<string, string | null> = {}
      for (const slot of TASK_SLOTS) {
        const v = data[`model.task.${slot.key}`]
        next[slot.key] = (v as string) || null
      }
      taskAssignments.value = next
    } catch {
      // 首次使用可能不存在配置，保持默认
    }
  }

  /** 按当前角色列表加载角色模型指派。 */
  async function fetchAgentAssignments(agentIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(agentIds.map((id) => id.trim().toLowerCase()).filter(Boolean))]
    if (uniqueIds.length === 0) {
      agentAssignments.value = {}
      return
    }
    try {
      const keys = uniqueIds.map((id) => `model.agent.${id}`)
      const res = await configApi.batch(keys)
      const data = res.data ?? {}
      agentAssignments.value = Object.fromEntries(
        uniqueIds.map((id) => [id, (data[`model.agent.${id}`] as string) || null]),
      )
    } catch {
      agentAssignments.value = Object.fromEntries(uniqueIds.map((id) => [id, null]))
    }
  }

  async function openEditor(model: LlmModel | null): Promise<void> {
    if (isSavingModel.value || isReadingConnection.value) return
    editorErrors.value = {}
    await loadConnections()
    if (model) {
      editingModel.value = model
      isLoading.value = true
      try {
        const response = await modelApi.getById(model.id)
        editorForm.value = toLlmModel(response.data ?? (model as ModelConfigItem))
      } catch (e) {
        error.value = (e as Error).message
        notify.toast(__t('ui.settings', '加载模型完整配置失败: ') + (e as Error).message, 'error')
        return
      } finally {
        isLoading.value = false
      }
    } else {
      editingModel.value = null
      editorForm.value = {
        id: '',
        name: '',
        provider: 'openai',
        modelId: '',
        maxTokens: null,
        contextWindowTokens: null,
        maxReActTurns: null,
        reasoningEffort: null,
        returnNativeReasoning: false,
        wireApi: 'chat_completions',
        reasoningDialect: 'auto',
        stream: true,
        enableVision: false,
        enableAudioInput: false,
        temperature: null,
        topP: null,
        apiBase: providerDefaults.openai,
        apiKey: '',
        providerType: 'openai',
        providerConnectionId: null,
        connectionOverride: true,
        connectionProtocol: 'openai',
        connectionAuthMode: 'api_key',
      }
    }
    remoteModels.value = []
    isEditorOpen.value = true
  }

  /** 保存模型（创建或更新） */
  async function saveModel(): Promise<void> {
    if (isSavingModel.value || isReadingConnection.value) return
    const { payload, errors } = prepareModelPayload(editorForm.value)
    editorErrors.value = errors
    if (Object.keys(errors).length > 0) return
    const editingId = editingModel.value?.id
    isSavingModel.value = true
    try {
      if (editingId) {
        await modelApi.update(editingId, payload)
        notify.toast(__t('ui.settings', '模型 "{0}" 已更新', [payload.name]), 'success')
      } else {
        await modelApi.create(payload)
        notify.toast(__t('ui.settings', '模型 "{0}" 已添加', [payload.name]), 'success')
      }
      isEditorOpen.value = false
      await Promise.all([fetchModels(), fetchMainModel()])
      window.dispatchEvent(new CustomEvent('infos:model-capabilities-changed'))
    } catch (e) {
      error.value = (e as Error).message
      const fields =
        e instanceof ApiError && e.code === 'VALIDATION_ERROR'
          ? (e.data as { fields?: unknown } | undefined)?.fields
          : undefined
      if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
        editorErrors.value = Object.fromEntries(
          Object.entries(fields).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      }
      if (Object.keys(editorErrors.value).length === 0) {
        editorErrors.value = { _root: (e as Error).message }
      }
    } finally {
      isSavingModel.value = false
    }
  }

  /** 删除模型 */
  async function deleteModel(id: string): Promise<void> {
    try {
      await modelApi.remove(id)
      await fetchModels()
      // 清理主模型引用
      if (mainModelId.value === id) {
        mainModelId.value = null
        await configApi.set('model.main', '')
      }
      // 清理任务与角色指派引用
      for (const slot of TASK_SLOTS) {
        if (taskAssignments.value[slot.key] === id) {
          taskAssignments.value[slot.key] = null
          await configApi.set(`model.task.${slot.key}`, '')
        }
      }
      for (const [agentId, assignedModelId] of Object.entries(agentAssignments.value)) {
        if (assignedModelId === id) {
          agentAssignments.value[agentId] = null
          await configApi.set(`model.agent.${agentId}`, '')
        }
      }
      notify.toast(__t('ui.settings', '模型已删除'), 'success')
      window.dispatchEvent(new CustomEvent('infos:model-capabilities-changed'))
    } catch (e) {
      error.value = (e as Error).message
      notify.toast(__t('ui.settings', '删除模型失败: ') + (e as Error).message, 'error')
    }
  }

  /** 从模型卡片直接切换布尔配置，失败时保持原值。 */
  async function setModelToggle(
    model: LlmModel,
    field: 'stream' | 'enableVision' | 'enableAudioInput',
    enabled: boolean,
  ): Promise<void> {
    try {
      await modelApi.update(model.id, { [field]: enabled })
      models.value = models.value.map((item) =>
        item.id === model.id ? { ...item, [field]: enabled } : item,
      )
      const label =
        field === 'stream'
          ? __t('ui.settings', '流式输出')
          : field === 'enableVision'
            ? __t('ui.settings', '图片输入')
            : __t('ui.settings', '音频输入')
      notify.toast(
        __t('ui.settings', '{0}已{1}', [
          label,
          enabled ? __t('ui.settings', '启用') : __t('ui.settings', '关闭'),
        ]),
        enabled ? 'success' : 'info',
      )
      window.dispatchEvent(new CustomEvent('infos:model-capabilities-changed'))
    } catch (e) {
      notify.toast(__t('ui.settings', '模型配置保存失败: ') + (e as Error).message, 'error')
    }
  }

  /** 设置主模型 (config KV: model.main) */
  async function setMainModel(modelId: string): Promise<void> {
    try {
      mainModelId.value = modelId
      await configApi.set('model.main', modelId)
      notify.toast(__t('ui.settings', '已设置为主模型'), 'success')
      window.dispatchEvent(new CustomEvent('infos:model-capabilities-changed'))
    } catch (e) {
      notify.toast(__t('ui.settings', '主模型设置失败: ') + (e as Error).message, 'error')
    }
  }

  /** 设置任务指派 (config KV: model.task.{taskSlot}) */
  async function setTaskAssignment(taskSlot: string, modelId: string | null): Promise<void> {
    try {
      taskAssignments.value[taskSlot] = modelId
      await configApi.set(`model.task.${taskSlot}`, modelId ?? '')
      notify.toast(
        modelId ? __t('ui.settings', '已指派任务模型') : __t('ui.settings', '已取消任务指派'),
        modelId ? 'success' : 'info',
      )
    } catch (e) {
      notify.toast(__t('ui.settings', '任务指派失败: ') + (e as Error).message, 'error')
    }
  }

  /** 设置角色指派。 */
  async function setAgentAssignment(agentId: string, modelId: string | null): Promise<void> {
    const normalizedAgentId = agentId.trim().toLowerCase()
    if (!normalizedAgentId) return
    const previous = agentAssignments.value[normalizedAgentId] ?? null
    agentAssignments.value[normalizedAgentId] = modelId
    try {
      await configApi.set(`model.agent.${normalizedAgentId}`, modelId ?? '')
      notify.toast(
        modelId ? __t('ui.settings', '已指派角色模型') : __t('ui.settings', '已恢复主模型'),
        modelId ? 'success' : 'info',
      )
    } catch (e) {
      agentAssignments.value[normalizedAgentId] = previous
      notify.toast(__t('ui.settings', '角色指派失败: ') + (e as Error).message, 'error')
    }
  }

  /** 获取 Embedding 远程模型列表 */
  async function fetchRemoteEmbeddingModels(): Promise<void> {
    const apiKey = embeddingApiKey.value
    const apiBase = embeddingApiBase.value || undefined
    if (!apiKey) {
      error.value = '请先填写 Embedding API Key'
      notify.toast(error.value, 'warning')
      return
    }
    isFetchingEmbedding.value = true
    remoteEmbeddingModels.value = []
    error.value = null
    try {
      const res = await modelApi.listRemote({ provider: 'openai', apiKey, apiBase })
      remoteEmbeddingModels.value = res.data ?? []
      notify.toast(
        remoteEmbeddingModels.value.length
          ? __t('ui.settings', '已获取 {0} 个 Embedding 模型', [remoteEmbeddingModels.value.length])
          : __t('ui.settings', '列表为空，请手动填写模型 ID'),
        remoteEmbeddingModels.value.length ? 'success' : 'warning',
      )
    } catch (e) {
      error.value = (e as Error).message
      notify.toast(
        __t('ui.settings', '获取 Embedding 模型列表失败: ') + (e as Error).message,
        'error',
      )
    } finally {
      isFetchingEmbedding.value = false
    }
  }

  /** 获取 Reranker 远程模型列表 */
  async function fetchRemoteRerankerModels(): Promise<void> {
    const apiKey = rerankerApiKey.value
    const apiBase = rerankerApiBase.value || undefined
    if (!apiKey) {
      error.value = '请先填写 Reranker API Key'
      notify.toast(error.value, 'warning')
      return
    }
    isFetchingReranker.value = true
    remoteRerankerModels.value = []
    error.value = null
    try {
      const res = await modelApi.listRemote({ provider: 'openai', apiKey, apiBase })
      remoteRerankerModels.value = res.data ?? []
      notify.toast(
        remoteRerankerModels.value.length
          ? __t('ui.settings', '已获取 {0} 个 Reranker 模型', [remoteRerankerModels.value.length])
          : __t('ui.settings', '列表为空，请手动填写模型 ID'),
        remoteRerankerModels.value.length ? 'success' : 'warning',
      )
    } catch (e) {
      error.value = (e as Error).message
      notify.toast(
        __t('ui.settings', '获取 Reranker 模型列表失败: ') + (e as Error).message,
        'error',
      )
    } finally {
      isFetchingReranker.value = false
    }
  }

  /** 真实激活候选Embedding模型，向量与配置维度一致后才由后端保存。 */
  async function saveVectorConfig(): Promise<void> {
    if (!embeddingEnabled.value || embeddingSwitchSaving.value) return
    if (embeddingProvider.value !== 'api') {
      embeddingActivationResult.value = {
        status: 'error',
        get message() {
          return __t('ui.settings', '当前仅支持在线 API Embedding')
        },
      }
      return
    }
    if (!embeddingModelId.value.trim()) {
      embeddingActivationResult.value = {
        status: 'error',
        get message() {
          return __t('ui.settings', '请填写 Embedding 模型 ID')
        },
      }
      return
    }
    isSavingVector.value = true
    embeddingActivationResult.value = null
    error.value = null
    try {
      const response = await configApi.activateEmbedding({
        provider: 'api',
        model: embeddingModelId.value.trim(),
        dimension: embeddingDimension.value,
        apiBase: embeddingApiBase.value.trim() || undefined,
        apiKey: embeddingApiKey.value.trim() || undefined,
        reranker: {
          enabled: rerankerEnabled.value,
          model: rerankerModelId.value.trim() || undefined,
          apiBase: rerankerApiBase.value.trim() || undefined,
          apiKey: rerankerApiKey.value.trim() || undefined,
        },
      })
      const result = response.data
      if (!result) throw new Error('后端未返回Embedding激活结果')
      embeddingActivationRevision.value++
      embeddingActivationResult.value = {
        status: 'success',
        durationMs: result.durationMs,
        get message() {
          return __t(
            'ui.index-maintenance',
            '激活成功：{0} 维，调用耗时 {1} ms。旧维度索引请重建后使用。',
            [result.dimension, result.durationMs],
          )
        },
      }
      notify.toast(embeddingActivationResult.value.message, 'success')
    } catch (e) {
      const message = (e as Error).message || 'Embedding 模型激活失败'
      error.value = message
      embeddingActivationResult.value = { status: 'error', message }
      notify.toast(__t('ui.settings', 'Embedding 模型激活失败：') + message, 'error')
    } finally {
      isSavingVector.value = false
    }
  }

  /** 加载多模态转述配置。 */
  async function loadRelayConfig(): Promise<void> {
    try {
      const res = await configApi.batch([
        'multimodalRelay.enabled',
        'multimodalRelay.modelConfigId',
        'multimodalRelay.detail',
      ])
      const data = res.data ?? {}
      relayEnabled.value = data['multimodalRelay.enabled'] === 'true'
      relayModelConfigId.value = data['multimodalRelay.modelConfigId'] || ''
      const detail = data['multimodalRelay.detail']
      relayDetail.value = detail === 'brief' || detail === 'detailed' ? detail : 'standard'
    } catch {
      // 首次使用时保留默认配置。
    }
  }

  /** 保存多模态转述配置，只允许引用已声明视觉能力的模型。 */
  async function saveRelayConfig(): Promise<void> {
    if (
      relayEnabled.value &&
      !visionModels.value.some((model) => model.id === relayModelConfigId.value)
    ) {
      notify.toast(__t('ui.settings', '请选择已启用图片视觉能力的转述模型'), 'warning')
      return
    }
    isSavingRelay.value = true
    try {
      await configApi.batchSet([
        { key: 'multimodalRelay.enabled', value: String(relayEnabled.value) },
        { key: 'multimodalRelay.modelConfigId', value: relayModelConfigId.value ?? '' },
        { key: 'multimodalRelay.detail', value: relayDetail.value },
      ])
      window.dispatchEvent(new CustomEvent('infos:model-capabilities-changed'))
      notify.toast(__t('ui.settings', '多模态转述配置已保存'), 'success')
    } catch (e) {
      notify.toast(__t('ui.settings', '多模态转述配置保存失败: ') + (e as Error).message, 'error')
    } finally {
      isSavingRelay.value = false
    }
  }

  /** 从后端加载向量配置 */
  async function loadVectorConfig(): Promise<void> {
    try {
      const res = await configApi.batch([
        'embedding.provider',
        'embedding.model',
        'embedding.dimension',
        'embedding.apiBase',
        'embedding.apiKey',
        'reranker.enabled',
        'reranker.model',
        'reranker.apiBase',
        'reranker.apiKey',
      ])
      const d = res.data ?? {}
      if (d['embedding.provider'])
        embeddingProvider.value = d['embedding.provider'] as 'local' | 'api'
      if (d['embedding.model']) embeddingModelId.value = d['embedding.model'] as string
      if (d['embedding.dimension']) embeddingDimension.value = Number(d['embedding.dimension'])
      if (d['embedding.apiBase']) embeddingApiBase.value = d['embedding.apiBase'] as string
      if (d['embedding.apiKey']) embeddingApiKey.value = d['embedding.apiKey'] as string
      if (d['reranker.enabled'] !== undefined)
        rerankerEnabled.value = d['reranker.enabled'] === 'true'
      if (d['reranker.model']) rerankerModelId.value = d['reranker.model'] as string
      if (d['reranker.apiBase']) rerankerApiBase.value = d['reranker.apiBase'] as string
      if (d['reranker.apiKey']) rerankerApiKey.value = d['reranker.apiKey'] as string
    } catch {
      // 首次使用，保持默认值
    }
  }

  // ── 初始化 ──
  onMounted(async () => {
    await Promise.all([
      fetchModels(),
      fetchMainModel(),
      fetchTaskAssignments(),
      loadConnections(),
      loadVectorConfig(),
      loadRelayConfig(),
    ])
  })

  return {
    // LLM
    models,
    modelTests,
    testModel,
    setModelConnection,
    switchingConnections,
    currentTab,
    isLoading,
    error,
    mainModelId,
    taskAssignments,
    agentAssignments,
    isTaskAssignOpen,
    isAgentAssignOpen,
    providerOptions,
    // 编辑器
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
    fetchMainModel,
    fetchTaskAssignments,
    fetchAgentAssignments,
    fetchModels,
    // 远程模型列表
    remoteModels,
    isFetchingRemote,
    fetchRemoteModels,
    customProviderTypeOptions,
    providerDefaults,
    // 全局配置
    isGlobalOpen,
    providerConnections,
    selectedConnection,
    loadConnections,
    handleConnectionChange,
    handleProviderChange,
    setConnectionOverride,
    // 多模态转述
    relayEnabled,
    relayModelConfigId,
    relayDetail,
    isSavingRelay,
    visionModels,
    saveRelayConfig,
    // 向量
    embeddingEnabled,
    embeddingSwitchReady,
    embeddingSwitchSaving,
    setEmbeddingEnabled,
    embeddingProvider,
    embeddingModelId,
    embeddingDimension,
    embeddingApiBase,
    embeddingApiKey,
    rerankerEnabled,
    rerankerModelId,
    rerankerApiBase,
    rerankerApiKey,
    isSavingVector,
    embeddingActivationResult,
    embeddingActivationRevision,
    saveVectorConfig,
    // 向量远程模型列表
    remoteEmbeddingModels,
    isFetchingEmbedding,
    fetchRemoteEmbeddingModels,
    remoteRerankerModels,
    isFetchingReranker,
    fetchRemoteRerankerModels,
  }
}
