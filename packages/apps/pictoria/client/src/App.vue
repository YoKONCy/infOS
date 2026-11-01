<script setup lang="ts">
import { t as __t } from './i18n'

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './components/PictoriaIcon.vue'
import CanvasCard from './components/CanvasCard.vue'
import CanvasGuides from './components/CanvasGuides.vue'
import CreationBar from './components/CreationBar.vue'
import CreationCard from './components/CreationCard.vue'
import ResourceLibrary from './components/ResourceLibrary.vue'
import CanvasStudio from './components/CanvasStudio.vue'

import ProjectBrowser from './components/ProjectBrowser.vue'
import PictoriaSelect from './components/PictoriaSelect.vue'
import TaskRecovery from './components/TaskRecovery.vue'
import WorkflowEditor from './components/WorkflowEditor.vue'
import ProviderDialog from './components/ProviderDialog.vue'
import ApplicationExitDialog from './components/ApplicationExitDialog.vue'
import { useCanvas } from './composables/useCanvas'
import { useCanvasNavigation } from './composables/useCanvasNavigation'
import { useNodeClipboard } from './composables/useNodeClipboard'
import { curve, outputAnchor, useCanvasLinks } from './composables/useCanvasLinks'
import { useCanvasSearch } from './composables/useCanvasSearch'
import { desktop, pictoria, standalone } from './services/transport'
import { canvasCandidates } from './services/canvasCandidates'
import type { Step, Asset, InputConnection, Prompt } from './types'

const store = useCanvas()
const {
  project,
  agents,
  agentId,
  online,
  steps,
  selected,
  activeItems,
  urls,
  missing,
  loading,
  importing,
  saving,
  dirty,
  error,
  notice,
  history,
  future,
  saveBlocked,
  conflictDraft,
} = store
const surface = ref<HTMLElement | null>(null)
const mode = ref<'canvas' | 'workflow'>('canvas')
const providersOpen = ref(false)
const studioModal = ref(false)
const studioAssistantOpen = ref(false)
const workflowDirty = ref(false)
const workflowEditor = ref<InstanceType<typeof WorkflowEditor> | null>(null)
const exitOpen = ref(false),
  exited = ref(false),
  exitProgress = ref(''),
  exitError = ref('')
const exitBusy = computed(() => Boolean(exitProgress.value))
const navigation = useCanvasNavigation(
  store,
  surface,
  computed(
    () =>
      mode.value === 'canvas' &&
      !providersOpen.value &&
      !studioModal.value &&
      !exitOpen.value &&
      !exited.value,
  ),
)
const { viewport, tool, panActive, dragging, guides, marquee, selectionToolbar } = navigation
let restoringViewport = false
watch(
  () => project.viewport,
  (value) => {
    if (!value) return
    restoringViewport = true
    Object.assign(viewport, value)
    restoringViewport = false
  },
  { deep: true, immediate: true, flush: 'sync' },
)
watch(
  viewport,
  (value) => {
    if (!restoringViewport && !loading.value) project.viewport = { ...value }
  },
  { flush: 'sync' },
)
function restoreView() {
  if (project.viewport) Object.assign(viewport, project.viewport)
  else navigation.fit()
}
const composer = ref<InstanceType<typeof CreationBar> | null>(null)
const studio = ref<InstanceType<typeof CanvasStudio> | null>(null)
const composerLinks = ref<InputConnection[]>([]),
  composerAnchor = ref({ x: 0, y: 0 })
const links = useCanvasLinks(store, navigation.world, (source, port) =>
  composer.value?.acceptConnection(source, port),
)
const { edges, connecting, pendingPath, selectedEdge, arranging } = links
const search = useCanvasSearch(
  store,
  (item) => {
    links.finishArrangement()
    navigation.reveal(item)
  },
  () => mode.value === 'canvas' && !studioModal.value && !exitOpen.value && !exited.value,
)
const {
  open: searchOpen,
  query: searchQuery,
  matches: searchMatches,
  position: searchPosition,
  currentId: searchCurrent,
} = search
const recoveryId = ref('')
watch(
  () => `${agentId.value}:${project.id}`,
  () => {
    recoveryId.value = ''
  },
)
const fileInput = ref<HTMLInputElement | null>(null)
const configInput = ref<HTMLInputElement | null>(null)
const panel = ref<'projects' | 'settings' | null>(null)
const resourcesOpen = ref(false)
const pageHidden = ref(document.hidden)
const submitting = ref(false)
const configBusy = ref(false)
const exitDisabled = computed(
  () =>
    loading.value ||
    importing.value > 0 ||
    submitting.value ||
    links.submitting.value.length > 0 ||
    configBusy.value ||
    store.hierarchyBusy.value,
)
const dropActive = ref(false)
const dimensions = ref({ width: 1200, height: 800 })
const composerPaths = computed(() => {
  const box = surface.value?.getBoundingClientRect()
  if (!box || !dimensions.value.width || !composerAnchor.value.y) return []
  return composerLinks.value.flatMap((connection) => {
    const item = project.items.find((item) => item.id === connection.source)
    if (!item) return []
    const point = outputAnchor(item, connection.sourcePort)
    const from = {
      x: point.x * viewport.scale + viewport.x,
      y: point.y * viewport.scale + viewport.y,
    }
    const to = { x: composerAnchor.value.x - box.left, y: composerAnchor.value.y - box.top }
    return [{ ...connection, path: curve(from, to, connection.sourcePort, 'top') }]
  })
})
const theme = ref<'dark' | 'light'>(
  (localStorage.getItem('pictoria.theme') as 'dark' | 'light') || 'dark',
)
const collectionTitle = computed(
  () =>
    store.collections.value.find((group) => group.id === project.collectionId)?.title ||
    __t('apps.pictoria.ui', '独立画布'),
)
const collectionOptions = computed(() => [
  {
    value: '',
    get label() {
      return __t('apps.pictoria.ui', '独立画布')
    },
  },
  ...store.collections.value.map((group) => ({ value: group.id, label: group.title })),
])
const visible = computed(() => {
  const left = (-viewport.x - 500) / viewport.scale,
    top = (-viewport.y - 500) / viewport.scale
  const right = (dimensions.value.width - viewport.x + 500) / viewport.scale,
    bottom = (dimensions.value.height - viewport.y + 500) / viewport.scale
  return project.items
    .filter(candidateVisible)
    .filter(
      (item) =>
        selected.value.includes(item.id) ||
        item.id === searchCurrent.value ||
        (item.x < right &&
          item.x + item.content.width > left &&
          item.y < bottom &&
          item.y + item.content.height > top),
    )
    .sort((a, b) => Number(b.content.kind === 'group') - Number(a.content.kind === 'group'))
})
const candidateIndex = computed(() => canvasCandidates(project.items, project.edges))
function showCandidates(id: string) {
  selected.value = [id]
  studio.value?.openCandidates()
}
function candidateVisible(item: (typeof project.items)[number]) {
  if (selected.value.includes(item.id) || item.id === searchCurrent.value) return true
  const group = candidateIndex.value.get(item.id)
  if (!group || item.content.kind === 'run' || group.parent.content.candidatesExpanded) return true
  if (project.edges?.some((edge) => edge.source === item.id && !edge.historical)) return true
  return item.id === group.primary?.id
}
const canvasEdges = computed(() => {
  const shown = new Set(project.items.filter(candidateVisible).map((item) => item.id))
  return edges.value.filter((edge) => shown.has(edge.source) && shown.has(edge.target))
})
const saveLabel = computed(() =>
  saving.value
    ? __t('apps.pictoria.ui', '正在保存')
    : dirty.value
      ? online.value
        ? __t('apps.pictoria.ui', '未保存')
        : __t('apps.pictoria.ui', '本地草稿')
      : project.revision
        ? __t('apps.pictoria.ui', '已保存')
        : __t('apps.pictoria.ui', '新画布'),
)
const counts = computed(() => ({
  images: project.items.filter((item) => item.content.mimeType?.startsWith('image/')).length,
  text: project.items.filter((item) => item.content.kind === 'text').length,
}))
watch(
  () => `${online.value}:${visible.value.map((item) => item.content.assetId || '').join('|')}`,
  () => {
    store.loadVisibleMedia(
      visible.value.flatMap((item) => (item.content.assetId ? [item.content.assetId] : [])),
    )
  },
  { flush: 'post' },
)
const layerItems = computed(() => [...project.items].reverse().slice(0, 80))
let observer: ResizeObserver | undefined
let stopTheme: (() => void) | undefined
let disposed = false
let dropDepth = 0
let themeChanging = false
function togglePanel(value: typeof panel.value) {
  resourcesOpen.value = false
  panel.value = panel.value === value ? null : value
}
async function toggleTheme() {
  if (themeChanging) return
  let applied = false
  const apply = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    localStorage.setItem('pictoria.theme', theme.value)
    applied = true
  }
  const transition = document as Document & {
    startViewTransition?: (callback: () => Promise<void>) => { finished: Promise<void> }
  }
  if (
    !transition.startViewTransition ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    apply()
    return
  }
  themeChanging = true
  document.documentElement.dataset.themeTransition = 'true'
  try {
    await transition.startViewTransition(async () => {
      apply()
      await nextTick()
    }).finished
  } catch {
    if (!applied) apply()
  } finally {
    delete document.documentElement.dataset.themeTransition
    themeChanging = false
  }
}
function addNote(text = '') {
  const point = navigation.center()
  store.addText(point.x, point.y, text)
}
function itemPointer(event: PointerEvent, id: string, resize = false) {
  links.finishArrangement()
  selectedEdge.value = ''
  navigation.pointerDown(event, id, resize)
}
function noteEdit() {
  store.checkpoint()
}
function newCanvas(collectionId: string | null = project.collectionId ?? null) {
  links.finishArrangement()
  panel.value = null
  void store
    .newProject(collectionId)
    .then(() => nextTick())
    .then(restoreView)
}
function openCanvas(id: string) {
  links.finishArrangement()
  panel.value = null
  void store
    .openProject(id)
    .then(() => nextTick())
    .then(restoreView)
}
function switchOwner(value: string) {
  if (configBusy.value || store.hierarchyBusy.value) return
  links.finishArrangement()
  void store
    .switchAgent(value)
    .then(() => nextTick())
    .then(restoreView)
}
async function connect() {
  await store.connect(true)
  restoreView()
}
async function importFiles(files: File[], x?: number, y?: number) {
  const point = x === undefined || y === undefined ? navigation.center() : navigation.world(x, y)
  await store.importFiles(files, point)
}
function pickedFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  void importFiles(files)
}
async function drop(event: DragEvent) {
  event.preventDefault()
  dropDepth = 0
  dropActive.value = false
  const value = event.dataTransfer?.getData('application/x-pictoria-resource')
  if (value) {
    const owner = agentId.value,
      canvasId = project.id,
      point = navigation.world(event.clientX, event.clientY)
    try {
      const resource = JSON.parse(value) as {
        owner: string
        kind: string
        id: string
        text?: string
      }
      if (resource.owner !== owner) throw new Error('素材属于其他创作归属')
      if (resource.kind === 'prompt' && typeof resource.text === 'string')
        store.addText(point.x, point.y, resource.text.slice(0, 64000))
      else if (resource.kind === 'asset') {
        const asset = await pictoria.operation<Asset>(owner, 'asset.get', { id: resource.id })
        if (owner !== agentId.value || canvasId !== project.id || disposed) return
        store.checkpoint()
        const item = store.addAsset(asset, point.x, point.y)
        selected.value = [item.id]
      }
      resourcesOpen.value = false
    } catch (e) {
      error.value = e instanceof Error ? e.message : '无法添加资源'
    }
    return
  }
  if (event.dataTransfer?.files.length)
    void importFiles(Array.from(event.dataTransfer.files), event.clientX, event.clientY)
}
function dragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dropDepth++
  dropActive.value = true
}
function dragLeave() {
  dropDepth = Math.max(0, dropDepth - 1)
  if (!dropDepth) dropActive.value = false
}
const clipboard = useNodeClipboard({
  context: () => `${agentId.value}:${project.id}`,
  enabled: () =>
    mode.value === 'canvas' &&
    !providersOpen.value &&
    !studioModal.value &&
    !recoveryId.value &&
    !loading.value &&
    !exitOpen.value &&
    !exited.value,
  snapshot: () => {
    links.finishArrangement()
    return store.copyNodes()
  },
  paste: (value, offset) => {
    links.finishArrangement()
    const point = navigation.center()
    store.pasteNodes(value, { x: point.x + offset, y: point.y + offset })
    error.value = ''
  },
  message: (value) => {
    notice.value = value
    error.value = ''
  },
  error: (value) => {
    error.value = value
  },
})
function paste(event: ClipboardEvent) {
  if (
    event.defaultPrevented ||
    mode.value !== 'canvas' ||
    providersOpen.value ||
    studioModal.value ||
    recoveryId.value ||
    loading.value ||
    exitOpen.value ||
    exited.value
  )
    return
  const target = event.target as HTMLElement | null
  if (
    target?.closest(
      'input,textarea,[contenteditable="true"],[role="dialog"],.creation-dock,.canvas-panel',
    )
  )
    return
  const files = Array.from(event.clipboardData?.files || [])
  if (files.length) {
    event.preventDefault()
    void importFiles(files)
    return
  }
  const text = event.clipboardData?.getData('text/plain')
  if (text?.trim()) {
    event.preventDefault()
    addNote(text.slice(0, 64000))
  }
}
async function create(
  step: Step,
  inputs: Record<string, unknown>,
  key: string,
  connections: InputConnection[] = [],
  uses: import('./types').ReferenceUse[] = [],
) {
  if (submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    const item =
      project.items.find(
        (item) => item.content.kind === 'draft' && item.content.request?.key === key,
      ) || createDraft(step, inputs, connections, uses)
    if (await links.submit(item, key)) composer.value?.acceptNewRequest()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '创作提交失败，请确认任务后再重试'
  } finally {
    submitting.value = false
  }
}
async function downloadSelected() {
  for (const item of activeItems.value) {
    if (!item.content.assetId) continue
    try {
      const url = await store.ensureMedia(item.content.assetId)
      if (!url || disposed) return
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = item.content.name || '作品'
      anchor.click()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '素材下载失败'
    }
  }
}
function createDraft(
  step: Step,
  inputs: Record<string, unknown>,
  connections: InputConnection[] = [],
  uses: import('./types').ReferenceUse[] = [],
) {
  const box = navigation.bounds.value
  const item = links.addDraft(
    step,
    inputs,
    box ? { x: box.x + box.width + 90, y: box.y } : navigation.center(),
    connections,
  )
  item.content.referenceUses = JSON.parse(JSON.stringify(uses))
  return item
}
function previewReference(id: string) {
  if (online.value) void store.ensureThumbnail(id).catch(() => {})
}
function connectInput(source: string, target: string, field: string) {
  try {
    links.connect(source, target, field)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法连接输入'
  }
}
function addLibraryAsset(asset: Asset, edit = false) {
  try {
    store.checkpoint()
    const point = navigation.center()
    const item = store.addAsset(asset, point.x, point.y)
    selected.value = [item.id]
    resourcesOpen.value = false
    if (edit) {
      const step =
        steps.value.find((step) => step.id === 'builtin.image-edit' && step.available) ||
        steps.value.find((step) => step.id === 'builtin.apimodels.image-edit' && step.available)
      if (!step) {
        notice.value = '先在供应商设置中配置图像编辑。'
        panel.value = 'settings'
        return
      }
      createDraft(step, { images: [{ assetId: asset.id }], prompt: '' })
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '添加资源失败'
  }
}
function usePrompt(prompt: Prompt, note: boolean) {
  resourcesOpen.value = false
  if (note) addNote(prompt.text)
  else composer.value?.insertPrompt(prompt.text)
}
function openAssets() {
  resourcesOpen.value = !resourcesOpen.value
  panel.value = null
}
async function refreshSteps() {
  const owner = agentId.value
  try {
    const result = await pictoria.operation<{ steps: Step[] }>(owner, 'catalog.get')
    if (!disposed && owner === agentId.value) steps.value = result.steps
  } catch (e) {
    error.value = e instanceof Error ? e.message : '步骤列表读取失败'
  }
}
function visibility() {
  pageHidden.value = document.hidden
}
async function openWorkflow() {
  links.finishArrangement()
  panel.value = null
  resourcesOpen.value = false
  search.close()
  if ((dirty.value || !project.revision) && !(await store.save())) return
  mode.value = 'workflow'
}
/** 首版允许导入作者编写的服务和步骤配置，工作流编辑器另行接入。 */
async function importConfiguration(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0]
  input.value = ''
  if (!file || !online.value) return
  if (file.size > 1024 * 1024) {
    error.value = '配置文件不能超过 1 MB'
    return
  }
  configBusy.value = true
  error.value = ''
  const owner = agentId.value
  try {
    const bundle = JSON.parse(await file.text()) as {
      services?: Record<string, unknown>[]
      steps?: Record<string, unknown>[]
    }
    if (!bundle || (!Array.isArray(bundle.services) && !Array.isArray(bundle.steps)))
      throw new Error('配置需要包含 services 或 steps 列表')
    if (
      (bundle.services !== undefined && !Array.isArray(bundle.services)) ||
      (bundle.steps !== undefined && !Array.isArray(bundle.steps))
    )
      throw new Error('services 和 steps 必须是列表')
    for (const [kind, definitions] of [
      ['service', bundle.services || []],
      ['step', bundle.steps || []],
    ] as const) {
      if (definitions.length > 100) throw new Error('单次配置最多 100 项')
      const existing = await pictoria.operation<Array<{ id: string; revision: number }>>(
        owner,
        `${kind}.list`,
      )
      for (const definition of definitions) {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition))
          throw new Error('步骤或服务定义格式无效')
        const {
          revision: _revision,
          available: _available,
          reason: _reason,
          hasCredential: _credential,
          modelName: _modelName,
          ...clean
        } = definition
        const old = existing.find((item) => item.id === clean.id)
        await pictoria.operation(owner, `${kind}.save`, {
          definition: clean,
          expectedRevision: old?.revision ?? 0,
        })
      }
    }
    steps.value = (await pictoria.operation<{ steps: Step[] }>(owner, 'catalog.get')).steps
    notice.value = '创作步骤已更新。'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '配置导入失败'
  } finally {
    configBusy.value = false
  }
}
function openExit() {
  if (exitDisabled.value || exited.value) return
  links.finishArrangement()
  exitError.value = ''
  exitOpen.value = true
}
async function closeExitedPage() {
  if (!exited.value) return
  try {
    if (desktop?.embedded) {
      desktop.send?.('desktop-tabs:unsaved-changes', false)
      await desktop.invoke('window-close')
    } else if (window.opener) window.close()
  } catch {
    if (!disposed) exitError.value = '后台已退出，请关闭当前标签页'
  }
}
async function exitPictoria() {
  if (!exitOpen.value || exitBusy.value || exited.value) return
  exitError.value = ''
  exitProgress.value = '正在保存…'
  try {
    if (exitDisabled.value) throw new Error('请等待当前操作完成后再退出')
    links.finishArrangement()
    store.setPaused(true)
    await workflowEditor.value?.prepareExit()
    if (!(await store.flushForExit()))
      throw new Error(error.value || '画布尚未保存，请处理后再退出')
    exitProgress.value = '正在退出…'
    store.status.value = await pictoria.stop()
    exited.value = true
    exitOpen.value = false
    desktop?.send?.('desktop-tabs:unsaved-changes', false)
  } catch (failure) {
    if (!disposed) {
      exitError.value = failure instanceof Error ? failure.message : '退出失败，请稍后重试'
      store.setPaused(false)
      workflowEditor.value?.resumeAfterExitFailure()
    }
  } finally {
    exitProgress.value = ''
  }
  if (exited.value) {
    await nextTick()
    await closeExitedPage()
  }
}
function guardUnload(event: BeforeUnloadEvent) {
  store.persistDraft()
  if (!exited.value && (dirty.value || importing.value || workflowDirty.value)) {
    event.preventDefault()
    event.returnValue = ''
  }
}
watch([dirty, workflowDirty, exited], () =>
  desktop?.send?.(
    'desktop-tabs:unsaved-changes',
    !exited.value && (dirty.value || workflowDirty.value),
  ),
)
function escape(event: KeyboardEvent) {
  if (!exitOpen.value && !exited.value && event.key === 'Escape') {
    panel.value = null
    resourcesOpen.value = false
  }
}
watch(
  theme,
  (value) => {
    document.documentElement.dataset.theme = value
  },
  { immediate: true },
)
onMounted(async () => {
  observer = new ResizeObserver(([entry]) => {
    if (entry)
      dimensions.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  if (surface.value) observer.observe(surface.value)
  restoreView()
  window.addEventListener('paste', paste)
  window.addEventListener('beforeunload', guardUnload)
  window.addEventListener('keydown', escape)
  document.addEventListener('visibilitychange', visibility)
  if (desktop?.embedded && !localStorage.getItem('pictoria.theme')) {
    const receive = (value: unknown) => {
      if (!localStorage.getItem('pictoria.theme') && (value === 'dark' || value === 'light'))
        theme.value = value
    }
    stopTheme = desktop.on?.('desktop-shell:theme-changed', receive)
    void desktop
      .invoke('desktop-tabs:get-theme')
      .then((value) => {
        if (!disposed) receive(value)
      })
      .catch(() => {})
  }
  await store.connect()
  if (!disposed) restoreView()
})
onBeforeUnmount(() => {
  disposed = true
  observer?.disconnect()
  stopTheme?.()
  document.removeEventListener('visibilitychange', visibility)
  window.removeEventListener('paste', paste)
  window.removeEventListener('beforeunload', guardUnload)
  window.removeEventListener('keydown', escape)
})
</script>

<template>
  <main
    v-show="mode === 'canvas'"
    ref="surface"
    :inert="exitOpen || exited"
    class="pictoria-canvas"
    :class="{
      'is-panning': panActive,
      'is-box-selecting': navigation.boxActive.value,
      'is-dragging': dragging,
      'is-dropping': dropActive,
      'is-connecting': connecting,
      'is-arranging': arranging,
      'is-background': pageHidden,
      'studio-assistant-open': studioAssistantOpen,
    }"
    :style="{
      '--grid-size': `${24 * viewport.scale}px`,
      '--grid-x': `${viewport.x}px`,
      '--grid-y': `${viewport.y}px`,
    }"
    @pointerdown.capture="navigation.capturePointerDown"
    @dblclick.capture="navigation.captureDoubleClick"
    @pointerdown="navigation.pointerDown($event)"
    @pointermove="navigation.pointerMove"
    @pointerup="navigation.pointerUp"
    @pointercancel="navigation.pointerUp"
    @wheel="navigation.wheel"
    @dragover.prevent
    @dragenter="dragEnter"
    @dragleave="dragLeave"
    @drop="drop"
    @contextmenu.prevent
  >
    <div class="canvas-ambience" aria-hidden="true" />
    <header class="canvas-header" data-ui>
      <div class="header-left">
        <a
          class="pictoria-brand"
          href="#"
          :aria-label="__t('apps.pictoria.ui', 'Pictoria 画布')"
          @click.prevent="navigation.fit()"
        >
          <svg viewBox="0 0 32 32" width="29" height="29" fill="none" aria-hidden="true">
            <path
              d="M7 25V7h10c6 0 9 3 9 8s-3 8-9 8h-4V13h4c2 0 3 1 3 2.5S19 18 17 18"
              stroke="currentColor"
              stroke-width="3.2"
              stroke-linejoin="round"
            />
            <path d="m25 2 .8 2.2L28 5l-2.2.8L25 8l-.8-2.2L22 5l2.2-.8Z" fill="var(--accent)" />
          </svg>
          <span>Pictoria</span>
        </a>
        <i class="header-divider" />
        <button class="project-switcher" @click="togglePanel('projects')">
          <Icon name="folder" :size="16" />
          <span class="project-parent-name">{{ collectionTitle }}</span>
          <i class="breadcrumb-divider">/</i>
          <span>{{ project.title }}</span>
          <Icon name="down" :size="13" />
        </button>
        <span class="save-status" :class="{ 'has-draft': dirty }">
          <span class="status-dot" />
          {{ saveLabel }}
        </span>
      </div>
      <div class="header-actions">
        <span class="quiet-button canvas-mode">
          <Icon name="grid" :size="15" />
          {{ __t('apps.pictoria.ui', '画布') }}
        </span>
        <button
          class="quiet-button"
          :disabled="loading || saving || submitting"
          @click="openWorkflow"
        >
          <Icon name="workflow" :size="16" />
          {{ __t('apps.pictoria.ui', '工作流') }}
        </button>
        <i class="header-divider" />
        <button
          class="quiet-button"
          :disabled="!project.items.length || arranging"
          :title="
            selected.length
              ? __t('apps.pictoria.ui', '整理选中内容')
              : __t('apps.pictoria.ui', '整理整个画布')
          "
          @click="links.organize()"
        >
          <Icon name="arrange" :size="16" />
          <span>{{ __t('apps.pictoria.ui', '整理') }}</span>
        </button>
        <button
          class="icon-button"
          :aria-label="
            theme === 'dark'
              ? __t('apps.pictoria.ui', '切换浅色')
              : __t('apps.pictoria.ui', '切换暗色')
          "
          @click="toggleTheme"
        >
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="18" />
        </button>
        <button class="quiet-button" @click="openAssets">
          <Icon name="layers" :size="17" />
          <span>{{ __t('apps.pictoria.ui', '资源库') }}</span>
        </button>
        <button class="quiet-button" @click="providersOpen = true">
          <Icon name="link" :size="17" />
          <span>{{ __t('apps.pictoria.ui', '供应商') }}</span>
        </button>
        <button
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '画布设置')"
          @click="togglePanel('settings')"
        >
          <Icon name="settings" :size="18" />
        </button>
        <i class="header-divider" />
        <button
          class="icon-button danger-button"
          :disabled="exitDisabled"
          :title="__t('apps.pictoria.ui', '退出 Pictoria')"
          :aria-label="__t('apps.pictoria.ui', '退出 Pictoria')"
          @click="openExit"
        >
          <Icon name="power" :size="18" />
        </button>
      </div>
    </header>

    <Transition name="float">
      <section
        v-if="error || notice || conflictDraft"
        class="canvas-notice"
        :class="{ 'notice-error': error }"
        data-ui
        role="status"
      >
        <span>{{ error || notice || __t('apps.pictoria.ui', '此画布有待恢复的本地草稿。') }}</span>
        <button v-if="conflictDraft" class="text-button" @click="store.recoverConflict">
          {{ __t('apps.pictoria.ui', '恢复为新画布') }}
        </button>
        <button v-if="saveBlocked" class="text-button" @click="store.retrySave">
          {{ __t('apps.pictoria.ui', '重试保存') }}
        </button>
        <button v-if="saveBlocked" class="text-button" @click="store.saveAsCopy">
          {{ __t('apps.pictoria.ui', '另存副本') }}
        </button>
        <button v-if="saveBlocked" class="text-button" @click="store.exportDraft">
          {{ __t('apps.pictoria.ui', '导出草稿') }}
        </button>
        <button
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '关闭提示')"
          @click="
            () => {
              error = ''
              notice = ''
            }
          "
        >
          <Icon name="close" :size="15" />
        </button>
      </section>
    </Transition>

    <Transition name="fade">
      <div v-if="!project.items.length" class="canvas-welcome" data-ui>
        <svg
          class="welcome-art"
          width="200"
          height="154"
          viewBox="0 0 200 154"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="29"
            y="37"
            width="100"
            height="88"
            rx="12"
            transform="rotate(-11 29 37)"
            fill="var(--welcome-fill)"
            stroke="var(--line)"
          />
          <rect
            x="69"
            y="21"
            width="100"
            height="88"
            rx="12"
            transform="rotate(10 69 21)"
            fill="var(--panel)"
            stroke="var(--line-bright)"
          />
          <path
            d="m85 84 20-20 15 17 10-9 22 25"
            stroke="var(--muted)"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <circle cx="134" cy="49" r="6" fill="var(--accent)" opacity=".65" />
          <path
            d="m39 24 2-6 2 6 6 2-6 2-2 6-2-6-6-2Zm130 98 2-5 2 5 5 2-5 2-2 5-2-5-5-2Z"
            fill="var(--accent)"
          />
          <path
            d="M27 125c-10 5-10 14 4 16m131-128c15-1 22 7 19 16"
            stroke="var(--muted)"
            stroke-dasharray="3 5"
          />
        </svg>
        <h1>{{ __t('apps.pictoria.ui', '开始创作') }}</h1>
        <div class="welcome-actions">
          <button class="welcome-primary" @click="fileInput?.click()">
            <Icon name="upload" :size="17" />
            {{ __t('apps.pictoria.ui', '导入素材') }}
          </button>
          <button class="welcome-secondary" @click="addNote()">
            <Icon name="note" :size="17" />
            {{ __t('apps.pictoria.ui', '便签') }}
          </button>
        </div>
      </div>
    </Transition>

    <div
      class="canvas-world"
      :style="{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }"
    >
      <svg
        class="canvas-connections"
        width="1"
        height="1"
        :aria-label="__t('apps.pictoria.ui', '创作引用关系')"
      >
        <g
          v-for="edge in canvasEdges"
          :key="edge.id"
          :class="{ historical: edge.historical, active: selectedEdge === edge.id }"
        >
          <path
            class="edge-hit"
            :d="edge.path"
            data-ui
            @pointerdown.stop="
              () => {
                selectedEdge = edge.id
                selected = []
              }
            "
          />
          <path class="edge-stroke" :d="edge.path" />
          <title>
            {{
              edge.historical
                ? __t('apps.pictoria.ui', '实际创作来源')
                : __t('apps.pictoria.ui', '输入引用：{0}', [edge.field])
            }}
          </title>
        </g>
        <path v-if="connecting" class="edge-pending" :d="pendingPath" />
      </svg>
      <template v-for="item in visible" :key="item.id">
        <article
          v-if="item.content.kind === 'group'"
          class="studio-group"
          :class="{ selected: selected.includes(item.id) }"
          :style="{
            width: `${item.content.width}px`,
            height: `${item.content.height}px`,
            transform: `translate(${item.x}px, ${item.y}px)`,
          }"
        >
          <header :data-canvas-item="item.id" @pointerdown.stop="itemPointer($event, item.id)">
            <span>{{ item.content.name }}</span>
            <small>
              {{ project.items.filter((child) => child.content.groupId === item.id).length }}
            </small>
          </header>
        </article>
        <CreationCard
          v-else-if="item.content.kind === 'draft'"
          :owner="agentId"
          :item="item"
          :items="project.items"
          :edges="project.edges || []"
          :thumbnails="store.thumbnails"
          :class="{
            'search-match': search.ids.value.has(item.id),
            'search-current': searchCurrent === item.id,
          }"
          :model-name="
            steps.find(
              (step) =>
                step.id === item.content.step?.id && step.revision === item.content.step?.revision,
            )?.modelName
          "
          :selected="selected.includes(item.id)"
          :busy="links.submitting.value.includes(item.id)"
          :online="online"
          :outdated="
            !steps.some(
              (step) =>
                step.id === item.content.step?.id &&
                step.revision === item.content.step?.revision &&
                step.available,
            )
          "
          @pointer="itemPointer($event, item.id)"
          @checkpoint="store.checkpoint"
          @submit="links.submit(item)"
          @content="Object.assign(item.content, $event)"
          @refresh="links.refreshDraft(item)"
          @disconnect="links.disconnect"
          @preview="previewReference"
          @remove-reference="(field, id) => links.removeReference(item, field, id)"
          @reorder-reference="
            (field, id, direction) => links.reorderReference(item, field, id, direction)
          "
          @connect="(source, field) => connectInput(source, item.id, field)"
        />
        <CanvasCard
          v-else
          :item="item"
          :selected="selected.includes(item.id)"
          :candidate-count="candidateIndex.get(item.id)?.items.length"
          :class="{
            'search-match': search.ids.value.has(item.id),
            'search-current': searchCurrent === item.id,
          }"
          :url="item.content.assetId ? urls[item.content.assetId] : undefined"
          :missing="item.content.assetId ? missing[item.content.assetId] : false"
          @pointer="itemPointer($event, item.id)"
          @resize="itemPointer($event, item.id, true)"
          @edit="noteEdit"
          @candidates="showCandidates(item.id)"
          @text="item.content.text = $event"
          @comment="item.content.comment = $event"
          @recover="recoveryId = item.content.runId || ''"
          @cancel="item.content.runId && store.cancelRun(item.content.runId)"
          @connect="(event, port) => links.begin(event, item.id, port)"
        />
      </template>
      <div
        v-if="marquee"
        class="selection-marquee"
        :style="{
          width: `${marquee.width}px`,
          height: `${marquee.height}px`,
          transform: `translate(${marquee.x}px, ${marquee.y}px)`,
        }"
      />
    </div>
    <CanvasGuides :guides="guides" :viewport="viewport" />
    <CanvasStudio
      ref="studio"
      :store="store"
      :links="links"
      :viewport="viewport"
      :size="dimensions"
      @modal="studioModal = $event"
      @assistant="studioAssistantOpen = $event"
      @providers="providersOpen = true"
      @navigate="
        (x, y) => {
          viewport.x = dimensions.width / 2 - x * viewport.scale
          viewport.y = dimensions.height / 2 - y * viewport.scale
        }
      "
    />

    <nav
      class="canvas-toolrail floating-panel"
      data-ui
      :aria-label="__t('apps.pictoria.ui', '画布工具')"
    >
      <button
        class="icon-button"
        :class="{ active: tool === 'free' }"
        :title="__t('apps.pictoria.ui', '自由操作 · A；拖动时 Alt 暂停吸附，Ctrl 对齐网格')"
        :aria-label="__t('apps.pictoria.ui', '自由操作')"
        @click="tool = 'free'"
      >
        <Icon name="arrow" />
      </button>
      <button
        class="icon-button"
        :class="{ active: tool === 'select' }"
        :title="__t('apps.pictoria.ui', '框选 · V / Shift＋左键')"
        :aria-label="__t('apps.pictoria.ui', '框选')"
        @click="tool = 'select'"
      >
        <Icon name="select" />
      </button>
      <button
        class="icon-button"
        :class="{ active: tool === 'hand' }"
        :title="__t('apps.pictoria.ui', '拖动画布 · H / 空格 / 中键')"
        :aria-label="__t('apps.pictoria.ui', '拖动画布')"
        @click="tool = 'hand'"
      >
        <Icon name="hand" />
      </button>
      <span class="rail-divider" />
      <button
        class="icon-button"
        :class="{ active: searchOpen }"
        :title="__t('apps.pictoria.ui', '搜索节点 · Ctrl F')"
        :aria-label="__t('apps.pictoria.ui', '搜索节点')"
        @click="searchOpen ? search.close() : search.show()"
      >
        <Icon name="search" :size="18" />
      </button>
      <button
        class="icon-button"
        :title="__t('apps.pictoria.ui', '导入素材')"
        :aria-label="__t('apps.pictoria.ui', '导入素材')"
        @click="fileInput?.click()"
      >
        <Icon name="plus" :size="23" />
      </button>
      <button
        class="icon-button"
        :title="__t('apps.pictoria.ui', '文字便签 · N')"
        :aria-label="__t('apps.pictoria.ui', '添加便签')"
        @click="addNote()"
      >
        <Icon name="note" />
      </button>
      <span class="rail-divider" />
      <button
        class="icon-button"
        :title="__t('apps.pictoria.ui', '粘贴 · Ctrl V')"
        :aria-label="__t('apps.pictoria.ui', '粘贴节点')"
        @click="clipboard.paste"
      >
        <Icon name="paste" :size="18" />
      </button>
      <button
        class="icon-button"
        :title="__t('apps.pictoria.ui', '撤销 · Ctrl Z')"
        :aria-label="__t('apps.pictoria.ui', '撤销')"
        :disabled="!history.length"
        @click="store.undo"
      >
        <Icon name="undo" :size="18" />
      </button>
      <button
        class="icon-button"
        :title="__t('apps.pictoria.ui', '重做 · Ctrl Shift Z')"
        :aria-label="__t('apps.pictoria.ui', '重做')"
        :disabled="!future.length"
        @click="store.redo"
      >
        <Icon name="redo" :size="18" />
      </button>
    </nav>
    <Transition name="float">
      <section
        v-if="searchOpen"
        class="canvas-search-panel floating-panel"
        data-ui
        @keydown.esc.stop="search.close()"
      >
        <div class="canvas-search-field">
          <Icon name="search" :size="15" />
          <input
            v-model="searchQuery"
            class="canvas-search-input"
            maxlength="200"
            :placeholder="__t('apps.pictoria.ui', '备注 / 提示词')"
            :aria-label="__t('apps.pictoria.ui', '搜索备注或提示词')"
            @keydown.enter.prevent.stop="search.jump($event.shiftKey ? -1 : 1)"
          />
          <button
            class="icon-button"
            :aria-label="__t('apps.pictoria.ui', '关闭搜索')"
            @click="search.close()"
          >
            <Icon name="close" :size="14" />
          </button>
        </div>
        <footer v-if="searchQuery.trim()">
          <small>
            {{
              searchMatches.length
                ? `${searchPosition} / ${searchMatches.length}`
                : __t('apps.pictoria.ui', '无匹配')
            }}
          </small>
          <button
            class="icon-button"
            :disabled="!searchMatches.length"
            :title="__t('apps.pictoria.ui', '上一个 · Shift F3')"
            :aria-label="__t('apps.pictoria.ui', '上一个匹配')"
            @click="search.jump(-1)"
          >
            <Icon class="search-previous" name="down" :size="15" />
          </button>
          <button
            class="icon-button"
            :disabled="!searchMatches.length"
            :title="__t('apps.pictoria.ui', '下一个 · F3')"
            :aria-label="__t('apps.pictoria.ui', '下一个匹配')"
            @click="search.jump(1)"
          >
            <Icon name="down" :size="15" />
          </button>
        </footer>
      </section>
    </Transition>
    <Transition name="float">
      <div v-if="selectedEdge" class="connection-actions floating-panel" data-ui>
        <Icon name="link" :size="15" />
        <span>
          {{
            edges.find((edge) => edge.id === selectedEdge)?.historical
              ? __t('apps.pictoria.ui', '实际创作来源')
              : __t('apps.pictoria.ui', '输入引用')
          }}
        </span>
        <button
          v-if="!edges.find((edge) => edge.id === selectedEdge)?.historical"
          class="text-button"
          @click="links.disconnect(selectedEdge)"
        >
          {{ __t('apps.pictoria.ui', '断开连线') }}
        </button>
        <button
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '取消选择连线')"
          @click="selectedEdge = ''"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>
    </Transition>

    <Transition name="float">
      <div
        v-if="selected.length && !dragging"
        class="selection-actions floating-panel"
        :style="selectionToolbar"
        data-ui
      >
        <button class="quiet-button" @click="composer?.focus()">
          <Icon name="sparkle" :size="16" />
          {{ __t('apps.pictoria.ui', '下一步') }}
        </button>
        <i class="header-divider" />
        <button
          v-if="activeItems.length === 1 && activeItems[0]?.content.mimeType?.startsWith('video/')"
          class="quiet-button"
          :disabled="studio?.busy"
          @click="studio?.openVideo()"
        >
          <Icon name="play" :size="16" />
          {{ __t('apps.pictoria.video', '接着生成') }}
        </button>
        <button
          v-if="activeItems.length === 1 && activeItems[0]?.content.mimeType?.startsWith('image/')"
          class="icon-button"
          :disabled="studio?.busy"
          :aria-label="__t('apps.pictoria.studio', '图像工作室')"
          :title="__t('apps.pictoria.studio', '图像工作室')"
          @click="studio?.openImage()"
        >
          <Icon name="crop" :size="17" />
        </button>
        <button
          class="icon-button"
          :disabled="studio?.busy"
          :aria-label="
            __t(
              'apps.pictoria.studio',
              activeItems.length === 1 && activeItems[0]?.content.kind === 'group'
                ? '解散分组'
                : '编组',
            )
          "
          :title="
            __t(
              'apps.pictoria.studio',
              activeItems.length === 1 && activeItems[0]?.content.kind === 'group'
                ? '解散分组'
                : '编组',
            )
          "
          @click="
            activeItems.length === 1 && activeItems[0]?.content.kind === 'group'
              ? studio?.ungroup()
              : studio?.group()
          "
        >
          <Icon
            :name="
              activeItems.length === 1 && activeItems[0]?.content.kind === 'group'
                ? 'ungroup'
                : 'group'
            "
            :size="17"
          />
        </button>
        <button
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '复制选中内容')"
          :title="__t('apps.pictoria.ui', '复制 · Ctrl C')"
          @click="clipboard.copy"
        >
          <Icon name="copy" :size="17" />
        </button>
        <button
          v-if="activeItems.some((item) => item.content.assetId)"
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '下载选中素材')"
          @click="downloadSelected"
        >
          <Icon name="download" :size="17" />
        </button>
        <button
          class="icon-button danger-button"
          :aria-label="__t('apps.pictoria.ui', '删除选中内容')"
          @click="store.removeSelection"
        >
          <Icon name="trash" :size="17" />
        </button>
      </div>
    </Transition>

    <svg class="composer-connections" aria-hidden="true">
      <path
        v-for="connection in composerPaths"
        :key="`${connection.field}:${connection.source}`"
        class="composer-edge"
        :d="connection.path"
      />
    </svg>
    <CreationBar
      ref="composer"
      v-model:creation="project.creation"
      :owner="agentId"
      :steps="steps"
      :selected="activeItems"
      :items="project.items"
      :thumbnails="store.thumbnails"
      :context-key="`${agentId}:${project.id}`"
      :busy="submitting"
      :online="online"
      @run="create"
      @draft="createDraft"
      @note="addNote"
      @upload="fileInput?.click()"
      @clear="selected = []"
      @configure="panel = 'settings'"
      @preview="previewReference"
      @connections="composerLinks = $event"
      @anchor="composerAnchor = $event"
    />
    <Transition name="float">
      <ResourceLibrary
        v-if="resourcesOpen"
        :store="store"
        @close="resourcesOpen = false"
        @asset="addLibraryAsset"
        @prompt="usePrompt"
        @upload="
          () => {
            resourcesOpen = false
            fileInput?.click()
          }
        "
      />
    </Transition>
    <Transition name="fade">
      <TaskRecovery
        v-if="recoveryId"
        :store="store"
        :run-id="recoveryId"
        @close="recoveryId = ''"
      />
    </Transition>

    <div class="canvas-bottom-left" data-ui>
      <span class="connection-indicator" :class="{ connected: online }">
        <span class="status-dot" />
        {{
          online ? __t('apps.pictoria.ui', '创作后台已连接') : __t('apps.pictoria.ui', '本地画布')
        }}
      </span>
      <button v-if="!online" class="text-button" :disabled="loading" @click="connect">
        {{ loading ? __t('apps.pictoria.ui', '连接中…') : __t('apps.pictoria.ui', '连接后台') }}
      </button>
      <small>
        {{ project.items.length }} {{ __t('apps.pictoria.ui', '项内容') }}
        <span v-if="counts.images">
          · {{ counts.images }} {{ __t('apps.pictoria.ui', '张图片') }}
        </span>
      </small>
    </div>
    <div class="canvas-zoom floating-panel" data-ui>
      <button
        class="icon-button"
        :aria-label="__t('apps.pictoria.ui', '缩小')"
        @click="navigation.zoom(viewport.scale / 1.2)"
      >
        <Icon name="minus" :size="16" />
      </button>
      <button
        class="zoom-percent"
        :title="__t('apps.pictoria.ui', '还原 100%')"
        @click="navigation.zoom(1)"
      >
        {{ Math.round(viewport.scale * 100) }}%
      </button>
      <button
        class="icon-button"
        :aria-label="__t('apps.pictoria.ui', '放大')"
        @click="navigation.zoom(viewport.scale * 1.2)"
      >
        <Icon name="plus" :size="16" />
      </button>
      <i class="header-divider" />
      <button
        class="icon-button"
        :aria-label="__t('apps.pictoria.ui', '适应画布')"
        :title="__t('apps.pictoria.ui', '适应全部内容 · 0')"
        @click="navigation.fit()"
      >
        <Icon name="fit" :size="17" />
      </button>
    </div>

    <Transition name="float">
      <ProjectBrowser
        v-if="panel === 'projects'"
        :store="store"
        @open="openCanvas"
        @create="newCanvas"
        @close="panel = null"
      />
    </Transition>
    <Transition name="float">
      <section
        v-if="panel === 'settings'"
        class="canvas-panel panel-settings floating-panel"
        data-ui
      >
        <header>
          <strong>{{ __t('apps.pictoria.ui', '画布设置') }}</strong>
          <button
            class="icon-button"
            :aria-label="__t('apps.pictoria.ui', '关闭面板')"
            @click="panel = null"
          >
            <Icon name="close" :size="17" />
          </button>
        </header>
        <label class="panel-field">
          {{ __t('apps.pictoria.ui', '画布名称') }}
          <input v-model="project.title" maxlength="120" @focus="store.checkpoint" />
        </label>
        <div class="panel-field">
          <span>{{ __t('apps.pictoria.ui', '所属项目') }}</span>
          <PictoriaSelect
            :model-value="project.collectionId || ''"
            :options="collectionOptions"
            :disabled="loading || saving || store.hierarchyBusy.value"
            :label="__t('apps.pictoria.ui', '所属项目')"
            @update:model-value="store.moveToCollection(project.id, $event || null)"
          />
        </div>
        <div class="panel-field">
          <span>{{ __t('apps.pictoria.ui', '角色') }}</span>
          <PictoriaSelect
            :model-value="agentId"
            :disabled="
              loading ||
              saving ||
              importing > 0 ||
              submitting ||
              links.submitting.value.length > 0 ||
              configBusy ||
              store.hierarchyBusy.value
            "
            :options="agents.map((agent) => ({ value: agent.id, label: agent.name }))"
            :label="__t('apps.pictoria.ui', '角色')"
            @update:model-value="switchOwner"
          />
        </div>
        <button class="quiet-button outlined" @click="providersOpen = true">
          <Icon name="link" :size="16" />
          {{ __t('apps.pictoria.ui', '模型供应商') }}
        </button>
        <div class="settings-section">
          <button
            class="quiet-button outlined"
            :disabled="!online || configBusy"
            @click="configInput?.click()"
          >
            <Icon name="upload" :size="15" />
            {{
              configBusy ? __t('apps.pictoria.ui', '导入中…') : __t('apps.pictoria.ui', '导入步骤')
            }}
          </button>
          <button class="quiet-button outlined" @click="store.exportDraft">
            <Icon name="download" :size="15" />
            {{ __t('apps.pictoria.ui', '导出画布') }}
          </button>
        </div>
        <details class="settings-section keyboard-help">
          <summary>{{ __t('apps.pictoria.ui', '快捷键') }}</summary>
          <span>
            <kbd>{{ __t('apps.pictoria.ui', '空格 / 中键 + 拖动') }}</kbd>
            {{ __t('apps.pictoria.ui', '平移视野') }}
          </span>
          <span>
            <kbd>{{ __t('apps.pictoria.ui', 'Ctrl + 滚轮') }}</kbd>
            {{ __t('apps.pictoria.ui', '缩放') }}
          </span>
          <span>
            <kbd>{{ __t('apps.pictoria.ui', 'Shift + 单击') }}</kbd>
            {{ __t('apps.pictoria.ui', '多选') }}
          </span>
          <span>
            <kbd>{{ __t('apps.pictoria.ui', 'Shift + 左键拖动') }}</kbd>
            {{ __t('apps.pictoria.ui', '追加框选') }}
          </span>
          <span>
            <kbd>Ctrl + D</kbd>
            {{ __t('apps.pictoria.ui', '复制') }}
          </span>
          <span>
            <kbd>0</kbd>
            {{ __t('apps.pictoria.ui', '适应全部') }}
          </span>
        </details>
        <div v-if="layerItems.length" class="settings-section">
          <strong>{{ __t('apps.pictoria.ui', '画布内容') }}</strong>
          <button
            v-for="item in layerItems"
            :key="item.id"
            class="layer-row"
            :class="{ active: selected.includes(item.id) }"
            @click="
              () => {
                selected = [item.id]
                navigation.fit(true)
              }
            "
          >
            <Icon
              :name="
                item.content.kind === 'text'
                  ? 'note'
                  : item.content.kind === 'draft'
                    ? 'sparkle'
                    : 'image'
              "
              :size="14"
            />
            <span>
              {{
                item.content.name ||
                item.content.text?.slice(0, 20) ||
                __t('apps.pictoria.ui', '画布内容')
              }}
            </span>
          </button>
        </div>
      </section>
    </Transition>

    <Transition name="fade">
      <div v-if="dropActive" class="canvas-dropzone">
        <div>
          <Icon name="upload" :size="34" />
          <strong>{{ __t('apps.pictoria.ui', '释放以导入') }}</strong>
          <span>{{ __t('apps.pictoria.ui', '每份最多 20 MB') }}</span>
        </div>
      </div>
    </Transition>
    <Transition name="float">
      <div v-if="importing" class="import-indicator floating-panel" data-ui>
        <Icon name="refresh" :size="16" />
        <span>{{ __t('apps.pictoria.ui', '正在导入素材…') }}</span>
      </div>
    </Transition>
    <input
      ref="fileInput"
      type="file"
      class="visually-hidden"
      accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg"
      multiple
      @change="pickedFiles"
    />
    <input
      ref="configInput"
      type="file"
      class="visually-hidden"
      accept="application/json,.json"
      @change="importConfiguration"
    />
  </main>
  <Transition name="fade">
    <ProviderDialog
      v-if="providersOpen"
      :agent-id="agentId"
      :online="online"
      @close="providersOpen = false"
      @updated="
        () => {
          refreshSteps()
          studio?.refreshProviders()
        }
      "
    />
  </Transition>
  <WorkflowEditor
    v-if="mode === 'workflow'"
    ref="workflowEditor"
    :canvas="store"
    :theme="theme"
    :suspended="exitOpen || exited"
    :exit-disabled="exitDisabled"
    @quit="openExit"
    @dirty="workflowDirty = $event"
    @close="
      () => {
        mode = 'canvas'
        refreshSteps()
      }
    "
    @theme="toggleTheme"
    @published="refreshSteps"
  />
  <Transition name="application-exit">
    <ApplicationExitDialog
      v-if="exitOpen || exited"
      :busy="exitBusy"
      :progress="exitProgress"
      :error="exitError"
      :exited="exited"
      :embedded="Boolean(desktop?.embedded)"
      :hosted="!standalone"
      @cancel="exitOpen = false"
      @confirm="exitPictoria"
      @close-page="closeExitedPage"
    />
  </Transition>
</template>
