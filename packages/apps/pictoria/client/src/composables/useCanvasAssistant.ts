import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Ajv from 'ajv'
import { t } from '../i18n'
import { pictoria } from '../services/transport'
import {
  applyCanvasOperations,
  canvasProposalSchema,
  documentKey,
  type CanvasProposal,
} from '../../../src/canvasDocument'
import { isAssetField, isAssetsField, acceptsAsset, draftHeight } from './useCanvasLinks'
import type { CanvasStore } from './useCanvas'
import type { Project, ProviderDirectory } from '../types'
import {
  assistantSettingsSchema,
  defaultAssistantSettings,
  type AssistantSettings,
  type AssistantSettingsRecord,
} from '../../../src/assistantSettings'
import { buildAssistantPrompt } from '../services/assistantContext'

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  taskId?: string
  baseKey?: string
  proposal?: CanvasProposal
  submission?: {
    stepId: string
    stepRevision: number
    prompt: string
    images?: Array<{ assetId: string }>
  }
}
interface Conversation {
  revision: number
  messages: AssistantMessage[]
}
interface ExternalProposal {
  id: string
  revision: number
  baseKey: string
  proposal: CanvasProposal
  sessionId: string
}
const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
const terminal = (state: string) => ['completed', 'failed', 'partial', 'cancelled'].includes(state)

export function useCanvasAssistant(store: CanvasStore) {
  const label = (source: string) => t('apps.pictoria.studio', source)
  const messages = ref<AssistantMessage[]>([]),
    revision = ref(0),
    busy = ref(false),
    ready = ref(false)
  const failure = ref(''),
    input = ref('')
  const settings = ref(defaultAssistantSettings()),
    settingsRevision = ref(0),
    settingsBusy = ref(false)
  const providerId = computed(() => settings.value.providerId),
    model = computed(() => settings.value.model)
  const providers = ref<ProviderDirectory['providers']>([]),
    proposals = ref<ExternalProposal[]>([])
  const includeImages = ref(false)
  const selectedImages = computed(() => {
    const seen = new Set<string>()
    return store.activeItems.value.filter((item) => {
      const id = item.content.assetId
      if (
        !id ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(item.content.mimeType || '') ||
        seen.has(id)
      )
        return false
      seen.add(id)
      return true
    })
  })
  const sessionId = crypto.randomUUID(),
    validator = new Ajv({ strict: false, allErrors: true })
  let sequence = 0,
    generation = 0,
    disposed = false,
    polling = false,
    publishing = false
  let lastSnapshot = '',
    lastPublished = 0
  const scope = () => ({ owner: store.agentId.value, projectId: store.project.id })
  const current = (saved: ReturnType<typeof scope>) =>
    !disposed && saved.owner === store.agentId.value && saved.projectId === store.project.id
  const snapshot = () => ({
    baseKey: documentKey(store.project),
    project: clone(store.project),
    selected: [...store.selected.value],
    viewport: clone(store.project.viewport),
    steps: store.steps.value
      .filter((step) => step.available)
      .map(({ id, name, revision, inputSchema }) => ({ id, name, revision, inputSchema })),
    imagesIncluded: false,
  })
  async function persist(saved = scope()) {
    const value = await pictoria.operation<Conversation>(saved.owner, 'canvas.conversation.save', {
      projectId: saved.projectId,
      expectedRevision: revision.value,
      messages: clone(messages.value),
    })
    if (current(saved)) revision.value = value.revision
  }
  async function publish() {
    if (!store.online.value || !ready.value || disposed || publishing) return
    const context = snapshot(),
      signature = JSON.stringify(context)
    if (signature === lastSnapshot && Date.now() - lastPublished < 30000) return
    publishing = true
    const saved = scope()
    try {
      await pictoria.operation(saved.owner, 'canvas.context.set', {
        projectId: saved.projectId,
        sessionId,
        sequence: ++sequence,
        snapshot: context,
      })
      if (current(saved)) {
        lastSnapshot = signature
        lastPublished = Date.now()
      }
    } catch (error) {
      if (current(saved))
        failure.value = error instanceof Error ? error.message : label('上下文同步失败')
    } finally {
      publishing = false
    }
  }
  async function load() {
    const token = ++generation,
      saved = scope()
    ready.value = false
    messages.value = []
    proposals.value = []
    revision.value = 0
    failure.value = ''
    settings.value = defaultAssistantSettings()
    settingsRevision.value = 0
    if (!store.online.value) return
    try {
      const [conversation, directory, preferences] = await Promise.all([
        pictoria.operation<Conversation>(saved.owner, 'canvas.conversation.get', {
          projectId: saved.projectId,
        }),
        pictoria.operation<ProviderDirectory>(saved.owner, 'provider.list'),
        pictoria.operation<AssistantSettingsRecord>(saved.owner, 'canvas.assistant.settings.get', {
          projectId: saved.projectId,
        }),
      ])
      if (token !== generation || !current(saved)) return
      messages.value = conversation.messages
      revision.value = conversation.revision
      settings.value = assistantSettingsSchema.parse(preferences.settings)
      settingsRevision.value = preferences.revision
      providers.value = directory.providers.filter(
        (provider) => provider.enabled && provider.protocol === 'openai',
      )
      ready.value = true
      await publish()
      await poll()
    } catch (error) {
      if (current(saved))
        failure.value = error instanceof Error ? error.message : label('助手会话加载失败')
    }
  }
  async function saveSettings(value: AssistantSettings): Promise<boolean> {
    if (settingsBusy.value || busy.value || !ready.value) return false
    const parsed = assistantSettingsSchema.safeParse(value)
    if (!parsed.success) {
      failure.value = t('apps.pictoria.assistant', '请检查参数范围')
      return false
    }
    const saved = scope()
    settingsBusy.value = true
    failure.value = ''
    try {
      const result = await pictoria.operation<AssistantSettingsRecord>(
        saved.owner,
        'canvas.assistant.settings.save',
        {
          projectId: saved.projectId,
          expectedRevision: settingsRevision.value,
          settings: clone(parsed.data),
        },
      )
      if (!current(saved)) return false
      settings.value = result.settings
      settingsRevision.value = result.revision
      return true
    } catch (error) {
      if (current(saved))
        failure.value =
          error instanceof Error ? error.message : t('apps.pictoria.assistant', '设置未保存')
      return false
    } finally {
      settingsBusy.value = false
    }
  }
  async function refreshProviders() {
    const saved = scope()
    try {
      const directory = await pictoria.operation<ProviderDirectory>(saved.owner, 'provider.list')
      if (current(saved))
        providers.value = directory.providers.filter(
          (provider) => provider.enabled && provider.protocol === 'openai',
        )
    } catch (error) {
      if (current(saved))
        failure.value =
          error instanceof Error ? error.message : t('apps.pictoria.assistant', '无法读取供应商')
    }
  }
  async function send() {
    if (
      !input.value.trim() ||
      busy.value ||
      settingsBusy.value ||
      polling ||
      !ready.value ||
      pending.value
    )
      return
    const saved = scope(),
      request = input.value.trim(),
      baseKey = documentKey(store.project)
    const capturedContext = snapshot()
    const capturedSettings = clone(settings.value)
    const capturedHistory = messages.value.map(({ role, text }) => ({ role, text }))
    busy.value = true
    failure.value = ''
    try {
      const imageBindings = includeImages.value
        ? selectedImages.value.map((item) => ({
            itemId: item.id,
            assetId: item.content.assetId!,
            name: item.content.name,
          }))
        : []
      if (imageBindings.length > 4)
        throw new Error(t('apps.pictoria.vision', '每次最多分析四张所选图片'))
      const images = imageBindings.map(({ assetId }) => ({ assetId }))
      let imageBytes = 0
      for (const image of images) {
        const info = await pictoria.operation<{ sizeBytes: number }>(saved.owner, 'asset.get', {
          id: image.assetId,
        })
        imageBytes += info.sizeBytes
      }
      if (imageBytes > 20 * 1024 * 1024)
        throw new Error(t('apps.pictoria.vision', '所选图片总量不能超过 20 MiB'))
      if (!current(saved)) return
      const prompt = buildAssistantPrompt(
        request,
        { ...capturedContext, imagesIncluded: images.length > 0, imageBindings },
        capturedHistory,
        capturedSettings,
      )
      const step = await pictoria.operation<{ id: string; revision: number }>(
        saved.owner,
        'canvas.assistant.prepare',
        {
          projectId: saved.projectId,
          settings: capturedSettings,
          vision: images.length > 0,
        },
      )
      if (!current(saved)) return
      const user: AssistantMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: request,
        baseKey,
        submission: {
          stepId: step.id,
          stepRevision: step.revision,
          prompt,
          ...(images.length ? { images } : {}),
        },
      }
      messages.value.push(user)
      await persist(saved)
      // 先持久化请求幂等键；页面中断后可用同一键恢复提交，不产生重复模型调用。
      const task = await pictoria.run(
        saved.owner,
        {
          projectId: `assistant:${saved.projectId}`,
          stepId: step.id,
          stepRevision: step.revision,
          inputs: { prompt, ...(images.length ? { images } : {}) },
        },
        user.id,
      )
      if (!current(saved)) return
      user.taskId = task.taskId
      input.value = ''
      await persist(saved)
    } catch (error) {
      if (current(saved)) {
        const code = error instanceof Error ? error.message : ''
        failure.value =
          code === 'ASSISTANT_SELECTION_REQUIRED'
            ? t('apps.pictoria.assistant', '先选择画布内容')
            : code === 'ASSISTANT_CONTEXT_LIMIT'
              ? t('apps.pictoria.assistant', '上下文过长，请缩小范围或提高上限')
              : error instanceof Error
                ? error.message
                : label('助手请求失败')
      }
    } finally {
      busy.value = false
    }
  }
  const pending = computed(() =>
    messages.value.find(
      (message) =>
        message.role === 'user' &&
        (message.taskId || message.submission) &&
        !messages.value.some(
          (answer) => answer.role === 'assistant' && answer.id === `reply:${message.id}`,
        ),
    ),
  )
  async function poll() {
    if (!ready.value || polling || busy.value || disposed) return
    polling = true
    const saved = scope()
    try {
      const external = await pictoria.operation<ExternalProposal[]>(
        saved.owner,
        'canvas.proposal.list',
        { projectId: saved.projectId },
      )
      if (!current(saved) || busy.value) return
      proposals.value = external
      const user = pending.value
      if (!user) return
      if (!user.taskId && user.submission) {
        const submitted = await pictoria.run(
          saved.owner,
          {
            projectId: `assistant:${saved.projectId}`,
            stepId: user.submission.stepId,
            stepRevision: user.submission.stepRevision,
            inputs: {
              prompt: user.submission.prompt,
              ...(user.submission.images?.length ? { images: user.submission.images } : {}),
            },
          },
          user.id,
        )
        if (!current(saved)) return
        user.taskId = submitted.taskId
        await persist(saved)
      }
      if (!user.taskId) return
      const task = await pictoria.task(saved.owner, user.taskId)
      if (!current(saved) || busy.value || !task || !terminal(task.state)) return
      const text = typeof task.result?.text === 'string' ? task.result.text : ''
      let proposal: CanvasProposal | undefined
      if (task.state === 'completed') {
        try {
          proposal = canvasProposalSchema.parse(
            JSON.parse(
              text
                .trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/, ''),
            ),
          )
        } catch {
          failure.value = label('助手未返回有效提案，原始回复已保留')
        }
      }
      messages.value.push({
        id: `reply:${user.id}`,
        role: 'assistant',
        text:
          proposal?.message ||
          text ||
          (task.error === 'ASSISTANT_IMAGE_LIMIT'
            ? t(
                'apps.pictoria.vision',
                '助手图片输入仅支持最多四张 PNG、JPEG 或 WebP，总量不超过 20 MiB。',
              )
            : task.error) ||
          label('助手请求失败'),
        baseKey: user.baseKey,
        ...(proposal ? { proposal } : {}),
      })
      delete user.submission
      await persist(saved)
    } catch (error) {
      if (current(saved))
        failure.value = error instanceof Error ? error.message : label('助手状态读取失败')
    } finally {
      polling = false
    }
  }
  function apply(proposal: CanvasProposal, baseKey?: string) {
    if (baseKey !== documentKey(store.project))
      throw new Error(label('画布已经变化，请重新生成提案'))
    const result = applyCanvasOperations(store.project, proposal.operations)
    const document = result.document as Project
    for (const draft of result.drafts) {
      const step = store.steps.value.find((step) => step.id === draft.stepId && step.available)
      if (!step) throw new Error(label('提案引用的步骤不可用'))
      const item = document.items.find((item) => item.id === draft.id)
      if (!item) continue
      const defaults = Object.fromEntries(
        Object.entries(step.inputSchema.properties ?? {})
          .filter(([, field]) => field.default !== undefined)
          .map(([name, field]) => [name, field.default]),
      )
      const inputs = { ...defaults, ...item.content.inputs }
      // 草稿允许待连线的必填输入，但已填写值必须符合步骤的字段契约。
      if (!validator.compile({ ...step.inputSchema, required: [] })(inputs))
        throw new Error(label('提案中的输入不符合步骤要求'))
      Object.assign(item.content, { step: clone(step), inputs, name: step.name })
      item.content.height = draftHeight(item)
    }
    for (const id of result.updatedDraftIds) {
      const item = document.items.find((entry) => entry.id === id)
      if (!item) continue
      const step = store.steps.value.find(
        (entry) => entry.id === item.content.step?.id && entry.available,
      )
      if (
        !step ||
        step.revision !== item.content.step?.revision ||
        !validator.compile({ ...step.inputSchema, required: [] })(item.content.inputs ?? {})
      )
        throw new Error(label('提案中的输入不符合步骤要求'))
      item.content.request = undefined
    }
    for (const edge of document.edges ?? []) {
      if (edge.historical) continue
      const source = document.items.find((item) => item.id === edge.source),
        target = document.items.find((item) => item.id === edge.target)
      const field = target?.content.step?.inputSchema.properties?.[edge.field]
      if (!source || !target || target.content.kind !== 'draft' || !field)
        throw new Error(label('提案中的连线无效'))
      const asset = isAssetField(field) || isAssetsField(field)
      if (
        asset
          ? !acceptsAsset(edge.field, source)
          : source.content.kind !== 'text' || field.type !== 'string' || Boolean(field.enum)
      )
        throw new Error(label('提案中的连线无效'))
      const incoming = document.edges!.filter(
        (entry) => !entry.historical && entry.target === edge.target && entry.field === edge.field,
      )
      const fixed = target.content.inputs?.[edge.field]
      const references = new Set<string>(
        Array.isArray(fixed)
          ? fixed.flatMap((entry) =>
              entry && typeof entry === 'object' && typeof entry.assetId === 'string'
                ? [entry.assetId as string]
                : [],
            )
          : [],
      )
      for (const entry of incoming) {
        const id = document.items.find((item) => item.id === entry.source)?.content.assetId
        if (id) references.add(id)
      }
      if (
        incoming.length > (isAssetsField(field) ? (field.maxItems ?? 20) : 1) ||
        (isAssetsField(field) && references.size > (field.maxItems ?? 20))
      )
        throw new Error(label('提案中的连线无效'))
      if (!isAssetsField(field) && target.content.inputs) delete target.content.inputs[edge.field]
    }
    store.checkpoint()
    Object.assign(store.project, document)
    if (result.selected) store.selected.value = result.selected
  }
  async function applyMessage(message: AssistantMessage) {
    if (busy.value || polling) return
    busy.value = true
    try {
      if (!message.proposal) return
      apply(message.proposal, message.baseKey)
      delete message.proposal
      await persist()
      await publish()
    } catch (error) {
      failure.value =
        error instanceof Error && !error.message.startsWith('CANVAS_')
          ? error.message
          : label('提案无法应用，画布保持不变')
    } finally {
      busy.value = false
    }
  }
  async function rejectMessage(message: AssistantMessage) {
    if (busy.value || polling) return
    busy.value = true
    try {
      delete message.proposal
      await persist()
    } catch (error) {
      failure.value = error instanceof Error ? error.message : label('助手请求失败')
    } finally {
      busy.value = false
    }
  }
  async function resolveExternal(proposal: ExternalProposal, accepted: boolean) {
    try {
      if (accepted) apply(proposal.proposal, proposal.baseKey)
      await pictoria.operation(store.agentId.value, 'canvas.proposal.resolve', {
        projectId: store.project.id,
        id: proposal.id,
        expectedRevision: proposal.revision,
        state: accepted ? 'applied' : 'rejected',
      })
      await poll()
    } catch (error) {
      failure.value = error instanceof Error ? error.message : label('提案无法应用，画布保持不变')
    }
  }
  async function cancel() {
    if (!pending.value?.taskId) return
    try {
      await pictoria.operation(store.agentId.value, 'task.cancel', { id: pending.value.taskId })
      await poll()
    } catch (error) {
      failure.value = error instanceof Error ? error.message : label('助手请求失败')
    }
  }
  let previousScope = scope()
  watch(
    () => `${store.agentId.value}:${store.project.id}:${store.online.value}`,
    () => {
      const next = scope()
      if (previousScope.owner !== next.owner || previousScope.projectId !== next.projectId) {
        includeImages.value = false
        void pictoria
          .operation(previousScope.owner, 'canvas.context.close', {
            projectId: previousScope.projectId,
            sessionId,
          })
          .catch(() => {})
      }
      previousScope = next
      void load()
    },
    { immediate: true },
  )
  const timer = setInterval(() => {
    void poll()
    void publish()
  }, 3000)
  onBeforeUnmount(() => {
    disposed = true
    generation++
    clearInterval(timer)
    const saved = scope()
    void pictoria
      .operation(saved.owner, 'canvas.context.close', { projectId: saved.projectId, sessionId })
      .catch(() => {})
  })
  return {
    messages,
    busy,
    ready,
    failure,
    input,
    providerId,
    model,
    providers,
    settings,
    settingsBusy,
    saveSettings,
    refreshProviders,
    includeImages,
    selectedImages,
    pending,
    proposals,
    send,
    applyMessage,
    rejectMessage,
    resolveExternal,
    cancel,
    reload: load,
  }
}
