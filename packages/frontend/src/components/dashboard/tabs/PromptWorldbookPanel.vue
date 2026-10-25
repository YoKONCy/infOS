<script lang="ts">
/** 跨实例记录已处理的跳转请求与上次打开的书；面板重新挂载后不重复处理同一请求。 */
let handledNavigation = 0
let lastBookId: string | null = null
</script>

<script setup lang="ts">
/**
 * 提示词管理 → 世界书
 *
 * 书库、全局启用列表与激活设置、单本世界书的条目编辑和命中测试。
 * 世界书独立于提示词草稿保存，保存后立即生效。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  WORLDBOOK_LIMITS,
  createWorldbookEntry,
  createWorldbookSettings,
  exportWorldbookFile,
  importSillyTavernWorldbook,
  normalizeWorldbookName,
  type Worldbook,
  type WorldbookEntry,
  type WorldbookImportWarning,
  type WorldbookSettings,
  type WorldbookSummary,
} from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { ApiError } from '../../../api/errors'
import { worldbookApi } from '../../../api/modules/worldbookApi'
import { useWorldbookNavigation } from '../../../composables/main/useWorldbookNavigation'
import { registerTabLeaveGuard } from '../../../composables/main/useMainNav'
import { useAgentStore } from '../../../stores/useAgentStore'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { PButton, PDialog, PEmpty, PSelect, PixelIcon } from '../../pixel'
import WorldbookBookPicker from './WorldbookBookPicker.vue'
import WorldbookEntryRow from './WorldbookEntryRow.vue'
import WorldbookGlobalCard from './WorldbookGlobalCard.vue'
import WorldbookHitTest from './WorldbookHitTest.vue'

type SortMode = 'custom' | 'order_desc' | 'title' | 'trigger'
interface ConfirmRequest {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  action: () => void | Promise<void>
  /** 用户取消或关闭确认框时调用。 */
  onCancel?: () => void
}
interface PromptRequest {
  title: string
  message?: string
  value: string
  confirmText: string
  action: (value: string) => void | Promise<void>
}

const notifications = useNotificationStore()
const agentStore = useAgentStore()
const navigation = useWorldbookNavigation()

// ── 书库与全局设置 ──
const books = ref<WorldbookSummary[]>([])
const settings = ref<WorldbookSettings>(createWorldbookSettings())
const libraryLoading = ref(true)
const libraryError = ref('')
const ready = ref(false)

// ── 当前书 ──
const book = shallowRef<Worldbook | null>(null)
const draft = ref<{ name: string; entries: WorldbookEntry[] } | null>(null)
const dirty = ref(false)
/** 每次编辑递增；保存期间若继续编辑，保存成功后仍保留本地草稿。 */
let editVersion = 0
let loadToken = 0
const bookLoading = ref(false)
const bookError = ref('')
const failedBookId = ref('')
const saving = ref(false)
const busy = ref(false)

// ── 条目列表视图 ──
const search = ref('')
const sortMode = ref<SortMode>('custom')
const pageSize = ref(100)
const page = ref(1)
const expanded = ref(new Set<string>())
const testOpen = ref(false)
const dragId = ref<string | null>(null)
const dropId = ref<string | null>(null)
const navigationAgent = ref<string | null>(null)
/** 跳转时角色是否已绑定世界书，用于选择提示文案。 */
const navigationBound = ref(false)

// ── 对话框 ──
const confirmRequest = ref<ConfirmRequest | null>(null)
const promptRequest = ref<PromptRequest | null>(null)
const promptValue = ref('')
const conflictOpen = ref(false)
const moveRequest = ref<{ entryId: string; target: string } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const isCode = (cause: unknown, code: string) => cause instanceof ApiError && cause.code === code

const sortedBooks = computed(() =>
  [...books.value].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
)
const otherBooks = computed(() => sortedBooks.value.filter((item) => item.id !== book.value?.id))
const navigationAgentName = computed(() => {
  const id = navigationAgent.value
  return id ? (agentStore.agents.find((agent) => agent.id === id)?.name ?? id) : ''
})

// ── 条目筛选、排序与分页 ──
const sortOptions = computed(() => [
  { value: 'custom', label: __t('ui.worldbook', '自定义（顺序 ↑）') },
  { value: 'order_desc', label: __t('ui.worldbook', '顺序 ↓') },
  { value: 'title', label: __t('ui.worldbook', '标题') },
  { value: 'trigger', label: __t('ui.worldbook', '触发策略') },
])
const pageSizeOptions = computed(() => [
  { value: 25, label: __t('ui.worldbook', '每页 {0}', [25]) },
  { value: 50, label: __t('ui.worldbook', '每页 {0}', [50]) },
  { value: 100, label: __t('ui.worldbook', '每页 {0}', [100]) },
  { value: 0, label: __t('ui.worldbook', '全部') },
])
const keyword = computed(() => search.value.trim().toLocaleLowerCase())
const matched = computed(() => {
  const entries = draft.value?.entries ?? []
  const query = keyword.value
  if (!query) return entries
  return entries.filter(
    (entry) =>
      entry.title.toLocaleLowerCase().includes(query) ||
      entry.content.toLocaleLowerCase().includes(query) ||
      entry.keys.some((key) => key.toLocaleLowerCase().includes(query)),
  )
})
/** 显示顺序：按所选方式排序，关闭的条目统一排在最后；只影响显示，不改写保存的顺序值。 */
const displayed = computed(() => {
  const index = new Map((draft.value?.entries ?? []).map((entry, i) => [entry.id, i]))
  const byOrder = (a: WorldbookEntry, b: WorldbookEntry) =>
    a.order - b.order || index.get(a.id)! - index.get(b.id)!
  const compare: Record<SortMode, (a: WorldbookEntry, b: WorldbookEntry) => number> = {
    custom: byOrder,
    order_desc: (a, b) => b.order - a.order || index.get(a.id)! - index.get(b.id)!,
    title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || byOrder(a, b),
    trigger: (a, b) =>
      Number(a.light === 'keyword') - Number(b.light === 'keyword') || byOrder(a, b),
  }
  const sorted = [...matched.value].sort(compare[sortMode.value])
  return [...sorted.filter((entry) => entry.enabled), ...sorted.filter((entry) => !entry.enabled)]
})
const pageCount = computed(() =>
  pageSize.value ? Math.max(1, Math.ceil(displayed.value.length / pageSize.value)) : 1,
)
const pageStart = computed(() => (pageSize.value ? (page.value - 1) * pageSize.value : 0))
const pageItems = computed(() =>
  pageSize.value
    ? displayed.value.slice(pageStart.value, pageStart.value + pageSize.value)
    : displayed.value,
)
const rangeLabel = computed(() =>
  displayed.value.length
    ? __t('ui.worldbook', '{0}-{1} / {2}', [
        pageStart.value + 1,
        pageStart.value + pageItems.value.length,
        displayed.value.length,
      ])
    : '0 / 0',
)
/** 拖动只在自定义排序且未搜索时开放，此时显示顺序与注入顺序一致。 */
const sortable = computed(() => sortMode.value === 'custom' && !keyword.value)
const entryCount = computed(() => draft.value?.entries.length ?? 0)
const enabledCount = computed(
  () => draft.value?.entries.filter((entry) => entry.enabled).length ?? 0,
)

watch([keyword, sortMode, pageSize], () => (page.value = 1))
watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})

// ── 通用 ──
function askConfirm(request: ConfirmRequest) {
  // 新确认框顶替旧的时视为取消旧的，避免等待中的离开确认永远不返回。
  const previous = confirmRequest.value
  confirmRequest.value = request
  previous?.onCancel?.()
}
function askText(request: PromptRequest) {
  promptValue.value = request.value
  promptRequest.value = request
}
async function submitPrompt() {
  const request = promptRequest.value
  if (!request) return
  promptRequest.value = null
  await request.action(promptValue.value)
}
async function runConfirm() {
  const request = confirmRequest.value
  confirmRequest.value = null
  await request?.action()
}
function cancelConfirm() {
  const request = confirmRequest.value
  confirmRequest.value = null
  request?.onCancel?.()
}
/** 有未保存修改时先确认；确认后放弃修改再执行。供页面切换分区时调用。 */
async function guard(action: () => void | Promise<void>) {
  if (await confirmLeave()) await action()
}
/**
 * 离开提示词页时的确认：没有未保存修改直接放行；同一时间只弹出一个确认框。
 * 确认后不清除未保存标记：离开失败时修改仍在，下次离开会再次提醒；成功时由换书或卸载自然清除。
 */
let pendingLeave: Promise<boolean> | null = null
function confirmLeave(): Promise<boolean> {
  if (!dirty.value) return Promise.resolve(true)
  pendingLeave ??= new Promise<boolean>((resolve) => {
    askConfirm({
      title: __t('ui.worldbook', '放弃未保存的修改？'),
      message: __t('ui.worldbook', '「{0}」有未保存的修改，继续操作将丢弃这些修改。', [
        draft.value?.name ?? '',
      ]),
      confirmText: __t('ui.worldbook', '放弃修改'),
      danger: true,
      action: () => resolve(true),
      onCancel: () => resolve(false),
    })
  }).finally(() => {
    pendingLeave = null
  })
  return pendingLeave
}
function touch() {
  dirty.value = true
  editVersion++
}
function downloadJson(value: unknown, name: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[\\/:*?"<>|]+/g, '_') || 'worldbook'}.json`
  try {
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
function suffixName(base: string, n: number) {
  const tail = ` (${n})`
  return `${base.slice(0, WORLDBOOK_LIMITS.name - tail.length)}${tail}`
}
/** 名称重复时依次追加「 (2)」「 (3)」…，本地已知的重名直接跳过以减少请求。 */
async function withUniqueName<T>(base: string, work: (name: string) => Promise<T>): Promise<T> {
  const known = new Set(books.value.map((item) => item.name))
  for (let n = 1; n <= 200; n++) {
    const name = n === 1 ? base : suffixName(base, n)
    if (known.has(name)) continue
    try {
      return await work(name)
    } catch (cause) {
      if (!isCode(cause, 'DUPLICATE_NAME')) throw cause
    }
  }
  throw new Error(__t('ui.worldbook', '无法生成不重复的名称'))
}
function checkBookLimit() {
  if (books.value.length < WORLDBOOK_LIMITS.books) return true
  notifications.toast(
    __t('ui.worldbook', '书库最多 {0} 本世界书', [WORLDBOOK_LIMITS.books]),
    'warning',
  )
  return false
}

// ── 书库加载 ──
async function loadLibrary() {
  libraryLoading.value = true
  libraryError.value = ''
  try {
    const response = await worldbookApi.list()
    books.value = response.data?.books ?? []
    settings.value = response.data?.settings ?? createWorldbookSettings()
    return true
  } catch (cause) {
    libraryError.value = errorText(cause)
    return false
  } finally {
    libraryLoading.value = false
  }
}
function syncSummary(next: Worldbook) {
  const summary: WorldbookSummary = {
    id: next.id,
    name: next.name,
    entryCount: next.entries.length,
    revision: next.revision,
    updatedAt: next.updatedAt,
  }
  const index = books.value.findIndex((item) => item.id === next.id)
  if (index >= 0) books.value.splice(index, 1, summary)
  else books.value.push(summary)
}

// ── 打开与保存 ──
function applyBook(next: Worldbook | null, reset: boolean) {
  book.value = next
  draft.value = next ? { name: next.name, entries: clone(next.entries) } : null
  dirty.value = false
  lastBookId = next?.id ?? null
  if (reset) {
    expanded.value = new Set()
    search.value = ''
    page.value = 1
  }
  if (next) syncSummary(next)
}
async function loadBook(id: string, reset = true) {
  const token = ++loadToken
  bookLoading.value = true
  bookError.value = ''
  failedBookId.value = id
  try {
    const response = await worldbookApi.get(id)
    if (token !== loadToken) return
    if (!response.data) throw new Error(__t('ui.worldbook', '未收到世界书数据'))
    applyBook(response.data, reset || book.value?.id !== id)
  } catch (cause) {
    if (token !== loadToken) return
    if (isCode(cause, 'NOT_FOUND')) {
      notifications.toast(__t('ui.worldbook', '世界书不存在或已被删除'), 'warning')
      books.value = books.value.filter((item) => item.id !== id)
      if (book.value?.id === id) applyBook(null, true)
    } else bookError.value = errorText(cause)
  } finally {
    if (token === loadToken) bookLoading.value = false
  }
}
/** 切换书；若书库中没有该书，先刷新书库（可能刚在其他页面创建）。 */
async function openBook(id: string) {
  if (!books.value.some((item) => item.id === id)) await loadLibrary()
  if (!books.value.some((item) => item.id === id)) {
    notifications.toast(__t('ui.worldbook', '世界书不存在或已被删除'), 'warning')
    return
  }
  await loadBook(id)
}
function switchBook(id: string) {
  // 移动条目等操作进行中不切换，避免结果落到另一本书上。
  if (id === book.value?.id || busy.value) return
  guard(() => openBook(id))
}
/** 提交焦点所在输入框中尚未提交的内容（数字与关键词在失焦时提交）。 */
async function flushPendingInput() {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.wb-editor')) {
    active.blur()
    await nextTick()
  }
}
async function save(): Promise<boolean> {
  await flushPendingInput()
  const current = book.value
  if (!current || !draft.value || saving.value) return false
  const name = normalizeWorldbookName(draft.value.name)
  if (!name) {
    notifications.toast(__t('ui.worldbook', '名称不能为空'), 'error')
    return false
  }
  const version = editVersion
  saving.value = true
  try {
    const response = await worldbookApi.save(current.id, {
      name,
      entries: draft.value.entries,
      revision: current.revision,
    })
    const next = response.data
    if (!next) throw new Error(__t('ui.worldbook', '未收到世界书数据'))
    if (book.value?.id !== current.id) return true
    if (version === editVersion) applyBook(next, false)
    else {
      // 保存期间又有新修改：只更新基准版本，保留本地草稿。
      book.value = next
      syncSummary(next)
    }
    notifications.toast(__t('ui.worldbook', '世界书已保存，立即生效'), 'success')
    return true
  } catch (cause) {
    if (isCode(cause, 'CONFLICT')) conflictOpen.value = true
    else if (isCode(cause, 'DUPLICATE_NAME'))
      notifications.toast(__t('ui.worldbook', '已有同名世界书「{0}」', [name]), 'error')
    else notifications.toast(__t('ui.worldbook', '保存失败：{0}', [errorText(cause)]), 'error')
    return false
  } finally {
    saving.value = false
  }
}
function refresh() {
  guard(async () => {
    await loadLibrary()
    if (book.value) await loadBook(book.value.id, false)
  })
}
async function reloadAfterConflict() {
  conflictOpen.value = false
  dirty.value = false
  await loadLibrary()
  if (book.value) await loadBook(book.value.id, false)
}

// ── 书操作 ──
function createBook() {
  if (!checkBookLimit()) return
  guard(() =>
    askText({
      title: __t('ui.worldbook', '新建世界书'),
      value: '',
      confirmText: __t('ui.worldbook', '创建'),
      action: async (value) => {
        const name = normalizeWorldbookName(value)
        if (!name) {
          notifications.toast(__t('ui.worldbook', '名称不能为空'), 'error')
          return
        }
        busy.value = true
        try {
          const response = await worldbookApi.create({ name })
          if (!response.data) throw new Error(__t('ui.worldbook', '未收到世界书数据'))
          applyBook(response.data, true)
          notifications.toast(__t('ui.worldbook', '已创建「{0}」', [name]), 'success')
        } catch (cause) {
          notifications.toast(
            isCode(cause, 'DUPLICATE_NAME')
              ? __t('ui.worldbook', '已有同名世界书「{0}」', [name])
              : __t('ui.worldbook', '创建失败：{0}', [errorText(cause)]),
            'error',
          )
        } finally {
          busy.value = false
        }
      },
    }),
  )
}
function startImport() {
  if (!checkBookLimit()) return
  guard(() => fileInput.value?.click())
}
const warningText: Record<WorldbookImportWarning, (count: number) => string> = {
  position_unified: (count) =>
    __t('ui.worldbook', '{0} 个条目原本的插入位置已统一为本轮上下文末尾。', [count]),
  secondary_keys_ignored: (count) => __t('ui.worldbook', '{0} 个条目的次要关键词已忽略。', [count]),
  regex_keys_literal: (count) =>
    __t('ui.worldbook', '{0} 个条目的正则关键词将按普通文字匹配。', [count]),
  entries_truncated: (count) =>
    __t('ui.worldbook', '超出 {1} 条上限，{0} 个条目未导入。', [count, WORLDBOOK_LIMITS.entries]),
  content_truncated: (count) =>
    __t('ui.worldbook', '{0} 个条目的正文、标题或关键词超出长度上限，已截断。', [count]),
}
async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  let parsed: ReturnType<typeof importSillyTavernWorldbook>
  try {
    parsed = importSillyTavernWorldbook(JSON.parse(await file.text()))
  } catch {
    notifications.toast(__t('ui.worldbook', '无法识别的世界书文件'), 'error')
    return
  }
  const base =
    normalizeWorldbookName(parsed.name || file.name.replace(/\.[^.]+$/, '')) ||
    __t('ui.worldbook', '导入的世界书')
  busy.value = true
  try {
    const created = await withUniqueName(base, async (name) => {
      const response = await worldbookApi.create({ name, entries: parsed.entries })
      if (!response.data) throw new Error(__t('ui.worldbook', '未收到世界书数据'))
      return response.data
    })
    applyBook(created, true)
    const warnings = (Object.keys(parsed.warnings) as WorldbookImportWarning[])
      .filter((key) => parsed.warnings[key])
      .map((key) => warningText[key](parsed.warnings[key]!))
    notifications.toast(
      [__t('ui.worldbook', '已导入 {0} 个条目。', [created.entries.length]), ...warnings].join(' '),
      {
        type: warnings.length ? 'warning' : 'success',
        title: __t('ui.worldbook', '已导入「{0}」', [created.name]),
        duration: warnings.length ? 9000 : 4000,
      },
    )
  } catch (cause) {
    notifications.toast(__t('ui.worldbook', '导入失败：{0}', [errorText(cause)]), 'error')
  } finally {
    busy.value = false
  }
}
/** 导出当前所见内容（含未保存修改），格式为酒馆世界书。 */
function exportBook() {
  if (!book.value || !draft.value) return
  downloadJson(
    exportWorldbookFile({ ...book.value, name: draft.value.name, entries: draft.value.entries }),
    draft.value.name,
  )
}
function renameBook() {
  if (!draft.value) return
  askText({
    title: __t('ui.worldbook', '重命名世界书'),
    message: dirty.value
      ? __t('ui.worldbook', '重命名会立即保存，当前未保存的条目修改也会一并保存。')
      : undefined,
    value: draft.value.name,
    confirmText: __t('ui.worldbook', '重命名'),
    action: async (value) => {
      const name = normalizeWorldbookName(value)
      if (!draft.value || name === draft.value.name) return
      if (!name) {
        notifications.toast(__t('ui.worldbook', '名称不能为空'), 'error')
        return
      }
      const previous = draft.value.name
      const wasDirty = dirty.value
      draft.value.name = name
      touch()
      if (!(await save()) && draft.value) {
        draft.value.name = previous
        dirty.value = wasDirty
      }
    },
  })
}
function duplicateBook() {
  const current = book.value
  if (!current || !checkBookLimit()) return
  const run = async () => {
    busy.value = true
    try {
      const copy = await withUniqueName(
        normalizeWorldbookName(__t('ui.worldbook', '{0} 副本', [current.name])),
        async (name) => {
          const response = await worldbookApi.duplicate(current.id, name)
          if (!response.data) throw new Error(__t('ui.worldbook', '未收到世界书数据'))
          return response.data
        },
      )
      syncSummary(copy)
      // 有未保存修改时不切换，避免丢失；否则直接打开副本。
      if (!dirty.value) applyBook(copy, true)
      notifications.toast(__t('ui.worldbook', '已复制为「{0}」', [copy.name]), 'success')
    } catch (cause) {
      notifications.toast(__t('ui.worldbook', '复制失败：{0}', [errorText(cause)]), 'error')
    } finally {
      busy.value = false
    }
  }
  if (!dirty.value) return void run()
  askConfirm({
    title: __t('ui.worldbook', '复制世界书'),
    message: __t('ui.worldbook', '副本基于已保存的版本，当前未保存的修改不会包含在内。'),
    confirmText: __t('ui.worldbook', '复制'),
    action: run,
  })
}
function deleteBook() {
  const current = book.value
  if (!current) return
  askConfirm({
    title: __t('ui.worldbook', '删除世界书'),
    message: __t(
      'ui.worldbook',
      '删除「{0}」？此操作无法撤销，它也会从全局启用列表和所有角色的绑定中移除。',
      [current.name],
    ),
    confirmText: __t('ui.worldbook', '删除'),
    danger: true,
    action: async () => {
      busy.value = true
      try {
        await worldbookApi.remove(current.id)
        applyBook(null, true)
        await loadLibrary()
        notifications.toast(__t('ui.worldbook', '已删除「{0}」', [current.name]), 'success')
        const next = sortedBooks.value[0]
        if (next) await loadBook(next.id)
      } catch (cause) {
        notifications.toast(__t('ui.worldbook', '删除失败：{0}', [errorText(cause)]), 'error')
      } finally {
        busy.value = false
      }
    },
  })
}

// ── 条目操作 ──
function findEntry(id: string) {
  return draft.value?.entries.find((entry) => entry.id === id)
}
function uniqueEntryId(taken: Set<string>) {
  let id = ''
  do id = `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  while (taken.has(id))
  return id
}
function nextOrder(entries: WorldbookEntry[]) {
  if (!entries.length) return 100
  return Math.min(WORLDBOOK_LIMITS.order, Math.max(...entries.map((entry) => entry.order)) + 10)
}
function checkEntryLimit(count: number) {
  if (count < WORLDBOOK_LIMITS.entries) return true
  notifications.toast(
    __t('ui.worldbook', '每本世界书最多 {0} 个条目', [WORLDBOOK_LIMITS.entries]),
    'warning',
  )
  return false
}
function patchEntry(id: string, patch: Partial<WorldbookEntry>) {
  const entry = findEntry(id)
  if (!entry) return
  Object.assign(entry, patch)
  touch()
}
/** 定位到条目所在页并滚动到可见位置。 */
async function reveal(id: string, focusTitle = false) {
  const index = displayed.value.findIndex((entry) => entry.id === id)
  if (index < 0) return
  if (pageSize.value) page.value = Math.floor(index / pageSize.value) + 1
  await nextTick()
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`)
  row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  if (focusTitle) row?.querySelector<HTMLInputElement>('.wb-row__title input')?.focus()
}
function addEntry() {
  const entries = draft.value?.entries
  if (!entries || !checkEntryLimit(entries.length)) return
  const entry = createWorldbookEntry(
    uniqueEntryId(new Set(entries.map((item) => item.id))),
    nextOrder(entries),
  )
  entries.push(entry)
  expanded.value.add(entry.id)
  search.value = ''
  touch()
  void reveal(entry.id, true)
}
function copyEntry(id: string) {
  const entries = draft.value?.entries
  const source = findEntry(id)
  if (!entries || !source || !checkEntryLimit(entries.length)) return
  const copy: WorldbookEntry = {
    ...clone(source),
    id: uniqueEntryId(new Set(entries.map((item) => item.id))),
    title: source.title
      ? __t('ui.worldbook', '{0} 副本', [source.title]).slice(0, WORLDBOOK_LIMITS.title)
      : '',
  }
  // 顺序值相同时按数组位置排列，插在原条目之后即可紧随其后显示。
  entries.splice(entries.indexOf(source) + 1, 0, copy)
  touch()
  void reveal(copy.id)
}
function removeEntry(id: string) {
  const entry = findEntry(id)
  if (!entry) return
  askConfirm({
    title: __t('ui.worldbook', '删除条目'),
    message: __t('ui.worldbook', '删除条目「{0}」？保存后生效。', [
      entry.title || __t('ui.worldbook', '未命名条目'),
    ]),
    confirmText: __t('ui.worldbook', '删除'),
    danger: true,
    action: () => {
      const entries = draft.value?.entries
      const index = entries?.findIndex((item) => item.id === id) ?? -1
      if (!entries || index < 0) return
      entries.splice(index, 1)
      expanded.value.delete(id)
      touch()
    },
  })
}
function toggleEntry(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}
function expandPage() {
  for (const entry of pageItems.value) expanded.value.add(entry.id)
}
function collapseAll() {
  expanded.value.clear()
}

// ── 拖动排序 ──
function onDragStart(id: string, event: DragEvent) {
  dragId.value = id
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragEnd() {
  dragId.value = null
  dropId.value = null
}
/**
 * 拖到目标行即占据目标位置。只在同一组（开启 / 关闭）内移动，
 * 组内原有顺序值互不重复时按新次序重新分配这些值，其余条目的顺序值不变；
 * 存在重复值时无法表达新次序，改为从组内最小值起以 10 为步长重新编号。
 */
function onDrop(targetId: string) {
  const sourceId = dragId.value
  onDragEnd()
  if (!sourceId || sourceId === targetId || !sortable.value) return
  const source = findEntry(sourceId)
  const target = findEntry(targetId)
  if (!source || !target) return
  if (source.enabled !== target.enabled) {
    notifications.toast(__t('ui.worldbook', '已关闭的条目固定显示在末尾，请在同组内拖动'), 'info')
    return
  }
  const group = displayed.value.filter((entry) => entry.enabled === source.enabled)
  const to = group.indexOf(target)
  group.splice(group.indexOf(source), 1)
  group.splice(to, 0, source)
  const values = group.map((entry) => entry.order).sort((a, b) => a - b)
  if (new Set(values).size === values.length)
    group.forEach((entry, i) => (entry.order = values[i]!))
  else {
    const step = 10
    const start = Math.max(
      -WORLDBOOK_LIMITS.order,
      Math.min(values[0]!, WORLDBOOK_LIMITS.order - (group.length - 1) * step),
    )
    group.forEach((entry, i) => (entry.order = start + i * step))
  }
  touch()
}

// ── 移动到其他书 ──
function startMove(id: string) {
  moveRequest.value = { entryId: id, target: otherBooks.value[0]?.id ?? '' }
}
/** 先写入目标书，成功后再从当前书移除并保存，任何一步失败都不会丢失条目。 */
async function commitMove() {
  const request = moveRequest.value
  const entry = request && findEntry(request.entryId)
  moveRequest.value = null
  const sourceId = book.value?.id
  if (!request || !entry || !request.target || !sourceId) return
  busy.value = true
  try {
    const response = await worldbookApi.get(request.target)
    const target = response.data
    if (!target) throw new Error(__t('ui.worldbook', '未收到世界书数据'))
    if (target.entries.length >= WORLDBOOK_LIMITS.entries)
      throw new Error(__t('ui.worldbook', '每本世界书最多 {0} 个条目', [WORLDBOOK_LIMITS.entries]))
    const taken = new Set(target.entries.map((item) => item.id))
    const moved: WorldbookEntry = {
      ...clone(entry),
      id: taken.has(entry.id) ? uniqueEntryId(taken) : entry.id,
      order: nextOrder(target.entries),
    }
    const saved = await worldbookApi.save(target.id, {
      name: target.name,
      entries: [...target.entries, moved],
      revision: target.revision,
    })
    if (saved.data) syncSummary(saved.data)
    // 期间换了书（例如角色页跳转）时不能按 ID 删除另一本书的同名条目。
    if (book.value?.id !== sourceId) {
      notifications.toast(
        __t('ui.worldbook', '条目已加入「{0}」，原书已切换，请回到原书手动删除该条目。', [
          target.name,
        ]),
        { type: 'warning', duration: 9000 },
      )
      return
    }
    const entries = draft.value?.entries
    const index = entries?.findIndex((item) => item.id === entry.id) ?? -1
    if (entries && index >= 0) {
      entries.splice(index, 1)
      expanded.value.delete(entry.id)
      touch()
    }
    if (await save())
      notifications.toast(__t('ui.worldbook', '已移动到「{0}」', [target.name]), 'success')
    else
      notifications.toast(
        __t('ui.worldbook', '条目已加入「{0}」，但当前书尚未保存；保存后才会从此处移除。', [
          target.name,
        ]),
        { type: 'warning', duration: 9000 },
      )
  } catch (cause) {
    notifications.toast(__t('ui.worldbook', '移动失败：{0}', [errorText(cause)]), 'error')
  } finally {
    busy.value = false
  }
}

// ── 跳转请求 ──
/** 处理角色页发来的跳转；返回是否已打开指定的书。 */
function consumeNavigation(): boolean {
  const target = navigation.value
  if (!ready.value || !target || target.revision <= handledNavigation) return false
  handledNavigation = target.revision
  navigationAgent.value = target.agentId
  navigationBound.value = Boolean(target.bookId)
  if (!target.bookId) return false
  if (target.bookId !== book.value?.id && !busy.value) guard(() => openBook(target.bookId!))
  return true
}
watch(navigation, () => void consumeNavigation())

function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}
let removeLeaveGuard: (() => void) | undefined
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  removeLeaveGuard = registerTabLeaveGuard(confirmLeave)
  await loadLibrary()
  ready.value = true
  if (consumeNavigation()) return
  const id =
    lastBookId && books.value.some((item) => item.id === lastBookId)
      ? lastBookId
      : sortedBooks.value[0]?.id
  if (id) await loadBook(id)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  removeLeaveGuard?.()
})

defineExpose({ guard, isDirty: () => dirty.value })
</script>

<template>
  <section class="wb-panel" :aria-busy="busy || saving" @keydown.ctrl.s.prevent="save()">
    <div v-if="libraryError" class="wb-banner" role="alert">
      <PixelIcon name="alert" size="sm" />
      <span>{{ __t('ui.worldbook', '读取书库失败：{0}', [libraryError]) }}</span>
      <PButton size="sm" variant="ghost" :disabled="libraryLoading" @click="loadLibrary">
        {{ __t('ui.worldbook', '重试') }}
      </PButton>
    </div>

    <div v-if="navigationAgentName" class="wb-banner info">
      <PixelIcon name="user" size="sm" />
      <span>
        {{
          navigationBound
            ? __t('ui.worldbook', '来自角色「{0}」的跳转；在角色档案中管理绑定关系。', [
                navigationAgentName,
              ])
            : __t('ui.worldbook', '角色「{0}」尚未绑定世界书，可在此创建后回到角色档案绑定。', [
                navigationAgentName,
              ])
        }}
      </span>
      <button
        class="wb-icon-button"
        type="button"
        :aria-label="__t('ui.worldbook', '关闭提示')"
        @click="navigationAgent = null"
      >
        <PixelIcon name="close" size="xs" />
      </button>
    </div>

    <!-- 全局启用 -->
    <WorldbookGlobalCard
      v-model:settings="settings"
      :books="sortedBooks"
      :loading="libraryLoading"
      :locked="busy"
      @open="switchBook"
    />

    <!-- 书栏 -->
    <section class="wb-bookbar">
      <WorldbookBookPicker
        icon="book"
        :books="sortedBooks"
        :selected="book ? [book.id] : []"
        :label="book ? (draft?.name ?? book.name) : ''"
        :placeholder="__t('ui.worldbook', '选择世界书')"
        :disabled="busy || (libraryLoading && !books.length)"
        @select="switchBook"
      />
      <PButton size="sm" variant="secondary" :disabled="busy" @click="createBook">
        <PixelIcon name="plus" size="xs" />
        {{ __t('ui.worldbook', '创建') }}
      </PButton>
      <PButton size="sm" variant="ghost" :disabled="busy" @click="startImport">
        <PixelIcon name="file" size="xs" />
        {{ __t('ui.worldbook', '导入') }}
      </PButton>
      <template v-if="book">
        <span class="wb-divider" aria-hidden="true" />
        <PButton size="sm" variant="ghost" :disabled="busy" @click="exportBook">
          <PixelIcon name="download" size="xs" />
          {{ __t('ui.worldbook', '导出') }}
        </PButton>
        <PButton size="sm" variant="ghost" :disabled="busy || saving" @click="renameBook">
          <PixelIcon name="pencil" size="xs" />
          {{ __t('ui.worldbook', '重命名') }}
        </PButton>
        <PButton size="sm" variant="ghost" :disabled="busy" @click="duplicateBook">
          <PixelIcon name="copy" size="xs" />
          {{ __t('ui.worldbook', '复制') }}
        </PButton>
        <PButton size="sm" variant="danger" :disabled="busy" @click="deleteBook">
          <PixelIcon name="trash" size="xs" />
          {{ __t('ui.worldbook', '删除') }}
        </PButton>
      </template>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        hidden
        @change="onImportFile"
      />
    </section>

    <!-- 编辑区 -->
    <div v-if="bookError" class="wb-banner" role="alert">
      <PixelIcon name="alert" size="sm" />
      <span>{{ __t('ui.worldbook', '读取世界书失败：{0}', [bookError]) }}</span>
      <PButton
        size="sm"
        variant="ghost"
        :disabled="bookLoading"
        @click="failedBookId && loadBook(failedBookId)"
      >
        {{ __t('ui.worldbook', '重试') }}
      </PButton>
    </div>
    <p v-if="(libraryLoading || bookLoading) && !draft" class="wb-loading">
      <PixelIcon name="loader" size="sm" animation="spin" />
      {{ __t('ui.worldbook', '正在载入……') }}
    </p>
    <section v-else-if="!draft && !bookError && !libraryError" class="wb-card surface wb-empty">
      <PEmpty
        :description="
          books.length
            ? __t('ui.worldbook', '选择一本世界书开始编辑')
            : __t('ui.worldbook', '书库里还没有世界书，创建一本或导入酒馆世界书开始吧')
        "
      />
      <div v-if="!books.length" class="wb-empty__actions">
        <PButton size="sm" @click="createBook">{{ __t('ui.worldbook', '创建世界书') }}</PButton>
        <PButton size="sm" variant="secondary" @click="startImport">
          {{ __t('ui.worldbook', '导入') }}
        </PButton>
      </div>
    </section>

    <section v-if="draft" class="wb-card wb-editor surface" :inert="busy">
      <header class="wb-editor__head">
        <div class="wb-editor__title">
          <h3>{{ draft.name }}</h3>
          <span class="wb-meta">
            {{ __t('ui.worldbook', '{0} 个条目 · {1} 个启用', [entryCount, enabledCount]) }}
          </span>
          <span class="wb-status" :class="{ changed: dirty }">
            {{ dirty ? __t('ui.worldbook', '未保存') : __t('ui.worldbook', '已保存') }}
          </span>
        </div>
        <div class="wb-editor__actions">
          <PButton size="sm" variant="ghost" :disabled="bookLoading || saving" @click="refresh">
            <PixelIcon name="refresh" size="xs" />
            {{ __t('ui.worldbook', '刷新') }}
          </PButton>
          <PButton
            size="sm"
            :variant="testOpen ? 'secondary' : 'ghost'"
            :aria-pressed="testOpen"
            @click="testOpen = !testOpen"
          >
            <PixelIcon name="flash" size="xs" />
            {{ __t('ui.worldbook', '命中测试') }}
          </PButton>
          <PButton size="sm" :disabled="saving || !dirty" :loading="saving" @click="save()">
            <PixelIcon name="save" size="xs" />
            {{ __t('ui.worldbook', '保存') }}
          </PButton>
        </div>
      </header>

      <Transition name="wb-fold">
        <div v-if="testOpen" class="wb-test-box">
          <WorldbookHitTest :book-id="book?.id ?? ''" :entries="draft.entries" />
        </div>
      </Transition>

      <div class="wb-toolbar">
        <PButton size="sm" variant="secondary" @click="addEntry">
          <PixelIcon name="plus" size="xs" />
          {{ __t('ui.worldbook', '新建条目') }}
        </PButton>
        <button type="button" class="wb-tool" :disabled="!pageItems.length" @click="expandPage">
          <PixelIcon name="maximize" size="xs" />
          {{ __t('ui.worldbook', '全部展开') }}
        </button>
        <button type="button" class="wb-tool" :disabled="!expanded.size" @click="collapseAll">
          <PixelIcon name="minimize" size="xs" />
          {{ __t('ui.worldbook', '全部折叠') }}
        </button>
        <label class="wb-search">
          <PixelIcon name="search" size="xs" />
          <input
            v-model="search"
            :placeholder="__t('ui.worldbook', '搜索标题、内容、关键词')"
            :aria-label="__t('ui.worldbook', '搜索条目')"
            @keydown.esc="search = ''"
          />
          <small v-if="keyword" class="wb-search__count">
            {{ __t('ui.worldbook', '{0} 条匹配', [matched.length]) }}
          </small>
          <button
            v-if="search"
            type="button"
            class="wb-icon-button"
            :aria-label="__t('ui.worldbook', '清除搜索')"
            @click="search = ''"
          >
            <PixelIcon name="close" size="xs" />
          </button>
        </label>
        <PSelect
          class="wb-sort"
          :model-value="sortMode"
          :options="sortOptions"
          size="sm"
          teleport
          @update:model-value="sortMode = $event as SortMode"
        />
        <div class="wb-pager">
          <span class="wb-meta">{{ rangeLabel }}</span>
          <button
            type="button"
            class="wb-icon-button"
            :disabled="page <= 1"
            :aria-label="__t('ui.worldbook', '第一页')"
            @click="page = 1"
          >
            «
          </button>
          <button
            type="button"
            class="wb-icon-button"
            :disabled="page <= 1"
            :aria-label="__t('ui.worldbook', '上一页')"
            @click="page--"
          >
            <PixelIcon name="chevron-left" size="xs" />
          </button>
          <span class="wb-meta">{{ page }} / {{ pageCount }}</span>
          <button
            type="button"
            class="wb-icon-button"
            :disabled="page >= pageCount"
            :aria-label="__t('ui.worldbook', '下一页')"
            @click="page++"
          >
            <PixelIcon name="chevron-right" size="xs" />
          </button>
          <button
            type="button"
            class="wb-icon-button"
            :disabled="page >= pageCount"
            :aria-label="__t('ui.worldbook', '最后一页')"
            @click="page = pageCount"
          >
            »
          </button>
          <PSelect
            class="wb-page-size"
            :model-value="pageSize"
            :options="pageSizeOptions"
            size="sm"
            teleport
            @update:model-value="pageSize = Number($event)"
          />
        </div>
      </div>

      <div class="wb-table-wrap">
        <div class="wb-table" role="table" :aria-label="__t('ui.worldbook', '条目列表')">
          <div class="wb-table__head" role="row">
            <span />
            <span />
            <span>{{ __t('ui.worldbook', '触发策略') }}</span>
            <span>{{ __t('ui.worldbook', '标题（备忘）') }}</span>
            <span class="num wb-order-head">
              {{ __t('ui.worldbook', '顺序') }}
              <span
                class="wb-order-help"
                tabindex="0"
                :title="
                  __t(
                    'ui.worldbook',
                    '激活的条目按顺序合并为一段，放在本轮上下文末尾，不影响提示词缓存。',
                  )
                "
                :aria-label="
                  __t(
                    'ui.worldbook',
                    '激活的条目按顺序合并为一段，放在本轮上下文末尾，不影响提示词缓存。',
                  )
                "
              >
                <PixelIcon name="info" size="xs" />
              </span>
            </span>
            <span class="num">{{ __t('ui.worldbook', '触发概率') }}</span>
            <span class="num">{{ __t('ui.worldbook', '操作') }}</span>
          </div>
          <WorldbookEntryRow
            v-for="entry in pageItems"
            :key="entry.id"
            :entry="entry"
            :expanded="expanded.has(entry.id)"
            :sortable="sortable"
            :drop-target="dropId === entry.id && dragId !== entry.id"
            :can-move="otherBooks.length > 0"
            @update="patchEntry(entry.id, $event)"
            @pending="touch"
            @toggle="toggleEntry(entry.id)"
            @copy="copyEntry(entry.id)"
            @move="startMove(entry.id)"
            @remove="removeEntry(entry.id)"
            @dragstart="onDragStart(entry.id, $event)"
            @dragend="onDragEnd"
            @dragover="dropId = entry.id"
            @drop="onDrop(entry.id)"
          />
        </div>
        <div v-if="!entryCount" class="wb-table__empty">
          <p>{{ __t('ui.worldbook', '这本世界书还没有条目') }}</p>
          <PButton size="sm" variant="secondary" @click="addEntry">
            {{ __t('ui.worldbook', '新建条目') }}
          </PButton>
        </div>
        <p v-else-if="!displayed.length" class="wb-table__empty">
          {{ __t('ui.worldbook', '没有匹配「{0}」的条目', [search.trim()]) }}
        </p>
      </div>
      <p class="wb-footnote">
        <PixelIcon name="info" size="xs" />
        <span>
          {{
            __t(
              'ui.worldbook',
              '激活的条目按顺序合并为一段，放在本轮上下文末尾，不影响提示词缓存。',
            )
          }}
          <template v-if="entryCount && !sortable">
            {{ __t('ui.worldbook', '切换到「自定义」排序并清空搜索后可拖动调整顺序。') }}
          </template>
        </span>
      </p>
    </section>

    <!-- 确认 -->
    <PDialog
      :model-value="Boolean(confirmRequest)"
      :title="confirmRequest?.title"
      :message="confirmRequest?.message"
      :confirm-text="confirmRequest?.confirmText"
      :confirm-variant="confirmRequest?.danger ? 'danger' : 'primary'"
      @update:model-value="!$event && cancelConfirm()"
      @confirm="runConfirm"
      @cancel="cancelConfirm"
    />
    <!-- 输入名称 -->
    <PDialog
      :model-value="Boolean(promptRequest)"
      :title="promptRequest?.title"
      width="min(460px, calc(100vw - 48px))"
      @update:model-value="!$event && (promptRequest = null)"
    >
      <div class="wb-dialog">
        <p v-if="promptRequest?.message" class="wb-muted">{{ promptRequest.message }}</p>
        <input
          v-model="promptValue"
          class="wb-dialog__input"
          :maxlength="WORLDBOOK_LIMITS.name"
          :placeholder="__t('ui.worldbook', '世界书名称')"
          :aria-label="__t('ui.worldbook', '世界书名称')"
          autofocus
          @keydown.enter.prevent="submitPrompt"
        />
      </div>
      <template #footer>
        <PButton size="sm" variant="secondary" @click="promptRequest = null">
          {{ __t('ui.worldbook', '取消') }}
        </PButton>
        <PButton size="sm" :disabled="!promptValue.trim()" @click="submitPrompt">
          {{ promptRequest?.confirmText }}
        </PButton>
      </template>
    </PDialog>
    <!-- 移动条目 -->
    <PDialog
      :model-value="Boolean(moveRequest)"
      :title="__t('ui.worldbook', '移动到其他书')"
      width="min(480px, calc(100vw - 48px))"
      @update:model-value="!$event && (moveRequest = null)"
    >
      <div v-if="moveRequest" class="wb-dialog">
        <p class="wb-muted">
          {{
            __t(
              'ui.worldbook',
              '条目会追加到目标书末尾并立即保存；随后保存当前书（包括其他未保存的修改）。',
            )
          }}
        </p>
        <PSelect
          :model-value="moveRequest.target"
          :options="otherBooks.map((item) => ({ value: item.id, label: item.name }))"
          :placeholder="__t('ui.worldbook', '选择目标世界书')"
          teleport
          @update:model-value="moveRequest && (moveRequest.target = String($event))"
        />
      </div>
      <template #footer>
        <PButton size="sm" variant="secondary" @click="moveRequest = null">
          {{ __t('ui.worldbook', '取消') }}
        </PButton>
        <PButton size="sm" :disabled="!moveRequest?.target" @click="commitMove">
          {{ __t('ui.worldbook', '移动') }}
        </PButton>
      </template>
    </PDialog>
    <!-- 保存冲突 -->
    <PDialog
      v-model="conflictOpen"
      :title="__t('ui.worldbook', '世界书已在别处修改')"
      width="min(520px, calc(100vw - 48px))"
    >
      <p class="wb-dialog__text">
        {{
          __t(
            'ui.worldbook',
            '另一个窗口已保存了这本世界书。重新载入会丢弃这里未保存的修改，可以先导出当前内容备份。',
          )
        }}
      </p>
      <template #footer>
        <PButton size="sm" variant="secondary" @click="conflictOpen = false">
          {{ __t('ui.worldbook', '取消') }}
        </PButton>
        <PButton size="sm" variant="ghost" @click="exportBook">
          {{ __t('ui.worldbook', '导出备份') }}
        </PButton>
        <PButton size="sm" variant="danger" @click="reloadAfterConflict">
          {{ __t('ui.worldbook', '重新载入') }}
        </PButton>
      </template>
    </PDialog>
  </section>
</template>

<style scoped>
.wb-panel {
  --wb-columns: 32px 32px 112px minmax(160px, 1fr) 76px 80px 112px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  font-size: 14px;
}
/* 与提示词页的 .surface 面板保持一致：方角、细描边、轻量像素投影。 */
.surface {
  background: var(--dash-panel-bg, var(--ui-bg-surface));
  border: 2px solid var(--ui-border-default);
  box-shadow: 4px 4px 0 color-mix(in srgb, var(--ui-border-default) 55%, transparent);
  transition:
    background-color 0.2s,
    border-color 0.2s,
    box-shadow 0.2s;
}
.wb-card {
  padding: 16px 20px;
}
.wb-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font: 700 16px/1.5 var(--ui-font-pixel);
}
.wb-muted {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text-tertiary);
}
.wb-meta {
  font: 400 12px/1.5 var(--ui-font-mono);
  color: var(--ui-text-tertiary);
  white-space: nowrap;
}
.wb-label {
  font: 700 12px/1.5 var(--ui-font-pixel);
  color: var(--ui-text-secondary);
}
.wb-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-left: 3px solid var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
  font-size: 13px;
}
.wb-banner > span {
  flex: 1;
  min-width: 0;
}
.wb-banner.info {
  border-left-color: var(--ui-accent-sky);
  background: color-mix(in srgb, var(--ui-accent-sky) 8%, transparent);
}
.wb-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  color: var(--ui-text-secondary);
  transition: color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-icon-button:hover:not(:disabled) {
  color: var(--ui-accent-sky);
}
.wb-icon-button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* 书栏 */
.wb-bookbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.wb-divider {
  width: 1px;
  height: 22px;
  margin: 0 4px;
  background: var(--ui-border-default);
}
.wb-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  padding: 48px 0;
  color: var(--ui-text-tertiary);
}
.wb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 20px;
}
.wb-empty__actions {
  display: flex;
  gap: 8px;
}

/* 编辑区 */
.wb-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0;
}
.wb-editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 20px 0;
}
.wb-editor__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}
.wb-editor__title h3 {
  overflow-wrap: anywhere;
}
.wb-editor__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-status {
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-tertiary);
  font: 700 11px/1.5 var(--ui-font-pixel);
  padding: 2px 8px;
}
.wb-status.changed {
  color: var(--ui-accent-primary);
  border-color: currentColor;
}
.wb-test-box {
  margin: 0 20px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border-subtle);
  background: color-mix(in srgb, var(--ui-bg-surface-soft) 70%, transparent);
}
.wb-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 0 20px;
}
.wb-tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  font-size: 13px;
  color: var(--ui-text-secondary);
  transition:
    color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-tool:hover:not(:disabled) {
  color: var(--ui-accent-sky);
  background: color-mix(in srgb, var(--ui-accent-sky) 8%, transparent);
}
.wb-tool:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.wb-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 220px;
  min-width: 180px;
  height: 34px;
  padding: 0 4px 0 10px;
  background: var(--dash-input-bg);
  border: 1px solid var(--dash-input-border, var(--ui-border-default));
  color: var(--ui-text-tertiary);
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-search:focus-within {
  border-color: var(--ui-accent-sky);
  box-shadow: 0 0 0 1px var(--ui-accent-sky);
}
.wb-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--ui-text-primary);
  font-size: 13px;
}
.wb-search__count {
  font: 400 11px/1 var(--ui-font-mono);
  white-space: nowrap;
  color: var(--ui-accent-sky);
}
.wb-sort {
  width: 170px;
}
.wb-pager {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.wb-pager > .wb-meta {
  padding: 0 6px;
}
.wb-page-size {
  width: 104px;
  margin-left: 6px;
}

/* 条目表格 */
.wb-table-wrap {
  overflow-x: auto;
  border-top: 1px solid var(--ui-border-subtle);
}
.wb-table {
  min-width: 620px;
}
.wb-table__head {
  display: grid;
  grid-template-columns: var(--wb-columns);
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ui-border-default);
  background: color-mix(in srgb, var(--ui-bg-surface-soft) 60%, transparent);
  font: 700 11px/1.5 var(--ui-font-pixel);
  color: var(--ui-text-tertiary);
  white-space: nowrap;
}
.wb-table__head .num {
  text-align: right;
}
.wb-order-head {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.wb-order-help {
  display: inline-flex;
  color: var(--ui-text-tertiary);
  cursor: help;
}
.wb-order-help:hover,
.wb-order-help:focus-visible {
  color: var(--ui-accent-sky);
}
.wb-table__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin: 0;
  padding: 40px 20px;
  color: var(--ui-text-tertiary);
  font-size: 13px;
}
.wb-table__empty p {
  margin: 0;
}
.wb-footnote {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.6;
  margin: 0;
  padding: 0 20px 14px;
  font-size: 12px;
  color: var(--ui-text-tertiary);
}

/* 对话框 */
.wb-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wb-dialog__input {
  height: 36px;
  padding: 0 10px;
  background: var(--dash-input-bg);
  border: 2px solid var(--dash-input-border, var(--ui-border-default));
  color: var(--ui-text-primary);
  outline: none;
  font-size: 14px;
}
.wb-dialog__input:focus {
  border-color: var(--ui-accent-sky);
}
.wb-dialog__text {
  margin: 0;
  line-height: 1.7;
}

.wb-fold-enter-active,
.wb-fold-leave-active {
  transition:
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-fold-enter-from,
.wb-fold-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (max-width: 800px) {
  .wb-card {
    padding: 14px 16px;
  }
  .wb-editor__head,
  .wb-toolbar,
  .wb-footnote {
    padding-left: 16px;
    padding-right: 16px;
  }
  .wb-test-box {
    margin: 0 16px;
  }
  .wb-pager {
    margin-left: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wb-fold-enter-active,
  .wb-fold-leave-active {
    transition: none;
  }
}
</style>
