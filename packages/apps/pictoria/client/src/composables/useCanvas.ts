import { t as __t } from '../i18n'
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { desktop, fileBase64, pictoria, standalone } from '../services/transport'
import { normalizeCreationPreferences } from '../services/creationPreferences'
import { descendants } from '../../../src/canvasDocument'
import type { Asset, CanvasCollection, CanvasItem, HostStatus, Project, Run, Step } from '../types'
import {
  assertClipboardOwner,
  clipboardContext,
  cloneNodes,
  type NodeClipboard,
} from '../services/nodeClipboard'

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled'])
const allowed = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
])
const uid = () => crypto.randomUUID()
function assetIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if ('assetId' in value && typeof value.assetId === 'string') return [value.assetId]
  return [...new Set(Object.values(value).flatMap(assetIds))]
}

export function useCanvas() {
  // 空画布名称跟随语言切换；加载、重命名与撤销仍须能够写入标题。
  const projectTitle = ref<string | null>(null)
  const project = reactive<Project>({
    id: uid(),
    get title() {
      return projectTitle.value ?? __t('apps.pictoria.ui', '未命名画布')
    },
    set title(value: string) {
      projectTitle.value = value === __t('apps.pictoria.ui', '未命名画布') ? null : value
    },
    revision: 0,
    items: [],
    creation: normalizeCreationPreferences(undefined),
  })
  const agents = ref<Array<{ id: string; name: string }>>([])
  const agentId = ref(
    standalone
      ? 'local'
      : new URLSearchParams(window.location.search).get('agentId') ||
          localStorage.getItem('pictoria.agent') ||
          '',
  )
  const status = ref<HostStatus>()
  const online = computed(() => status.value?.federation.state === 'connected')
  const projects = ref<Project[]>([])
  const collections = ref<CanvasCollection[]>([])
  const hierarchyBusy = ref(false)
  const removedCollections = new Set<string>()
  const steps = ref<Step[]>([])
  const library = ref<Asset[]>([])
  const selected = ref<string[]>([])
  const activeItems = computed(() => {
    const items = new Map(project.items.map((item) => [item.id, item]))
    return selected.value.flatMap((id) => (items.has(id) ? [items.get(id)!] : []))
  })
  const urls = reactive<Record<string, string>>({})
  const thumbnails = reactive<Record<string, string>>({})
  const missing = reactive<Record<string, boolean>>({})
  const loading = ref(false)
  const importing = ref(0)
  const saving = ref(false)
  const dirty = ref(false)
  const error = ref('')
  const notice = ref('')
  const history = ref<string[]>([])
  const future = ref<string[]>([])
  const saveBlocked = ref(false)
  const conflictDraft = ref<Project>()
  const loadedAssets = new Map<string, Promise<string>>()
  const mediaSizes = new Map<string, number>()
  const previewPins = new Set<string>()
  const thumbnailRequests = new Map<string, Promise<string>>()
  const thumbnailQueue: Array<() => Promise<void>> = []
  let activeThumbnails = 0
  let mediaSequence = 0
  let disposed = false
  let restoring = false
  let version = 0
  let context = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  let polling = false
  let paused = false
  let activeSave: Promise<boolean> | undefined
  const documentValue = () =>
    JSON.stringify({
      title: project.title,
      collectionId: project.collectionId ?? null,
      items: project.items,
      edges: project.edges || [],
      dismissedRunIds: project.dismissedRunIds || [],
      viewport: project.viewport,
    })
  const draftKey = () => `pictoria.canvas.${agentId.value || 'local'}.${project.id}`
  const remember = () => {
    try {
      localStorage.setItem(
        draftKey(),
        JSON.stringify({ ...project, dirty: dirty.value, savedAt: Date.now() }),
      )
      localStorage.setItem(`pictoria.last.${agentId.value || 'local'}`, project.id)
    } catch {
      notice.value = '本地草稿空间不足，请尽快保存画布。'
    }
  }
  function clearMedia() {
    for (const key of Object.keys(urls)) {
      URL.revokeObjectURL(urls[key]!)
      delete urls[key]
    }
    for (const key of Object.keys(missing)) delete missing[key]
    loadedAssets.clear()
    mediaSizes.clear()
    mediaSequence++
    for (const key of Object.keys(thumbnails)) {
      URL.revokeObjectURL(thumbnails[key]!)
      delete thumbnails[key]
    }
    thumbnailRequests.clear()
  }
  function ensureThumbnail(id: string): Promise<string> {
    if (thumbnails[id]) return Promise.resolve(thumbnails[id]!)
    if (thumbnailRequests.has(id)) return thumbnailRequests.get(id)!
    const generation = context
    const pending = new Promise<string>((resolve, reject) => {
      thumbnailQueue.push(async () => {
        try {
          if (disposed || generation !== context) {
            resolve('')
            return
          }
          const url = await ensureMedia(id)
          if (!url || disposed || generation !== context) {
            resolve('')
            return
          }
          const blob = await (await fetch(url)).blob()
          const image = await createImageBitmap(blob)
          let thumbnail: Blob | null
          try {
            const scale = Math.min(1, 360 / Math.max(image.width, image.height))
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round(image.width * scale))
            canvas.height = Math.max(1, Math.round(image.height * scale))
            const painter = canvas.getContext('2d')
            if (!painter) throw new Error('无法创建缩略图')
            painter.drawImage(image, 0, 0, canvas.width, canvas.height)
            thumbnail = await new Promise<Blob | null>((done) =>
              canvas.toBlob(done, 'image/webp', 0.8),
            )
          } finally {
            image.close()
          }
          if (!thumbnail || disposed || generation !== context) {
            resolve('')
            return
          }
          thumbnails[id] = URL.createObjectURL(thumbnail)
          for (const cachedId of Object.keys(thumbnails).slice(
            0,
            Math.max(0, Object.keys(thumbnails).length - 180),
          )) {
            URL.revokeObjectURL(thumbnails[cachedId]!)
            delete thumbnails[cachedId]
          }
          resolve(thumbnails[id]!)
        } catch (error) {
          reject(error)
        }
      })
    }).finally(() => {
      if (generation === context) thumbnailRequests.delete(id)
    })
    thumbnailRequests.set(id, pending)
    pumpThumbnails()
    return pending
  }
  function pumpThumbnails() {
    while (activeThumbnails < 3 && thumbnailQueue.length) {
      activeThumbnails++
      void thumbnailQueue.shift()!().finally(() => {
        activeThumbnails--
        pumpThumbnails()
      })
    }
  }
  function pinMedia(id: string) {
    previewPins.add(id)
    return () => {
      previewPins.delete(id)
    }
  }
  async function ensureMedia(id: string): Promise<string> {
    if (urls[id]) {
      const size = mediaSizes.get(id)
      if (size !== undefined) {
        mediaSizes.delete(id)
        mediaSizes.set(id, size)
      }
      return urls[id]!
    }
    if (loadedAssets.has(id)) return loadedAssets.get(id)!
    const generation = context
    const owner = agentId.value
    const pending = pictoria
      .asset(owner, id)
      .then(({ info, base64 }) => {
        if (disposed || generation !== context) return ''
        const raw = atob(base64)
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([bytes], { type: info.mimeType }))
        urls[id] = url
        delete missing[id]
        mediaSizes.set(id, bytes.length)
        // 大画布限制预览内存；被释放的素材仍保留在后台，可再次按需加载。
        let total = [...mediaSizes.values()].reduce((sum, size) => sum + size, 0)
        for (const [cachedId, size] of mediaSizes) {
          if (total <= 128 * 1024 * 1024) break
          if (cachedId === id || previewPins.has(cachedId)) continue
          URL.revokeObjectURL(urls[cachedId]!)
          delete urls[cachedId]
          mediaSizes.delete(cachedId)
          total -= size
        }
        return url
      })
      .catch((e) => {
        if (!disposed && generation === context) missing[id] = true
        throw e
      })
      .finally(() => {
        if (generation === context) loadedAssets.delete(id)
      })
    loadedAssets.set(id, pending)
    return pending
  }
  function warmMedia() {
    if (!online.value) return
    loadVisibleMedia(
      project.items
        .flatMap((item) => (item.content.assetId ? [item.content.assetId] : []))
        .slice(0, 8),
    )
  }
  function loadVisibleMedia(requested: string[]) {
    if (!online.value) return
    const ids = [...new Set(requested)].slice(0, 32)
    let cursor = 0
    const generation = context,
      sequence = ++mediaSequence
    const worker = async () => {
      while (
        !disposed &&
        generation === context &&
        sequence === mediaSequence &&
        cursor < ids.length
      ) {
        const id = ids[cursor++]!
        await ensureMedia(id).catch(() => {})
      }
    }
    void Promise.all([worker(), worker(), worker()])
  }
  function checkpoint() {
    history.value.push(documentValue())
    if (history.value.length > 60) history.value.shift()
    future.value = []
  }
  function restoreSnapshot(value: string) {
    const snapshot = JSON.parse(value) as Project
    project.title = snapshot.title
    project.collectionId =
      snapshot.collectionId && !removedCollections.has(snapshot.collectionId)
        ? snapshot.collectionId
        : null
    project.items = snapshot.items
    project.edges = snapshot.edges || []
    project.dismissedRunIds = snapshot.dismissedRunIds || []
    project.viewport = snapshot.viewport
    selected.value = selected.value.filter((id) => project.items.some((item) => item.id === id))
    warmMedia()
  }
  function undo() {
    const previous = history.value.pop()
    if (!previous) return
    future.value.push(documentValue())
    restoreSnapshot(previous)
  }
  function redo() {
    const next = future.value.pop()
    if (!next) return
    history.value.push(documentValue())
    restoreSnapshot(next)
  }
  function addText(x = 0, y = 0, text = '') {
    if (project.items.length >= 2000) throw new Error('画布最多容纳 2000 个内容')
    checkpoint()
    const item: CanvasItem = {
      id: uid(),
      x,
      y,
      content: { version: 1, kind: 'text', width: 280, height: 190, text, name: '灵感便签' },
    }
    project.items.push(item)
    selected.value = [item.id]
    return item
  }
  function removeSelection() {
    if (!selected.value.length) return
    checkpoint()
    const ids = new Set(selected.value)
    const removedRuns = project.items.flatMap((item) =>
      ids.has(item.id) && item.content.runId ? [item.content.runId] : [],
    )
    // 只移除画布卡片，不取消后台任务；删除记录阻止恢复逻辑再次补回卡片。
    project.dismissedRunIds = [...new Set([...(project.dismissedRunIds || []), ...removedRuns])]
    project.items = project.items.filter((item) => !ids.has(item.id))
    for (const item of project.items)
      if (item.content.groupId && ids.has(item.content.groupId)) delete item.content.groupId
    project.edges = (project.edges || []).filter(
      (edge) => !ids.has(edge.source) && !ids.has(edge.target),
    )
    selected.value = []
    version++
    dirty.value = true
    clearTimeout(draftTimer)
    remember()
  }
  function duplicate() {
    const value = copyNodes()
    if (!value || value.kind !== 'canvas') return
    try {
      pasteNodes(value, {
        x: Math.min(...value.items.map((item) => item.x)) + 32,
        y: Math.min(...value.items.map((item) => item.y)) + 32,
      })
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '无法创建副本'
    }
  }
  function copyNodes(): NodeClipboard | undefined {
    if (!activeItems.value.length) return
    const members = descendants(project, selected.value) as CanvasItem[]
    const ids = new Set(members.map((item) => item.id))
    const items = cloneNodes(members)
    for (const item of items) {
      delete item.content.request
      delete item.content.runId
      delete item.content.outputIds
      delete item.content.outputsResolved
      delete item.content.state
      delete item.content.error
    }
    return cloneNodes({
      ...clipboardContext(agentId.value, project.id),
      kind: 'canvas' as const,
      items,
      edges: (project.edges || []).filter((edge) => ids.has(edge.target)),
    })
  }
  function pasteNodes(value: NodeClipboard, point: { x: number; y: number }) {
    assertClipboardOwner(value, agentId.value)
    if (value.kind !== 'canvas') throw new Error('请在工作流中粘贴这些节点')
    if (!value.items.length) return
    if (value.items.length + project.items.length > 2000)
      throw new Error('画布最多容纳 2000 个内容，请减少粘贴数量')
    const source = cloneNodes(value),
      ids = new Map(source.items.map((item) => [item.id, uid()]))
    const dx = point.x - Math.min(...source.items.map((item) => item.x)),
      dy = point.y - Math.min(...source.items.map((item) => item.y))
    const copies = source.items.map((item) => {
      if (item.content.groupId) item.content.groupId = ids.get(item.content.groupId)
      if (item.content.candidateGroupId)
        item.content.candidateGroupId = ids.get(item.content.candidateGroupId)
      item.id = ids.get(item.id)!
      item.x += dx
      item.y += dy
      delete item.content.request
      delete item.content.runId
      delete item.content.outputIds
      delete item.content.outputsResolved
      delete item.content.state
      delete item.content.error
      if (item.content.kind === 'run') item.content.kind = item.content.step ? 'draft' : 'text'
      if (item.content.kind === 'text' && !item.content.text)
        item.content.text = item.content.name || ''
      item.content.originId = item.content.originId ? ids.get(item.content.originId) : undefined
      return item
    })
    const copiedEdges = source.edges
      .filter(
        (edge) =>
          ids.has(edge.target) &&
          (ids.has(edge.source) ||
            (value.source === project.id && project.items.some((item) => item.id === edge.source))),
      )
      .map((edge) => ({
        ...edge,
        id: uid(),
        source: ids.get(edge.source) || edge.source,
        target: ids.get(edge.target)!,
      }))
    if (copiedEdges.length + (project.edges?.length || 0) > 8000)
      throw new Error('画布连线已达上限')
    checkpoint()
    project.items.push(...copies)
    project.edges = [...(project.edges || []), ...copiedEdges]
    selected.value = copies.map((item) => item.id)
    warmMedia()
    notice.value = '已粘贴'
  }
  function addAsset(asset: Asset, x: number, y: number) {
    if (project.items.length >= 2000) throw new Error('画布最多容纳 2000 个内容')
    const kind = asset.mimeType.startsWith('video/')
      ? 'video'
      : asset.mimeType.startsWith('audio/')
        ? 'audio'
        : 'image'
    const item: CanvasItem = {
      id: uid(),
      x,
      y,
      content: {
        version: 1,
        kind: 'asset',
        width: 300,
        height: kind === 'audio' ? 110 : 260,
        assetId: asset.id,
        name: asset.meta?.title || asset.name,
        mimeType: asset.mimeType,
        promptText:
          typeof asset.meta?.inputs?.prompt === 'string' ? asset.meta.inputs.prompt : undefined,
      },
    }
    project.items.push(item)
    void ensureMedia(asset.id).catch(() => {})
    return item
  }
  async function importFiles(files: File[], position: { x: number; y: number }) {
    if (!online.value) {
      error.value = '连接创作后台后即可导入素材，文字和布局仍可编辑。'
      return
    }
    if (importing.value) return
    const owner = agentId.value,
      generation = context
    let index = 0
    const importedIds: string[] = []
    checkpoint()
    error.value = ''
    for (const file of files.slice(0, 20)) {
      const aliases: Record<string, string> = {
        'audio/x-wav': 'audio/wav',
        'audio/wave': 'audio/wav',
        'audio/mp3': 'audio/mpeg',
        'image/jpg': 'image/jpeg',
      }
      const mimeType = aliases[file.type] || file.type
      if (!allowed.has(mimeType) || file.size > 20 * 1024 * 1024) {
        error.value = `“${file.name}”格式不支持或超过 20 MB。`
        continue
      }
      importing.value++
      try {
        const asset = await pictoria.upload(owner, file.name, mimeType, await fileBase64(file))
        if (disposed || generation !== context) return
        const item = addAsset(asset, position.x + index * 330, position.y)
        importedIds.push(item.id)
        selected.value = [...importedIds]
        index++
      } catch (e) {
        if (generation === context) error.value = e instanceof Error ? e.message : '导入失败'
      } finally {
        importing.value--
      }
    }
    if (files.length > 20) notice.value = '一次最多导入 20 份素材。'
  }
  function save(): Promise<boolean> {
    if (hierarchyBusy.value) return Promise.resolve(false)
    if (activeSave) return activeSave
    if (!online.value || !agentId.value || saveBlocked.value) return Promise.resolve(false)
    activeSave = performSave().finally(() => {
      activeSave = undefined
    })
    return activeSave
  }
  async function performSave(): Promise<boolean> {
    const current = version,
      generation = context,
      owner = agentId.value
    const definition = JSON.parse(
      JSON.stringify({
        id: project.id,
        title: project.title.trim() || __t('apps.pictoria.ui', '未命名画布'),
        collectionId: project.collectionId ?? null,
        items: project.items,
        edges: project.edges || [],
        dismissedRunIds: project.dismissedRunIds || [],
        creation: project.creation,
        viewport: project.viewport,
      }),
    )
    saving.value = true
    try {
      const saved = await pictoria.operation<Project>(owner, 'project.save', {
        definition,
        expectedRevision: project.revision,
      })
      if (disposed || generation !== context) return false
      project.revision = saved.revision
      if (current === version) dirty.value = false
      remember()
      projects.value = [saved, ...projects.value.filter((item) => item.id !== saved.id)]
      return true
    } catch (e) {
      if (generation === context) {
        error.value = e instanceof Error ? e.message : '保存失败，草稿已留在此设备'
        saveBlocked.value = true
      }
      return false
    } finally {
      if (!disposed && generation === context) {
        saving.value = false
        if (!paused && dirty.value && !saveBlocked.value) {
          clearTimeout(timer)
          timer = setTimeout(() => {
            void save()
          }, 1200)
        }
      }
    }
  }
  async function retrySave() {
    saveBlocked.value = false
    error.value = ''
    await save()
  }
  function loadDocument(value: Project) {
    context++
    restoring = true
    clearTimeout(timer)
    clearTimeout(draftTimer)
    clearMedia()
    selected.value = []
    history.value = []
    future.value = []
    conflictDraft.value = undefined
    Object.assign(project, value)
    project.creation = normalizeCreationPreferences(value.creation)
    project.viewport = value.viewport
    project.collectionId = value.collectionId ?? null
    project.edges = value.edges || []
    project.dismissedRunIds = value.dismissedRunIds || []
    project.items = value.items
      .filter(
        (item) =>
          item && typeof item.id === 'string' && Number.isFinite(item.x) && Number.isFinite(item.y),
      )
      .map((item) => {
        const raw = item.content as unknown
        const content: Partial<CanvasItem['content']> =
          raw && typeof raw === 'object'
            ? (raw as Partial<CanvasItem['content']>)
            : { text: String(raw ?? '') }
        const assetId = content.assetId
        const runId = content.runId
        const kind: CanvasItem['content']['kind'] =
          content.kind && ['text', 'asset', 'run', 'draft', 'group'].includes(content.kind)
            ? content.kind
            : assetId
              ? 'asset'
              : runId
                ? 'run'
                : 'text'
        return {
          ...item,
          content: {
            ...content,
            version: 1 as const,
            kind,
            text: typeof content.text === 'string' ? content.text : '',
            width: Math.max(
              120,
              Math.min(kind === 'group' ? 100000 : 1600, Number(content.width) || 280),
            ),
            height: Math.max(
              90,
              Math.min(kind === 'group' ? 100000 : 1600, Number(content.height) || 220),
            ),
          },
        }
      })
    dirty.value = false
    saving.value = false
    saveBlocked.value = false
    error.value = ''
    version++
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey()) || 'null') as
        | (Project & { dirty?: boolean })
        | null
      if (draft?.dirty && draft.id === project.id && Array.isArray(draft.items)) {
        if (draft.revision === project.revision) {
          project.title = draft.title
          project.collectionId = draft.collectionId ?? null
          project.items = draft.items
          project.edges = draft.edges || []
          project.dismissedRunIds = draft.dismissedRunIds || []
          project.creation = normalizeCreationPreferences(draft.creation ?? project.creation)
          project.viewport = draft.viewport ?? project.viewport
          dirty.value = true
          notice.value = '已恢复本地草稿。'
        } else {
          conflictDraft.value = draft
          localStorage.setItem(`${draftKey()}.conflict`, JSON.stringify(draft))
          notice.value = '已保存的画布有新版本，本地草稿可恢复为独立副本。'
        }
      }
      if (!conflictDraft.value) {
        const backup = JSON.parse(
          localStorage.getItem(`${draftKey()}.conflict`) || 'null',
        ) as Project | null
        if (backup?.id === project.id && Array.isArray(backup.items)) conflictDraft.value = backup
      }
    } catch {
      /* 无效草稿不覆盖已保存画布。 */
    }
    const generation = context
    void nextTick(() => {
      if (generation === context) restoring = false
    })
    remember()
    warmMedia()
    void restoreRuns()
  }
  async function openProject(id: string) {
    if (importing.value || loading.value || saving.value || hierarchyBusy.value) return
    if (dirty.value && !(await save())) {
      error.value = '当前画布尚未保存，请先保存或导出草稿。'
      return
    }
    await nextTick()
    if (dirty.value) {
      error.value = '画布仍有新修改，请保存完成后再切换。'
      return
    }
    loading.value = true
    try {
      loadDocument(await pictoria.operation<Project>(agentId.value, 'project.get', { id }))
    } catch (e) {
      error.value = e instanceof Error ? e.message : '打开失败'
    } finally {
      loading.value = false
    }
  }
  async function newProject(collectionId: string | null = project.collectionId ?? null) {
    if (importing.value || loading.value || saving.value || hierarchyBusy.value) return
    if (dirty.value && online.value && !(await save())) return
    await nextTick()
    if (dirty.value && online.value) {
      error.value = '画布仍有新修改，请稍后重试。'
      return
    }
    if (dirty.value) remember()
    loadDocument({
      id: uid(),
      title: __t('apps.pictoria.ui', '未命名画布'),
      revision: 0,
      collectionId,
      items: [],
    })
    dirty.value = true
    remember()
    if (online.value) await save()
  }
  async function connect(start = false) {
    loading.value = true
    error.value = ''
    try {
      if (start) await pictoria.start()
      const data = await pictoria.bootstrap()
      if (disposed) return
      agents.value = data.agents
      status.value = data.status
      if (!data.agents.some((agent) => agent.id === agentId.value)) {
        const previousOwner = agentId.value
        if (previousOwner && dirty.value) remember()
        agentId.value = data.agents[0]?.id || ''
        if (previousOwner !== agentId.value) removedCollections.clear()
        if (previousOwner)
          loadDocument({
            id: uid(),
            title: __t('apps.pictoria.ui', '未命名画布'),
            revision: 0,
            items: [],
          })
      }
      if (!online.value || !agentId.value) return
      localStorage.setItem('pictoria.agent', agentId.value)
      const owner = agentId.value,
        generation = context
      const [saved, catalog, assets, groups] = await Promise.all([
        listAll<Project>(owner, 'project.list'),
        pictoria.operation<{ steps: Step[] }>(owner, 'catalog.get'),
        pictoria.operation<Asset[]>(owner, 'asset.list', { limit: 100 }),
        listAll<CanvasCollection>(owner, 'collection.list'),
      ])
      if (disposed || generation !== context || owner !== agentId.value) return
      projects.value = saved
      collections.value = groups
      steps.value = catalog.steps
      library.value = assets
      const lastId = localStorage.getItem(`pictoria.last.${agentId.value}`)
      const previous =
        saved.find((item) => item.id === project.id) ||
        saved.find((item) => item.id === lastId) ||
        saved[0]
      if (dirty.value && previous?.id === project.id && previous.revision !== project.revision) {
        remember()
        loadDocument(previous)
      }
      if (!dirty.value) {
        if (previous) loadDocument(previous)
        else {
          let draft: Project | null = null
          try {
            draft = lastId
              ? (JSON.parse(
                  localStorage.getItem(`pictoria.canvas.${agentId.value}.${lastId}`) || 'null',
                ) as Project | null)
              : null
          } catch {
            /* 损坏草稿忽略。 */
          }
          if (draft?.id && Array.isArray(draft.items)) loadDocument({ ...draft, revision: 0 })
        }
      }
      warmMedia()
      void restoreRuns()
      if (dirty.value && !saveBlocked.value) {
        clearTimeout(timer)
        timer = setTimeout(() => {
          void save()
        }, 1200)
      }
    } catch (e) {
      if (!disposed) error.value = e instanceof Error ? e.message : '连接失败'
    } finally {
      if (!disposed) loading.value = false
    }
  }
  async function switchAgent(id: string) {
    if (importing.value || saving.value || loading.value || hierarchyBusy.value) return
    if (dirty.value && !(await save())) {
      error.value = '请先保存当前画布。'
      return
    }
    await nextTick()
    if (dirty.value) {
      error.value = '画布仍有新修改，请保存完成后再切换。'
      return
    }
    agentId.value = id
    localStorage.setItem('pictoria.agent', id)
    removedCollections.clear()
    projects.value = []
    collections.value = []
    loadDocument({
      id: uid(),
      title: __t('apps.pictoria.ui', '未命名画布'),
      revision: 0,
      items: [],
    })
    await connect()
  }
  async function listAll<T>(owner: string, operation: string): Promise<T[]> {
    const result: T[] = []
    for (let offset = 0; ; offset += 200) {
      const page = await pictoria.operation<T[]>(owner, operation, { limit: 200, offset })
      result.push(...page)
      if (page.length < 200 || disposed || owner !== agentId.value) return result
    }
  }
  async function refreshHierarchy(owner = agentId.value) {
    const generation = context
    const [canvases, groups] = await Promise.all([
      listAll<Project>(owner, 'project.list'),
      listAll<CanvasCollection>(owner, 'collection.list'),
    ])
    if (disposed || generation !== context || owner !== agentId.value) return
    projects.value = canvases
    collections.value = groups
  }
  function releaseHierarchy() {
    hierarchyBusy.value = false
    if (dirty.value && online.value && !saveBlocked.value) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void save()
      }, 300)
    }
  }
  async function saveCollection(title: string, existing?: CanvasCollection) {
    if (!online.value || hierarchyBusy.value) return false
    const owner = agentId.value,
      generation = context
    hierarchyBusy.value = true
    error.value = ''
    try {
      const saved = await pictoria.operation<CanvasCollection>(owner, 'collection.save', {
        definition: { id: existing?.id || uid(), title: title.trim() },
        expectedRevision: existing?.revision ?? 0,
      })
      if (disposed || generation !== context || owner !== agentId.value) return false
      collections.value = [saved, ...collections.value.filter((item) => item.id !== saved.id)]
      return true
    } catch (e) {
      if (generation === context) {
        error.value = e instanceof Error ? e.message : '项目保存失败'
        await refreshHierarchy(owner).catch(() => {})
      }
      return false
    } finally {
      releaseHierarchy()
    }
  }
  async function moveToCollection(id: string, collectionId: string | null) {
    if (hierarchyBusy.value || loading.value || importing.value) return false
    if (id === project.id) {
      if ((project.collectionId ?? null) === collectionId) return true
      checkpoint()
      project.collectionId = collectionId
      await nextTick()
      return online.value ? await save() : true
    }
    if (!online.value) return false
    const canvas = projects.value.find((item) => item.id === id)
    if (!canvas) return false
    const owner = agentId.value,
      generation = context
    hierarchyBusy.value = true
    error.value = ''
    try {
      const saved = await pictoria.operation<Project>(owner, 'project.move', {
        id,
        collectionId,
        expectedRevision: canvas.revision,
      })
      if (disposed || generation !== context || owner !== agentId.value) return false
      projects.value = projects.value.map((item) => (item.id === saved.id ? saved : item))
      return true
    } catch (e) {
      if (generation === context) {
        error.value = e instanceof Error ? e.message : '画布移动失败'
        await refreshHierarchy(owner).catch(() => {})
      }
      return false
    } finally {
      releaseHierarchy()
    }
  }
  async function removeCollection(group: CanvasCollection) {
    if (!online.value || hierarchyBusy.value || loading.value || importing.value) return false
    const owner = agentId.value,
      generation = context
    if ((dirty.value || saving.value) && !(await save())) return false
    if (disposed || generation !== context || owner !== agentId.value) return false
    hierarchyBusy.value = true
    error.value = ''
    try {
      const result = await pictoria.operation<{
        canvases: Array<{ id: string; previousRevision: number; revision: number }>
      }>(owner, 'collection.delete', { id: group.id, expectedRevision: group.revision })
      if (disposed || generation !== context || owner !== agentId.value) return false
      removedCollections.add(group.id)
      collections.value = collections.value.filter((item) => item.id !== group.id)
      const current = result.canvases.find((item) => item.id === project.id)
      if (current) {
        if (project.revision === current.previousRevision) {
          project.collectionId = null
          project.revision = current.revision
        } else {
          project.collectionId = null
          saveBlocked.value = true
          error.value = '画布已有新版本，请另存本地修改后重新打开'
        }
      }
      await refreshHierarchy(owner)
      return true
    } catch (e) {
      if (generation === context) error.value = e instanceof Error ? e.message : '项目移除失败'
      return false
    } finally {
      releaseHierarchy()
    }
  }
  async function renameProject(id: string, title: string) {
    if (disposed || hierarchyBusy.value || loading.value || saving.value || importing.value)
      return false
    const name = title.trim()
    if (!name || name.length > 120) {
      error.value = '画布名称须为 1 至 120 个字符'
      return false
    }
    if (id === project.id) {
      const owner = agentId.value,
        generation = context
      if (project.title !== name) {
        checkpoint()
        project.title = name
      }
      await nextTick()
      if (disposed || generation !== context || owner !== agentId.value) return false
      remember()
      return online.value ? await save() : true
    }
    if (!online.value) return false
    const canvas = projects.value.find((item) => item.id === id)
    if (!canvas) return false
    const owner = agentId.value,
      generation = context
    hierarchyBusy.value = true
    error.value = ''
    try {
      // 只更新名称，避免用列表中的旧快照覆盖画布内容。
      const saved = await pictoria.operation<Project>(owner, 'project.rename', {
        id,
        title: name,
        expectedRevision: canvas.revision,
      })
      if (disposed || generation !== context || owner !== agentId.value) return false
      projects.value = projects.value.map((item) => (item.id === saved.id ? saved : item))
      return true
    } catch (e) {
      if (!disposed && generation === context && owner === agentId.value) {
        error.value = e instanceof Error ? e.message : '画布重命名失败'
        await refreshHierarchy(owner).catch(() => {})
      }
      return false
    } finally {
      if (!disposed) releaseHierarchy()
    }
  }
  async function removeProject(id: string) {
    if (disposed || hierarchyBusy.value || loading.value || importing.value) return false
    const owner = agentId.value,
      generation = context
    hierarchyBusy.value = true
    try {
      // 先等待在途保存结束，再按最新版本删除，避免保存请求把画布重新写回。
      if (activeSave) await activeSave
      await nextTick()
      if (disposed || generation !== context || owner !== agentId.value) return false
      const canvas = id === project.id ? project : projects.value.find((item) => item.id === id)
      if (!canvas) return false
      error.value = ''
      if (canvas.revision > 0) {
        if (!online.value) {
          error.value = '请连接创作后台后再删除已保存的画布'
          return false
        }
        await pictoria.operation(owner, 'project.delete', {
          id,
          expectedRevision: canvas.revision,
        })
      }
      // 删除已确认后清理草稿；即使组件已关闭，也不能在下次启动时恢复旧画布。
      let draftCleanupFailed = false
      try {
        localStorage.removeItem(`pictoria.canvas.${owner || 'local'}.${id}`)
        localStorage.removeItem(`pictoria.canvas.${owner || 'local'}.${id}.conflict`)
        const lastKey = `pictoria.last.${owner || 'local'}`
        if (localStorage.getItem(lastKey) === id) localStorage.removeItem(lastKey)
      } catch {
        draftCleanupFailed = true
      }
      if (disposed || generation !== context || owner !== agentId.value) return false
      projects.value = projects.value.filter((item) => item.id !== id)
      if (project.id === id) {
        loadDocument({
          id: uid(),
          title: __t('apps.pictoria.ui', '未命名画布'),
          revision: 0,
          items: [],
        })
      }
      notice.value = draftCleanupFailed
        ? '画布已删除，但此设备的本地草稿清理失败'
        : '画布已删除，素材库中的素材已保留'
      return true
    } catch (e) {
      if (!disposed && generation === context && owner === agentId.value) {
        error.value = e instanceof Error ? e.message : '画布删除失败'
        await refreshHierarchy(owner).catch(() => {})
      }
      return false
    } finally {
      if (!disposed) releaseHierarchy()
    }
  }
  async function createRun(
    step: Step,
    inputs: Record<string, unknown>,
    position: { x: number; y: number },
    key: string,
    originId?: string,
  ) {
    if (!online.value) throw new Error('创作后台尚未连接')
    if (loading.value) throw new Error('正在切换画布，请稍后提交')
    if (project.items.length >= 2000) throw new Error('请先整理画布，或新建画布后再创作')
    const owner = agentId.value,
      generation = context,
      projectId = project.id
    const provenance = (project.edges || [])
      .filter((edge) => edge.target === originId && !edge.historical)
      .map((edge) => ({ ...edge }))
    const origin = project.items.find((item) => item.id === originId)
    const referenceUses = JSON.parse(JSON.stringify(origin?.content.referenceUses ?? []))
    const continuation = origin?.content.continuation
      ? JSON.parse(JSON.stringify(origin.content.continuation))
      : undefined
    await nextTick()
    if (disposed || generation !== context) throw new Error('画布已切换，此次尚未提交')
    if ((dirty.value || project.revision === 0) && !(await save()))
      throw new Error('先保存画布后再开始创作')
    await nextTick()
    if (disposed || generation !== context) throw new Error('画布已切换，此次尚未提交')
    if (dirty.value) throw new Error('画布仍在保存，请稍后重试创作')
    const result = await pictoria.run(
      owner,
      { stepId: step.id, stepRevision: step.revision, inputs, projectId, canvasItemId: originId },
      key,
    )
    if (disposed || generation !== context) return
    if (project.dismissedRunIds?.includes(result.taskId)) return
    if (originId && !project.items.some((item) => item.id === originId)) {
      project.dismissedRunIds = [...new Set([...(project.dismissedRunIds || []), result.taskId])]
      version++
      dirty.value = true
      remember()
      return
    }
    const existing = project.items.find((item) => item.content.runId === result.taskId)
    if (existing) return existing
    checkpoint()
    const card: CanvasItem = {
      id: uid(),
      x: position.x,
      y: position.y,
      content: {
        version: 1,
        kind: 'run',
        width: 300,
        height: 180,
        runId: result.taskId,
        name: step.name,
        state: 'queued',
        inputs: JSON.parse(JSON.stringify(inputs)),
        step: JSON.parse(JSON.stringify(step)),
        originId,
        referenceUses,
        continuation,
      },
    }
    project.items.push(card)
    selected.value = [card.id]
    project.edges ||= []
    for (const edge of provenance)
      if (project.edges.length < 8000 && project.items.some((item) => item.id === edge.source))
        project.edges.push({ ...edge, id: uid(), target: card.id, historical: true })
    if (
      project.edges.length < 8000 &&
      originId &&
      project.items.some((item) => item.id === originId)
    )
      project.edges.push({
        id: uid(),
        source: originId,
        target: card.id,
        field: '创作',
        historical: true,
      })
    return card
  }
  async function poll() {
    if (polling || paused || document.hidden || !online.value || disposed) return
    polling = true
    const generation = context,
      owner = agentId.value
    try {
      const cards = project.items.filter(
        (item) =>
          item.content.kind === 'run' &&
          item.content.runId &&
          (!terminal.has(item.content.state || '') || !item.content.outputsResolved),
      )
      for (const card of cards) {
        const run = await pictoria.task(owner, card.content.runId!)
        if (disposed || paused || generation !== context) return
        if (!project.items.includes(card)) continue
        if (!run) {
          card.content.state = 'failed'
          card.content.error = '创作记录已不存在'
          card.content.outputsResolved = true
          continue
        }
        if (card.content.state !== run.state) card.content.state = run.state
        card.content.error = run.error
        if (terminal.has(run.state) && run.result) {
          const known = new Set(card.content.outputIds ?? [])
          const ids = assetIds(run.result)
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i]!
            if (known.has(id)) continue
            const info = await pictoria.operation<Asset>(owner, 'asset.get', { id })
            if (disposed || paused || generation !== context) return
            if (!project.items.includes(card)) break
            const output = addAsset(info, card.x + i * 330, card.y + card.content.height + 44)
            output.content.candidateGroupId = card.content.candidateParentId || card.id
            if (info.mimeType.startsWith('video/') && card.content.continuation)
              output.content.continuation = JSON.parse(JSON.stringify(card.content.continuation))
            const parent =
              card.content.candidateParentId &&
              project.items.find((item) => item.id === card.content.candidateParentId)
            if (parent)
              parent.content.outputIds = [...new Set([...(parent.content.outputIds || []), id])]
            if (info.mimeType.startsWith('image/')) card.content.primaryAssetId ||= id
            project.edges ||= []
            if (project.edges.length < 8000)
              project.edges.push({
                id: uid(),
                source: card.id,
                target: output.id,
                field: '输出',
                sourcePort: 'bottom',
                targetPort: 'top',
                historical: true,
              })
            known.add(id)
            card.content.outputIds = [...known]
          }
          const text = Object.values(run.result)
            .filter((value): value is string => typeof value === 'string')
            .join('\n')
          if (project.items.includes(card) && text && !known.has('text')) {
            addText(card.x + ids.length * 330, card.y + card.content.height + 44, text)
            known.add('text')
            card.content.outputIds = [...known]
          }
        }
        if (terminal.has(run.state)) card.content.outputsResolved = true
      }
    } catch (e) {
      if (!disposed && !paused && generation === context)
        notice.value = e instanceof Error ? e.message : '任务状态暂时无法更新'
    } finally {
      polling = false
    }
  }
  async function restoreRuns() {
    if (!online.value || paused || disposed) return
    const generation = context,
      owner = agentId.value,
      projectId = project.id
    try {
      const runs = await pictoria.operation<Run[]>(owner, 'task.list')
      if (disposed || paused || generation !== context) return
      for (const run of runs.filter((item) => item.projectId === projectId)) {
        // 历史成品不因打开画布重新铺回；只恢复未被主动移除的进行中任务。
        if (terminal.has(run.state) || project.dismissedRunIds?.includes(run.id)) continue
        if (project.items.length >= 2000) break
        if (project.items.some((item) => item.content.runId === run.id)) continue
        const right = project.items.length
          ? Math.max(...project.items.map((item) => item.x + item.content.width)) + 60
          : 0
        const origin = project.items.find(
          (item) =>
            item.content.kind === 'draft' &&
            item.content.request?.fingerprint ===
              JSON.stringify([run.nodes[0]?.step?.id, run.nodes[0]?.step?.revision, run.inputs]),
        )
        project.items.push({
          id: uid(),
          x: right,
          y: 0,
          content: {
            version: 1,
            kind: 'run',
            width: 300,
            height: 180,
            runId: run.id,
            state: run.state,
            name: run.name,
            inputs: run.inputs,
            step: run.nodes[0]?.step,
            originId: origin?.id,
            continuation: origin?.content.continuation
              ? JSON.parse(JSON.stringify(origin.content.continuation))
              : undefined,
            referenceUses: JSON.parse(JSON.stringify(origin?.content.referenceUses ?? [])),
          },
        })
      }
      void poll()
    } catch {
      /* 暂时断线不清空已保存的任务卡片。 */
    }
  }
  async function recoverConflict() {
    if (!conflictDraft.value) return
    const draft = JSON.parse(JSON.stringify(conflictDraft.value)) as Project
    loadDocument({
      ...draft,
      collectionId: collections.value.some((group) => group.id === draft.collectionId)
        ? draft.collectionId
        : null,
      id: uid(),
      revision: 0,
      title: __t('apps.pictoria.ui', '{0}（本地副本）', [draft.title]).slice(0, 120),
    })
    dirty.value = true
    remember()
    if (online.value) await save()
  }
  async function saveAsCopy() {
    if (saving.value || importing.value || hierarchyBusy.value) return
    remember()
    const copy = JSON.parse(JSON.stringify(project)) as Project
    loadDocument({
      ...copy,
      collectionId: collections.value.some((group) => group.id === copy.collectionId)
        ? copy.collectionId
        : null,
      id: uid(),
      revision: 0,
      title: __t('apps.pictoria.ui', '{0}（副本）', [copy.title]).slice(0, 120),
    })
    dirty.value = true
    remember()
    if (online.value) await save()
  }
  async function cancelRun(id: string) {
    try {
      await pictoria.operation<Run>(agentId.value, 'task.cancel', { id })
      await poll()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '取消失败'
    }
  }
  function exportDraft() {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob),
      anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${project.title || '画布'}.pictoria.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function setPaused(value: boolean) {
    paused = value
    clearTimeout(timer)
    if (!value && !disposed) {
      if (dirty.value && online.value && !saveBlocked.value)
        timer = setTimeout(() => {
          void save()
        }, 1200)
      void poll()
    }
  }
  async function flushForExit(): Promise<boolean> {
    setPaused(true)
    await nextTick()
    remember()
    if (conflictDraft.value) {
      error.value = '请先恢复或处理本地画布草稿'
      return false
    }
    if (!dirty.value && !saving.value && project.revision > 0) return true
    if (!(await save())) return false
    await nextTick()
    // 已在途的自动保存可能只覆盖旧快照，退出前继续保存最后一次修改。
    if (dirty.value && !(await save())) return false
    return !dirty.value
  }
  // 拖动按帧更新，草稿延迟落盘，避免每次坐标变化同步写 localStorage。
  const contentWatcher = watch(
    () => [
      project.title,
      project.collectionId,
      project.items,
      project.edges,
      project.dismissedRunIds,
      project.creation,
      project.viewport,
    ],
    () => {
      if (restoring || disposed) return
      version++
      dirty.value = true
      clearTimeout(draftTimer)
      draftTimer = setTimeout(remember, 300)
      clearTimeout(timer)
      if (!paused && online.value && !saveBlocked.value)
        timer = setTimeout(() => {
          void save()
        }, 1200)
    },
    { deep: true, flush: 'post' },
  )
  let interacting = false
  function beginInteraction(): void {
    if (interacting) return
    interacting = true
    contentWatcher.pause()
    version++
    dirty.value = true
    clearTimeout(timer)
  }
  function endInteraction(): void {
    if (!interacting) return
    interacting = false
    contentWatcher.resume()
  }
  watch(dirty, (value) => desktop?.send?.('desktop-tabs:unsaved-changes', value))
  const pollTimer = setInterval(() => {
    void poll()
  }, 2500)
  const refreshWhenVisible = () => {
    if (!document.hidden) void poll()
  }
  document.addEventListener('visibilitychange', refreshWhenVisible)
  try {
    const last = localStorage.getItem(`pictoria.last.${agentId.value || 'local'}`)
    const draft = last
      ? (JSON.parse(
          localStorage.getItem(`pictoria.canvas.${agentId.value || 'local'}.${last}`) || 'null',
        ) as Project | null)
      : null
    if (draft?.id && Array.isArray(draft.items)) loadDocument(draft)
  } catch {
    /* 首次打开或本地草稿损坏时使用空画布。 */
  }
  onBeforeUnmount(() => {
    disposed = true
    context++
    remember()
    clearTimeout(timer)
    clearTimeout(draftTimer)
    clearInterval(pollTimer)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
    clearMedia()
  })
  return {
    project,
    agents,
    agentId,
    status,
    online,
    projects,
    collections,
    hierarchyBusy,
    saveCollection,
    moveToCollection,
    removeCollection,
    renameProject,
    removeProject,
    steps,
    library,
    selected,
    activeItems,
    movingItems: () => descendants(project, selected.value) as CanvasItem[],
    urls,
    thumbnails,
    missing,
    loading,
    importing,
    saving,
    dirty,
    saveBlocked,
    conflictDraft,
    error,
    notice,
    history,
    future,
    checkpoint,
    beginInteraction,
    endInteraction,
    undo,
    redo,
    addText,
    addAsset,
    removeSelection,
    duplicate,
    copyNodes,
    pasteNodes,
    importFiles,
    ensureMedia,
    ensureThumbnail,
    pinMedia,
    loadVisibleMedia,
    save,
    retrySave,
    openProject,
    newProject,
    connect,
    switchAgent,
    createRun,
    cancelRun,
    exportDraft,
    recoverConflict,
    saveAsCopy,
    persistDraft: remember,
    setPaused,
    flushForExit,
  }
}
export type CanvasStore = ReturnType<typeof useCanvas>
