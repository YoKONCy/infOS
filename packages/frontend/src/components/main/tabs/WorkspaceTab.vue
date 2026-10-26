<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

defineOptions({ name: 'WorkspaceTab' })
/**
 * WorkspaceTab — Agent 强绑定的协作工作台。
 *
 * 使用统一的交互画布与一体化面板承载资源栏、编辑器、终端和 Agent 协作栏。
 * 所有文件与终端上下文始终绑定当前 Agent 的 workspace，不允许跨角色串用。
 */
import {
  ref,
  inject,
  computed,
  watch,
  nextTick,
  onMounted,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
} from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { storeToRefs } from 'pinia'
import type { ApprovalSurfaceProps, WorkspaceFileDescriptor } from '@infos/shared'
import { PixelIcon, PButton, PDialog } from '../../pixel'
import { ChatContainer } from '../../chat'
import HistoryExportDialog from '../../chat/HistoryExportDialog.vue'
import ChatRichText from '../../chat/ChatRichText.vue'
import { ApprovalCard } from '../../approval'
import AgentStateHover from '../../agent/AgentStateHover.vue'
import WorkspaceTree from '../../workspace/WorkspaceTree.vue'
import WorkspaceTerminal from '../../workspace/WorkspaceTerminal.vue'
import WorkspaceSessionDrawer from '../../workspace/WorkspaceSessionDrawer.vue'
import WorkspaceFilePreview from '../../workspace/WorkspaceFilePreview.vue'
import SurfaceTransition from '../../motion/SurfaceTransition.vue'
import WorkspaceFileGlyph from '../../workspace/WorkspaceFileGlyph.vue'
import { createPreviewState, type WorkspacePreviewState } from '../../workspace/workspacePreview'
import { useWorkspaceFullscreen } from '../../../composables/workspace/useWorkspaceFullscreen'
import {
  useAgentStore,
  useThreadStore,
  useApprovalStore,
  useCompositorStore,
  useNotificationStore,
} from '../../../stores'
import {
  workspaceApi,
  type ApprovalDecision,
  type WorkspaceFileNode,
} from '../../../api/modules/approvalsApi'
import { threadsApi } from '../../../api/modules/threadsApi'
import { getApiBaseUrl, isLocalBackendRuntime } from '../../../api/transport'
import { invoke } from '../../../utils/ipcAdapter'
import { resourceNavigation } from '../../../composables/resources/useResources'
import {
  useWorkspaceSearchNavigation,
  type WorkspaceSearchRequest,
} from '../../../composables/workspace/useWorkspaceSearchNavigation'
import { useMobileLayout } from '../../../composables/ui/useMobileLayout'
import {
  buildConversationMarkdown,
  downloadMarkdown,
  type HistoryExportOptions,
} from '../../../utils/historyExport'

interface OpenFile extends WorkspaceFileDescriptor {
  content: string
  hash: string
  dirty: boolean
  truncated: boolean
  previewState: WorkspacePreviewState
  previewRevision: number
  searchSource?: WorkspaceSearchRequest
  sourceLineStart?: number
}

const agentStore = useAgentStore()
const threadStore = useThreadStore()
const approvalStore = useApprovalStore()
const compositor = useCompositorStore()
const approvalErrors = ref<Record<string, string>>({})
const notification = useNotificationStore()
const { currentAgent } = storeToRefs(agentStore)

const openFiles = ref<OpenFile[]>([])
const pendingFile = ref<string | null>(null)
const needsRefresh = new WeakSet<OpenFile>()
const workspaceActive = ref(true)
const desktopHomeVisible = inject(
  'infos:main-surface-visible',
  computed(() => true),
)
let fileFocusRevision = 0
const discardDialog = ref<{ title: string; message: string; confirmText: string } | null>(null)
let resolveDiscard: ((confirmed: boolean) => void) | undefined

function settleDiscard(confirmed = false): void {
  const resolve = resolveDiscard
  resolveDiscard = undefined
  discardDialog.value = null
  resolve?.(confirmed)
}

/** 未保存内容的确认统一走应用内弹窗，关闭弹窗等同于继续编辑。 */
function confirmDiscard(title: string, message: string, confirmText: string): Promise<boolean> {
  settleDiscard()
  discardDialog.value = { title, message, confirmText }
  return new Promise((resolve) => {
    resolveDiscard = resolve
  })
}
const workspaceTreeRef = ref<InstanceType<typeof WorkspaceTree> | null>(null)
const activePath = ref('')
const activeTerminalId = ref('')
const editorTextarea = ref<HTMLTextAreaElement | null>(null)
const selectedSnippet = ref<{
  path: string
  text: string
  startLine: number
  endLine: number
} | null>(null)
const { isMobile } = useMobileLayout()
const isExplorerCollapsed = ref(isMobile.value)
const isCopilotCollapsed = ref(isMobile.value)
function dismissMobileWorkspacePanels() {
  isExplorerCollapsed.value = true
  isCopilotCollapsed.value = true
}
const isTerminalCollapsed = ref(isMobile.value)
const isTerminalMaximized = ref(false)
const previewFrame = ref<HTMLElement | null>(null)
const previewVisible = computed(
  () => workspaceActive.value && desktopHomeVisible.value && !isTerminalMaximized.value,
)
const previewFiles = computed(() => openFiles.value.filter((file) => file.kind !== 'text'))
const {
  expanded: previewExpanded,
  pending: fullscreenPending,
  toggle: toggleFullscreen,
} = useWorkspaceFullscreen(previewFrame, previewVisible)
async function togglePreviewFullscreen() {
  if (fullscreenPending.value || !previewVisible.value) return
  if (!(await toggleFullscreen()))
    notification.toast(__t('ui.workspace', '无法进入全屏，请重试'), { type: 'error' })
}
const isApprovalQueueExpanded = ref(true)
const isSessionDrawerOpen = ref(false)
const markdownPreviewPaths = ref(new Set<string>())
const terminalHeight = ref(248)
const copilotWidth = ref(480)
const explorerWidth = ref(248)
const showHistoryExport = ref(false)
const isExportingHistory = ref(false)
// 手机一次展示一个工作面板；终端和文件仍由同一服务端持有。
watch(isMobile, (value) => {
  if (value) {
    isExplorerCollapsed.value = true
    isCopilotCollapsed.value = true
    isTerminalCollapsed.value = true
  }
})
watch(isExplorerCollapsed, (closed) => {
  if (isMobile.value && !closed) {
    isCopilotCollapsed.value = true
    isTerminalCollapsed.value = true
  }
})
watch(isCopilotCollapsed, (closed) => {
  if (isMobile.value && !closed) {
    isExplorerCollapsed.value = true
    isTerminalCollapsed.value = true
  }
})
watch(isTerminalCollapsed, (closed) => {
  if (isMobile.value && !closed) {
    isExplorerCollapsed.value = true
    isCopilotCollapsed.value = true
  }
})
function closeMobilePanels(event: KeyboardEvent) {
  if (isMobile.value && event.key === 'Escape') {
    isExplorerCollapsed.value = true
    isCopilotCollapsed.value = true
  }
}
onMounted(() => window.addEventListener('keydown', closeMobilePanels))
onBeforeUnmount(() => window.removeEventListener('keydown', closeMobilePanels))

async function exportCurrentHistory(options: HistoryExportOptions): Promise<void> {
  if (!threadStore.threadId || !currentAgent.value) return
  isExportingHistory.value = true
  try {
    const response = await threadsApi.getProjection(threadStore.threadId)
    if (!response.data) throw new Error('服务端未返回工作区会话历史')
    const title = __t('ui.navigation', '{0}-工作区会话', [currentAgent.value.name])
    downloadMarkdown(
      title,
      buildConversationMarkdown(
        {
          title,
          channelLabel: '工作区协作 · desktop',
          participantNames: {
            [currentAgent.value.id]: currentAgent.value.name,
          },
          messages: response.data.messages,
        },
        options,
      ),
    )
    showHistoryExport.value = false
    notification.toast(__t('ui.navigation', '会话记录已导出'), { type: 'success' })
  } catch (error) {
    notification.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '历史记录导出失败'),
      {
        type: 'error',
      },
    )
  } finally {
    isExportingHistory.value = false
  }
}

// 切换 Agent 时按角色保留未保存缓冲，避免异步全局切换直接丢稿。
const buffersByAgent = new Map<string, { files: OpenFile[]; activePath: string }>()

const activeFile = computed(
  () => openFiles.value.find((file) => file.path === activePath.value) ?? null,
)
const threadId = computed(() =>
  threadStore.agentId === currentAgent.value?.id && threadStore.channel === 'desktop'
    ? threadStore.threadId
    : '',
)
const pendingApprovals = computed(() => approvalStore.forAgent(currentAgent.value?.id ?? ''))
// 已投影的当前会话审批交给交互 Surface；其余请求及投影恢复前的请求由队列兜底。
const queuedApprovals = computed(() => {
  const projected = new Set(
    [...compositor.surfaces.values()]
      .filter(
        (surface) =>
          surface.scopeId === `conversation:${threadId.value}` &&
          surface.state === 'open' &&
          !surface.messageId,
      )
      .flatMap((surface) =>
        surface.nodes
          .filter((node) => node.kind === 'approval')
          .map((node) => (node.props as ApprovalSurfaceProps).approvalId),
      ),
  )
  return pendingApprovals.value.filter((request) => !projected.has(request.id))
})
watch(
  () => pendingApprovals.value.map((request) => request.id),
  (ids, previous = []) => {
    if (ids.some((id) => !previous.includes(id))) expandApprovalQueue()
  },
)
const agentInitial = computed(() => currentAgent.value?.name?.trim().charAt(0).toUpperCase() || '?')
const agentAvatarUrl = computed(() => {
  const avatarUrl = currentAgent.value?.avatarUrl
  return avatarUrl ? `${getApiBaseUrl()}${avatarUrl}` : ''
})
const activeFileExtension = computed(() => {
  const name = activeFile.value?.name ?? ''
  const extension = name.includes('.') ? name.split('.').pop() : ''
  return extension?.toUpperCase() || 'TEXT'
})

const isMarkdownFile = computed(
  () => activeFile.value?.kind === 'text' && activeFileExtension.value === 'MD',
)
const isMarkdownPreview = computed(() =>
  Boolean(activeFile.value && markdownPreviewPaths.value.has(activeFile.value.path)),
)

function setMarkdownPreview(enabled: boolean): void {
  const file = activeFile.value
  if (!file || activeFileExtension.value !== 'MD') return
  const next = new Set(markdownPreviewPaths.value)
  if (enabled) next.add(file.path)
  else next.delete(file.path)
  markdownPreviewPaths.value = next
}

async function ensureAgent(): Promise<void> {
  try {
    if (!agentStore.agents.length) await agentStore.fetchAgents()
    if (currentAgent.value && !threadId.value)
      await threadStore.ensureLatestThread(currentAgent.value.id, 'desktop')
  } catch (error) {
    notification.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '恢复工作区会话失败'),
      {
        type: 'error',
      },
    )
  }
}

const revealingWorkspace = ref(false)
async function revealWorkspace(): Promise<void> {
  if (!isLocalBackendRuntime()) return
  if (!currentAgent.value || !threadId.value || revealingWorkspace.value) return
  revealingWorkspace.value = true
  try {
    const session = { agentId: currentAgent.value.id, threadId: threadId.value }
    // Electron 必须由主进程在当前桌面会话中调用 shell.openPath；Daemon 可能运行在独立服务会话中。
    const response = await workspaceApi.reveal(session)
    if (!response.data) throw new Error('未能解析工作区路径')
    await invoke('open-local-path', response.data.path)
    notification.toast(
      __t('ui.workspace', '已在系统文件管理器中打开工作区'),
      { type: 'success' },
    )
  } catch (error) {
    notification.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '无法打开工作区目录'),
      {
        type: 'error',
      },
    )
  } finally {
    revealingWorkspace.value = false
  }
}

async function openFile(
  node: WorkspaceFileNode,
  forceReload = false,
  activate = true,
): Promise<void> {
  if (!currentAgent.value || !threadId.value || node.type !== 'file') return
  const focusRevision = activate ? ++fileFocusRevision : fileFocusRevision
  if (activate) pendingFile.value = null
  const focus = () => {
    if (activate && focusRevision === fileFocusRevision) activePath.value = node.path
  }
  const existing = openFiles.value.find((file) => file.path === node.path)
  if (existing?.searchSource && forceReload) {
    await openSearchFile(existing.searchSource, activate)
    return
  }
  forceReload ||= !!existing && !existing.dirty && needsRefresh.has(existing)
  if (existing && !forceReload) {
    focus()
    return
  }
  if (existing?.dirty && forceReload) {
    // Agent 修改了用户仍在编辑的未保存文件时，不静默覆盖本地缓冲。
    notification.toast(
      __t('ui.navigation', '“{0}”已被外部修改，请保存当前编辑或重新载入', [existing.name]),
      { type: 'warning' },
    )
    focus()
    return
  }
  if (activate) pendingFile.value = node.path
  try {
    const ownerAgentId = currentAgent.value.id
    const ownerThreadId = threadId.value
    const ownerFiles = openFiles.value
    const session = { agentId: ownerAgentId, threadId: ownerThreadId }
    const described = await workspaceApi.describeFile(session, node.path)
    if (!described.data) return
    const descriptor = described.data
    if (
      currentAgent.value?.id !== ownerAgentId ||
      threadId.value !== ownerThreadId ||
      openFiles.value !== ownerFiles ||
      (existing && !openFiles.value.includes(existing)) ||
      existing?.dirty
    )
      return
    if (
      existing?.kind === 'text' &&
      descriptor.kind === 'text' &&
      existing.version &&
      existing.version === descriptor.version
    ) {
      needsRefresh.delete(existing)
      focus()
      return
    }
    const res =
      descriptor.kind === 'text'
        ? await workspaceApi.readFile(session, { path: node.path, limit: 128_000 })
        : null
    if (
      (descriptor.kind === 'text' && !res?.data) ||
      currentAgent.value?.id !== ownerAgentId ||
      threadId.value !== ownerThreadId ||
      openFiles.value !== ownerFiles ||
      (existing && !openFiles.value.includes(existing))
    )
      return
    // 读取期间新产生的编辑也必须保留，不能只在发起请求前检查一次。
    const current = openFiles.value.find((file) => file.path === node.path)
    if (current?.dirty) return
    const loaded: OpenFile = {
      ...descriptor,
      path: node.path,
      name: node.name,
      content: res?.data?.content ?? '',
      hash: res?.data?.hash ?? '',
      dirty: false,
      truncated: res?.data?.truncated ?? false,
      previewState:
        current?.version === descriptor.version ? current.previewState : createPreviewState(),
      previewRevision: current?.previewRevision ?? 0,
    }
    if (current) {
      Object.assign(current, loaded)
      needsRefresh.delete(current)
    } else openFiles.value.push(loaded)
    focus()
  } finally {
    if (activate && focusRevision === fileFocusRevision) pendingFile.value = null
  }
}

function activateFile(path: string): void {
  ++fileFocusRevision
  pendingFile.value = null
  activePath.value = path
  const file = openFiles.value.find((item) => item.path === path)
  if (file && !file.dirty && needsRefresh.has(file))
    void openFile({ path, name: file.name, type: 'file' }, true, false).catch(() =>
      notification.toast(__t('ui.navigation', '文件刷新失败，请手动重载'), { type: 'error' }),
    )
}

function selectFile(node: WorkspaceFileNode): void {
  if (isMobile.value) isExplorerCollapsed.value = true
  void openFile(node).catch((error) =>
    notification.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '文件打开失败'),
      { type: 'error' },
    ),
  )
}

async function reloadPreview(): Promise<void> {
  const file = activeFile.value
  if (!file) return
  try {
    await openFile({ path: file.path, name: file.name, type: 'file' }, true)
    if (openFiles.value.includes(file)) file.previewRevision++
  } catch (error) {
    notification.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '文件重新载入失败'),
      {
        type: 'error',
      },
    )
  }
}

function updateContent(event: Event): void {
  if (
    !activeFile.value ||
    activeFile.value.kind !== 'text' ||
    activeFile.value.truncated ||
    activeFile.value.searchSource
  )
    return
  activeFile.value.content = (event.target as HTMLTextAreaElement).value
  activeFile.value.dirty = true
  selectedSnippet.value = null
}

async function openSearchFile(request: WorkspaceSearchRequest, activate = true): Promise<void> {
  const ownerFiles = openFiles.value
  const revision = activate ? ++fileFocusRevision : fileFocusRevision
  const response = await workspaceApi.searchResultFile(request)
  if (
    !response.data ||
    currentAgent.value?.id !== request.agentId ||
    openFiles.value !== ownerFiles
  )
    return
  const { descriptor, read } = response.data
  const existing = ownerFiles.find((file) => file.path === request.file)
  if (existing?.searchSource && existing.searchSource.revision > request.revision) return
  if (!existing?.dirty) {
    const loaded: OpenFile = {
      ...descriptor,
      path: request.file,
      content: read.content,
      hash: read.hash,
      dirty: false,
      truncated: read.truncated,
      sourceLineStart: read.lineStart,
      previewState: createPreviewState(),
      previewRevision: 0,
      searchSource: request,
    }
    if (existing) Object.assign(existing, loaded)
    else ownerFiles.push(loaded)
  }
  if (activate && revision === fileFocusRevision) activePath.value = request.file
}

const searchNavigation = useWorkspaceSearchNavigation()
let openedSearchRevision = -1
watch(
  [searchNavigation, () => currentAgent.value?.id, threadId, workspaceActive],
  async () => {
    const request = searchNavigation.value
    if (
      !workspaceActive.value ||
      !request ||
      request.revision === openedSearchRevision ||
      request.agentId !== currentAgent.value?.id ||
      !threadId.value
    )
      return
    openedSearchRevision = request.revision
    try {
      isTerminalMaximized.value = false
      isExplorerCollapsed.value = false
      const name = request.file.replaceAll('\\', '/').split('/').pop() || request.file
      if (openFiles.value.some((file) => file.path === request.file && file.searchSource))
        await openSearchFile(request)
      else {
        const requestFocus = fileFocusRevision + 1
        try {
          await openFile({ path: request.file, name, type: 'file' })
        } catch {
          if (
            searchNavigation.value?.revision !== request.revision ||
            fileFocusRevision !== requestFocus
          )
            return
          await openSearchFile(request)
        }
      }
      if (
        activePath.value === request.file &&
        activeFile.value?.truncated &&
        !activeFile.value.searchSource &&
        (request.line ?? 1) > activeFile.value.content.split('\n').length
      )
        await openSearchFile(request)
      await nextTick()
      if (
        activePath.value !== request.file ||
        !activeFile.value ||
        searchNavigation.value?.revision !== request.revision
      )
        return
      setMarkdownPreview(false)
      await nextTick()
      const target = editorTextarea.value
      if (!target) return
      const lines = target.value.split('\n')
      const line = Math.max(
        1,
        Math.min(lines.length, (request.line ?? 1) - (activeFile.value.sourceLineStart ?? 1) + 1),
      )
      const offset = lines.slice(0, line - 1).reduce((size, text) => size + text.length + 1, 0)
      const column = Math.min(lines[line - 1]?.length ?? 0, Math.max(0, (request.column ?? 1) - 1))
      target.focus()
      target.setSelectionRange(offset + column, offset + (lines[line - 1]?.length ?? 0))
      target.scrollTop = Math.max(
        0,
        (line - 1) * (parseFloat(getComputedStyle(target).lineHeight) || 22) -
          target.clientHeight / 3,
      )
    } catch (error) {
      notification.toast(
        error instanceof Error ? error.message : __t('ui.navigation', '无法打开文件'),
        { type: 'error' },
      )
    }
  },
  { immediate: true },
)

let openedResourceRevision = -1
watch(
  [resourceNavigation, () => currentAgent.value?.id, threadId],
  async () => {
    const request = resourceNavigation.value
    const origin = request?.origin
    if (
      !request ||
      request.revision === openedResourceRevision ||
      origin?.type !== 'workspace' ||
      origin.agentId !== currentAgent.value?.id ||
      !threadId.value
    )
      return
    openedResourceRevision = request.revision
    try {
      const name = origin.value.replaceAll('\\', '/').split('/').pop() || origin.value
      isExplorerCollapsed.value = false
      await openFile({ path: origin.value, name, type: 'file' })
      await nextTick()
      const editor = editorTextarea.value
      if (!editor || !origin.line || activePath.value !== origin.value || !activeFile.value) return
      const lines = activeFile.value.content.split('\n')
      const line = Math.min(lines.length, origin.line)
      const offset = lines.slice(0, line - 1).reduce((count, text) => count + text.length + 1, 0)
      editor.focus()
      editor.setSelectionRange(offset, offset + (lines[line - 1]?.length || 0))
      editor.scrollTop = Math.max(
        0,
        (line - 1) * (parseFloat(getComputedStyle(editor).lineHeight) || 22) -
          editor.clientHeight / 3,
      )
    } catch (error) {
      openedResourceRevision = -1
      notification.toast(
        error instanceof Error ? error.message : __t('ui.navigation', '无法打开文件'),
        { type: 'error' },
      )
    }
  },
  { immediate: true },
)

function attachSelection(): void {
  const file = activeFile.value
  const editor = editorTextarea.value
  if (!file || !editor || editor.selectionEnd <= editor.selectionStart) return
  const text = editor.value.slice(editor.selectionStart, editor.selectionEnd)
  if (!text.trim()) return
  if (text.length > 4000) {
    notification.toast(__t('ui.navigation', '选区最多附带 4000 字，请缩小范围'), {
      type: 'warning',
    })
    return
  }
  const startLine =
    editor.value.slice(0, editor.selectionStart).split('\n').length +
    (file.sourceLineStart ?? 1) -
    1
  const endLine =
    editor.value.slice(0, editor.selectionEnd).split('\n').length + (file.sourceLineStart ?? 1) - 1
  selectedSnippet.value = { path: file.path, text, startLine, endLine }
  notification.toast(__t('ui.navigation', '选区已加入本轮材料'), { type: 'success' })
}

async function save(): Promise<void> {
  const file = activeFile.value
  if (!file || file.kind !== 'text' || !currentAgent.value || !threadId.value) return
  if (file.searchSource) return
  if (file.truncated) {
    notification.toast(__t('ui.navigation', '大文件仅支持预览'), { type: 'error' })
    return
  }
  try {
    const res = await workspaceApi.writeFile(
      { agentId: currentAgent.value.id, threadId: threadId.value },
      { path: file.path, content: file.content, expectedHash: file.hash },
    )
    file.hash = res.data?.hash ?? file.hash
    file.dirty = false
    selectedSnippet.value = null
    notification.toast(__t('ui.navigation', '文件已保存'), { type: 'success' })
  } catch {
    notification.toast(__t('ui.navigation', '保存失败：文件可能已被外部修改'), { type: 'error' })
  }
}

async function close(file: OpenFile): Promise<void> {
  const ownerFiles = openFiles.value
  if (
    file.dirty &&
    !(await confirmDiscard(
      '关闭未保存文件',
      `“${file.name}”尚未保存，关闭后将放弃这些修改。`,
      '放弃修改并关闭',
    ))
  )
    return
  // 等待确认期间切换了角色或文件已被移除时，不再操作新的编辑缓冲。
  if (openFiles.value !== ownerFiles || !ownerFiles.includes(file)) return
  if (pendingFile.value === file.path) {
    ++fileFocusRevision
    pendingFile.value = null
  }
  const nextPreviewPaths = new Set(markdownPreviewPaths.value)
  nextPreviewPaths.delete(file.path)
  markdownPreviewPaths.value = nextPreviewPaths
  openFiles.value = openFiles.value.filter((item) => item.path !== file.path)
  if (activePath.value === file.path) activePath.value = openFiles.value.at(-1)?.path ?? ''
}

/** 重命名目录时同步所有后代标签、预览与选中片段，保留未保存缓冲。 */
function handleFileRenamed(payload: { oldPath: string; newPath: string; name: string }): void {
  const remap = (path: string) =>
    path === payload.oldPath || path.startsWith(`${payload.oldPath}/`)
      ? payload.newPath + path.slice(payload.oldPath.length)
      : path
  for (const file of openFiles.value) {
    const nextPath = remap(file.path)
    if (nextPath === file.path) continue
    file.path = nextPath
    file.name = nextPath.split('/').pop() || payload.name
    file.previewRevision++
    if (!file.dirty) {
      void openFile({ path: file.path, name: file.name, type: 'file' }, true, false).catch(() =>
        notification.toast(__t('ui.navigation', '重命名已完成，预览刷新失败，请重新载入'), {
          type: 'warning',
        }),
      )
    }
  }
  activePath.value = remap(activePath.value)
  markdownPreviewPaths.value = new Set([...markdownPreviewPaths.value].map(remap))
  if (selectedSnippet.value) selectedSnippet.value.path = remap(selectedSnippet.value.path)
}

/** 删除目录后关闭全部后代标签，并清理失效的上下文。 */
function handleFileDeleted(path: string): void {
  const matches = (value: string) => value === path || value.startsWith(`${path}/`)
  if (pendingFile.value && matches(pendingFile.value)) {
    ++fileFocusRevision
    pendingFile.value = null
  }
  openFiles.value = openFiles.value.filter((item) => !matches(item.path))
  markdownPreviewPaths.value = new Set(
    [...markdownPreviewPaths.value].filter((value) => !matches(value)),
  )
  if (matches(activePath.value)) activePath.value = openFiles.value.at(-1)?.path ?? ''
  if (selectedSnippet.value && matches(selectedSnippet.value.path)) selectedSnippet.value = null
}

interface WorkspaceFileChangedDetail {
  agentId: string
  threadId: string
  path: string
  operation: 'create' | 'overwrite' | 'append' | 'edit' | string
}

/**
 * 消费聊天工具成功事件：刷新资源树；新建文件时自动在编辑器打开。
 * 监听器只在 WorkspaceTab 挂载期间存在，因此不会在其他 Tab 抢焦点。
 */
async function handleWorkspaceFileChanged(event: Event): Promise<void> {
  const detail = (event as CustomEvent<WorkspaceFileChangedDetail>).detail
  if (
    !currentAgent.value ||
    detail.agentId !== currentAgent.value.id ||
    detail.threadId !== threadId.value
  )
    return
  await workspaceTreeRef.value?.refresh()
  const name = detail.path.replaceAll('\\', '/').split('/').pop() || detail.path
  if (detail.operation === 'create') {
    isExplorerCollapsed.value = false
    await openFile({ path: detail.path, name, type: 'file' }, true)
  } else {
    const existing = openFiles.value.find((file) => file.path === detail.path)
    if (existing) await openFile({ path: detail.path, name, type: 'file' }, true, false)
  }
}

interface WorkspaceRewoundDetail {
  threadId: string
  agentId?: string
  files: Array<{
    path: string
    action:
      | 'delete_created'
      | 'restore_edited'
      | 'restore_deleted'
      | 'restore_renamed'
      | 'preserve_changed'
  }>
}

/** 撤回前检查当前角色及暂存角色的编辑缓冲，避免磁盘恢复越过尚未保存的修改。 */
function handleBeforeWorkspaceRewind(event: Event): void {
  const detail = (event as CustomEvent<WorkspaceRewoundDetail>).detail
  const files = detail.agentId
    ? detail.agentId === currentAgent.value?.id
      ? openFiles.value
      : (buffersByAgent.get(detail.agentId)?.files ?? [])
    : detail.threadId === threadId.value
      ? openFiles.value
      : []
  const key = (value: string) => {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
    return /Win/i.test(navigator.platform) ? normalized.toLowerCase() : normalized
  }
  const affected = new Set(detail.files.map((file) => key(file.path)))
  const dirty = files.filter((file) => file.dirty && affected.has(key(file.path)))
  if (!dirty.length) return
  event.preventDefault()
  notification.toast(
    __t('ui.navigation', '请先保存或关闭未保存的文件：{0}', [
      dirty.map((file) => file.name).join('、'),
    ]),
    {
      type: 'warning',
    },
  )
}

/** 回滚完成后同步资源树与编辑器标签。 */
async function handleWorkspaceRewound(event: Event): Promise<void> {
  const detail = (event as CustomEvent<WorkspaceRewoundDetail>).detail
  if (
    detail.agentId ? detail.agentId !== currentAgent.value?.id : detail.threadId !== threadId.value
  )
    return
  await workspaceTreeRef.value?.refresh()
  for (const change of detail.files) {
    if (change.action === 'preserve_changed') continue
    if (change.action === 'delete_created') {
      const file = openFiles.value.find((item) => item.path === change.path)
      if (file?.dirty) {
        notification.toast(
          __t('ui.navigation', '“{0}”已被回滚删除，但本地有未保存缓冲，标签暂时保留', [file.name]),
          {
            type: 'warning',
          },
        )
        continue
      }
      handleFileDeleted(change.path)
      continue
    }
    const file = openFiles.value.find((item) => item.path === change.path)
    if (file) {
      const name = change.path.replaceAll('\\', '/').split('/').pop() || change.path
      await openFile({ path: change.path, name, type: 'file' }, true, false)
    }
  }
}

function onWorkspaceRewound(event: Event): void {
  void handleWorkspaceRewound(event).catch(() => {
    notification.toast(__t('ui.navigation', '文件已回滚，工作区刷新失败，请手动重载'), {
      type: 'warning',
    })
  })
}

function expandApprovalQueue(): void {
  isCopilotCollapsed.value = false
  isApprovalQueueExpanded.value = true
}

async function resolveWorkspaceApproval(
  id: string,
  decision: ApprovalDecision,
  message?: string,
): Promise<void> {
  delete approvalErrors.value[id]
  try {
    await approvalStore.resolve(id, decision, message)
  } catch (error) {
    approvalErrors.value[id] = error instanceof Error ? error.message : '审批提交失败，请重试'
  }
}

/** 使用 Pointer Events 调整桌面工作台分栏，避免绑定全局鼠标事件后遗留监听器。 */
function toggleTerminalMaximized(): void {
  isTerminalMaximized.value = !isTerminalMaximized.value
  isTerminalCollapsed.value = false
}

function toggleTerminalCollapsed(): void {
  isTerminalCollapsed.value = !isTerminalCollapsed.value
  isTerminalMaximized.value = false
}

function startResize(event: PointerEvent, target: 'explorer' | 'copilot' | 'terminal'): void {
  const handle = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startY = event.clientY
  const startExplorer = explorerWidth.value
  const startCopilot = copilotWidth.value
  const startTerminal = terminalHeight.value
  handle.setPointerCapture(event.pointerId)

  const move = (pointer: PointerEvent) => {
    if (target === 'explorer')
      explorerWidth.value = Math.min(360, Math.max(200, startExplorer + pointer.clientX - startX))
    if (target === 'copilot')
      copilotWidth.value = Math.min(640, Math.max(400, startCopilot + startX - pointer.clientX))
    if (target === 'terminal')
      terminalHeight.value = Math.min(520, Math.max(150, startTerminal + startY - pointer.clientY))
  }
  const stop = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', stop)
    handle.removeEventListener('pointercancel', stop)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
}

watch(
  () => currentAgent.value?.id,
  (nextAgentId, previousAgentId) => {
    ++fileFocusRevision
    pendingFile.value = null
    settleDiscard()
    // Agent 切换时按角色封存编辑缓冲；返回该 Agent 后原样恢复，绝不跨 workspace 展示路径。
    if (previousAgentId)
      buffersByAgent.set(previousAgentId, { files: openFiles.value, activePath: activePath.value })
    const restored = nextAgentId ? buffersByAgent.get(nextAgentId) : undefined
    openFiles.value = restored?.files ?? []
    activePath.value = restored?.activePath ?? ''
    activeTerminalId.value = ''
    selectedSnippet.value = null
    if (nextAgentId && threadStore.agentId !== nextAgentId) void ensureAgent()
  },
)

watch(activePath, () => {
  selectedSnippet.value = null
})

watch(threadId, () => {
  activeTerminalId.value = ''
  selectedSnippet.value = null
})

onBeforeRouteLeave(async () => {
  const files = [
    ...openFiles.value,
    ...[...buffersByAgent.values()].flatMap((buffer) => buffer.files),
  ]
  if (files.some((file) => file.dirty))
    return confirmDiscard(
      __t('ui.navigation', '离开工作区'),
      __t('ui.navigation', '工作区仍有未保存文件，确定离开吗？'),
      __t('ui.navigation', '离开工作区'),
    )
  return true
})

onDeactivated(() => {
  workspaceActive.value = false
  settleDiscard()
})

onMounted(() => {
  void ensureAgent()
  approvalStore.startPolling()
  window.addEventListener('infos:workspace-file-changed', handleWorkspaceFileChanged)
  window.addEventListener('infos:workspace-rewound', onWorkspaceRewound)
  window.addEventListener('infos:before-workspace-rewind', handleBeforeWorkspaceRewind)
})

onActivated(() => {
  workspaceActive.value = true
  void (async () => {
    await ensureAgent()
    for (const file of openFiles.value) needsRefresh.add(file)
    const file = activeFile.value
    if (file && !file.dirty)
      await openFile({ path: file.path, name: file.name, type: 'file' }, true, false)
  })().catch(() =>
    notification.toast(__t('ui.navigation', '工作区文件刷新失败，请手动重载'), { type: 'error' }),
  )
})

onBeforeUnmount(() => {
  settleDiscard()
  window.removeEventListener('infos:workspace-file-changed', handleWorkspaceFileChanged)
  window.removeEventListener('infos:workspace-rewound', onWorkspaceRewound)
  window.removeEventListener('infos:before-workspace-rewind', handleBeforeWorkspaceRewind)
})
</script>

<template>
  <div v-if="currentAgent" class="workspace-tab">
    <div
      class="workspace-panel"
      :class="{ 'workspace-panel--mobile-terminal': isMobile && !isTerminalCollapsed }"
    >
      <!-- 工作台上下文栏：集中呈现 Agent、当前文件和可见区域开关。 -->
      <header class="workspace-commandbar">
        <div class="workspace-agent">
          <AgentStateHover
            class="workspace-agent__avatar"
            :agent-id="currentAgent.id"
            :agent-name="currentAgent.name"
          >
            <img v-if="agentAvatarUrl" :src="agentAvatarUrl" :alt="currentAgent.name" />
            <span v-else>{{ agentInitial }}</span>
          </AgentStateHover>
          <div class="workspace-agent__identity">
            <div class="workspace-agent__title">
              <strong>{{ currentAgent.name }}</strong>
              <span class="workspace-label">WORKSPACE</span>
            </div>
            <span class="workspace-agent__status">
              <i />
              {{ __t('ui.navigation', '专属工作空间已连接') }}
            </span>
          </div>
        </div>

        <div class="workspace-context" :title="activeFile?.path">
          <WorkspaceFileGlyph v-if="activeFile" :kind="activeFile.kind" />
          <PixelIcon v-else name="folder" size="xs" />
          <span>{{ activeFile?.path || __t('ui.navigation', '选择文件开始协作') }}</span>
          <i
            v-if="activeFile?.dirty"
            class="workspace-dirty-dot"
            :title="__t('ui.navigation', '尚未保存')"
          />
          <span
            v-if="activeFile?.truncated || activeFile?.searchSource"
            class="workspace-readonly-badge"
          >
            {{ __t('ui.navigation', '只读预览') }}
          </span>
        </div>

        <div class="workspace-actions">
          <button
            v-if="pendingApprovals.length"
            class="workspace-action workspace-action--approval"
            :title="__t('ui.navigation', '展开待审批队列')"
            @click="expandApprovalQueue"
          >
            <PixelIcon name="alert" size="xs" />
            <span>{{ pendingApprovals.length }}</span>
          </button>
          <button
            class="workspace-action"
            :class="{ active: !isExplorerCollapsed }"
            :title="__t('ui.navigation', '切换资源栏')"
            @click="isExplorerCollapsed = !isExplorerCollapsed"
          >
            <PixelIcon name="folder" size="sm" />
          </button>
          <button
            class="workspace-action"
            :class="{ active: !isTerminalCollapsed }"
            :title="__t('ui.navigation', '切换终端面板')"
            @click="isTerminalCollapsed = !isTerminalCollapsed"
          >
            <PixelIcon name="terminal" size="sm" />
          </button>
          <button
            class="workspace-action"
            :class="{ active: !isCopilotCollapsed }"
            :title="__t('ui.navigation', '切换 Agent 协作栏')"
            @click="isCopilotCollapsed = !isCopilotCollapsed"
          >
            <PixelIcon name="chat" size="sm" />
          </button>
        </div>
      </header>

      <div class="workspace-body">
        <button
          v-if="isMobile && (!isExplorerCollapsed || !isCopilotCollapsed)"
          class="workspace-mobile-backdrop"
          :aria-label="__t('ui.navigation', '关闭工作区面板')"
          @click="dismissMobileWorkspacePanels"
        />
        <!-- 左侧资源栏。折叠后保留可恢复的图标轨道。 -->
        <aside
          class="workspace-explorer"
          :class="{ 'workspace-explorer--collapsed': isExplorerCollapsed }"
          :style="isExplorerCollapsed ? undefined : { width: `${explorerWidth}px` }"
        >
          <button
            v-if="isExplorerCollapsed"
            class="workspace-rail-button"
            :title="__t('ui.navigation', '展开资源栏')"
            @click="isExplorerCollapsed = false"
          >
            <PixelIcon name="folder" size="sm" />
          </button>
          <template v-else>
            <WorkspaceTree
              v-if="threadId"
              ref="workspaceTreeRef"
              :active="workspaceActive && desktopHomeVisible && !isExplorerCollapsed"
              :opening="revealingWorkspace"
              :allow-reveal="isLocalBackendRuntime()"
              :agent-id="currentAgent.id"
              :agent-name="currentAgent.name"
              :thread-id="threadId"
              @select="selectFile"
              @renamed="handleFileRenamed"
              @deleted="handleFileDeleted"
              @reveal="revealWorkspace"
            />
            <div
              class="workspace-resizer workspace-resizer--vertical"
              @pointerdown="startResize($event, 'explorer')"
            />
          </template>
        </aside>

        <!-- 中部始终是第一视觉焦点：文件标签、编辑器和底部工作面板。 -->
        <main
          class="workspace-center"
          :inert="isMobile && (!isExplorerCollapsed || !isCopilotCollapsed)"
        >
          <div class="editor-tabs" role="tablist" :aria-label="__t('ui.navigation', '已打开文件')">
            <button
              v-for="file in openFiles"
              :key="file.path"
              role="tab"
              :aria-selected="file.path === activePath"
              :class="{ active: file.path === activePath }"
              @click="activateFile(file.path)"
            >
              <WorkspaceFileGlyph :kind="file.kind" />
              <span>{{ file.name }}</span>
              <i v-if="file.dirty" :title="__t('ui.navigation', '尚未保存')" />
              <b :title="__t('ui.navigation', '关闭文件')" @click.stop="close(file)">×</b>
            </button>
            <span v-if="!openFiles.length" class="editor-tabs__empty">
              {{ __t('ui.navigation', '没有打开的文件') }}
            </span>
          </div>

          <div v-show="!isTerminalMaximized" ref="previewFrame" class="editor-preview-frame">
            <SurfaceTransition
              fill
              variant="panel"
              :identity="`${currentAgent.id}:${activePath}`"
              :pending="!!pendingFile && !isTerminalMaximized"
              :label="__t('ui.navigation', '正在打开文件')"
              class="editor-area"
              :class="{ 'editor-area--terminal-maximized': isTerminalMaximized }"
            >
              <div v-if="activeFile && !isTerminalMaximized" class="editor-toolbar">
                <div class="editor-breadcrumb">
                  <PixelIcon name="folder" size="xs" />
                  <span>{{ activeFile.path }}</span>
                </div>
                <span v-if="activeFile.truncated" class="editor-warning">
                  {{
                    activeFile.searchSource
                      ? __t('ui.toolSearchResult', '当前文件的第 {0}–{1} 行', [
                          activeFile.sourceLineStart ?? 1,
                          (activeFile.sourceLineStart ?? 1) +
                            activeFile.content.split('\n').length -
                            1,
                        ])
                      : __t('ui.navigation', '文件过大，仅载入前 128K 字符')
                  }}
                </span>
                <div
                  v-if="isMarkdownFile"
                  class="editor-view-switch"
                  role="group"
                  :aria-label="__t('ui.navigation', 'Markdown视图')"
                >
                  <button
                    type="button"
                    :class="{ active: !isMarkdownPreview }"
                    @click="setMarkdownPreview(false)"
                  >
                    <PixelIcon name="code" size="xs" />
                    {{ __t('ui.navigation', '编辑') }}
                  </button>
                  <button
                    type="button"
                    :class="{ active: isMarkdownPreview }"
                    @click="setMarkdownPreview(true)"
                  >
                    <PixelIcon name="eye" size="xs" />
                    {{ __t('ui.navigation', '浏览') }}
                  </button>
                </div>
                <PButton
                  size="sm"
                  variant="ghost"
                  :disabled="fullscreenPending"
                  :aria-pressed="previewExpanded"
                  @click="togglePreviewFullscreen"
                >
                  <PixelIcon :name="previewExpanded ? 'minimize' : 'maximize'" size="xs" />
                  {{
                    previewExpanded
                      ? __t('ui.workspace', '退出全屏')
                      : __t('ui.workspace', '全屏浏览')
                  }}
                </PButton>
                <PButton
                  v-if="activeFile.kind === 'text' && !isMarkdownPreview"
                  size="sm"
                  variant="ghost"
                  @click="attachSelection"
                >
                  {{ __t('ui.navigation', '引用选区') }}
                </PButton>
                <PButton
                  v-if="activeFile.kind === 'text' && !isMarkdownPreview"
                  size="sm"
                  :disabled="!activeFile.dirty || activeFile.truncated || !!activeFile.searchSource"
                  @click="save"
                >
                  {{
                    activeFile.truncated || activeFile.searchSource
                      ? __t('ui.navigation', '只读预览')
                      : __t('ui.navigation', '保存')
                  }}
                </PButton>
              </div>
              <WorkspaceFilePreview
                v-for="file in previewFiles"
                v-show="file.path === activePath && !isTerminalMaximized"
                :key="`${currentAgent.id}:${threadId}:${file.path}:${file.version}:${file.previewRevision}`"
                :file="file"
                :session="{ agentId: currentAgent.id, threadId }"
                :state="file.previewState"
                :active="previewVisible && file.path === activePath"
                @state="(state, patch) => Object.assign(state, patch)"
                @reload="reloadPreview"
                @fullscreen="togglePreviewFullscreen"
              />
              <template v-if="activeFile && !isTerminalMaximized">
                <div
                  v-if="isMarkdownPreview"
                  class="markdown-preview"
                  :aria-label="__t('ui.navigation', 'Markdown浏览器')"
                >
                  <article class="markdown-preview__paper">
                    <ChatRichText :content="activeFile.content" />
                  </article>
                </div>
                <div v-else-if="activeFile.kind === 'text'" class="editor-surface">
                  <div class="editor-gutter" aria-hidden="true">
                    {{ activeFile.sourceLineStart ?? 1 }}
                  </div>
                  <textarea
                    ref="editorTextarea"
                    :value="activeFile.content"
                    :readonly="activeFile.truncated || !!activeFile.searchSource"
                    spellcheck="false"
                    :aria-label="__t('ui.navigation', '文件编辑器')"
                    @input="updateContent"
                    @keydown.ctrl.s.prevent="save"
                  />
                </div>
                <footer class="editor-statusbar">
                  <span>
                    {{
                      activeFile.kind !== 'text'
                        ? __t('ui.navigation', '只读浏览')
                        : activeFile.dirty
                          ? __t('ui.navigation', '已修改')
                          : __t('ui.navigation', '已保存')
                    }}
                  </span>
                  <span class="editor-statusbar__spacer" />
                  <span v-if="activeFile.kind === 'text'">UTF-8</span>
                  <span v-if="activeFile.kind === 'text'">LF</span>
                  <span>{{ activeFileExtension }}</span>
                </footer>
              </template>

              <div v-else-if="!isTerminalMaximized" class="editor-empty">
                <div class="editor-empty__mark"><PixelIcon name="code" size="2xl" /></div>
                <strong>
                  {{ __t('ui.navigation', '打开文件，开始与') }} {{ currentAgent.name }}
                  {{ __t('ui.navigation', '协作') }}
                </strong>
                <span>{{ __t('ui.navigation', '从左侧选择文件，与助手一起编辑。') }}</span>
                <button v-if="isLocalBackendRuntime()" @click="revealWorkspace">
                  <PixelIcon name="folder" size="xs" />
                  {{ __t('ui.navigation', '在文件管理器中打开') }}
                </button>
              </div>
            </SurfaceTransition>
          </div>

          <section
            class="terminal-area"
            :class="{
              'terminal-area--collapsed': isTerminalCollapsed,
              'terminal-area--maximized': isTerminalMaximized,
            }"
            :style="
              isTerminalCollapsed || isTerminalMaximized
                ? undefined
                : { height: `${terminalHeight}px` }
            "
          >
            <div
              v-if="!isTerminalCollapsed && !isTerminalMaximized"
              class="workspace-resizer workspace-resizer--horizontal"
              @pointerdown="startResize($event, 'terminal')"
            />
            <div class="terminal-panelbar" @dblclick="isTerminalCollapsed = !isTerminalCollapsed">
              <div class="terminal-panelbar__title">
                <PixelIcon name="terminal" size="xs" />
                <strong>{{ __t('ui.navigation', '终端') }}</strong>
                <span v-if="activeTerminalId">{{ __t('ui.navigation', '已连接') }}</span>
              </div>
              <div class="terminal-panelbar__actions">
                <button
                  :title="__t('ui.navigation', '最大化终端')"
                  @click="toggleTerminalMaximized"
                >
                  <PixelIcon
                    :name="isTerminalMaximized ? 'chevron-down' : 'chevron-up'"
                    size="xs"
                  />
                </button>
                <button
                  :title="
                    isTerminalCollapsed
                      ? __t('ui.navigation', '展开终端')
                      : __t('ui.navigation', '收起终端')
                  "
                  @click="toggleTerminalCollapsed"
                >
                  <PixelIcon
                    :name="isTerminalCollapsed ? 'chevron-up' : 'chevron-down'"
                    size="xs"
                  />
                </button>
              </div>
            </div>
            <WorkspaceTerminal
              v-if="!isTerminalCollapsed && threadId"
              :agent-id="currentAgent.id"
              :thread-id="threadId"
              @active="activeTerminalId = $event"
            />
          </section>
        </main>

        <!-- 右侧 Agent Copilot：审批队列与聊天分层呈现，互不覆盖。 -->
        <aside
          class="workspace-copilot"
          :class="{ 'workspace-copilot--collapsed': isCopilotCollapsed }"
          :style="isCopilotCollapsed ? undefined : { width: `${copilotWidth}px` }"
        >
          <template v-if="isCopilotCollapsed">
            <AgentStateHover
              as="button"
              :agent-id="currentAgent.id"
              :agent-name="currentAgent.name"
              class="copilot-rail-avatar"
              :aria-label="__t('ui.navigation', '切换会话（当前：{0}）', [currentAgent.name])"
              @click="isSessionDrawerOpen = true"
            >
              <img v-if="agentAvatarUrl" :src="agentAvatarUrl" :alt="currentAgent.name" />
              <span v-else>{{ agentInitial }}</span>
              <i v-if="pendingApprovals.length">{{ pendingApprovals.length }}</i>
            </AgentStateHover>
            <button
              class="workspace-rail-button"
              :title="__t('ui.navigation', '展开协作栏')"
              @click="isCopilotCollapsed = false"
            >
              <PixelIcon name="chat" size="sm" />
            </button>
          </template>
          <template v-else>
            <div
              class="workspace-resizer workspace-resizer--copilot"
              @pointerdown="startResize($event, 'copilot')"
            />
            <header class="copilot-header">
              <button
                class="copilot-header__main"
                :aria-label="__t('ui.navigation', '切换工作区会话')"
                @click="isSessionDrawerOpen = true"
              >
                <AgentStateHover
                  class="copilot-header__avatar"
                  :agent-id="currentAgent.id"
                  :agent-name="currentAgent.name"
                >
                  <img v-if="agentAvatarUrl" :src="agentAvatarUrl" :alt="currentAgent.name" />
                  <span v-else>{{ agentInitial }}</span>
                </AgentStateHover>
                <div class="copilot-header__identity">
                  <strong>
                    {{ __t('ui.navigation', '与') }} {{ currentAgent.name }}
                    {{ __t('ui.navigation', '协作') }}
                  </strong>
                  <span>{{ __t('ui.navigation', 'AGENT COPILOT · 点击切换会话') }}</span>
                </div>
                <PixelIcon name="chevron-down" size="xs" class="copilot-header__switch" />
              </button>
              <PButton
                variant="ghost"
                size="sm"
                :disabled="!threadStore.threadId"
                :title="__t('ui.navigation', '导出当前工作区会话历史')"
                @click="showHistoryExport = true"
              >
                <PixelIcon name="download" size="xs" />
                {{ __t('ui.navigation', '导出') }}
              </PButton>
              <button
                class="copilot-header__collapse"
                :title="__t('ui.navigation', '收起协作栏')"
                @click="isCopilotCollapsed = true"
              >
                <PixelIcon name="chevron-right" size="xs" />
              </button>
            </header>

            <div v-if="activePath || activeTerminalId" class="copilot-context">
              <span class="copilot-context__label">{{ __t('ui.navigation', '当前上下文') }}</span>
              <span v-if="activePath" class="context-chip">
                <PixelIcon name="code" size="xs" />
                {{ activeFile?.name || activePath }}
              </span>
              <span v-if="activeTerminalId" class="context-chip">
                <PixelIcon name="terminal" size="xs" />
                {{ __t('ui.navigation', '当前终端') }}
              </span>
            </div>

            <section
              v-if="queuedApprovals.length"
              class="approval-queue"
              :class="{ 'approval-queue--expanded': isApprovalQueueExpanded }"
            >
              <button
                class="approval-queue__header"
                @click="isApprovalQueueExpanded = !isApprovalQueueExpanded"
              >
                <span>
                  <PixelIcon name="alert" size="xs" />
                  <strong>{{ __t('ui.navigation', '安全确认') }}</strong>
                  <i>{{ queuedApprovals.length }}</i>
                </span>
                <PixelIcon
                  :name="isApprovalQueueExpanded ? 'chevron-up' : 'chevron-down'"
                  size="xs"
                />
              </button>
              <div v-if="isApprovalQueueExpanded" class="approval-queue__body">
                <button
                  class="approval-queue__collapse"
                  :title="__t('ui.navigation', '收起待审批队列')"
                  @click="isApprovalQueueExpanded = false"
                >
                  <PixelIcon name="chevron-up" size="xs" />
                  {{ __t('ui.navigation', '收起待审批队列') }}
                </button>
                <ApprovalCard
                  v-for="request in queuedApprovals"
                  :key="request.id"
                  :request="request"
                  :loading="approvalStore.isResolving[request.id]"
                  :error="approvalErrors[request.id]"
                  compact
                  @resolve="
                    (decision, message) => resolveWorkspaceApproval(request.id, decision, message)
                  "
                />
              </div>
            </section>

            <div class="copilot-chat">
              <ChatContainer
                :agent-id="currentAgent.id"
                :agent-name="currentAgent.name"
                :agent-avatar-url="agentAvatarUrl"
                :thread-id="threadId"
                compact-input
                :workspace-context="{
                  filePath: activePath || undefined,
                  fileHash: activeFile?.hash || undefined,
                  fileDirty: activeFile?.dirty,
                  terminalId: activeTerminalId || undefined,
                  selection:
                    selectedSnippet?.path === activePath
                      ? {
                          text: selectedSnippet.text,
                          startLine: selectedSnippet.startLine,
                          endLine: selectedSnippet.endLine,
                        }
                      : undefined,
                }"
                @context-consumed="selectedSnippet = null"
              />
            </div>
          </template>
        </aside>
      </div>
    </div>

    <HistoryExportDialog
      v-model="showHistoryExport"
      :disabled="isExportingHistory"
      @confirm="exportCurrentHistory"
    />

    <PDialog
      :model-value="Boolean(discardDialog)"
      :title="discardDialog?.title"
      :message="discardDialog?.message"
      :confirm-text="discardDialog?.confirmText"
      :cancel-text="__t('ui.navigation', '继续编辑')"
      confirm-variant="danger"
      @confirm="settleDiscard(true)"
      @cancel="settleDiscard()"
      @update:model-value="
        (visible) => {
          if (!visible) settleDiscard()
        }
      "
    />

    <!-- 会话切换抽屉：由 Header 主体或收起态角色图标触发。 -->
    <WorkspaceSessionDrawer v-model:open="isSessionDrawerOpen" />
  </div>

  <div v-else class="workspace-loading">
    <PixelIcon name="refresh" size="lg" animation="spin" />
    {{ __t('ui.navigation', '正在加载 Agent 工作区…') }}
  </div>
</template>

<style scoped>
.workspace-tab {
  width: 100%;
  height: 100%;
  padding: 14px;
  overflow: hidden;
  background:
    radial-gradient(
      circle at 12% 8%,
      color-mix(in srgb, var(--ui-accent-sky) 8%, transparent),
      transparent 31%
    ),
    radial-gradient(
      circle at 88% 86%,
      color-mix(in srgb, var(--ui-accent-purple) 7%, transparent),
      transparent 34%
    ),
    var(--ui-bg-canvas);
}

.workspace-panel {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-xl);
  background: var(--ui-bg-surface);
  box-shadow: var(--ui-shadow-md);
}

.workspace-commandbar {
  display: grid;
  min-height: 50px;
  flex-shrink: 0;
  grid-template-columns: minmax(220px, auto) minmax(120px, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 0 12px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}

.workspace-agent {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}
.workspace-agent__avatar,
.copilot-header__avatar,
.copilot-rail-avatar {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 45%, var(--ui-border-default));
  background: linear-gradient(135deg, var(--ui-accent-primary-soft), var(--ui-accent-purple-soft));
  color: var(--ui-accent-primary);
  font-family: var(--ui-font-pixel);
  font-weight: 900;
  box-shadow: 0 0 14px color-mix(in srgb, var(--ui-accent-primary) 14%, transparent);
}
.workspace-agent__avatar {
  width: 34px;
  height: 34px;
  border-radius: var(--ui-radius-sm);
}
.workspace-agent__identity {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.workspace-agent__title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.workspace-agent__title strong {
  overflow: hidden;
  color: var(--ui-text-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-label {
  color: var(--ui-accent-sky);
  font: 700 8px var(--ui-font-mono);
  letter-spacing: 0.12em;
}
.workspace-agent__status {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-tertiary);
  font-size: 9px;
}
.workspace-agent__status i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-success);
  box-shadow: 0 0 6px var(--ui-success);
}

.workspace-context {
  display: flex;
  min-width: 0;
  max-width: 560px;
  align-items: center;
  justify-self: center;
  gap: 7px;
  padding: 7px 11px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
  font: 10px var(--ui-font-mono);
}
.workspace-context > span:first-of-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-dirty-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--ui-warning);
}
.workspace-readonly-badge {
  flex-shrink: 0;
  padding: 2px 5px;
  border-radius: var(--ui-radius-xs);
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
  font: 700 8px var(--ui-font-sans);
}
.workspace-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.workspace-action {
  position: relative;
  display: grid;
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
  transition: all var(--ui-duration-fast);
}
.workspace-action:hover,
.workspace-action.active {
  border-color: var(--ui-border-default);
  border-bottom-color: var(--ui-accent-sky);
  background: var(--ui-bg-hover);
  color: var(--ui-accent-sky);
}
.workspace-action--approval {
  display: flex;
  gap: 5px;
  border-color: color-mix(in srgb, var(--ui-warning) 28%, transparent);
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
  font-size: 10px;
  font-weight: 800;
}

.workspace-body {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.workspace-explorer,
.workspace-copilot {
  position: relative;
  display: flex;
  min-height: 0;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--ui-bg-surface-soft);
  transition: width var(--ui-duration-normal) var(--ui-ease-standard);
}
.workspace-explorer {
  border-right: 1px solid var(--ui-border-subtle);
}
.workspace-explorer--collapsed {
  width: 48px;
  justify-content: center;
  padding-top: 10px;
}
.workspace-copilot {
  flex-direction: column;
  border-left: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface);
}
.workspace-copilot--collapsed {
  width: 52px;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  background: var(--ui-bg-surface-soft);
}
.workspace-rail-button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
}
.workspace-rail-button:hover {
  border-color: var(--ui-border-default);
  background: var(--ui-bg-hover);
  color: var(--ui-accent-sky);
}

.workspace-resizer {
  position: absolute;
  z-index: 15;
  touch-action: none;
}
.workspace-resizer--vertical {
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
}
.workspace-resizer--copilot {
  top: 0;
  left: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
}
.workspace-resizer--horizontal {
  top: -4px;
  right: 0;
  left: 0;
  height: 8px;
  cursor: row-resize;
}
.workspace-resizer:hover,
.workspace-resizer:active {
  background: color-mix(in srgb, var(--ui-accent-sky) 45%, transparent);
}

.workspace-center {
  display: flex;
  min-width: 320px;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--ui-bg-surface);
}
.editor-tabs {
  display: flex;
  height: 38px;
  flex-shrink: 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
}
.editor-tabs button {
  position: relative;
  display: flex;
  max-width: 200px;
  min-width: 112px;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border: 0;
  border-right: 1px solid var(--ui-border-subtle);
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.editor-tabs button::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: transparent;
}
.editor-tabs button:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}
.editor-tabs button.active {
  background: var(--ui-bg-surface);
  color: var(--ui-accent-sky);
}
.editor-tabs button.active::after {
  background: var(--ui-accent-sky);
}
.editor-tabs button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-tabs button i {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--ui-warning);
}
.editor-tabs button b {
  margin-left: auto;
  color: var(--ui-text-tertiary);
  font-size: 15px;
  font-weight: 400;
}
.editor-tabs button b:hover {
  color: var(--ui-danger);
}
.editor-tabs__empty {
  display: flex;
  align-items: center;
  padding: 0 12px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}

.editor-preview-frame {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 120px;
  flex-direction: column;
  overflow: hidden;
}
.editor-preview-frame:fullscreen {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--ui-bg-surface);
}
.editor-preview-frame:fullscreen .editor-toolbar {
  min-height: 44px;
}
.editor-area {
  display: flex;
  min-height: 120px;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--ui-bg-surface);
}
.editor-area--terminal-maximized {
  display: none;
}
.editor-toolbar {
  display: flex;
  min-height: 38px;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  padding: 0 10px 0 12px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-elevated);
}
.editor-breadcrumb {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 7px;
  color: var(--ui-text-tertiary);
  font: 9px var(--ui-font-mono);
}
.editor-breadcrumb span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-warning {
  color: var(--ui-warning);
  font-size: 9px;
}
.editor-view-switch {
  display: inline-flex;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface-soft);
}
.editor-view-switch button {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  border: 0;
  background: transparent;
  color: var(--ui-text-tertiary);
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;
}
.editor-view-switch button + button {
  border-left: 1px solid var(--ui-border-default);
}
.editor-view-switch button:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}
.editor-view-switch button.active {
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
}
.markdown-preview {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: clamp(20px, 4vw, 48px);
  background:
    radial-gradient(
      circle at top,
      color-mix(in srgb, var(--ui-accent-sky) 5%, transparent),
      transparent 45%
    ),
    var(--ui-bg-surface-soft);
}
.markdown-preview__paper {
  width: min(860px, 100%);
  min-height: 100%;
  margin: 0 auto;
  padding: clamp(24px, 5vw, 56px);
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-surface);
  box-shadow: var(--ui-shadow-sm);
  color: var(--ui-text-primary);
}
.markdown-preview__paper :deep(.chat-rich-text) {
  font-size: 14px;
  line-height: 1.8;
}
.markdown-preview__paper :deep(.chat-rich-text > :first-child) {
  margin-top: 0;
}
.markdown-preview__paper :deep(.chat-rich-text > :last-child) {
  margin-bottom: 0;
}
.editor-surface {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: var(--ui-bg-surface);
  background-image: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-border-subtle) 25%, transparent) 1px,
    transparent 1px
  );
  background-size: 80px 100%;
}
.editor-gutter {
  width: 42px;
  flex-shrink: 0;
  padding: 14px 10px;
  border-right: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-disabled);
  text-align: right;
  font: 12px/1.65 var(--ui-font-mono);
  user-select: none;
}
.editor-surface textarea {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  resize: none;
  border: 0;
  outline: 0;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--ui-bg-surface) 96%, transparent);
  color: var(--ui-text-primary);
  caret-color: var(--ui-accent-sky);
  font: 12px/1.65 var(--ui-font-mono);
  tab-size: 2;
  white-space: pre;
}
.editor-surface textarea:focus {
  box-shadow: inset 2px 0 0 var(--ui-accent-sky);
}
.editor-surface textarea:read-only {
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface-soft);
}
.editor-statusbar {
  display: flex;
  min-height: 24px;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  padding: 0 10px;
  border-top: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-tertiary);
  font: 8px var(--ui-font-mono);
}
.editor-statusbar__spacer {
  flex: 1;
}
.editor-empty {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  padding: 24px;
  color: var(--ui-text-tertiary);
  text-align: center;
}
.editor-empty__mark {
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-lg);
  background: linear-gradient(135deg, var(--ui-accent-sky-soft), var(--ui-accent-purple-soft));
  color: var(--ui-accent-sky);
  box-shadow: var(--ui-shadow-sm);
}
.editor-empty strong {
  color: var(--ui-text-primary);
  font-size: 14px;
}
.editor-empty span {
  max-width: 430px;
  font-size: 11px;
  line-height: 1.6;
}
.editor-empty button {
  display: flex;
  min-height: 30px;
  align-items: center;
  gap: 7px;
  margin-top: 4px;
  padding: 0 12px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-surface);
  color: var(--ui-accent-sky);
  cursor: pointer;
  box-shadow: 3px 3px 0 var(--ui-bg-hover);
}
.editor-empty button:hover {
  background: var(--ui-bg-hover);
  box-shadow: var(--ui-shadow-sm);
}

.terminal-area {
  position: relative;
  display: flex;
  min-height: 150px;
  flex-shrink: 0;
  flex-direction: column;
  border-top: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}
.terminal-area--collapsed {
  min-height: 36px;
  height: 36px !important;
}
.terminal-area--maximized {
  min-height: 0;
  height: 100% !important;
  flex: 1;
}
.terminal-panelbar {
  display: flex;
  min-height: 36px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 11px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-tertiary);
  user-select: none;
}
.terminal-panelbar__title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
}
.terminal-panelbar__title strong {
  color: var(--ui-text-primary);
}
.terminal-panelbar__title span {
  color: var(--ui-success);
  font-size: 8px;
}
.terminal-panelbar__actions {
  display: flex;
  gap: 3px;
}
.terminal-panelbar__actions button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}
.terminal-panelbar__actions button:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #e2e8f0;
}

.copilot-rail-avatar {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: var(--ui-radius-sm);
  cursor: pointer;
}
.copilot-rail-avatar i {
  position: absolute;
  top: -6px;
  right: -7px;
  display: grid;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  place-items: center;
  border: 2px solid var(--ui-bg-surface-soft);
  border-radius: 9px;
  background: var(--ui-danger);
  color: white;
  font: 800 8px var(--ui-font-sans);
}
.copilot-header {
  display: flex;
  min-height: 56px;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-elevated);
}
.copilot-header__main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.copilot-header__main:hover {
  border-color: var(--ui-border-subtle);
  background: var(--ui-bg-hover);
}
.copilot-header__avatar {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: var(--ui-radius-sm);
}
.copilot-header__identity {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.copilot-header__identity strong {
  overflow: hidden;
  color: var(--ui-text-primary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.copilot-header__identity span {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font: 700 8px var(--ui-font-mono);
  letter-spacing: 0.06em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.copilot-header__switch {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
  transition: transform var(--ui-duration-fast);
}
.copilot-header__main:hover .copilot-header__switch {
  color: var(--ui-accent-primary);
  transform: translateY(1px);
}
.copilot-header__collapse {
  display: grid;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
}
.copilot-header__collapse:hover {
  border-color: var(--ui-border-default);
  background: var(--ui-bg-hover);
  color: var(--ui-accent-primary);
}
.copilot-context {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
}
.copilot-context__label {
  width: 100%;
  color: var(--ui-text-tertiary);
  font: 700 8px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.context-chip {
  display: flex;
  min-width: 0;
  max-width: 180px;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-sky) 20%, var(--ui-border-subtle));
  border-radius: var(--ui-radius-full);
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  font-size: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.approval-queue {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  min-height: 38px;
  max-height: 55%;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-warning-soft);
}
.approval-queue__header {
  display: flex;
  width: 100%;
  min-height: 38px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 0 11px;
  border: 0;
  background: transparent;
  color: var(--ui-warning);
  cursor: pointer;
}
.approval-queue__header > span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.approval-queue__header strong {
  font-size: 10px;
}
.approval-queue__header i {
  display: grid;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  place-items: center;
  border-radius: 9px;
  background: var(--ui-warning);
  color: var(--ui-text-inverse);
  font-size: 8px;
  font-style: normal;
}
.approval-queue__body {
  display: flex;
  max-height: 310px;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding: 8px;
}
.approval-queue__body :deep(.approval-card) {
  max-height: min(240px, 40vh);
}
.approval-queue__collapse {
  display: flex;
  width: 100%;
  min-height: 28px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 32%, var(--ui-border-default));
  border-radius: var(--ui-radius-sm);
  background: color-mix(in srgb, var(--ui-bg-surface) 72%, var(--ui-warning-soft));
  color: var(--ui-warning);
  font: 700 9px var(--ui-font-mono);
  letter-spacing: 0.03em;
  cursor: pointer;
}
.approval-queue__collapse:hover {
  border-color: var(--ui-warning);
  background: var(--ui-warning-soft);
}
.approval-queue__collapse:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 2px;
}
.copilot-chat {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: var(--ui-bg-surface);
}

.workspace-loading {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--ui-bg-canvas);
  color: var(--ui-text-secondary);
}

[data-theme='dark'] .workspace-panel {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 20%, var(--ui-border-default));
  background: color-mix(in srgb, var(--ui-bg-surface) 96%, black);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
[data-theme='dark'] .workspace-commandbar {
  background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
}
[data-theme='dark'] .workspace-explorer,
[data-theme='dark'] .workspace-copilot--collapsed {
  background: color-mix(in srgb, var(--ui-bg-surface-soft) 88%, black);
}
[data-theme='dark'] .editor-surface textarea {
  background: #151821;
}
[data-theme='dark'] .markdown-preview {
  background:
    radial-gradient(
      circle at top,
      color-mix(in srgb, var(--ui-accent-sky) 7%, transparent),
      transparent 44%
    ),
    #10131b;
}
[data-theme='dark'] .markdown-preview__paper {
  border-color: color-mix(in srgb, var(--ui-border-default) 74%, transparent);
  background: #171b25;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.32);
}
[data-theme='dark'] .editor-gutter {
  background: #12151d;
}
[data-theme='dark'] .workspace-agent__avatar,
[data-theme='dark'] .copilot-header__avatar,
[data-theme='dark'] .copilot-rail-avatar {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 50%, var(--ui-border-default));
  color: var(--ui-accent-purple);
  box-shadow: var(--ui-glow-purple);
}

@media (max-width: 1180px) {
  .workspace-context {
    justify-self: stretch;
  }
  .workspace-copilot:not(.workspace-copilot--collapsed) {
    position: absolute;
    z-index: 30;
    top: 56px;
    right: 0;
    bottom: 0;
    width: min(420px, calc(100% - 90px)) !important;
    box-shadow: var(--ui-shadow-panel);
  }
}

@media (max-width: 900px) {
  .workspace-tab {
    padding: 0;
  }
  .workspace-commandbar {
    grid-template-columns: 1fr auto;
    gap: 8px;
  }
  .workspace-context {
    display: none;
  }
  .workspace-agent__status {
    display: none;
  }
  .workspace-explorer:not(.workspace-explorer--collapsed) {
    position: absolute;
    z-index: 31;
    top: 56px;
    bottom: 0;
    left: 0;
    width: min(300px, calc(100% - 60px)) !important;
    box-shadow: 12px 0 34px rgba(0, 0, 0, 0.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-explorer,
  .workspace-copilot,
  .workspace-action {
    transition: none;
  }
}
</style>
