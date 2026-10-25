<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/types/src/display/api'
import { t as __t } from '../../i18n/index'

const props = defineProps<{
  document: PDFDocumentProxy
  page: number
  width: number
  zoom: number
  query: string
}>()
const emit = defineEmits<{ size: [size: { width: number; height: number }] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const textContainer = ref<HTMLElement | null>(null)
const rendering = ref(false)
const failure = ref(false)
const scale = ref({ scale: 1, totalScale: 1 })
let revision = 0
let disposed = false
let task: RenderTask | undefined
let layer: TextLayer | undefined
let renderedPage: PDFPageProxy | undefined

function highlight() {
  const normalize = (value: string) =>
    value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
  const term = normalize(props.query)
  for (const span of textContainer.value?.querySelectorAll('span') ?? [])
    span.classList.toggle(
      'workspace-pdf-match',
      !!term && normalize(span.textContent ?? '').includes(term),
    )
}

async function render() {
  const current = ++revision
  const previous = task
  previous?.cancel()
  layer?.cancel()
  rendering.value = true
  failure.value = false
  try {
    await previous?.promise.catch(() => undefined)
    if (disposed || current !== revision) return
    const targetPage = await props.document.getPage(props.page)
    if (disposed || current !== revision) return
    renderedPage = targetPage
    const original = targetPage.getViewport({ scale: 1 })
    emit('size', { width: original.width, height: original.height })
    const viewport = targetPage.getViewport({
      scale: props.zoom || Math.max(0.1, props.width / original.width),
    })
    scale.value = { scale: viewport.scale, totalScale: viewport.scale * viewport.userUnit }
    await nextTick()
    if (disposed || current !== revision || !canvas.value || !textContainer.value) return
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      2,
      Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
      8192 / viewport.width,
      8192 / viewport.height,
    )
    const target = canvas.value
    target.width = Math.max(1, Math.floor(viewport.width * ratio))
    target.height = Math.max(1, Math.floor(viewport.height * ratio))
    target.style.width = `${viewport.width}px`
    target.style.height = `${viewport.height}px`
    textContainer.value.replaceChildren()
    const renderTask = targetPage.render({
      canvas: target,
      viewport,
      transform: [ratio, 0, 0, ratio, 0, 0],
    })
    task = renderTask
    await renderTask.promise
    if (disposed || current !== revision || !textContainer.value) return
    const textLayer = new TextLayer({
      textContentSource: targetPage.streamTextContent(),
      container: textContainer.value,
      viewport,
    })
    layer = textLayer
    await textLayer.render()
    if (!disposed && current === revision) highlight()
  } catch (error) {
    if (
      !disposed &&
      current === revision &&
      !(error instanceof Error && error.name === 'RenderingCancelledException')
    )
      failure.value = true
  } finally {
    if (!disposed && current === revision) rendering.value = false
  }
}
watch(
  () => [props.document, props.page, props.width, props.zoom],
  () => void render(),
  {
    immediate: true,
  },
)
watch(() => props.query, highlight)
onBeforeUnmount(() => {
  disposed = true
  ++revision
  task?.cancel()
  layer?.cancel()
  const target = canvas.value
  const currentPage = renderedPage
  // 离开附近视口后释放位图与文字层，长文档不保留每一页的 Canvas。
  void Promise.resolve(task?.promise)
    .catch(() => undefined)
    .then(() => {
      if (target) {
        target.width = 0
        target.height = 0
      }
      currentPage?.cleanup()
    })
})
</script>
<template>
  <div
    class="workspace-pdf-page"
    :style="{ '--total-scale-factor': scale.totalScale, '--scale-factor': scale.scale }"
  >
    <canvas ref="canvas" />
    <div ref="textContainer" class="workspace-pdf-page__text textLayer" />
    <div v-if="failure" class="workspace-pdf-page__notice" role="alert">
      <span>{{ __t('ui.workspace', 'PDF 页面无法显示，可重新载入后重试') }}</span>
      <button type="button" @click="render">{{ __t('ui.workspace', '重新载入') }}</button>
    </div>
    <span v-else-if="rendering" class="workspace-pdf-page__notice" role="status">
      {{ __t('ui.workspace', '正在绘制…') }}
    </span>
  </div>
</template>
<style scoped>
.workspace-pdf-page {
  --scale-round-x: 1px;
  --scale-round-y: 1px;
  position: relative;
  width: 100%;
  height: 100%;
}
.workspace-pdf-page canvas {
  display: block;
}
.workspace-pdf-page__notice {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface-soft);
  font: 12px/1.6 var(--ui-font-mono);
}
.workspace-pdf-page__notice button {
  padding: 5px 12px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface);
  color: var(--ui-accent-sky);
  cursor: pointer;
}
/* 文字层遵循 PDF.js 的缩放坐标，保留复制能力，且不执行文档脚本。 */
.workspace-pdf-page__text {
  position: absolute;
  inset: 0;
  overflow: clip;
  text-align: initial;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  transform-origin: 0 0;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.workspace-pdf-page__text :deep(:is(span, br)) {
  position: absolute;
  color: transparent;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
  user-select: text;
}
.workspace-pdf-page__text :deep(> :not(.markedContent)),
.workspace-pdf-page__text :deep(.markedContent span:not(.markedContent)) {
  z-index: 1;
  --font-height: 0;
  --scale-x: 1;
  --rotate: 0deg;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.workspace-pdf-page__text :deep(.markedContent) {
  display: contents;
}
.workspace-pdf-page__text[data-main-rotation='90'] {
  transform: rotate(90deg) translateY(-100%);
}
.workspace-pdf-page__text[data-main-rotation='180'] {
  transform: rotate(180deg) translate(-100%, -100%);
}
.workspace-pdf-page__text[data-main-rotation='270'] {
  transform: rotate(270deg) translateX(-100%);
}
.workspace-pdf-page__text :deep(::selection) {
  background: #35b6ef55;
  color: transparent;
}
.workspace-pdf-page__text :deep(.workspace-pdf-match) {
  background: #ffc85766;
}
</style>
