<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * AgentConfigTab.vue — 界面组件
 *
 * 负责组织该界面的响应式状态、用户交互与领域数据展示。
 * 副作用在组件生命周期内建立并清理，避免跨页面残留监听器或异步状态。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PButton, PCheckbox, PDialog, PEmpty, PInput, PTextarea, PixelIcon } from '../../pixel'
import {
  agentApi,
  type AgentCapabilities,
  type AgentDetail,
  type AgentListItem,
  type AgentSkillOption,
  type AgentTool,
} from '../../../api/modules/agentApi'
import { getApiBaseUrl } from '../../../api/transport'
import { invoke, isElectron } from '../../../utils/ipcAdapter'
import { useNotificationStore } from '../../../stores'
import { systemApi } from '../../../api/modules/systemApi'

/** 角色图鉴采用用户能理解的五区协议，不暴露底层文件结构。 */
type AtlasSection = 'identity' | 'persona' | 'reactions' | 'capability' | 'runtime'
type ManagedChannel = 'desktop' | 'group'

const notif = useNotificationStore()
const agents = ref<AgentListItem[]>([])
const selectedId = ref('')
const form = ref<AgentDetail | null>(null)
const capabilities = ref<AgentCapabilities>({ channels: {} })
const tools = ref<AgentTool[]>([])
const skillOptions = ref<AgentSkillOption[]>([])
const activeSection = ref<AtlasSection>('identity')
const activeChannel = ref<ManagedChannel>('desktop')
const loadingList = ref(false)
const loadingDetail = ref(false)
const saving = ref(false)
const deleting = ref(false)
const exporting = ref(false)
const createDialog = ref(false)
const deleteDialog = ref(false)
const newAgentId = ref('')
const cleanSnapshot = ref('')
const pendingAgentId = ref('')
const switchDecisionOpen = ref(false)
const archiveRailOpen = ref(false)

// ── 身份档案头像：客户端选择/裁切，服务端保存为 Agent 资源 ──
const avatarFileInput = ref<HTMLInputElement | null>(null)
const avatarCropOpen = ref(false)
const avatarCropSource = ref('')
const avatarCropScale = ref(1)
const avatarCropOffsetX = ref(0)
const avatarCropOffsetY = ref(0)
const avatarCropNaturalWidth = ref(0)
const avatarCropNaturalHeight = ref(0)
const avatarUploading = ref(false)
let avatarCropObjectUrl = ''

const sections: Array<{ id: AtlasSection; code: string; label: string; help: string }> = [
  {
    id: 'identity',
    code: '01',
    get label() {
      return __t('ui.settings', '身份档案')
    },
    help: '角色名称、称呼与档案说明',
  },
  {
    id: 'persona',
    code: '02',
    get label() {
      return __t('ui.settings', '人格内核')
    },
    help: '核心人格与不同场景表达',
  },
  {
    id: 'reactions',
    code: '03',
    get label() {
      return __t('ui.settings', '交互反应')
    },
    help: '桌宠点击、闲置与时段问候',
  },
  {
    id: 'capability',
    code: '04',
    get label() {
      return __t('ui.settings', '能力协议')
    },
    help: '主 Agent 在各场景下的工具与技能',
  },
  {
    id: 'runtime',
    code: '05',
    get label() {
      return __t('ui.settings', '运行来源')
    },
    help: '配置来源、系统协议与资源状态',
  },
]
const channels: Array<{ value: ManagedChannel; code: string; label: string; help: string }> = [
  {
    value: 'desktop',
    code: 'DESK',
    get label() {
      return __t('ui.settings', '桌面工作')
    },
    help: '主窗口与桌宠共享的本地能力',
  },
  {
    value: 'group',
    code: 'BASE',
    get label() {
      return __t('ui.settings', '据点群聊')
    },
    help: 'infOS 据点内部的多人会话能力',
  },
]
const reactionParts = [
  {
    key: 'click.head',
    code: 'HEAD',
    get label() {
      return __t('ui.settings', '头部')
    },
    help: '头发、面部、眼睛与头饰区域',
  },
  {
    key: 'click.arm',
    code: 'ARM',
    get label() {
      return __t('ui.settings', '手臂与手部')
    },
    help: '手臂、手掌与袖子区域',
  },
  {
    key: 'click.body',
    code: 'BODY',
    get label() {
      return __t('ui.settings', '身体')
    },
    help: '胸部、腰部与服装主体区域',
  },
  {
    key: 'click.leg',
    code: 'LEG',
    get label() {
      return __t('ui.settings', '腿部')
    },
    help: '腿、脚与鞋袜区域',
  },
]
const welcomeSlots = [
  {
    key: 'welcome.midnight',
    get label() {
      return __t('ui.settings', '深夜')
    },
    range: '00:00–04:00',
  },
  {
    key: 'welcome.morningEarly',
    get label() {
      return __t('ui.settings', '清晨')
    },
    range: '04:00–07:00',
  },
  {
    key: 'welcome.morning',
    get label() {
      return __t('ui.settings', '早晨')
    },
    range: '07:00–11:00',
  },
  {
    key: 'welcome.noon',
    get label() {
      return __t('ui.settings', '中午')
    },
    range: '11:00–13:00',
  },
  {
    key: 'welcome.afternoon',
    get label() {
      return __t('ui.settings', '下午')
    },
    range: '13:00–17:00',
  },
  {
    key: 'welcome.eveningSunset',
    get label() {
      return __t('ui.settings', '傍晚')
    },
    range: '17:00–19:00',
  },
  {
    key: 'welcome.night',
    get label() {
      return __t('ui.settings', '夜晚')
    },
    range: '19:00–24:00',
  },
]
const fragmentCatalog = [
  {
    id: 'components/abilities/workspace',
    name: '工作区操作',
    get description() {
      return __t('ui.settings', '让角色常驻了解工作区文件与编辑能力。')
    },
  },
]
// 分组名与 classifyTool 的返回值同为当前语言译文，切换繁中/英文时两者仍能对上。
const categoryOrder = computed(() => [
  __t('ui.settings', '文件读取'),
  __t('ui.settings', '文件编辑'),
  __t('ui.settings', '终端执行'),
  __t('ui.settings', '视觉交互'),
  __t('ui.settings', '网页访问'),
  __t('ui.settings', '系统操作'),
  __t('ui.settings', '提醒记忆'),
  __t('ui.settings', '其他'),
  // 子应用工具随子应用启动动态出现，固定排在最后。
  __t('ui.settings', '子应用'),
])

const avatarSrc = computed(() => {
  if (!form.value?.avatarUrl) return ''
  return /^https?:\/\//.test(form.value.avatarUrl)
    ? form.value.avatarUrl
    : `${getApiBaseUrl()}${form.value.avatarUrl}`
})

const AVATAR_CROP_SIZE = 280
const avatarCropBaseScale = computed(() => {
  if (!avatarCropNaturalWidth.value || !avatarCropNaturalHeight.value) return 1
  return Math.max(
    AVATAR_CROP_SIZE / avatarCropNaturalWidth.value,
    AVATAR_CROP_SIZE / avatarCropNaturalHeight.value,
  )
})
const avatarCropImageStyle = computed(() => {
  const width = avatarCropNaturalWidth.value * avatarCropBaseScale.value * avatarCropScale.value
  const height = avatarCropNaturalHeight.value * avatarCropBaseScale.value * avatarCropScale.value
  return {
    width: `${width}px`,
    height: `${height}px`,
    left: `calc(50% + ${avatarCropOffsetX.value}px)`,
    top: `calc(50% + ${avatarCropOffsetY.value}px)`,
  }
})
let avatarDragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null

function openAvatarPicker(): void {
  if (!form.value || avatarUploading.value) return
  avatarFileInput.value?.click()
}

function releaseAvatarCropSource(): void {
  if (avatarCropObjectUrl) URL.revokeObjectURL(avatarCropObjectUrl)
  avatarCropObjectUrl = ''
}

function handleAvatarFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    notif.toast(__t('ui.settings', '请选择图片文件'), 'warning')
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    notif.toast(__t('ui.settings', '原始图片不能超过 10MB'), 'warning')
    return
  }
  releaseAvatarCropSource()
  avatarCropObjectUrl = URL.createObjectURL(file)
  avatarCropSource.value = avatarCropObjectUrl
  avatarCropScale.value = 1
  avatarCropOffsetX.value = 0
  avatarCropOffsetY.value = 0
  avatarCropOpen.value = true
}

function handleAvatarCropImageLoad(event: Event): void {
  const image = event.target as HTMLImageElement
  avatarCropNaturalWidth.value = image.naturalWidth
  avatarCropNaturalHeight.value = image.naturalHeight
}

function startAvatarDrag(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  avatarDragStart = {
    x: event.clientX,
    y: event.clientY,
    offsetX: avatarCropOffsetX.value,
    offsetY: avatarCropOffsetY.value,
  }
}

function dragAvatar(event: PointerEvent): void {
  if (!avatarDragStart) return
  avatarCropOffsetX.value = avatarDragStart.offsetX + event.clientX - avatarDragStart.x
  avatarCropOffsetY.value = avatarDragStart.offsetY + event.clientY - avatarDragStart.y
}

function stopAvatarDrag(): void {
  avatarDragStart = null
}

function cancelAvatarCrop(): void {
  if (avatarUploading.value) return
  avatarCropOpen.value = false
  releaseAvatarCropSource()
  avatarCropSource.value = ''
}

async function saveAvatarCrop(): Promise<void> {
  if (!form.value || !avatarCropNaturalWidth.value || !avatarCropNaturalHeight.value) return
  avatarUploading.value = true
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持图片裁切')
    const image = new Image()
    image.src = avatarCropSource.value
    await image.decode()

    const renderedWidth =
      avatarCropNaturalWidth.value * avatarCropBaseScale.value * avatarCropScale.value
    const renderedHeight =
      avatarCropNaturalHeight.value * avatarCropBaseScale.value * avatarCropScale.value
    const left = (AVATAR_CROP_SIZE - renderedWidth) / 2 + avatarCropOffsetX.value
    const top = (AVATAR_CROP_SIZE - renderedHeight) / 2 + avatarCropOffsetY.value
    const scale = canvas.width / AVATAR_CROP_SIZE
    context.drawImage(
      image,
      left * scale,
      top * scale,
      renderedWidth * scale,
      renderedHeight * scale,
    )

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('头像编码失败'))),
        'image/png',
      )
    })
    const response = await agentApi.uploadAvatar(form.value.id, blob)
    const avatarUrl = `${response.data?.avatarUrl ?? `/agents/${form.value.id}/avatar`}?v=${Date.now()}`
    form.value.avatarUrl = avatarUrl
    agents.value = agents.value.map((agent) =>
      agent.id === form.value!.id ? { ...agent, avatarUrl } : agent,
    )
    cleanSnapshot.value = serializeState()
    notif.toast(__t('ui.settings', '角色头像已更新'), 'success')
    cancelAvatarCrop()
  } catch (error) {
    notif.toast(
      __t('ui.settings', '头像保存失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  } finally {
    avatarUploading.value = false
  }
}

const reactionCount = computed(() => {
  if (!form.value) return 0
  return (
    reactionParts.reduce(
      (total, part) => total + getStringArray(part.key).filter(Boolean).length,
      0,
    ) +
    getStringArray('idleMessages').filter(Boolean).length +
    welcomeSlots.filter((slot) => getString(slot.key)).length +
    (getString('visibilityBack') ? 1 : 0)
  )
})
const capabilityCount = computed(() => {
  const names = new Set<string>()
  for (const channel of channels) {
    for (const name of capabilities.value.channels[channel.value]?.tools ?? []) names.add(name)
  }
  return names.size
})
const profileCompletion = computed(() => {
  if (!form.value) return 0
  const checks = [
    form.value.name,
    form.value.description,
    form.value.ownerAppellation,
    form.value.systemPrompt,
    form.value.publicProfile.gender,
    form.value.publicProfile.identity,
    form.value.publicProfile.appearance,
    form.value.publicProfile.personality,
    avatarSrc.value,
  ]
  return Math.round((checks.filter(Boolean).length / checks.length) * 100)
})
const activeSectionMeta = computed(
  () => sections.find((item) => item.id === activeSection.value) ?? sections[0]!,
)
const isDirty = computed(() => Boolean(form.value) && serializeState() !== cleanSnapshot.value)
const promptTokenCount = ref(0)
let promptTokenTimer: ReturnType<typeof setTimeout> | undefined
let promptTokenRequest = 0
const promptStats = computed(() => {
  const chars = form.value?.systemPrompt.length ?? 0
  return {
    chars,
    tokens: promptTokenCount.value,
    lines: form.value?.systemPrompt.split('\n').length ?? 0,
  }
})

watch(
  () => form.value?.systemPrompt ?? '',
  (text) => {
    window.clearTimeout(promptTokenTimer)
    const request = ++promptTokenRequest
    if (!text) {
      promptTokenCount.value = 0
      return
    }
    promptTokenTimer = window.setTimeout(async () => {
      try {
        const response = await systemApi.countTokens(text)
        if (request === promptTokenRequest) promptTokenCount.value = response.data?.tokens ?? 0
      } catch {
        if (request === promptTokenRequest) promptTokenCount.value = 0
      }
    }, 180)
  },
  { immediate: true },
)
/** 只读空能力集合，避免 computed 求值时写回 capabilities 造成“假未同步”。 */
const EMPTY_CAPABILITY: { tools: string[]; skills: string[]; promptFragments: string[] } = {
  tools: [],
  skills: [],
  promptFragments: [],
}
const activeCapability = computed(
  () => capabilities.value.channels[activeChannel.value] ?? EMPTY_CAPABILITY,
)
/** 获取某个场景的真实能力对象；仅在实际写入时创建并落回 channels，不影响同步快照判定。 */
function getOrCreateChannelCapability(key: ManagedChannel) {
  let value = capabilities.value.channels[key]
  if (!value) {
    value = { tools: [], skills: [], promptFragments: [] }
    capabilities.value.channels[key] = value
  }
  return value
}
const activeCompatibleTools = computed(() =>
  tools.value.filter((tool) => tool.channels?.includes(activeChannel.value)),
)
/** 后端 Registry 标记为 locked 的工具即当前权威系统执行协议，不在前端维护静态副本。 */
const systemProtocolTools = computed(() => tools.value.filter((tool) => tool.locked))
const groupedTools = computed(() => {
  const groups = Object.fromEntries(categoryOrder.value.map((name) => [name, [] as AgentTool[]]))
  for (const tool of activeCompatibleTools.value) groups[classifyTool(tool)]!.push(tool)
  return groups
})
const configuredFragments = computed(() => {
  const configured = new Set(activeCapability.value.promptFragments)
  const catalog = [...fragmentCatalog]
  for (const id of configured) {
    if (!catalog.some((item) => item.id === id)) {
      catalog.push({
        id,
        name: '自定义能力片段',
        get description() {
          return __t('ui.settings', '现有配置：{0}', [id])
        },
      })
    }
  }
  return catalog
})

function serializeState(): string {
  return JSON.stringify({ form: form.value, capabilities: capabilities.value })
}

function classifyTool(tool: AgentTool): string {
  // 子应用工具由子应用工具管理层标明来源，单独成组，不参与关键字归类。
  if (tool.source?.kind === 'application') return __t('ui.settings', '子应用')
  const value = `${tool.name} ${tool.description} ${tool.display?.style ?? ''}`.toLowerCase()
  if (/read|search|glob|list|info|读取|搜索|查找|目录/.test(value))
    return __t('ui.settings', '文件读取')
  if (/write|edit|save|写入|编辑/.test(value)) return __t('ui.settings', '文件编辑')
  if (/terminal|shell|command|exec|终端/.test(value)) return __t('ui.settings', '终端执行')
  if (/screen|image|vision|window|mouse|automation|截图|视觉/.test(value))
    return __t('ui.settings', '视觉交互')
  if (/web|browser|http|url|网页/.test(value)) return __t('ui.settings', '网页访问')
  if (/system|device|application|系统|应用/.test(value)) return __t('ui.settings', '系统操作')
  if (/remind|diary|memory|schedule|提醒|日记|记忆/.test(value))
    return __t('ui.settings', '提醒记忆')
  return __t('ui.settings', '其他')
}

function getObjectRoot(): Record<string, unknown> {
  if (!form.value) return {}
  if (!form.value.waifuTexts) form.value.waifuTexts = {}
  return form.value.waifuTexts
}

function migrateReactionSchema(): boolean {
  const root = getObjectRoot()
  let changed = false
  // 点击反应：仅在已存在 click 配置时迁移旧字段（face/hand → head/arm），避免凭空造出空结构
  if (root.click && typeof root.click === 'object' && !Array.isArray(root.click)) {
    const click = root.click as Record<string, unknown>
    if (!Array.isArray(click.head) && Array.isArray(click.face)) {
      click.head = click.face
      changed = true
    }
    if (!Array.isArray(click.arm) && Array.isArray(click.hand)) {
      click.arm = click.hand
      changed = true
    }
    if (click.face !== undefined) {
      delete click.face
      changed = true
    }
    if (click.hand !== undefined) {
      delete click.hand
      changed = true
    }
  }
  if (Array.isArray(root.visibilityBack)) {
    root.visibilityBack = String(root.visibilityBack[0] ?? '')
    changed = true
  }
  // 时段问候：仅在已存在 welcome 配置时迁移，避免凭空造出空结构
  if (root.welcome && typeof root.welcome === 'object' && !Array.isArray(root.welcome)) {
    const welcome = root.welcome as Record<string, unknown>
    for (const [key, value] of Object.entries(welcome)) {
      if (Array.isArray(value)) {
        welcome[key] = String(value[0] ?? '')
        changed = true
      }
    }
    if (typeof welcome.eveningSunset !== 'string' && typeof welcome.evening === 'string') {
      welcome.eveningSunset = welcome.evening
      changed = true
    }
    if (welcome.evening !== undefined) {
      delete welcome.evening
      changed = true
    }
  }
  if (root.lateNight !== undefined) {
    delete root.lateNight
    changed = true
  }
  if (root.randTextures !== undefined) {
    delete root.randTextures
    changed = true
  }
  return changed
}

function getPath(pathValue: string): unknown {
  let cursor: unknown = getObjectRoot()
  for (const part of pathValue.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function setPath(pathValue: string, value: unknown): void {
  const parts = pathValue.split('.')
  let cursor = getObjectRoot()
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part]))
      cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts.at(-1)!] = value
}

function getString(pathValue: string): string {
  const value = getPath(pathValue)
  return typeof value === 'string' ? value : ''
}
function setString(pathValue: string, value: string): void {
  setPath(pathValue, value)
}
function getStringArray(pathValue: string): string[] {
  const value = getPath(pathValue)
  return Array.isArray(value) ? value.map(String) : []
}
function updateArrayItem(pathValue: string, index: number, value: string): void {
  const rows = [...getStringArray(pathValue)]
  rows[index] = value
  setPath(pathValue, rows)
}
function addArrayItem(pathValue: string): void {
  setPath(pathValue, [...getStringArray(pathValue), ''])
}
function removeArrayItem(pathValue: string, index: number): void {
  const rows = [...getStringArray(pathValue)]
  rows.splice(index, 1)
  setPath(pathValue, rows)
}

function isToolEnabled(tool: AgentTool): boolean {
  return (
    Boolean(tool.locked) ||
    activeCapability.value.tools.includes('*') ||
    activeCapability.value.tools.includes(tool.name)
  )
}
function setToolEnabled(tool: AgentTool, enabled: boolean): void {
  if (tool.locked) return
  const target = getOrCreateChannelCapability(activeChannel.value)
  const currentTools = target.tools.includes('*')
    ? activeCompatibleTools.value.map((item) => item.name)
    : target.tools
  target.tools = enabled
    ? [...new Set([...currentTools, tool.name])]
    : currentTools.filter((name) => name !== tool.name)
}
function toggleSkill(skillId: string, enabled: boolean): void {
  const target = getOrCreateChannelCapability(activeChannel.value)
  target.skills = enabled
    ? [...new Set([...target.skills, skillId])]
    : target.skills.filter((id) => id !== skillId)
}
function toggleFragment(fragmentId: string, enabled: boolean): void {
  const target = getOrCreateChannelCapability(activeChannel.value)
  target.promptFragments = enabled
    ? [...new Set([...target.promptFragments, fragmentId])]
    : target.promptFragments.filter((id) => id !== fragmentId)
}

async function fetchAgents(preferredId?: string): Promise<void> {
  loadingList.value = true
  try {
    const response = await agentApi.list()
    agents.value = response.data ?? []
    const next =
      preferredId && agents.value.some((item) => item.id === preferredId)
        ? preferredId
        : agents.value[0]?.id
    if (next) await loadAgent(next)
    else form.value = null
  } catch (error) {
    notif.toast(
      __t('ui.settings', '加载角色图鉴失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  } finally {
    loadingList.value = false
  }
}

async function loadAgent(id: string): Promise<void> {
  loadingDetail.value = true
  try {
    const [detailResponse, capabilityResponse] = await Promise.all([
      agentApi.get(id),
      agentApi.getCapabilities(id),
    ])
    selectedId.value = id
    form.value = detailResponse.data ?? null
    if (form.value && !form.value.publicProfile) form.value.publicProfile = {}
    if (form.value && !form.value.waifuTexts) form.value.waifuTexts = {}
    capabilities.value = capabilityResponse.data ?? { channels: {} }
    for (const channel of Object.values(capabilities.value.channels)) {
      channel.promptFragments = channel.promptFragments.filter(
        (fragment) => fragment !== 'components/abilities/vision',
      )
    }
    skillOptions.value = capabilities.value.skills ?? []
    activeSection.value = 'identity'
    // 旧档案自动迁移（清理 lateNight/randTextures 等历史字段）属静默数据修复：
    // 迁移结果直接作为“已同步”基准，避免什么都没干也误报“档案存在未同步修改”。
    migrateReactionSchema()
    cleanSnapshot.value = serializeState()
  } catch (error) {
    notif.toast(
      __t('ui.settings', '读取角色档案失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  } finally {
    loadingDetail.value = false
  }
}

async function selectAgent(id: string): Promise<void> {
  if (id === selectedId.value) return
  if (isDirty.value) {
    pendingAgentId.value = id
    switchDecisionOpen.value = true
    return
  }
  await loadAgent(id)
}

function cancelAgentSwitch(): void {
  switchDecisionOpen.value = false
  pendingAgentId.value = ''
}

async function discardAndSwitch(): Promise<void> {
  const target = pendingAgentId.value
  cancelAgentSwitch()
  if (target) await loadAgent(target)
}

async function saveAndSwitch(): Promise<void> {
  const target = pendingAgentId.value
  await saveAgent()
  if (!isDirty.value && target) {
    cancelAgentSwitch()
    await loadAgent(target)
  }
}

async function discardChanges(): Promise<void> {
  if (selectedId.value) await loadAgent(selectedId.value)
}

async function saveAgent(): Promise<void> {
  if (!form.value) return
  saving.value = true
  try {
    await Promise.all([
      agentApi.update(form.value.id, {
        name: form.value.name,
        description: form.value.description,
        publicProfile: form.value.publicProfile,
        ownerAppellation: form.value.ownerAppellation,
        systemPrompt: form.value.systemPrompt,
        channelPatches: form.value.channelPatches,
        waifuTexts: form.value.waifuTexts,
      }),
      agentApi.updateCapabilities(form.value.id, { channels: capabilities.value.channels }),
    ])
    cleanSnapshot.value = serializeState()
    const listResponse = await agentApi.list()
    agents.value = listResponse.data ?? []
    notif.toast(__t('ui.settings', '角色档案已同步'), 'success')
  } catch (error) {
    notif.toast(
      __t('ui.settings', '同步失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  } finally {
    saving.value = false
  }
}

async function createAgent(id?: string): Promise<void> {
  const value = id?.trim().toLowerCase()
  if (!value || !/^[a-z0-9_-]+$/.test(value)) {
    notif.toast(__t('ui.settings', '角色 ID 只能包含小写字母、数字、下划线和连字符'), 'warning')
    return
  }
  saving.value = true
  try {
    await agentApi.create({
      id: value,
      name: '新角色',
      description: '',
      ownerAppellation: '主人',
      systemPrompt: '',
    })
    newAgentId.value = ''
    await fetchAgents(value)
    notif.toast(__t('ui.settings', '角色档案已初始化'), 'success')
  } catch (error) {
    notif.toast(
      __t('ui.settings', '创建失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  } finally {
    saving.value = false
  }
}

async function exportAgent(): Promise<void> {
  if (!form.value || exporting.value) return
  if (!isElectron()) {
    notif.toast(__t('ui.settings', '角色包目录导出仅支持桌面客户端'), 'warning')
    return
  }
  if (isDirty.value) {
    notif.toast(__t('ui.settings', '请先同步当前修改，再导出角色包'), 'warning')
    return
  }
  exporting.value = true
  try {
    const response = await agentApi.exportPackage(form.value.id)
    if (!response.data) throw new Error('服务端没有返回角色包')
    const result = (await invoke('export-agent-package', response.data)) as {
      canceled: boolean
      path?: string
    } | null
    if (result && !result.canceled)
      notif.toast(__t('ui.settings', '角色包已导出到：{0}', [result.path]), 'success')
  } catch (error) {
    notif.toast(
      __t('ui.settings', '导出失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  } finally {
    exporting.value = false
  }
}

async function deleteAgent(): Promise<void> {
  if (!form.value?.isUser) return
  deleting.value = true
  try {
    await agentApi.remove(form.value.id)
    await fetchAgents()
    notif.toast(__t('ui.settings', '用户角色档案已删除'), 'success')
  } catch (error) {
    notif.toast(
      __t('ui.settings', '删除失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  } finally {
    deleting.value = false
  }
}

async function initialize(): Promise<void> {
  try {
    const response = await agentApi.listTools()
    tools.value = response.data ?? []
  } catch (error) {
    notif.toast(
      __t('ui.settings', '加载能力协议失败：{0}', [
        error instanceof Error ? error.message : __t('ui.settings', '未知错误'),
      ]),
      'error',
    )
  }
  await fetchAgents()
}

onMounted(initialize)
onBeforeUnmount(() => {
  window.clearTimeout(promptTokenTimer)
  releaseAvatarCropSource()
})
</script>

<template>
  <div class="atlas">
    <aside class="atlas-index">
      <header class="index-head">
        <div>
          <b class="index-head-title">{{ __t('ui.settings', '角色管理') }}</b>
          <span>
            {{ __t('ui.settings', '角色图鉴 /') }} {{ agents.length.toString().padStart(2, '0') }}
          </span>
        </div>
        <button :title="__t('ui.settings', '刷新角色图鉴')" @click="fetchAgents(selectedId)">
          <PixelIcon name="refresh" size="xs" :animation="loadingList ? 'spin' : undefined" />
        </button>
      </header>
      <div class="index-list">
        <button
          v-for="(agent, index) in agents"
          :key="agent.id"
          class="index-agent"
          :class="{ active: selectedId === agent.id }"
          @click="selectAgent(agent.id)"
        >
          <span class="index-card-top">
            <i>{{ String(index + 1).padStart(2, '0') }}</i>
            <b>{{ agent.isUser ? 'USER ARCHIVE' : 'CORE ARCHIVE' }}</b>
          </span>
          <span class="index-avatar">
            <img
              v-if="agent.avatarUrl"
              :src="`${getApiBaseUrl()}${agent.avatarUrl}`"
              :alt="agent.name"
            />
            <i v-else>{{ agent.name?.[0] || '?' }}</i>
          </span>
          <span class="index-meta">
            <strong>{{ agent.name }}</strong>
            <small>{{ agent.id.toUpperCase() }}</small>
            <em>{{ agent.description || __t('ui.settings', '未记录角色简介') }}</em>
          </span>
          <span class="index-card-foot">
            <i :class="{ online: selectedId === agent.id }" />
            {{ selectedId === agent.id ? 'OPEN FILE' : 'STANDBY' }}
            <b>VIEW →</b>
          </span>
        </button>
      </div>
      <button class="initialize-agent" @click="createDialog = true">
        <PixelIcon name="plus" size="xs" />
        INITIALIZE CHARACTER
      </button>
    </aside>

    <main class="atlas-workspace">
      <PEmpty
        v-if="!loadingDetail && !form"
        :description="__t('ui.settings', '角色图鉴暂无档案')"
      />
      <div v-else-if="loadingDetail" class="atlas-loading">
        <PixelIcon name="refresh" size="lg" animation="spin" />
        <span>READING CHARACTER PROFILE</span>
      </div>
      <template v-else-if="form">
        <header class="profile-band">
          <div class="portrait">
            <img v-if="avatarSrc" :src="avatarSrc" :alt="form.name" />
            <span v-else>{{ form.name?.[0] || '?' }}</span>
            <i>{{ form.isUser ? 'USER ARCHIVE' : 'CORE ARCHIVE' }}</i>
          </div>
          <div class="profile-identity">
            <span class="eyebrow">CHARACTER / {{ form.id.toUpperCase() }}</span>
            <h1>{{ form.name }}</h1>
            <p>{{ form.description || __t('ui.settings', '尚未记录角色简介。') }}</p>
            <div class="profile-signals">
              <span>
                <i />
                {{ form.isUser ? __t('ui.settings', '用户档案') : __t('ui.settings', '内置档案') }}
              </span>
              <span>
                <i />
                {{
                  form.isActive ? __t('ui.settings', '系统默认') : __t('ui.settings', '可选角色')
                }}
              </span>
              <span>
                <i />
                {{ Object.keys(capabilities.channels).length }}
                {{ __t('ui.settings', '个能力通道') }}
              </span>
            </div>
          </div>
          <div class="profile-seal">
            <span>{{ activeSectionMeta.code }}</span>
            <b>{{ activeSectionMeta.label }}</b>
            <small>CURRENT CHAPTER</small>
          </div>
        </header>

        <nav class="protocol-nav">
          <button
            v-for="section in sections"
            :key="section.id"
            :class="{ active: activeSection === section.id }"
            @click="activeSection = section.id"
          >
            <span>{{ section.code }}</span>
            <strong>{{ section.label }}</strong>
            <small>{{ section.help }}</small>
          </button>
        </nav>

        <div class="protocol-scroll">
          <section v-if="activeSection === 'identity'" class="protocol-page">
            <header class="section-title">
              <span>01</span>
              <div>
                <h2>{{ __t('ui.settings', '身份档案') }}</h2>
                <p>{{ __t('ui.settings', '设置角色名称、称呼与简介。') }}</p>
              </div>
            </header>
            <div class="identity-layout">
              <button
                class="identity-portrait"
                type="button"
                :disabled="avatarUploading"
                @click="openAvatarPicker"
              >
                <img v-if="avatarSrc" :src="avatarSrc" :alt="form.name" />
                <span v-else>{{ form.name?.[0] || '?' }}</span>
                <small>
                  <PixelIcon name="image" size="xs" />
                  {{
                    avatarUploading
                      ? __t('ui.settings', '头像保存中…')
                      : __t('ui.settings', '点击更换头像')
                  }}
                </small>
              </button>
              <div class="data-fields">
                <label>
                  <span>{{ __t('ui.settings', '角色 ID / IMMUTABLE') }}</span>
                  <PInput :model-value="form.id" disabled />
                </label>
                <label>
                  <span>{{ __t('ui.settings', '角色名称') }}</span>
                  <PInput v-model="form.name" :placeholder="__t('ui.settings', '角色显示名称')" />
                </label>
                <label>
                  <span>{{ __t('ui.settings', '对你的称呼') }}</span>
                  <PInput
                    v-model="form.ownerAppellation"
                    :placeholder="__t('ui.settings', '例如：主人、老师')"
                  />
                </label>
                <label class="wide">
                  <span>{{ __t('ui.settings', '角色简介 / 仅用于展示') }}</span>
                  <PTextarea
                    v-model="form.description"
                    :rows="4"
                    :placeholder="__t('ui.settings', '角色背景简介（不作为人格提示词）')"
                  />
                </label>
              </div>
            </div>
            <div class="subsection-head public-profile-head">
              <div>
                <h3>{{ __t('ui.settings', '对外公开档案') }}</h3>
                <p>{{ __t('ui.settings', '仅同房间角色可见，私聊与记忆保持私密。') }}</p>
              </div>
            </div>
            <div class="data-fields public-profile-fields">
              <label>
                <span>{{ __t('ui.settings', '性别 / GENDER') }}</span>
                <PInput
                  v-model="form.publicProfile.gender"
                  :placeholder="__t('ui.settings', '可留空，例如：女')"
                />
              </label>
              <label>
                <span>{{ __t('ui.settings', '公开身份 / IDENTITY') }}</span>
                <PInput
                  v-model="form.publicProfile.identity"
                  :placeholder="__t('ui.settings', '例如：AI数字生命体，主人的助手')"
                />
              </label>
              <label class="wide">
                <span>{{ __t('ui.settings', '外貌 / APPEARANCE') }}</span>
                <PTextarea
                  :model-value="form.publicProfile.appearance ?? ''"
                  :rows="3"
                  :placeholder="__t('ui.settings', '其他角色可以观察到的稳定外貌特征')"
                  @update:model-value="form.publicProfile.appearance = $event ?? ''"
                />
              </label>
              <label class="wide">
                <span>{{ __t('ui.settings', '基本性格 / PERSONALITY') }}</span>
                <PTextarea
                  :model-value="form.publicProfile.personality ?? ''"
                  :rows="3"
                  :placeholder="__t('ui.settings', '对外可见的基本性格，不要填写私密设定')"
                  @update:model-value="form.publicProfile.personality = $event ?? ''"
                />
              </label>
            </div>
          </section>

          <section v-else-if="activeSection === 'persona'" class="protocol-page">
            <header class="section-title">
              <span>02</span>
              <div>
                <h2>{{ __t('ui.settings', '人格内核') }}</h2>
                <p>{{ __t('ui.settings', '核心人格通用，场景表达按场景生效。') }}</p>
              </div>
            </header>
            <div class="persona-console">
              <header>
                <b>PERSONA DEFINITION</b>
                <span>
                  {{ promptStats.lines }} LINES / {{ promptStats.chars }} CHARS /
                  {{ promptStats.tokens }} TOKENS
                </span>
              </header>
              <textarea
                v-model="form.systemPrompt"
                spellcheck="false"
                :placeholder="
                  __t('ui.settings', '描述角色身份、性格、边界、表达方式与长期行为准则。')
                "
              />
            </div>
            <div class="subsection-head">
              <div>
                <h3>{{ __t('ui.settings', '场景表达') }}</h3>
                <p>
                  {{ __t('ui.settings', '补充此场景的表达方式，保留核心人格。社交规则单独设置。') }}
                </p>
              </div>
            </div>
            <div class="scene-patches">
              <article v-for="channel in channels" :key="channel.value">
                <header>
                  <span>{{ channel.code }}</span>
                  <div>
                    <b>{{ channel.label }}</b>
                    <small>{{ channel.help }}</small>
                  </div>
                  <i>{{ form.channelPatches[channel.value]?.length || 0 }} CH</i>
                </header>
                <PTextarea
                  :model-value="form.channelPatches[channel.value] ?? ''"
                  :rows="5"
                  :placeholder="
                    __t('ui.settings', '{0}下需要追加的说话方式或行为边界（可留空）', [
                      channel.label,
                    ])
                  "
                  @update:model-value="form.channelPatches[channel.value] = $event"
                />
              </article>
            </div>
          </section>

          <section v-else-if="activeSection === 'reactions'" class="protocol-page">
            <header class="section-title">
              <span>03</span>
              <div>
                <h2>{{ __t('ui.settings', '交互反应') }}</h2>
                <p>{{ __t('ui.settings', '设置桌宠互动台词。') }}</p>
              </div>
            </header>
            <div class="reaction-grid">
              <article v-for="part in reactionParts" :key="part.key" class="reaction-module">
                <header>
                  <span>{{ part.code }}</span>
                  <div>
                    <b>{{ __t('ui.settings', '点击') }}{{ part.label }}</b>
                    <small>{{ part.help }}</small>
                  </div>
                  <button @click="addArrayItem(part.key)">+ ADD</button>
                </header>
                <div
                  v-for="(line, index) in getStringArray(part.key)"
                  :key="index"
                  class="reaction-line"
                >
                  <span>{{ String(index + 1).padStart(2, '0') }}</span>
                  <PInput
                    :model-value="line"
                    :placeholder="__t('ui.settings', '输入随机反应台词')"
                    @update:model-value="updateArrayItem(part.key, index, $event)"
                  />
                  <button @click="removeArrayItem(part.key, index)">×</button>
                </div>
                <p v-if="!getStringArray(part.key).length">
                  {{ __t('ui.settings', '暂无静态反应，Pet3D 将使用默认台词。') }}
                </p>
              </article>
            </div>
            <div class="subsection-head">
              <div>
                <h3>{{ __t('ui.settings', '环境反应') }}</h3>
                <p>{{ __t('ui.settings', '闲置时随机选用台词。') }}</p>
              </div>
            </div>
            <article class="reaction-module full">
              <header>
                <span>IDLE</span>
                <div>
                  <b>{{ __t('ui.settings', '闲置自语') }}</b>
                  <small>{{ __t('ui.settings', 'Pet3D 空闲 30–60 秒后随机显示') }}</small>
                </div>
                <button @click="addArrayItem('idleMessages')">+ ADD</button>
              </header>
              <div
                v-for="(line, index) in getStringArray('idleMessages')"
                :key="index"
                class="reaction-line"
              >
                <span>{{ String(index + 1).padStart(2, '0') }}</span>
                <PInput
                  :model-value="line"
                  @update:model-value="updateArrayItem('idleMessages', index, $event)"
                />
                <button @click="removeArrayItem('idleMessages', index)">×</button>
              </div>
            </article>
            <article class="single-reaction">
              <span>BACK</span>
              <div>
                <b>{{ __t('ui.settings', '返回桌面问候') }}</b>
                <small>
                  {{ __t('ui.settings', '页面从后台重新可见时显示；动态状态问候优先。') }}
                </small>
              </div>
              <PInput
                :model-value="getString('visibilityBack')"
                :placeholder="__t('ui.settings', '例如：欢迎回来。')"
                @update:model-value="setString('visibilityBack', $event)"
              />
            </article>
            <div class="subsection-head">
              <div>
                <h3>{{ __t('ui.settings', '时段问候') }}</h3>
                <p>{{ __t('ui.settings', '进入 Pet3D 时按本机时间选择一条对应问候。') }}</p>
              </div>
            </div>
            <div class="welcome-table">
              <label v-for="slot in welcomeSlots" :key="slot.key">
                <span>{{ slot.range }}</span>
                <b>{{ slot.label }}</b>
                <PInput
                  :model-value="getString(slot.key)"
                  :placeholder="__t('ui.settings', '可留空')"
                  @update:model-value="setString(slot.key, $event)"
                />
              </label>
            </div>
          </section>

          <section v-else-if="activeSection === 'capability'" class="protocol-page capability-page">
            <header class="section-title">
              <span>04</span>
              <div>
                <h2>{{ __t('ui.settings', '能力协议') }}</h2>
                <p>{{ __t('ui.settings', '设置主助手的工具；社交工具单独管理。') }}</p>
              </div>
            </header>
            <div class="channel-rail">
              <button
                v-for="channel in channels"
                :key="channel.value"
                :class="{ active: activeChannel === channel.value }"
                @click="activeChannel = channel.value"
              >
                <span>{{ channel.code }}</span>
                <div>
                  <b>{{ channel.label }}</b>
                  <small>{{ channel.help }}</small>
                </div>
                <i>{{ capabilities.channels[channel.value]?.tools.length || 0 }}</i>
              </button>
            </div>
            <div class="system-protocol">
              <span>SYS</span>
              <div>
                <b>{{ __t('ui.settings', '常驻工具') }}</b>
                <p v-if="systemProtocolTools.length">
                  <span
                    v-for="tool in systemProtocolTools"
                    :key="tool.name"
                    class="protocol-tool-chip"
                  >
                    {{ tool.display?.label || tool.name }}
                  </span>
                </p>
                <p v-else>{{ __t('ui.settings', '暂无常驻工具。') }}</p>
              </div>
              <strong>LOCKED / {{ systemProtocolTools.length }}</strong>
            </div>
            <div class="subsection-head">
              <div>
                <h3>{{ __t('ui.settings', '工具权限') }}</h3>
                <p>{{ __t('ui.settings', '勾选角色在此场景可用的工具。') }}</p>
              </div>
            </div>
            <div class="tool-table">
              <template v-for="category in categoryOrder" :key="category">
                <header v-if="groupedTools[category]?.some((tool) => !tool.locked)">
                  <span>{{ category }}</span>
                  <i>{{ groupedTools[category].filter((tool) => !tool.locked).length }}</i>
                </header>
                <label
                  v-for="tool in groupedTools[category]?.filter((item) => !item.locked)"
                  :key="tool.name"
                  :class="{ enabled: isToolEnabled(tool) }"
                >
                  <PCheckbox
                    :model-value="isToolEnabled(tool)"
                    @update:model-value="setToolEnabled(tool, $event)"
                  />
                  <span>
                    <b>
                      {{ tool.display?.label }}
                      <em v-if="tool.source" class="tool-source">{{ tool.source.appName }}</em>
                    </b>
                    <small>{{ tool.description }}</small>
                  </span>
                  <i>{{ isToolEnabled(tool) ? 'ON' : 'OFF' }}</i>
                </label>
              </template>
            </div>
            <div class="capability-columns">
              <section>
                <div class="subsection-head">
                  <div>
                    <h3>{{ __t('ui.settings', '专业技能') }}</h3>
                    <p>{{ __t('ui.settings', '角色按需加载技能与所需工具。') }}</p>
                  </div>
                </div>
                <label
                  v-for="skill in skillOptions"
                  :key="skill.id"
                  class="select-row"
                  :class="{ enabled: activeCapability.skills.includes(skill.id) }"
                >
                  <PCheckbox
                    :model-value="activeCapability.skills.includes(skill.id)"
                    @update:model-value="toggleSkill(skill.id, $event)"
                  />
                  <span>
                    <b>{{ skill.name }}</b>
                    <small>{{ skill.description || skill.id }}</small>
                  </span>
                </label>
                <p v-if="!skillOptions.length" class="empty-data">
                  {{ __t('ui.settings', '暂无已安装 Skill') }}
                </p>
              </section>
              <section>
                <div class="subsection-head">
                  <div>
                    <h3>{{ __t('ui.settings', '常驻能力说明') }}</h3>
                    <p>{{ __t('ui.settings', '供角色随时参考的简短能力说明。') }}</p>
                  </div>
                </div>
                <label
                  v-for="fragment in configuredFragments"
                  :key="fragment.id"
                  class="select-row"
                  :class="{ enabled: activeCapability.promptFragments.includes(fragment.id) }"
                >
                  <PCheckbox
                    :model-value="activeCapability.promptFragments.includes(fragment.id)"
                    @update:model-value="toggleFragment(fragment.id, $event)"
                  />
                  <span>
                    <b>{{ fragment.name }}</b>
                    <small>{{ fragment.description }}</small>
                    <code>{{ fragment.id }}</code>
                  </span>
                </label>
              </section>
            </div>
          </section>

          <section v-else class="protocol-page">
            <header class="section-title">
              <span>05</span>
              <div>
                <h2>{{ __t('ui.settings', '运行来源') }}</h2>
                <p>{{ __t('ui.settings', '查看角色来源与资源状态。') }}</p>
              </div>
            </header>
            <div class="runtime-grid">
              <article>
                <span>SOURCE</span>
                <b>{{ form.isUser ? 'USER ARCHIVE' : 'CORE ARCHIVE' }}</b>
                <p>
                  {{
                    form.isUser
                      ? __t('ui.settings', '自定义角色')
                      : __t('ui.settings', '内置角色，可自定义修改。')
                  }}
                </p>
              </article>
              <article>
                <span>DEFAULT</span>
                <b>{{ form.isActive ? 'SYSTEM DEFAULT' : 'SELECTABLE' }}</b>
                <p>
                  {{
                    form.isActive
                      ? __t('ui.settings', '系统默认角色')
                      : __t('ui.settings', '可在会话中选择')
                  }}
                </p>
              </article>
              <article>
                <span>PORTRAIT</span>
                <b>{{ avatarSrc ? 'RESOURCE ONLINE' : 'NO RESOURCE' }}</b>
                <p>{{ __t('ui.settings', '角色头像') }}</p>
              </article>
              <article>
                <span>SOCIAL</span>
                <b>SUBAPP ISOLATED</b>
                <p>{{ __t('ui.settings', '在「社交配置」中管理账号与社交功能。') }}</p>
              </article>
            </div>
            <div class="runtime-note">
              <span>CONFIG CONTRACT</span>
              <p>{{ __t('ui.settings', '工具、模型与社交账号可在对应页面设置。') }}</p>
            </div>
          </section>
        </div>
      </template>
    </main>

    <aside v-if="form" class="archive-rail" :class="{ open: archiveRailOpen }">
      <button
        class="rail-handle"
        :aria-label="
          archiveRailOpen
            ? __t('ui.settings', '收起档案状态栏')
            : __t('ui.settings', '展开档案状态栏')
        "
        @click="archiveRailOpen = !archiveRailOpen"
      >
        <PixelIcon :name="archiveRailOpen ? 'chevron-right' : 'chevron-left'" size="xs" />
        <span>ARCHIVE</span>
      </button>
      <header class="rail-head">
        <span>ARCHIVE CONTROL</span>
        <b>{{ __t('ui.settings', '档案状态与同步') }}</b>
      </header>

      <section class="rail-sync" :class="{ dirty: isDirty }">
        <div class="rail-sync__signal">
          <i />
          <span>{{ isDirty ? 'UNSYNCED DATA' : 'ARCHIVE READY' }}</span>
        </div>
        <h3>
          {{
            isDirty
              ? __t('ui.settings', '档案存在未同步修改')
              : __t('ui.settings', '角色档案已同步')
          }}
        </h3>
        <p>
          {{
            isDirty
              ? __t('ui.settings', '点击「同步档案」保存修改。')
              : __t('ui.settings', '所有修改已保存。')
          }}
        </p>
        <div class="rail-sync__actions">
          <PButton variant="secondary" :disabled="!isDirty || saving" @click="discardChanges">
            {{ __t('ui.settings', '放弃修改') }}
          </PButton>
          <PButton :loading="saving" :disabled="!isDirty" @click="saveAgent">
            {{ __t('ui.settings', '同步档案') }}
          </PButton>
        </div>
      </section>

      <section class="rail-completion">
        <header>
          <span>PROFILE INTEGRITY</span>
          <b>{{ profileCompletion }}%</b>
        </header>
        <div><i :style="{ width: `${profileCompletion}%` }" /></div>
        <p>{{ __t('ui.settings', '根据头像、名称、简介、称呼和人格内核估算。') }}</p>
      </section>

      <section class="rail-stats">
        <article>
          <PixelIcon name="thought" size="sm" />
          <span>
            <b>{{ promptStats.chars }}</b>
            <small>{{ __t('ui.settings', '人格字符') }}</small>
          </span>
        </article>
        <article>
          <PixelIcon name="chat" size="sm" />
          <span>
            <b>{{ reactionCount }}</b>
            <small>{{ __t('ui.settings', '交互反应') }}</small>
          </span>
        </article>
        <article>
          <PixelIcon name="tool" size="sm" />
          <span>
            <b>{{ capabilityCount }}</b>
            <small>{{ __t('ui.settings', '业务工具') }}</small>
          </span>
        </article>
        <article>
          <PixelIcon name="puzzle" size="sm" />
          <span>
            <b>{{ skillOptions.length }}</b>
            <small>{{ __t('ui.settings', '可选技能') }}</small>
          </span>
        </article>
      </section>

      <section class="rail-chapters">
        <header>CHARACTER CHAPTERS</header>
        <button
          v-for="section in sections"
          :key="section.id"
          :class="{ active: activeSection === section.id }"
          @click="activeSection = section.id"
        >
          <span>{{ section.code }}</span>
          <div>
            <b>{{ section.label }}</b>
            <small>{{ section.help }}</small>
          </div>
          <i>→</i>
        </button>
      </section>

      <section class="rail-source">
        <span>ARCHIVE SOURCE</span>
        <b>{{ form.isUser ? 'USER DATA' : 'INFOS CORE' }}</b>
        <p>
          {{
            form.isUser ? __t('ui.settings', '自定义角色') : __t('ui.settings', '内置角色 · 可编辑')
          }}
        </p>
      </section>

      <button class="rail-export" :disabled="exporting || isDirty" @click="exportAgent">
        <PixelIcon name="download" size="xs" />
        {{ exporting ? __t('ui.settings', '正在生成角色包…') : __t('ui.settings', '导出角色包') }}
      </button>
      <button v-if="form.isUser" class="rail-danger" @click="deleteDialog = true">
        <PixelIcon name="trash" size="xs" />
        {{ __t('ui.settings', '删除用户档案') }}
      </button>
    </aside>

    <div v-if="switchDecisionOpen" class="decision-layer" @click.self="cancelAgentSwitch">
      <section
        class="decision-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-decision-title"
      >
        <header>
          <span>UNSYNCED CHARACTER DATA</span>
          <button :aria-label="__t('ui.settings', '关闭')" @click="cancelAgentSwitch">×</button>
        </header>
        <div class="decision-body">
          <span class="decision-icon"><PixelIcon name="warning" size="lg" /></span>
          <div>
            <h2 id="switch-decision-title">{{ __t('ui.settings', '当前角色档案尚未同步') }}</h2>
            <p>{{ __t('ui.settings', '是否保存当前修改？') }}</p>
          </div>
        </div>
        <div class="decision-target">
          <span>SWITCH TARGET</span>
          <b>{{ agents.find((item) => item.id === pendingAgentId)?.name || pendingAgentId }}</b>
        </div>
        <footer>
          <PButton variant="danger" @click="discardAndSwitch">
            {{ __t('ui.settings', '放弃并切换') }}
          </PButton>
          <PButton variant="secondary" @click="cancelAgentSwitch">
            {{ __t('ui.settings', '继续编辑') }}
          </PButton>
          <PButton :loading="saving" @click="saveAndSwitch">
            {{ __t('ui.settings', '先同步再切换') }}
          </PButton>
        </footer>
      </section>
    </div>

    <input ref="avatarFileInput" hidden type="file" accept="image/*" @change="handleAvatarFile" />

    <div v-if="avatarCropOpen" class="avatar-crop-layer" @click.self="cancelAvatarCrop">
      <section
        class="avatar-crop-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-crop-title"
      >
        <header>
          <div>
            <span>AVATAR RESOURCE</span>
            <h2 id="avatar-crop-title">{{ __t('ui.settings', '裁切角色头像') }}</h2>
          </div>
          <button
            :disabled="avatarUploading"
            :aria-label="__t('ui.settings', '关闭裁切窗口')"
            @click="cancelAvatarCrop"
          >
            ×
          </button>
        </header>
        <div class="avatar-crop-body">
          <div
            class="avatar-crop-stage"
            @pointerdown="startAvatarDrag"
            @pointermove="dragAvatar"
            @pointerup="stopAvatarDrag"
            @pointercancel="stopAvatarDrag"
          >
            <img
              :src="avatarCropSource"
              :style="avatarCropImageStyle"
              :alt="__t('ui.settings', '待裁切头像')"
              @load="handleAvatarCropImageLoad"
            />
            <i class="avatar-crop-grid" />
          </div>
          <label class="avatar-crop-zoom">
            <span>{{ __t('ui.settings', '缩放') }}</span>
            <input
              v-model.number="avatarCropScale"
              type="range"
              min="1"
              max="3"
              step="0.01"
              :disabled="avatarUploading"
            />
            <b>{{ Math.round(avatarCropScale * 100) }}%</b>
          </label>
          <p>{{ __t('ui.settings', '拖动调整位置，保存为 512×512 头像。') }}</p>
        </div>
        <footer>
          <PButton variant="secondary" :disabled="avatarUploading" @click="cancelAvatarCrop">
            {{ __t('ui.settings', '取消') }}
          </PButton>
          <PButton :loading="avatarUploading" @click="saveAvatarCrop">
            {{ __t('ui.settings', '保存头像') }}
          </PButton>
        </footer>
      </section>
    </div>

    <PDialog
      v-model="createDialog"
      :title="__t('ui.settings', '初始化角色档案')"
      mode="prompt"
      :placeholder="__t('ui.settings', '唯一 ID，例如 my_agent')"
      :confirm-text="__t('ui.settings', '创建')"
      @confirm="createAgent"
    />
    <PDialog
      v-model="deleteDialog"
      :title="__t('ui.settings', '删除角色档案')"
      :message="
        __t('ui.settings', '确定删除「{0}」的用户档案吗？此操作无法撤销。', [form?.name ?? ''])
      "
      :confirm-text="__t('ui.settings', '删除')"
      confirm-variant="danger"
      @confirm="deleteAgent"
    />
  </div>
</template>

<style scoped>
.atlas {
  display: grid;
  grid-template-columns: 224px minmax(540px, 1fr) 256px;
  height: 100%;
  min-height: 0;
  color: var(--ui-text-primary);
  background: var(--ui-bg-canvas);
  font-family: var(--ui-font-sans);
}
.atlas-index {
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding: var(--ui-space-3);
  border-right: 1px solid var(--ui-border-default);
  background: var(--ui-bg-sidebar);
}
.index-head {
  display: flex;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 10px;
  border-bottom: 2px solid var(--ui-accent-primary);
}
.index-head div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.index-head .index-head-title {
  font: 900 18px var(--font-pixel);
  letter-spacing: 0.05em;
}
.index-head span {
  color: var(--ui-text-tertiary);
  font: 800 9px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.index-head button,
.initialize-agent,
.reaction-module button,
.reaction-line button {
  border: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
}
.index-head button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid var(--ui-border-default);
}
.index-head button:hover {
  border-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
}
.index-list {
  min-height: 0;
  flex: 1;
  margin: 10px -2px;
  padding: 0 2px;
  overflow: auto;
}
.index-agent {
  position: relative;
  display: grid;
  width: 100%;
  grid-template-columns: 68px minmax(0, 1fr);
  grid-template-rows: 20px 76px 22px;
  gap: 0 10px;
  margin-bottom: 10px;
  padding: 0 9px 0 0;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-left: 3px solid transparent;
  background: var(--ui-bg-elevated);
  color: inherit;
  text-align: left;
  box-shadow: 3px 3px 0 var(--ui-border-subtle);
  cursor: pointer;
  transition:
    transform var(--ui-duration-fast),
    border-color var(--ui-duration-fast),
    background var(--ui-duration-fast);
}
.index-agent:hover {
  border-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
  transform: translate(-1px, -1px);
}
.index-agent.active {
  border-color: var(--ui-accent-primary);
  border-left-color: var(--ui-accent-pink, var(--ui-accent-primary));
  background: var(--ui-accent-primary-soft);
  box-shadow: 4px 4px 0 color-mix(in srgb, var(--ui-accent-primary) 20%, transparent);
}
.index-card-top {
  grid-column: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.index-card-top i,
.index-card-top b {
  font: 800 7px var(--ui-font-mono);
  font-style: normal;
  letter-spacing: 0.05em;
}
.index-card-top i {
  color: var(--ui-accent-primary);
}
.index-card-top b {
  color: var(--ui-text-disabled);
}
.index-avatar {
  grid-row: 1/4;
  display: grid;
  width: 68px;
  height: 118px;
  place-items: center;
  overflow: hidden;
  border-right: 1px solid var(--ui-border-default);
  clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%);
  background: linear-gradient(145deg, var(--ui-accent-primary-soft), var(--ui-bg-surface-soft));
}
.index-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.index-avatar > i {
  font-style: normal;
  font-size: 28px;
  font-weight: 900;
  color: var(--ui-accent-primary);
}
.index-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}
.index-meta strong,
.index-meta small,
.index-meta em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.index-meta strong {
  font-size: 15px;
}
.index-meta small {
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.index-meta em {
  color: var(--ui-text-tertiary);
  font-size: 9px;
  font-style: normal;
}
.index-card-foot {
  display: flex;
  align-items: center;
  gap: 5px;
  border-top: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-disabled);
  font: 800 7px var(--ui-font-mono);
  letter-spacing: 0.05em;
}
.index-card-foot > i {
  width: 5px;
  height: 5px;
  background: var(--ui-text-disabled);
}
.index-card-foot > i.online {
  background: var(--ui-success);
  box-shadow: 0 0 0 2px var(--ui-success-soft);
}
.index-card-foot > b {
  margin-left: auto;
  color: var(--ui-accent-primary);
  font: inherit;
}
.initialize-agent {
  min-height: 42px;
  border: 1px solid var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
  font: 800 9px var(--ui-font-mono);
  letter-spacing: 0.08em;
  box-shadow: 3px 3px 0 var(--ui-border-subtle);
}
.initialize-agent:hover {
  background: var(--ui-bg-hover);
  transform: translate(-1px, -1px);
}
.atlas-workspace {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--ui-bg-canvas);
}
.atlas-loading {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ui-text-tertiary);
  font: 10px var(--ui-font-mono);
}
.profile-band {
  display: grid;
  min-height: 150px;
  grid-template-columns: 126px minmax(0, 1fr) 112px;
  align-items: stretch;
  margin: var(--ui-space-4) var(--ui-space-5) 0;
  border: 1px solid var(--ui-border-default);
  border-top: 4px solid var(--ui-accent-primary);
  background: var(--ui-bg-elevated);
  box-shadow: 5px 5px 0 var(--ui-border-subtle);
}
.portrait {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-right: 1px solid var(--ui-border-default);
  clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%);
  background: linear-gradient(145deg, var(--ui-accent-primary-soft), var(--ui-bg-surface-soft));
}
.portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.portrait > span {
  font-size: 42px;
  font-weight: 900;
  color: var(--ui-accent-primary);
}
.portrait i {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 6px;
  background: color-mix(in srgb, var(--ui-bg-canvas) 88%, transparent);
  color: var(--ui-accent-primary);
  font: 800 7px var(--ui-font-mono);
  text-align: center;
  letter-spacing: 0.08em;
}
.profile-identity {
  align-self: center;
  padding: 18px 20px;
}
.eyebrow {
  color: var(--ui-accent-primary);
  font: 800 9px var(--ui-font-mono);
  letter-spacing: 0.14em;
}
.profile-identity h1 {
  margin: 7px 0 6px;
  font-size: 28px;
  line-height: 1;
}
.profile-identity > p {
  max-width: 680px;
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.profile-signals {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 15px;
}
.profile-signals span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-tertiary);
  font-size: 9px;
  font-weight: 700;
}
.profile-signals i {
  width: 7px;
  height: 7px;
  background: var(--ui-success);
  box-shadow: 0 0 0 2px var(--ui-success-soft);
}
.profile-seal {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-left: 1px solid var(--ui-border-default);
  background: linear-gradient(180deg, var(--ui-accent-primary-soft), transparent);
}
.profile-seal > span {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 2px solid var(--ui-accent-primary);
  color: var(--ui-accent-primary);
  font: 900 16px var(--ui-font-mono);
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--ui-accent-primary) 20%, transparent);
}
.profile-seal b {
  font-size: 10px;
}
.profile-seal small {
  color: var(--ui-text-disabled);
  font: 7px var(--ui-font-mono);
}
.protocol-nav {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  margin: 14px var(--ui-space-5) 0;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  box-shadow: 3px 3px 0 var(--ui-border-subtle);
}
.protocol-nav button {
  display: grid;
  min-height: 58px;
  grid-template-columns: 26px 1fr;
  grid-template-rows: auto auto;
  align-content: center;
  column-gap: 7px;
  padding: 9px;
  border: 0;
  border-right: 1px solid var(--ui-border-subtle);
  border-top: 3px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.protocol-nav button:last-child {
  border-right: 0;
}
.protocol-nav button:hover {
  background: var(--ui-bg-hover);
}
.protocol-nav button.active {
  border-top-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.protocol-nav span {
  grid-row: 1/3;
  display: grid;
  height: 25px;
  place-items: center;
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-disabled);
  font: 800 8px var(--ui-font-mono);
}
.protocol-nav button.active span {
  border-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary);
  color: var(--ui-bg-canvas);
}
.protocol-nav strong {
  font-size: 11px;
}
.protocol-nav small {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.protocol-scroll {
  min-height: 0;
  flex: 1;
  overflow: auto;
}
.protocol-page {
  max-width: 1120px;
  margin: 0 auto;
  padding: 22px var(--ui-space-5) 32px;
}
.section-title {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 18px;
  padding: 12px;
  border-left: 4px solid var(--ui-accent-primary);
  background: linear-gradient(90deg, var(--ui-accent-primary-soft), transparent);
}
.section-title > span {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid var(--ui-accent-primary);
  background: var(--ui-bg-elevated);
  color: var(--ui-accent-primary);
  font: 800 10px var(--ui-font-mono);
}
.section-title h2,
.subsection-head h3 {
  margin: 0;
  font-size: 17px;
}
.section-title p,
.subsection-head p {
  margin: 4px 0 0;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  line-height: 1.5;
}
.identity-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  border: 1px solid var(--ui-border-default);
}
.identity-portrait {
  display: flex;
  min-height: 300px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 0;
  border: 0;
  border-right: 1px solid var(--ui-border-default);
  background: linear-gradient(135deg, var(--ui-bg-surface-soft), var(--ui-bg-elevated));
  color: var(--ui-text-primary);
  cursor: pointer;
}
.identity-portrait:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--ui-accent-primary-soft), var(--ui-bg-elevated));
}
.identity-portrait:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: -4px;
}
.identity-portrait:disabled {
  cursor: wait;
}
.identity-portrait img,
.identity-portrait > span {
  width: 126px;
  height: 164px;
  border: 1px solid var(--ui-border-strong);
  clip-path: polygon(0 0, calc(100% - 15px) 0, 100% 15px, 100% 100%, 0 100%);
  object-fit: cover;
}
.identity-portrait > span {
  display: grid;
  place-items: center;
  font-size: 44px;
  font-weight: 900;
}
.identity-portrait small {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-tertiary);
  font: 8px var(--ui-font-mono);
}
.identity-portrait:hover:not(:disabled) small {
  color: var(--ui-accent-primary);
}
.data-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-content: start;
}
.data-fields label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
  padding: 14px;
  border-right: 1px solid var(--ui-border-subtle);
  border-bottom: 1px solid var(--ui-border-subtle);
}
.data-fields label > span {
  color: var(--ui-text-tertiary);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.06em;
}
.data-fields .wide {
  grid-column: 1/-1;
}
.public-profile-head {
  margin-top: 24px;
}
.public-profile-fields {
  border: 1px solid var(--ui-border-default);
  background: color-mix(in srgb, var(--ui-bg-surface) 82%, transparent);
}
.persona-console {
  border: 1px solid var(--ui-border-default);
  box-shadow: 5px 5px 0 var(--ui-border-subtle);
}
.persona-console header {
  display: flex;
  height: 34px;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}
.persona-console header b,
.persona-console header span {
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.07em;
}
.persona-console header span {
  color: var(--ui-text-tertiary);
}
.persona-console textarea {
  display: block;
  width: 100%;
  min-height: 310px;
  resize: vertical;
  padding: 14px;
  border: 0;
  outline: 0;
  background: var(--ui-bg-canvas);
  color: var(--ui-text-primary);
  font: 11px/1.65 var(--ui-font-mono);
}
.persona-console textarea:focus {
  box-shadow: inset 3px 0 0 var(--ui-accent-primary);
}
.subsection-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin: 22px 0 9px;
  padding-left: 8px;
  border-left: 3px solid var(--ui-accent-primary);
}
.scene-patches {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--ui-border-default);
}
.scene-patches article {
  padding: 10px;
  border-right: 1px solid var(--ui-border-subtle);
}
.scene-patches article:last-child {
  border: 0;
}
.scene-patches header,
.reaction-module header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}
.scene-patches header > span,
.reaction-module header > span,
.single-reaction > span {
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
}
.scene-patches header div,
.reaction-module header div {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.scene-patches header b,
.reaction-module header b {
  font-size: 10px;
}
.scene-patches header small,
.reaction-module header small {
  color: var(--ui-text-tertiary);
  font-size: 8px;
}
.scene-patches header i {
  color: var(--ui-text-disabled);
  font: 8px var(--ui-font-mono);
}
.reaction-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid var(--ui-border-default);
}
.reaction-module {
  padding: 10px;
  border-right: 1px solid var(--ui-border-subtle);
  border-bottom: 1px solid var(--ui-border-subtle);
}
.reaction-module:nth-child(2n) {
  border-right: 0;
}
.reaction-module.full {
  border: 1px solid var(--ui-border-default);
}
.reaction-module header button {
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
}
.reaction-module > p,
.empty-data {
  margin: 10px 0;
  color: var(--ui-text-disabled);
  font-size: 9px;
  text-align: center;
}
.reaction-line {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) 20px;
  align-items: center;
  border-top: 1px solid var(--ui-border-subtle);
}
.reaction-line > span {
  color: var(--ui-text-disabled);
  font: 8px var(--ui-font-mono);
}
.reaction-line > button {
  font-size: 15px;
}
.single-reaction {
  display: grid;
  grid-template-columns: 42px 190px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  padding: 10px;
  border: 1px solid var(--ui-border-default);
}
.single-reaction div {
  display: flex;
  flex-direction: column;
}
.single-reaction b {
  font-size: 10px;
}
.single-reaction small {
  color: var(--ui-text-tertiary);
  font-size: 8px;
}
.welcome-table {
  border: 1px solid var(--ui-border-default);
}
.welcome-table label {
  display: grid;
  grid-template-columns: 100px 70px minmax(0, 1fr);
  align-items: center;
  padding: 6px 9px;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.welcome-table label:last-child {
  border: 0;
}
.welcome-table span {
  color: var(--ui-text-tertiary);
  font: 8px var(--ui-font-mono);
}
.welcome-table b {
  font-size: 9px;
}
.channel-rail {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--ui-border-default);
}
.channel-rail button {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 28px;
  align-items: center;
  padding: 10px;
  border: 0;
  border-right: 1px solid var(--ui-border-subtle);
  border-top: 3px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.channel-rail button:last-child {
  border-right: 0;
}
.channel-rail button.active {
  border-top-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.channel-rail > button > span,
.channel-rail i {
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
}
.channel-rail div {
  display: flex;
  flex-direction: column;
}
.channel-rail b {
  font-size: 10px;
}
.channel-rail small {
  color: var(--ui-text-tertiary);
  font-size: 8px;
}
.channel-rail i {
  text-align: right;
}
.system-protocol {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--ui-success);
  background: var(--ui-success-soft);
}
.system-protocol > span {
  display: grid;
  height: 24px;
  place-items: center;
  border: 1px solid var(--ui-success);
  color: var(--ui-success);
  font: 800 8px var(--ui-font-mono);
}
.system-protocol b {
  font-size: 10px;
}
.system-protocol p {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0 0;
  color: var(--ui-text-secondary);
  font-size: 8px;
}
.protocol-tool-chip {
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--ui-success) 42%, transparent);
  background: color-mix(in srgb, var(--ui-success) 8%, transparent);
  color: var(--ui-text-secondary);
  line-height: 1.2;
}
.system-protocol strong {
  color: var(--ui-success);
  font: 800 8px var(--ui-font-mono);
}
.tool-table {
  border: 1px solid var(--ui-border-default);
}
.tool-table > header {
  display: flex;
  height: 26px;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}
.tool-table > header span,
.tool-table > header i {
  font: 800 8px var(--ui-font-mono);
}
.tool-table > header i {
  color: var(--ui-text-disabled);
}
.tool-table > label {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) 30px;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--ui-border-subtle);
  border-left: 2px solid transparent;
}
.tool-table > label.enabled {
  border-left-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.tool-table label > span,
.select-row > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.tool-table b,
.select-row b {
  font-size: 9px;
}
.tool-table small,
.select-row small {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-table .tool-source {
  margin-left: 4px;
  color: var(--ui-text-tertiary);
  font-size: 8px;
  font-style: normal;
  font-weight: 400;
}
.tool-table label > i {
  color: var(--ui-text-disabled);
  font: 800 8px var(--ui-font-mono);
  text-align: right;
}
.tool-table label.enabled > i {
  color: var(--ui-accent-primary);
}
.capability-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.select-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  gap: 7px;
  padding: 8px;
  border: 1px solid var(--ui-border-subtle);
  border-left: 2px solid transparent;
}
.select-row.enabled {
  border-left-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.select-row code {
  margin-top: 3px;
  color: var(--ui-text-disabled);
  font: 7px var(--ui-font-mono);
}
.runtime-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid var(--ui-border-default);
}
.runtime-grid article {
  min-height: 130px;
  padding: 14px;
  border-right: 1px solid var(--ui-border-subtle);
  border-bottom: 1px solid var(--ui-border-subtle);
}
.runtime-grid article:nth-child(2n) {
  border-right: 0;
}
.runtime-grid span {
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
}
.runtime-grid b {
  display: block;
  margin: 12px 0 6px;
  font: 800 13px var(--ui-font-mono);
}
.runtime-grid p,
.runtime-note p {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 9px;
  line-height: 1.6;
}
.runtime-note {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  border-left: 3px solid var(--ui-warning);
  background: var(--ui-warning-soft);
}
.runtime-note span {
  color: var(--ui-warning);
  font: 800 8px var(--ui-font-mono);
}
.rail-handle {
  display: none;
}
.archive-rail {
  position: relative;
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
  padding: var(--ui-space-4);
  overflow: auto;
  border-left: 1px solid var(--ui-border-default);
  background: var(--ui-bg-sidebar);
}
.rail-head {
  padding: 2px 0 11px;
  border-bottom: 2px solid var(--ui-accent-primary);
}
.rail-head span {
  display: block;
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.12em;
}
.rail-head b {
  display: block;
  margin-top: 4px;
  font-size: 15px;
}
.rail-sync {
  padding: 12px;
  border: 1px solid var(--ui-success);
  border-left: 4px solid var(--ui-success);
  background: var(--ui-success-soft);
  box-shadow: 3px 3px 0 var(--ui-border-subtle);
}
.rail-sync.dirty {
  border-color: var(--ui-warning);
  background: var(--ui-warning-soft);
}
.rail-sync__signal {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-success);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.dirty .rail-sync__signal {
  color: var(--ui-warning);
}
.rail-sync__signal i {
  width: 7px;
  height: 7px;
  background: currentColor;
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 20%, transparent);
}
.rail-sync h3 {
  margin: 10px 0 5px;
  font-size: 13px;
}
.rail-sync p {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 9px;
  line-height: 1.55;
}
.rail-sync__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 12px;
}
.rail-completion {
  padding: 11px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}
.rail-completion header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rail-completion header span {
  color: var(--ui-text-tertiary);
  font: 800 8px var(--ui-font-mono);
}
.rail-completion header b {
  color: var(--ui-accent-primary);
  font: 900 14px var(--ui-font-mono);
}
.rail-completion > div {
  height: 8px;
  margin: 9px 0;
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-subtle);
}
.rail-completion > div i {
  display: block;
  height: 100%;
  background: linear-gradient(
    90deg,
    var(--ui-accent-primary),
    var(--ui-accent-pink, var(--ui-accent-primary))
  );
}
.rail-completion p {
  margin: 0;
  color: var(--ui-text-disabled);
  font-size: 8px;
  line-height: 1.45;
}
.rail-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}
.rail-stats article {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 58px;
  padding: 9px;
  border-right: 1px solid var(--ui-border-subtle);
  border-bottom: 1px solid var(--ui-border-subtle);
  color: var(--ui-accent-primary);
}
.rail-stats article:nth-child(2n) {
  border-right: 0;
}
.rail-stats article:nth-last-child(-n + 2) {
  border-bottom: 0;
}
.rail-stats article > span {
  display: flex;
  flex-direction: column;
}
.rail-stats b {
  color: var(--ui-text-primary);
  font: 900 14px var(--ui-font-mono);
}
.rail-stats small {
  color: var(--ui-text-tertiary);
  font-size: 8px;
}
.rail-chapters {
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}
.rail-chapters > header {
  height: 28px;
  padding: 0 9px;
  border-bottom: 1px solid var(--ui-border-default);
  color: var(--ui-text-tertiary);
  font: 800 8px/28px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.rail-chapters button {
  display: grid;
  width: 100%;
  grid-template-columns: 24px minmax(0, 1fr) 12px;
  align-items: center;
  gap: 7px;
  padding: 8px;
  border: 0;
  border-bottom: 1px solid var(--ui-border-subtle);
  border-left: 3px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.rail-chapters button:last-child {
  border-bottom: 0;
}
.rail-chapters button:hover {
  background: var(--ui-bg-hover);
}
.rail-chapters button.active {
  border-left-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.rail-chapters button > span {
  color: var(--ui-text-disabled);
  font: 800 8px var(--ui-font-mono);
}
.rail-chapters button div {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.rail-chapters button b {
  font-size: 9px;
}
.rail-chapters button small {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font-size: 7px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-chapters button > i {
  color: var(--ui-accent-primary);
  font-style: normal;
}
.rail-source {
  padding: 10px;
  border-left: 3px solid var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.rail-source span {
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
}
.rail-source b {
  display: block;
  margin: 5px 0 2px;
  font: 900 11px var(--ui-font-mono);
}
.rail-source p {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 8px;
}
.rail-export,
.rail-danger {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 9px;
  font-weight: 800;
  cursor: pointer;
}
.rail-export {
  border: 1px solid var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
}
.rail-export:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent-sky) 16%, transparent);
}
.rail-export:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.rail-danger {
  border: 1px solid var(--ui-danger);
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  font-size: 9px;
  font-weight: 800;
  cursor: pointer;
}
.rail-danger:hover {
  background: color-mix(in srgb, var(--ui-danger) 16%, transparent);
}
.decision-layer {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--ui-bg-canvas) 76%, transparent);
  backdrop-filter: blur(3px);
}
.decision-panel {
  width: min(560px, 100%);
  border: 1px solid var(--ui-border-strong);
  border-top: 4px solid var(--ui-warning);
  background: var(--ui-bg-elevated);
  box-shadow: 8px 8px 0 color-mix(in srgb, var(--ui-warning) 18%, var(--ui-border-subtle));
}
.decision-panel > header {
  display: flex;
  height: 38px;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-warning-soft);
}
.decision-panel > header span {
  color: var(--ui-warning);
  font: 800 9px var(--ui-font-mono);
  letter-spacing: 0.1em;
}
.decision-panel > header button {
  border: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 20px;
  cursor: pointer;
}
.decision-body {
  display: grid;
  grid-template-columns: 54px 1fr;
  align-items: center;
  gap: 12px;
  padding: 20px;
}
.decision-icon {
  display: grid;
  width: 50px;
  height: 50px;
  place-items: center;
  border: 1px solid var(--ui-warning);
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
}
.decision-body h2 {
  margin: 0 0 6px;
  font-size: 18px;
}
.decision-body p {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.55;
}
.decision-target {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 20px;
  padding: 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}
.decision-target span {
  color: var(--ui-text-tertiary);
  font: 800 8px var(--ui-font-mono);
}
.decision-target b {
  font-size: 12px;
}
.decision-panel > footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
  padding: 12px;
  border-top: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}
.avatar-crop-layer {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--ui-bg-canvas) 82%, transparent);
  backdrop-filter: blur(4px);
}
.avatar-crop-panel {
  width: min(540px, 100%);
  border: 1px solid var(--ui-border-strong);
  border-top: 4px solid var(--ui-accent-primary);
  background: var(--ui-bg-elevated);
  box-shadow: 8px 8px 0 color-mix(in srgb, var(--ui-accent-primary) 22%, var(--ui-border-subtle));
}
.avatar-crop-panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 14px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-accent-primary-soft);
}
.avatar-crop-panel header span {
  display: block;
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
  letter-spacing: 0.1em;
}
.avatar-crop-panel header h2 {
  margin: 4px 0 0;
  font-size: 17px;
}
.avatar-crop-panel header button {
  width: 28px;
  height: 28px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-secondary);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.avatar-crop-panel header button:hover:not(:disabled) {
  border-color: var(--ui-danger);
  color: var(--ui-danger);
}
.avatar-crop-body {
  padding: 18px;
}
.avatar-crop-stage {
  position: relative;
  width: 280px;
  height: 280px;
  margin: 0 auto;
  overflow: hidden;
  touch-action: none;
  background: repeating-conic-gradient(var(--ui-bg-surface-soft) 0 25%, var(--ui-bg-elevated) 0 50%)
    50%/20px 20px;
  cursor: grab;
}
.avatar-crop-stage:active {
  cursor: grabbing;
}
.avatar-crop-stage img {
  position: absolute;
  max-width: none;
  transform: translate(-50%, -50%);
  user-select: none;
  pointer-events: none;
}
.avatar-crop-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(
      to right,
      transparent 33%,
      color-mix(in srgb, var(--ui-text-primary) 34%, transparent) 33.5%,
      transparent 34%
    ),
    linear-gradient(
      to right,
      transparent 66%,
      color-mix(in srgb, var(--ui-text-primary) 34%, transparent) 66.5%,
      transparent 67%
    ),
    linear-gradient(
      to bottom,
      transparent 33%,
      color-mix(in srgb, var(--ui-text-primary) 34%, transparent) 33.5%,
      transparent 34%
    ),
    linear-gradient(
      to bottom,
      transparent 66%,
      color-mix(in srgb, var(--ui-text-primary) 34%, transparent) 66.5%,
      transparent 67%
    );
  box-shadow: inset 0 0 0 2px var(--ui-accent-primary);
}
.avatar-crop-zoom {
  display: grid;
  grid-template-columns: 38px 1fr 42px;
  align-items: center;
  gap: 10px;
  margin: 16px auto 0;
  max-width: 360px;
  color: var(--ui-text-tertiary);
  font: 800 9px var(--ui-font-mono);
}
.avatar-crop-zoom input {
  accent-color: var(--ui-accent-primary);
}
.avatar-crop-zoom b {
  color: var(--ui-accent-primary);
  text-align: right;
}
.avatar-crop-body > p {
  margin: 12px 0 0;
  color: var(--ui-text-tertiary);
  font-size: 9px;
  line-height: 1.5;
  text-align: center;
}
.avatar-crop-panel footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}

@media (max-width: 1240px) {
  .atlas {
    position: relative;
    grid-template-columns: 210px minmax(520px, 1fr);
  }
  .archive-rail {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 20;
    width: 250px;
    overflow: visible auto;
    box-shadow: -5px 0 0 color-mix(in srgb, var(--ui-border-default) 45%, transparent);
    transform: translateX(calc(100% - 12px));
    transition: transform var(--ui-duration-normal);
  }
  .archive-rail.open,
  .archive-rail:focus-within {
    transform: translateX(0);
  }
  .rail-handle {
    position: absolute;
    left: -29px;
    top: 76px;
    display: flex;
    width: 30px;
    height: 92px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--ui-accent-primary);
    border-right: 0;
    background: var(--ui-accent-primary-soft);
    color: var(--ui-accent-primary);
    cursor: pointer;
  }
  .rail-handle span {
    font: 800 7px var(--ui-font-mono);
    letter-spacing: 0.08em;
    writing-mode: vertical-rl;
  }
  .protocol-nav small {
    display: none;
  }
}
@media (max-width: 900px) {
  .atlas {
    grid-template-columns: 180px minmax(480px, 1fr);
  }
  .index-agent {
    grid-template-columns: 54px minmax(0, 1fr);
  }
  .index-avatar {
    width: 54px;
  }
  .scene-patches,
  .channel-rail {
    grid-template-columns: 1fr;
  }
  .scene-patches article,
  .channel-rail button {
    border-right: 0;
    border-bottom: 1px solid var(--ui-border-subtle);
  }
  .capability-columns {
    grid-template-columns: 1fr;
  }
  .profile-band {
    grid-template-columns: 100px minmax(0, 1fr) 78px;
  }
  .profile-seal small {
    display: none;
  }
}
</style>
