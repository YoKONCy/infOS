import { t as __t } from '../../i18n/index'
import { createClientUuid } from '../../lib/clientPlatform'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  PromptAssignment,
  PromptBlock,
  PromptBundle,
  PromptDocument,
  PromptFramework,
  PromptIssue,
  PromptKind,
  PromptPreview,
  PromptWorkspaceView,
  PromptFormat,
  SillyTavernImport,
  PromptPreset,
} from '@infos/shared'
import { promptFormat, PROMPT_FORMATS, ST_MARKER_BINDINGS } from '@infos/shared'
import { promptApi } from '../../api/modules/promptApi'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { ApiError } from '../../api/errors'
import { isPromptBundle, isPromptFramework } from '../../lib/promptDraft'
import { getApiBaseUrl } from '../../api/transport'
import { createPromptPreset, parsePromptPreset, preparePromptPreset } from '../../lib/promptPreset'

export type PromptSection = 'framework' | PromptKind | 'assignments' | 'versions'
const empty = (): PromptBundle => ({ documents: [], frameworks: [], assignments: [] })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function usePromptWorkspace() {
  const cacheKey = `infos:prompt-workspace:draft:v1:${getApiBaseUrl()}`
  const notify = useNotificationStore()
  const view = ref<PromptWorkspaceView | null>(null)
  const bundle = ref<PromptBundle>(empty())
  const baseline = ref('')
  const busy = ref(false)
  const error = ref('')
  const section = ref<PromptSection>('framework')
  const search = ref('')
  const formatFilter = ref<PromptFormat | ''>('')
  const stImport = ref<SillyTavernImport | null>(null)
  const stImportOpen = ref(false)
  const presetExportOpen = ref(false)
  const presetImportOpen = ref(false)
  const presetImport = ref<{ preset: PromptPreset; issues: PromptIssue[] } | null>(null)
  let stImportInput: unknown
  let stImportFile = ''
  const selectedId = ref('builtin.main')
  const mode = ref<'visual' | 'source'>('visual')
  const source = ref('')
  const sourceBase = ref('')
  const issues = ref<PromptIssue[]>([])
  const preview = ref<PromptPreview | null>(null)
  const previewOpen = ref(false)
  const previewAgent = ref('')
  const previewChannel = ref('desktop')
  const previewGeneration = ref('normal')
  const variablesText = ref(
    JSON.stringify(
      {
        memory_context: '示例：用户喜欢简洁的说明。',
        conversation_history: '<user>你好</user>\n<assistant>你好！</assistant>',
        interaction_mode: 'chat',
        capability_fragments: [],
        tools_description: '',
        skill_menu: '',
        draft_flow_instructions: '',
        task_plan_instructions: '',
        spoken_reply_enabled: '',
        small: true,
        detail: '简要描述主体与可见文字。',
      },
      null,
      2,
    ),
  )
  const scopeAgent = ref('')
  const scopeChannel = ref('')
  const versionId = ref('')
  const historical = ref<PromptBundle | null>(null)
  const diffId = ref('')
  const pendingDialog = ref<null | {
    title: string
    message: string
    action: () => void | Promise<void>
  }>(null)
  let stashTimer: ReturnType<typeof setTimeout> | undefined
  const draftDirty = computed(() => JSON.stringify(bundle.value) !== baseline.value)
  const dirty = computed(
    () => draftDirty.value || (mode.value === 'source' && source.value !== sourceBase.value),
  )
  const framework = computed(() =>
    section.value === 'framework'
      ? bundle.value.frameworks.find((f) => f.id === selectedId.value)
      : undefined,
  )
  const document = computed(() => bundle.value.documents.find((d) => d.id === selectedId.value))
  const resources = computed(() => {
    const entries =
      section.value === 'framework'
        ? bundle.value.frameworks
        : bundle.value.documents.filter((d) => d.kind === section.value)
    const query = search.value.trim().toLowerCase()
    return entries.filter(
      (item) =>
        (!query || `${item.name} ${item.id}`.toLowerCase().includes(query)) &&
        (section.value !== 'framework' ||
          !formatFilter.value ||
          promptFormat(item as PromptFramework) === formatFilter.value),
    )
  })
  function displayBuiltinName(item?: { id: string; name: string; builtin?: boolean }): string {
    if (!item) return ''
    const original =
      view.value?.defaults.documents.find((entry) => entry.id === item.id) ??
      view.value?.defaults.frameworks.find((entry) => entry.id === item.id)
    return item.builtin !== false && original?.name === item.name
      ? __t('common.prompts', item.name)
      : item.name
  }
  const frameworkOptions = computed(() =>
    bundle.value.frameworks.map((f) => ({
      label: `${displayBuiltinName(f)} · ${__t('common.interface', PROMPT_FORMATS.find((format) => format.value === promptFormat(f))?.label ?? '')}`,
      value: f.id,
    })),
  )
  const sourceOptions = computed(() => [
    {
      get label() {
        return __t('ui.settings', '内联模板')
      },
      value: '',
    },
    ...bundle.value.documents.map((d) => ({ label: displayBuiltinName(d), value: d.id })),
  ])
  const currentAssignment = computed(() =>
    bundle.value.assignments.find(
      (a) => a.agentId === scopeAgent.value && a.channel === scopeChannel.value,
    ),
  )
  const record = computed(() => framework.value ?? document.value)
  const changedEntries = computed(() => {
    if (!historical.value) return []
    const index = (data: PromptBundle) =>
      new Map([
        ...data.documents.map((d) => [d.id, JSON.stringify(d, null, 2)] as const),
        ...data.frameworks.map((f) => [f.id, JSON.stringify(f, null, 2)] as const),
        ['assignments', JSON.stringify(data.assignments, null, 2)] as const,
      ])
    const before = index(historical.value),
      after = index(bundle.value)
    return [...new Set([...before.keys(), ...after.keys()])]
      .filter((key) => before.get(key) !== after.get(key))
      .map((key) => ({
        id: key,
        kind: !before.has(key) ? '新增' : !after.has(key) ? '删除' : '修改',
        before: before.get(key) ?? '',
        after: after.get(key) ?? '',
      }))
  })
  const activeDiff = computed(
    () => changedEntries.value.find((d) => d.id === diffId.value) ?? changedEntries.value[0],
  )

  function refreshSource() {
    source.value = framework.value
      ? JSON.stringify(framework.value, null, 2)
      : (document.value?.body ?? '')
    sourceBase.value = source.value
  }
  function applySource(): boolean {
    if (mode.value !== 'source' || source.value === sourceBase.value) return true
    try {
      if (framework.value) {
        const parsed: unknown = JSON.parse(source.value)
        if (!isPromptFramework(parsed) || parsed.id !== framework.value.id)
          throw new Error('请保留框架 ID，并提供有效的 name、bindings 和 blocks')
        bundle.value.frameworks.splice(bundle.value.frameworks.indexOf(framework.value), 1, parsed)
      } else if (document.value) document.value.body = source.value
      sourceBase.value = source.value
      error.value = ''
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }
  function select(id: string, nextSection = section.value) {
    if (!applySource()) return
    section.value = nextSection
    if (nextSection === 'task') previewChannel.value = 'task'
    else if (nextSection === 'framework') previewChannel.value = 'desktop'
    selectedId.value = id
    refreshSource()
    preview.value = null
  }
  function setSection(nextSection: PromptSection) {
    if (!applySource()) return
    section.value = nextSection
    if (nextSection === 'task') previewChannel.value = 'task'
    else if (nextSection === 'framework') previewChannel.value = 'desktop'
    search.value = ''
    formatFilter.value = ''
    selectedId.value =
      nextSection === 'framework'
        ? (bundle.value.frameworks[0]?.id ?? '')
        : (bundle.value.documents.find((d) => d.kind === nextSection)?.id ?? '')
    refreshSource()
  }
  function setMode(nextMode: 'visual' | 'source') {
    if (!applySource()) return
    mode.value = nextMode
    refreshSource()
  }
  function setFormatFilter(next: PromptFormat | '') {
    if (!applySource()) return
    formatFilter.value = next
    selectedId.value = resources.value[0]?.id ?? ''
    refreshSource()
  }
  function accept(next: PromptWorkspaceView) {
    view.value = next
    bundle.value = clone(next.draft)
    baseline.value = JSON.stringify(next.draft)
    refreshSource()
    try {
      localStorage.removeItem(cacheKey)
    } catch {
      /* 本地草稿不可用时仍保留服务端草稿。 */
    }
  }
  async function action(work: () => Promise<void>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      await work()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      if (e instanceof ApiError && Array.isArray(e.data))
        issues.value = e.data.map((item) => ({
          level: 'error',
          source: item.source ?? item.path?.join('.') ?? 'config',
          message: item.message ?? __t('ui.settings', '配置格式无效'),
        }))
    } finally {
      busy.value = false
    }
  }
  async function load() {
    await action(async () => {
      let cached: string | null = null
      try {
        cached = localStorage.getItem(cacheKey)
      } catch {
        /* 本地存储不可用时直接读取服务端。 */
      }
      const response = await promptApi.get()
      if (!response.data) throw new Error('未收到提示词配置')
      accept(response.data)
      try {
        if (cached) {
          const value = JSON.parse(cached) as {
            revision: number
            bundle: PromptBundle
            source?: string
            sourceBase?: string
            mode?: 'visual' | 'source'
            section?: PromptSection
            selectedId?: string
          }
          if (!isPromptBundle(value.bundle)) throw new Error('本地草稿格式无效')
          const restore = () => {
            bundle.value = value.bundle
            // 本地未保存草稿也可能带有旧的英文自动名称，仅修正同名内置条目。
            for (const doc of bundle.value.documents) {
              const original = view.value?.defaults.documents.find((item) => item.id === doc.id)
              if (original && doc.builtin !== false && doc.name === doc.id.split('/').at(-1))
                doc.name = original.name
            }
            section.value =
              value.section &&
              ['framework', 'slot', 'component', 'task', 'assignments', 'versions'].includes(
                value.section,
              )
                ? value.section
                : 'framework'
            selectedId.value =
              typeof value.selectedId === 'string' ? value.selectedId : 'builtin.main'
            mode.value = value.mode === 'source' ? 'source' : 'visual'
            refreshSource()
            if (mode.value === 'source' && typeof value.source === 'string') {
              source.value = value.source
              sourceBase.value =
                typeof value.sourceBase === 'string' ? value.sourceBase : sourceBase.value
            }
          }
          if (value.revision === view.value?.revision) {
            restore()
            notify.toast(__t('ui.settings', '已恢复本地草稿'), 'info')
          } else {
            // 并发版本冲突不自动覆盖；保留原始草稿供用户导出。
            pendingDialog.value = {
              get title() {
                return __t('ui.settings', '发现本地草稿')
              },
              get message() {
                return __t(
                  'ui.settings',
                  '服务端已有更新。是否保留本地编辑到当前草稿？发布前请比较版本。',
                )
              },
              action: restore,
            }
          }
        }
      } catch {
        /* 损坏的本地草稿不影响服务端版本。 */
      }
    })
  }
  function create(copyCurrent = false) {
    if (!applySource()) return
    const suffix = createClientUuid().slice(0, 8)
    if (section.value === 'framework') {
      const item: PromptFramework =
        copyCurrent && framework.value
          ? clone(framework.value)
          : { id: '', name: '新框架', bindings: [], blocks: [] }
      item.id = `custom.framework.${suffix}`
      item.builtin = false
      if (copyCurrent) item.name += ' 副本'
      bundle.value.frameworks.push(item)
      select(item.id)
    } else if (['slot', 'component', 'task'].includes(section.value)) {
      const item: PromptDocument =
        copyCurrent && document.value
          ? clone(document.value)
          : {
              id: '',
              name: '新模板',
              kind: section.value as PromptKind,
              body: '',
              role: 'system',
              enabled: true,
              variables: [],
            }
      item.id = `custom/${item.kind}/${suffix}`
      item.builtin = false
      if (copyCurrent) item.name += ' 副本'
      bundle.value.documents.push(item)
      select(item.id)
    }
    mode.value = 'visual'
  }
  function createIndependent(options: {
    name: string
    body: string
    history: boolean
    layout: 'text' | 'blocks'
    format?: PromptFormat
    scope: 'all' | 'range' | 'later'
    agentId: string
    channel: string
  }): boolean {
    if (!applySource() || !options.name.trim()) return false
    const item: PromptFramework = {
      id: `custom.framework.${createClientUuid().slice(0, 8)}`,
      name: options.name.trim(),
      builtin: false,
      format: options.format ?? 'custom',
      bindings: [],
      blocks: [],
    }
    // 独立框架从内联正文开始，不复制内置槽位、人设、规则或能力装配。
    if (options.layout === 'text')
      item.blocks.push({
        id: 'prompt',
        name: '完整提示词',
        kind: 'template',
        role: 'system',
        enabled: true,
        template: options.body,
      })
    if (options.history)
      item.blocks.push({
        id: 'history',
        name: '对话历史',
        kind: 'history',
        role: 'user',
        enabled: true,
      })
    if (item.format === 'infos') {
      const original = view.value?.defaults.frameworks.find(
        (framework) => framework.id === 'builtin.main',
      )
      if (!original) return false
      item.bindings = clone(original.bindings)
      item.blocks = clone(original.blocks)
    } else if (item.format === 'sillytavern') {
      item.sillyTavern = { markerBindings: { ...ST_MARKER_BINDINGS }, values: {} }
      for (const block of item.blocks) {
        block.stIdentifier = block.kind === 'history' ? 'chatHistory' : 'main'
        block.position = 'relative'
      }
    }
    addFramework(item, options)
    notify.toast(
      options.scope === 'later'
        ? __t('ui.settings', '已创建框架草稿')
        : __t('ui.settings', '已创建并指派，发布后生效'),
      'success',
    )
    return true
  }
  function addFramework(
    item: PromptFramework,
    options: { scope: 'all' | 'range' | 'later'; agentId: string; channel: string },
  ) {
    bundle.value.frameworks.push(item)
    if (options.scope === 'all') {
      // 全部对话包含已有频道和角色指派，避免社交等范围继续覆盖新框架。
      for (const scope of bundle.value.assignments) scope.frameworkId = item.id
      const global = bundle.value.assignments.find((scope) => !scope.agentId && !scope.channel)
      if (!global)
        bundle.value.assignments.push({
          agentId: '',
          channel: '',
          frameworkId: item.id,
          overrides: {},
        })
    } else if (options.scope === 'range') {
      const scope = bundle.value.assignments.find(
        (scope) => scope.agentId === options.agentId && scope.channel === options.channel,
      )
      if (scope) scope.frameworkId = item.id
      else
        bundle.value.assignments.push({
          agentId: options.agentId,
          channel: options.channel,
          frameworkId: item.id,
          overrides: {},
        })
    }
    scopeAgent.value = options.agentId
    scopeChannel.value = options.channel
    mode.value = 'visual'
    search.value = ''
    select(item.id, 'framework')
    if (options.channel) previewChannel.value = options.channel
    if (options.agentId) previewAgent.value = options.agentId
    formatFilter.value = promptFormat(item)
  }
  function assignSelectedFramework(agentId: string, channel: string): boolean {
    if (!applySource() || !framework.value) return false
    const id = framework.value.id
    scopeAgent.value = agentId
    scopeChannel.value = channel
    section.value = 'assignments'
    assignment().frameworkId = id
    refreshSource()
    return true
  }
  function confirm(title: string, message: string, work: () => void | Promise<void>) {
    pendingDialog.value = { title, message, action: work }
  }
  function remove() {
    const item = record.value
    if (!item) return
    confirm(
      __t('ui.settings', '删除模板'),
      __t('ui.settings', '删除“{0}”？已有引用需要同步调整。', [item.name]),
      () => {
        if (framework.value)
          bundle.value.frameworks = bundle.value.frameworks.filter((f) => f.id !== item.id)
        else bundle.value.documents = bundle.value.documents.filter((d) => d.id !== item.id)
        setSection(section.value)
      },
    )
  }
  function reset() {
    const original =
      view.value?.defaults.frameworks.find((f) => f.id === selectedId.value) ??
      view.value?.defaults.documents.find((d) => d.id === selectedId.value)
    if (!original) return
    confirm(
      __t('ui.settings', '恢复内置'),
      __t('ui.settings', '当前条目将恢复到内置内容，发布后生效。'),
      () => {
        if (framework.value)
          bundle.value.frameworks.splice(
            bundle.value.frameworks.indexOf(framework.value),
            1,
            clone(original as PromptFramework),
          )
        else if (document.value)
          bundle.value.documents.splice(
            bundle.value.documents.indexOf(document.value),
            1,
            clone(original as PromptDocument),
          )
        refreshSource()
      },
    )
  }
  function addBlock() {
    const blocks = framework.value?.blocks
    if (!blocks) return
    const conversation = blocks.findIndex(
      (block) => block.kind === 'history' || block.role !== 'system',
    )
    const blockId = `block.${createClientUuid().slice(0, 8)}`
    blocks.splice(conversation < 0 ? blocks.length : conversation, 0, {
      id: blockId,
      name: '新区块',
      kind: 'template',
      role: 'system',
      enabled: true,
      template: '',
      ...(framework.value && promptFormat(framework.value) === 'sillytavern'
        ? { stIdentifier: blockId, position: 'relative' as const, depth: 4, order: 100 }
        : {}),
    })
  }
  function moveBlock(from: number, to: number) {
    const blocks = framework.value?.blocks
    if (
      !blocks ||
      from < 0 ||
      from >= blocks.length ||
      to < 0 ||
      to >= blocks.length ||
      from === to
    )
      return
    const block = blocks.splice(from, 1)[0] as PromptBlock
    blocks.splice(to, 0, block)
  }
  function assignment(): PromptAssignment {
    if (currentAssignment.value) return currentAssignment.value
    const created = {
      agentId: scopeAgent.value,
      channel: scopeChannel.value,
      frameworkId: '',
      overrides: {},
    }
    bundle.value.assignments.push(created)
    return created
  }
  async function save(publish = false) {
    if (!view.value || !applySource()) return
    await action(async () => {
      const saved = await promptApi.save(clone(bundle.value), view.value!.revision)
      if (!saved.data) throw new Error('未收到保存结果')
      accept(saved.data)
      if (publish) {
        issues.value = (await promptApi.validate(bundle.value)).data ?? []
        if (issues.value.some((i) => i.level === 'error')) throw new Error('请先修复校验错误')
        const result = await promptApi.publish(view.value!.revision, '')
        if (result.data) accept(result.data)
      }
      notify.toast(
        publish ? __t('ui.settings', '已发布，下轮生效') : __t('ui.settings', '草稿已保存'),
        'success',
      )
    })
  }
  async function validate() {
    if (!applySource()) return
    await action(async () => {
      issues.value = (await promptApi.validate(bundle.value)).data ?? []
      if (!issues.value.length) notify.toast(__t('ui.settings', '校验通过'), 'success')
    })
  }
  async function renderPreview() {
    if (!applySource()) return
    previewOpen.value = true
    await action(async () => {
      const variables = JSON.parse(variablesText.value) as Record<string, unknown>
      if (!variables || typeof variables !== 'object' || Array.isArray(variables))
        throw new Error('示例变量需要 JSON 对象')
      const result = await promptApi.preview({
        bundle: clone(bundle.value),
        channel: previewChannel.value,
        agentId: previewAgent.value,
        frameworkId: framework.value?.id,
        taskId: section.value === 'task' ? document.value?.id : undefined,
        variables: { ...variables, generation_type: previewGeneration.value },
      })
      preview.value = result.data ?? null
    })
  }
  async function showVersion(id: string) {
    versionId.value = id
    await action(async () => {
      historical.value = (await promptApi.version(id)).data?.bundle ?? null
      diffId.value = ''
    })
  }
  function restoreVersion() {
    if (!historical.value) return
    confirm(
      __t('ui.settings', '恢复版本'),
      __t('ui.settings', '将这个版本恢复到草稿，发布后生效。'),
      () => {
        bundle.value = clone(historical.value!)
        mode.value = 'visual'
        refreshSource()
        notify.toast(__t('ui.settings', '已恢复到草稿'), 'success')
      },
    )
  }
  function restoreDefaults() {
    if (!view.value) return
    confirm(
      __t('ui.settings', '恢复内置预设'),
      __t('ui.settings', '用内置配置替换当前草稿，发布后生效。'),
      () => {
        bundle.value = clone(view.value!.defaults)
        mode.value = 'visual'
        setSection('framework')
      },
    )
  }
  function downloadJson(value: unknown, filename: string) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    if (blob.size > 4_000_000)
      throw new Error(__t('ui.prompt-presets', '预设超过 4 MB，请减少内容后重试'))
    const url = URL.createObjectURL(blob)
    const link = window.document.createElement('a')
    link.href = url
    link.download = filename
    try {
      window.document.body.append(link)
      link.click()
    } finally {
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  }
  async function exportBundle() {
    if (!applySource()) return
    await action(async () => {
      downloadJson({ format: 'infos-prompts-v1', bundle: bundle.value }, 'infos-prompts.json')
      presetExportOpen.value = false
    })
  }
  async function exportPreset(frameworkId: string) {
    if (!applySource()) return
    await action(async () => {
      const preset = createPromptPreset(clone(bundle.value), frameworkId)
      const validation = await promptApi.validate({
        documents: preset.documents,
        frameworks: [preset.framework],
        assignments: [{ agentId: '', channel: '', frameworkId, overrides: {} }],
      })
      issues.value = validation.data ?? []
      if (issues.value.some((issue) => issue.level === 'error'))
        throw new Error(
          __t('ui.prompt-presets', '预设校验未通过，请先修复提示问题，或导出完整备份'),
        )
      // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
      const name = preset.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80)
      downloadJson(preset, `infos-${name || 'prompt'}.preset.json`)
      presetExportOpen.value = false
    })
  }
  async function commitPresetImport(options: {
    scope: 'all' | 'range' | 'later'
    agentId: string
    channel: string
  }) {
    const pending = presetImport.value
    if (!pending || !pending.preset.name.trim() || !applySource()) return
    await action(async () => {
      const before = JSON.stringify(bundle.value)
      const prepared = preparePromptPreset(pending.preset, createClientUuid())
      const candidate: PromptBundle = {
        ...clone(bundle.value),
        documents: [...clone(bundle.value.documents), ...prepared.documents],
        frameworks: [...clone(bundle.value.frameworks), prepared.framework],
      }
      const result = await promptApi.validate(candidate)
      if (presetImport.value !== pending || !presetImportOpen.value) return
      if (JSON.stringify(bundle.value) !== before)
        throw new Error(__t('ui.prompt-presets', '草稿已变化，请重新确认导入'))
      bundle.value.documents.push(...prepared.documents)
      addFramework(prepared.framework, options)
      issues.value = result.data ?? []
      presetImportOpen.value = false
      presetImport.value = null
      notify.toast(__t('ui.settings', '已导入草稿，发布后生效'), 'success')
    })
  }
  async function parseStImport(profile?: number) {
    const result = await promptApi.importSillyTavern(
      stImportInput,
      stImport.value?.framework.name ?? stImportFile,
      profile,
    )
    if (!result.data || !isPromptFramework(result.data.framework))
      throw new Error('未收到有效的酒馆预设')
    stImport.value = result.data
    stImportOpen.value = true
  }
  async function reloadStImport(profile: number) {
    await action(() => parseStImport(profile))
  }
  function commitStImport(options: {
    scope: 'all' | 'range' | 'later'
    agentId: string
    channel: string
  }) {
    if (!stImport.value || !applySource()) return false
    const item = clone(stImport.value.framework)
    item.id = `custom.st.${createClientUuid()}`
    addFramework(item, options)
    issues.value = stImport.value.issues
    stImportOpen.value = false
    stImport.value = null
    stImportInput = undefined
    notify.toast(__t('ui.settings', '已导入草稿，发布后生效'), 'success')
    return true
  }
  async function exportStPreset() {
    if (!framework.value || !applySource()) return
    const selected = framework.value
    await action(async () => {
      const result = await promptApi.exportSillyTavern(clone(bundle.value), selected.id)
      if (!result.data) throw new Error('预设导出失败')
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' }),
      )
      const link = window.document.createElement('a')
      link.href = url
      link.download = `${selected.name.replace(/[<>:"/\\|?*]/g, '_')}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  async function importBundle(file?: File) {
    if (!file) return
    await action(async () => {
      if (file.size > 4_000_000)
        throw new Error(__t('ui.prompt-presets', '预设超过 4 MB，请减少内容后重试'))
      let input: Record<string, unknown>
      try {
        const value: unknown = JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        input = value as Record<string, unknown>
      } catch {
        throw new Error(__t('ui.prompt-presets', '请选择有效的 JSON 预设文件'))
      }
      if (input.format === 'infos-prompt-preset') {
        const preset = parsePromptPreset(input)
        const prepared = preparePromptPreset(preset, createClientUuid())
        const result = await promptApi.validate({
          ...clone(bundle.value),
          documents: [...clone(bundle.value.documents), ...prepared.documents],
          frameworks: [...clone(bundle.value.frameworks), prepared.framework],
        })
        presetImport.value = { preset, issues: result.data ?? [] }
        presetImportOpen.value = true
        return
      }
      if (
        input &&
        typeof input === 'object' &&
        ('prompts' in input ||
          'main_prompt' in input ||
          'nsfw_prompt' in input ||
          'jailbreak_prompt' in input)
      ) {
        stImportInput = input
        stImportFile = file.name
        stImport.value = null
        await parseStImport()
        return
      }
      if (input.format !== undefined && input.format !== 'infos-prompts-v1')
        throw new Error(__t('ui.prompt-presets', '不支持此预设格式或版本'))
      const candidate = input.bundle ?? input
      if (!isPromptBundle(candidate))
        throw new Error(__t('ui.prompt-presets', '不是有效的 infOS 提示词预设'))
      const result = await promptApi.validate(candidate)
      issues.value = result.data ?? []
      confirm(
        __t('ui.settings', '导入配置'),
        __t('ui.settings', '替换当前草稿，发布后生效。'),
        () => {
          if (!applySource()) return
          bundle.value = candidate
          mode.value = 'visual'
          setSection('framework')
        },
      )
    })
  }
  function stash() {
    if (!view.value) return
    if (!dirty.value) {
      try {
        localStorage.removeItem(cacheKey)
      } catch {
        /* 清理失败不影响服务端草稿。 */
      }
      return
    }
    try {
      localStorage.setItem(
        cacheKey,
        JSON.stringify({
          revision: view.value.revision,
          bundle: bundle.value,
          source: source.value,
          sourceBase: sourceBase.value,
          mode: mode.value,
          section: section.value,
          selectedId: selectedId.value,
        }),
      )
    } catch {
      /* 存储空间不足不影响当前编辑。 */
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value) {
      stash()
      event.preventDefault()
      event.returnValue = ''
    }
  }
  watch(
    [bundle, source],
    () => {
      preview.value = null
      if (stashTimer) clearTimeout(stashTimer)
      stashTimer = setTimeout(stash, 400)
    },
    { deep: true },
  )
  onMounted(() => {
    void load()
    window.addEventListener('beforeunload', beforeUnload)
  })
  onBeforeUnmount(() => {
    if (stashTimer) clearTimeout(stashTimer)
    stash()
    window.removeEventListener('beforeunload', beforeUnload)
  })
  return {
    view,
    bundle,
    busy,
    error,
    section,
    search,
    formatFilter,
    setFormatFilter,
    stImport,
    stImportOpen,
    presetExportOpen,
    presetImportOpen,
    presetImport,
    exportPreset,
    commitPresetImport,
    reloadStImport,
    commitStImport,
    exportStPreset,
    selectedId,
    mode,
    source,
    issues,
    preview,
    previewOpen,
    previewAgent,
    previewChannel,
    previewGeneration,
    variablesText,
    scopeAgent,
    scopeChannel,
    versionId,
    historical,
    diffId,
    activeDiff,
    changedEntries,
    pendingDialog,
    dirty,
    framework,
    document,
    resources,
    frameworkOptions,
    sourceOptions,
    displayBuiltinName,
    currentAssignment,
    setSection,
    select,
    setMode,
    create,
    createIndependent,
    assignSelectedFramework,
    remove,
    reset,
    addBlock,
    moveBlock,
    assignment,
    save,
    validate,
    renderPreview,
    showVersion,
    restoreVersion,
    restoreDefaults,
    exportBundle,
    importBundle,
    confirm,
    load,
  }
}
