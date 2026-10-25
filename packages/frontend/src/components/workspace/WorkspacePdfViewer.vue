<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type ComponentPublicInstance,
} from 'vue'
import { getDocument, GlobalWorkerOptions, PasswordResponses } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { WorkspacePreviewState } from './workspacePreview'
import WorkspacePdfPage from './WorkspacePdfPage.vue'
import { getApiBaseUrl, getApiResourceHeaders } from '../../api/transport'
import { t as __t } from '../../i18n/index'

const props = defineProps<{ src: string; state: WorkspacePreviewState }>()
const emit = defineEmits<{
  error: [message: string]
  state: [patch: Partial<WorkspacePreviewState>]
}>()
GlobalWorkerOptions.workerSrc = workerUrl
const pdf = shallowRef<PDFDocumentProxy | null>(null)
const stage = ref<HTMLElement | null>(null)
const loading = ref(true),
  pageCount = ref(0),
  width = ref(720)
const firstSize = ref({ width: 595, height: 842 })
const pageSizes = ref(new Map<number, { width: number; height: number }>())
const nearbyPages = ref(new Set<number>())
const password = ref(''),
  passwordRequired = ref(false),
  passwordError = ref(false)
const query = ref(''),
  searching = ref(false),
  searchMessage = ref('')
const pageInput = ref(props.state.page)
const layout = computed(() => props.state.pdfLayout ?? 'continuous')
const pages = computed(() =>
  !pdf.value
    ? []
    : layout.value === 'single'
      ? [props.state.page]
      : Array.from({ length: pageCount.value }, (_, index) => index + 1),
)
const zoomLabel = computed(() =>
  props.state.zoom ? `${Math.round(props.state.zoom * 100)}%` : __t('ui.workspace', '适应宽度'),
)
const pageElements = new Map<number, HTMLElement>()
const cachedText = new Map<number, string>()
let passwordCallback: ((value: string) => void) | undefined
let loadingTask: PDFDocumentLoadingTask | undefined
let loadRevision = 0,
  searchRevision = 0,
  navigationRevision = 0
let observer: ResizeObserver | undefined
let pageObserver: IntersectionObserver | undefined
let scrollTimer: ReturnType<typeof setTimeout> | undefined
let restoring = false
let lastMatch: { term: string; page: number } | undefined

function metrics(number: number) {
  const original = pageSizes.value.get(number) ?? firstSize.value
  const scale = props.state.zoom || Math.max(0.1, width.value / original.width)
  return { width: original.width * scale, height: original.height * scale }
}
function setPageElement(number: number, element: Element | ComponentPublicInstance | null) {
  const previous = pageElements.get(number)
  if (previous === element) return
  if (previous) pageObserver?.unobserve(previous)
  if (element instanceof HTMLElement) {
    pageElements.set(number, element)
    pageObserver?.observe(element)
  } else {
    pageElements.delete(number)
  }
}
function setPageSize(number: number, size: { width: number; height: number }) {
  const previous = pageSizes.value.get(number)
  if (previous?.width !== size.width || previous.height !== size.height)
    pageSizes.value.set(number, size)
}
function recordScroll() {
  const element = stage.value
  if (!element || !pdf.value || restoring) return
  let current = props.state.page
  if (layout.value === 'continuous') {
    const offset = element.scrollTop + Math.min(120, element.clientHeight / 4)
    let low = 1,
      high = pageCount.value
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const top = pageElements.get(middle)?.offsetTop ?? Infinity
      if (top <= offset) {
        current = middle
        low = middle + 1
      } else high = middle - 1
    }
  }
  emit('state', { page: current, pdfScrollTop: element.scrollTop })
}
function scrolled() {
  if (scrollTimer || restoring) return
  scrollTimer = setTimeout(() => {
    scrollTimer = undefined
    recordScroll()
  }, 100)
}
async function go(number: number) {
  if (!Number.isFinite(number) || !pageCount.value) return
  const revision = ++navigationRevision
  const target = Math.max(1, Math.min(pageCount.value, Math.trunc(number)))
  restoring = true
  emit('state', { page: target })
  pageInput.value = target
  await nextTick()
  if (revision !== navigationRevision) return
  if (stage.value) {
    stage.value.scrollTop =
      layout.value === 'continuous'
        ? Math.max(0, (pageElements.get(target)?.offsetTop ?? 24) - 24)
        : 0
    stage.value.scrollLeft = 0
    emit('state', { pdfScrollTop: stage.value.scrollTop })
  }
  restoring = false
}
function zoom(direction: number) {
  const original = pageSizes.value.get(props.state.page) ?? firstSize.value
  const current = props.state.zoom || Math.max(0.1, width.value / original.width)
  emit('state', { zoom: Math.min(4, Math.max(0.25, current * (direction > 0 ? 1.25 : 0.8))) })
}
function changeLayout(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'continuous' || value === 'single')
    emit('state', { pdfLayout: value, pdfScrollTop: 0 })
}
async function load() {
  const revision = ++loadRevision
  ++searchRevision
  ++navigationRevision
  if (scrollTimer) clearTimeout(scrollTimer)
  scrollTimer = undefined
  restoring = true
  const previous = loadingTask
  loadingTask = undefined
  pdf.value = null
  pageCount.value = 0
  cachedText.clear()
  pageSizes.value.clear()
  nearbyPages.value = new Set()
  lastMatch = undefined
  searching.value = false
  searchMessage.value = ''
  loading.value = true
  passwordRequired.value = false
  passwordCallback = undefined
  await previous?.destroy().catch(() => undefined)
  if (revision !== loadRevision) return
  try {
    const assets = new URL('pdf-assets/', document.baseURI).href
    const task = getDocument({
      url: props.src,
      httpHeaders: getApiResourceHeaders(props.src),
      withCredentials:
        new URL(props.src, getApiBaseUrl()).origin === new URL(getApiBaseUrl()).origin,
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      disableStream: true,
      disableAutoFetch: true,
      enableXfa: false,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
    })
    loadingTask = task
    task.onPassword = (callback: (value: string) => void, reason: number) => {
      if (revision !== loadRevision) return
      passwordCallback = callback
      passwordRequired.value = true
      passwordError.value = reason === PasswordResponses.INCORRECT_PASSWORD
      loading.value = false
    }
    const documentProxy = await task.promise
    if (revision !== loadRevision) return
    const firstPage = await documentProxy.getPage(1)
    if (revision !== loadRevision) return
    const viewport = firstPage.getViewport({ scale: 1 })
    firstSize.value = { width: viewport.width, height: viewport.height }
    pageCount.value = documentProxy.numPages
    const page = Math.max(1, Math.min(pageCount.value, props.state.page))
    const savedTop = props.state.pdfScrollTop
    emit('state', { page })
    pageInput.value = page
    pdf.value = documentProxy
    loading.value = false
    passwordRequired.value = false
    password.value = ''
    passwordCallback = undefined
    await nextTick()
    if (revision !== loadRevision) return
    if (stage.value && savedTop !== undefined) {
      stage.value.scrollTop = savedTop
      restoring = false
      recordScroll()
    } else {
      await go(page)
    }
  } catch (error) {
    if (revision !== loadRevision) return
    loading.value = false
    restoring = false
    emit(
      'error',
      error instanceof Error && /409/.test(error.message)
        ? __t('ui.workspace', '文件已变化，请重新载入预览')
        : __t('ui.workspace', 'PDF 无法读取，请重新载入或用系统应用打开'),
    )
  }
}
function unlock() {
  if (password.value && passwordCallback) {
    loading.value = true
    passwordRequired.value = false
    passwordCallback(password.value)
    password.value = ''
  }
}
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
async function search(direction = 1) {
  const documentProxy = pdf.value,
    term = normalize(query.value)
  if (!documentProxy || !term || searching.value) return
  const revision = ++searchRevision
  const startPage = props.state.page
  const offset = lastMatch?.term === term && lastMatch.page === startPage ? 1 : 0
  searching.value = true
  searchMessage.value = ''
  try {
    for (let step = 0; step < pageCount.value; step++) {
      const candidate =
        ((startPage - 1 + direction * (step + offset) + pageCount.value) % pageCount.value) + 1
      let text = cachedText.get(candidate)
      if (text === undefined) {
        const page = await documentProxy.getPage(candidate)
        if (revision !== searchRevision) return
        const content = await page.getTextContent()
        if (revision !== searchRevision) return
        text = normalize(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
        if (cachedText.size >= 6) cachedText.delete(cachedText.keys().next().value!)
        cachedText.set(candidate, text)
      }
      if (text.includes(term)) {
        lastMatch = { term, page: candidate }
        await go(candidate)
        if (revision === searchRevision)
          searchMessage.value = __t('ui.workspace', '第 {0} 页', [candidate])
        return
      }
    }
    searchMessage.value = __t('ui.workspace', '未找到')
  } catch {
    if (revision === searchRevision) searchMessage.value = __t('ui.workspace', '查找失败')
  } finally {
    if (revision === searchRevision) searching.value = false
  }
}
watch(query, () => {
  ++searchRevision
  searching.value = false
  searchMessage.value = ''
  lastMatch = undefined
})
watch(
  () => props.state.page,
  (page) => {
    pageInput.value = page
  },
)
watch([width, () => props.state.zoom, layout], async (_value, previous) => {
  if (!pdf.value || restoring) return
  const current = props.state.page
  const anchor = pageElements.get(current)
  const sameLayout = layout.value === previous[2]
  const fraction =
    anchor && stage.value && sameLayout
      ? (stage.value.scrollTop - anchor.offsetTop) / Math.max(1, anchor.offsetHeight)
      : 0
  const revision = ++navigationRevision
  restoring = true
  await nextTick()
  if (revision !== navigationRevision) return
  const updated = pageElements.get(current)
  if (stage.value && updated) {
    stage.value.scrollTop = Math.max(
      0,
      updated.offsetTop + (sameLayout ? fraction * updated.offsetHeight : -24),
    )
    emit('state', { pdfScrollTop: stage.value.scrollTop })
  }
  restoring = false
})
watch(
  () => props.src,
  () => void load(),
  { immediate: true },
)
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry?.contentRect.width) width.value = Math.max(1, entry.contentRect.width)
  })
  if (stage.value) observer.observe(stage.value)
  if (typeof IntersectionObserver !== 'undefined') {
    pageObserver = new IntersectionObserver(
      (entries) => {
        const next = new Set(nearbyPages.value)
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.page)
          if (entry.isIntersecting) next.add(number)
          else next.delete(number)
        }
        nearbyPages.value = next
      },
      { root: stage.value, rootMargin: '600px 0px' },
    )
    for (const element of pageElements.values()) pageObserver.observe(element)
  }
})
onBeforeUnmount(() => {
  recordScroll()
  ++loadRevision
  ++searchRevision
  ++navigationRevision
  if (scrollTimer) clearTimeout(scrollTimer)
  observer?.disconnect()
  pageObserver?.disconnect()
  void loadingTask?.destroy().catch(() => undefined)
  passwordCallback = undefined
})
</script>
<template>
  <div class="workspace-pdf">
    <div class="file-view-controls">
      <button
        type="button"
        :disabled="!pdf || state.page <= 1"
        :aria-label="__t('ui.workspace', '上一页')"
        @click="go(state.page - 1)"
      >
        ‹
      </button>
      <input
        v-model.number="pageInput"
        type="number"
        min="1"
        :max="pageCount || 1"
        :disabled="!pdf"
        :aria-label="__t('ui.workspace', '页码')"
        @change="go(Number(pageInput))"
        @keydown.enter.prevent="go(Number(pageInput))"
      />
      <span>/ {{ pageCount || '—' }}</span>
      <button
        type="button"
        :disabled="!pdf || state.page >= pageCount"
        :aria-label="__t('ui.workspace', '下一页')"
        @click="go(state.page + 1)"
      >
        ›
      </button>
      <select
        :value="layout"
        :disabled="!pdf"
        :aria-label="__t('ui.workspace', '阅读布局')"
        @change="changeLayout"
      >
        <option value="continuous">{{ __t('ui.workspace', '连续滚动') }}</option>
        <option value="single">{{ __t('ui.workspace', '单页浏览') }}</option>
      </select>
      <button
        type="button"
        :disabled="!pdf"
        :aria-label="__t('ui.workspace', '缩小')"
        @click="zoom(-1)"
      >
        −
      </button>
      <button type="button" :disabled="!pdf" @click="emit('state', { zoom: 0 })">
        {{ zoomLabel }}
      </button>
      <button
        type="button"
        :disabled="!pdf"
        :aria-label="__t('ui.workspace', '放大')"
        @click="zoom(1)"
      >
        ＋
      </button>
      <span class="file-view-spacer" />
      <form class="workspace-pdf__search" @submit.prevent="search()">
        <input
          v-model="query"
          type="search"
          :placeholder="__t('ui.workspace', '查找文字')"
          :aria-label="__t('ui.workspace', '查找 PDF 文字')"
          :disabled="!pdf"
        />
        <button type="submit" :disabled="!pdf || !query || searching">
          {{ searching ? __t('ui.workspace', '查找中…') : __t('ui.workspace', '查找') }}
        </button>
      </form>
      <small v-if="searchMessage">{{ searchMessage }}</small>
    </div>
    <div ref="stage" class="workspace-pdf__stage" @scroll.passive="scrolled">
      <form
        v-if="passwordRequired"
        class="file-view-state file-view-password"
        @submit.prevent="unlock"
      >
        <span>
          {{
            passwordError
              ? __t('ui.workspace', '密码不正确，请重新输入')
              : __t('ui.workspace', '此 PDF 需要密码')
          }}
        </span>
        <input
          v-model="password"
          type="password"
          autocomplete="off"
          :aria-label="__t('ui.workspace', 'PDF 密码')"
        />
        <button class="workspace-pdf__unlock" type="submit">
          {{ __t('ui.workspace', '打开') }}
        </button>
      </form>
      <div v-if="loading" class="file-view-state">{{ __t('ui.workspace', '正在读取 PDF…') }}</div>
      <div
        v-for="number in pages"
        :key="number"
        :ref="(element) => setPageElement(number, element)"
        class="workspace-pdf__sheet"
        :data-page="number"
        :aria-label="__t('ui.workspace', '第 {0} 页', [number])"
        :style="{ width: `${metrics(number).width}px`, height: `${metrics(number).height}px` }"
      >
        <WorkspacePdfPage
          v-if="layout === 'single' || nearbyPages.has(number) || number === state.page"
          :document="pdf!"
          :page="number"
          :width="width"
          :zoom="state.zoom"
          :query="query"
          @size="setPageSize(number, $event)"
        />
        <span v-else class="workspace-pdf__placeholder" aria-hidden="true">{{ number }}</span>
      </div>
    </div>
  </div>
</template>
<style scoped>
.workspace-pdf {
  display: flex;
  min-height: 0;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.workspace-pdf__search {
  display: flex;
  gap: 4px;
}
.workspace-pdf__search input {
  width: 120px;
  min-width: 70px;
}
.workspace-pdf__stage {
  position: relative;
  min-height: 0;
  flex: 1;
  padding: 24px;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--ui-bg-surface-soft);
}
.workspace-pdf__sheet {
  position: relative;
  flex-shrink: 0;
  margin: 0 auto 20px;
  background: white;
  color-scheme: only light;
  box-shadow:
    1px 2px 0 var(--ui-border-default),
    3px 4px 0 var(--ui-border-subtle);
}
.workspace-pdf__sheet:last-child {
  margin-bottom: 0;
}
.workspace-pdf__placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #adb4c0;
  font: 12px var(--ui-font-mono);
}
.workspace-pdf__unlock {
  padding: 5px 14px;
  border: 1px solid var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  cursor: pointer;
}
</style>
