<template>
  <figure ref="wrapperRef" class="wk-diagram">
    <!-- 顶部标签与操作 -->
    <div class="wk-diagram-bar">
      <span class="wk-diagram-label">
        <PixelIcon name="sparkle" :size="10" />
        流程图
      </span>
      <div class="wk-diagram-tools">
        <button type="button" class="wk-tool" aria-label="放大" @click.stop="zoomInInline">＋</button>
        <button type="button" class="wk-tool" aria-label="缩小" @click.stop="zoomOutInline">－</button>
        <button type="button" class="wk-tool" aria-label="复位缩放" @click.stop="resetInline">1:1</button>
        <button type="button" class="wk-tool" aria-label="全屏查看" @click.stop="openModal">全屏</button>
        <button type="button" class="wk-tool" aria-label="复制 Mermaid 源码" @click.stop="copyCode">
          {{ isCopied ? '已复制' : '源码' }}
        </button>
      </div>
    </div>

    <!-- 图表主体 -->
    <div class="wk-diagram-body" @dblclick="openModal">
      <div v-if="isLoading" class="wk-diagram-state">正在绘制流程图……</div>
      <div v-else-if="error" class="wk-diagram-state is-error">
        <p>流程图暂时没能画出来：</p>
        <pre>{{ error }}</pre>
      </div>
      <div
        v-else
        class="wk-diagram-svg"
        :style="{ transform: `scale(${inlineScale})` }"
        v-html="svgContent"
      ></div>
    </div>

    <!-- 全屏查看（挂到 body，避免被正文 overflow 裁切） -->
    <Teleport to="body">
      <Transition name="wk-fade">
        <div
          v-if="isModalOpen"
          class="wk-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="全屏查看流程图"
          @click.self="closeModal"
        >
          <div class="wk-lightbox-bar">
            <span class="wk-lightbox-scale">{{ Math.round(modalScale * 100) }}%</span>
            <div class="wk-diagram-tools">
              <button type="button" class="wk-tool" aria-label="放大" @click="zoomInModal">＋</button>
              <button type="button" class="wk-tool" aria-label="缩小" @click="zoomOutModal">－</button>
              <button type="button" class="wk-tool" aria-label="复位并居中" @click="resetModal">复位</button>
              <button ref="closeRef" type="button" class="wk-tool is-close" aria-label="关闭全屏" @click="closeModal">
                关闭
              </button>
            </div>
          </div>
          <div
            class="wk-lightbox-canvas"
            :class="{ grabbing: isDragging }"
            @wheel.prevent="handleWheel"
            @pointerdown="startDrag"
            @pointermove="onDrag"
            @pointerup="stopDrag"
            @pointercancel="stopDrag"
          >
            <div
              class="wk-lightbox-svg"
              :style="{ transform: `translate(${panX}px, ${panY}px) scale(${modalScale})` }"
              v-html="svgContent"
            ></div>
          </div>
          <p class="wk-lightbox-hint">拖动画布可平移，滚轮缩放，按 Esc 退出</p>
        </div>
      </Transition>
    </Teleport>
  </figure>
</template>
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import PixelIcon from './PixelIcon.vue'

/**
 * Mermaid 流程图：进入视口后再加载 mermaid 并渲染，跟随站点深浅色重新绘制。
 */
const props = defineProps<{ code: string }>()
const { isDark } = useData()

const wrapperRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const svgContent = ref('')
const isLoading = ref(true)
const error = ref('')
const isCopied = ref(false)

let isRendered = false
let observer: IntersectionObserver | null = null
let lastFocus: HTMLElement | null = null

const inlineScale = ref(1)
const isModalOpen = ref(false)
const modalScale = ref(1.2)
const panX = ref(0)
const panY = ref(0)
const isDragging = ref(false)
const dragStart = { x: 0, y: 0 }

// 两套配色与 style.css 的浅蓝 / 浅粉令牌保持一致
const PALETTES = {
  light: {
    primaryColor: '#eaf4fc',
    primaryTextColor: '#1d2433',
    primaryBorderColor: '#7cc0ea',
    lineColor: '#8a97ad',
    secondaryColor: '#fdeef5',
    tertiaryColor: '#f3f6fb',
    background: '#ffffff',
    mainBkg: '#eaf4fc',
    nodeBorder: '#7cc0ea',
    clusterBkg: '#f7f9fc',
    clusterBorder: '#f4a6c6',
    edgeLabelBackground: '#ffffff',
    actorBorder: '#7cc0ea',
    actorBkg: '#eaf4fc',
    signalColor: '#8a97ad',
    signalTextColor: '#1d2433',
  },
  dark: {
    primaryColor: '#1d2a3d',
    primaryTextColor: '#e9edf5',
    primaryBorderColor: '#5fa6d8',
    lineColor: '#7d889d',
    secondaryColor: '#2a2030',
    tertiaryColor: '#192030',
    background: '#12161f',
    mainBkg: '#1d2a3d',
    nodeBorder: '#5fa6d8',
    clusterBkg: '#161c28',
    clusterBorder: '#b9789c',
    edgeLabelBackground: '#12161f',
    actorBorder: '#5fa6d8',
    actorBkg: '#1d2a3d',
    signalColor: '#7d889d',
    signalTextColor: '#e9edf5',
  },
}

function zoomInInline() {
  inlineScale.value = Math.min(inlineScale.value + 0.2, 2.5)
}

function zoomOutInline() {
  inlineScale.value = Math.max(inlineScale.value - 0.2, 0.6)
}

function resetInline() {
  inlineScale.value = 1
}

function openModal() {
  if (!svgContent.value) return
  lastFocus = document.activeElement as HTMLElement | null
  isModalOpen.value = true
  modalScale.value = 1.3
  panX.value = 0
  panY.value = 0
  document.body.style.overflow = 'hidden'
  nextTick(() => closeRef.value?.focus())
}

function closeModal() {
  isModalOpen.value = false
  document.body.style.overflow = ''
  lastFocus?.focus()
  lastFocus = null
}
function zoomInModal() {
  modalScale.value = Math.min(modalScale.value + 0.25, 4)
}

function zoomOutModal() {
  modalScale.value = Math.max(modalScale.value - 0.25, 0.4)
}

function resetModal() {
  modalScale.value = 1.2
  panX.value = 0
  panY.value = 0
}

function handleWheel(event: WheelEvent) {
  const delta = event.deltaY < 0 ? 0.15 : -0.15
  modalScale.value = Math.max(0.4, Math.min(modalScale.value + delta, 4.5))
}

// 指针拖拽：鼠标、触屏与触控笔共用
function startDrag(event: PointerEvent) {
  isDragging.value = true
  dragStart.x = event.clientX - panX.value
  dragStart.y = event.clientY - panY.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onDrag(event: PointerEvent) {
  if (!isDragging.value) return
  panX.value = event.clientX - dragStart.x
  panY.value = event.clientY - dragStart.y
}

function stopDrag() {
  isDragging.value = false
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(decodeURIComponent(props.code).trim())
    isCopied.value = true
    setTimeout(() => (isCopied.value = false), 2000)
  } catch (err) {
    console.error('[Mermaid]', err)
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isModalOpen.value) closeModal()
}

async function renderDiagram() {
  if (typeof window === 'undefined') return
  // 重绘（例如切换深浅色）时保留旧图，不闪成加载提示
  isLoading.value = !svgContent.value
  error.value = ''

  try {
    let rawCode = decodeURIComponent(props.code).trim()
    if (!rawCode) return

    // 连线文字 -->|text| 含括号等字符时补上引号，避免 Mermaid 解析失败
    rawCode = rawCode.replace(/-->\|([^"\n|]+)\|/g, (match, label: string) => {
      const trimmed = label.trim()
      if (/^(["']).*\1$/.test(trimmed)) return match
      return /[()[\]{}:;]/.test(trimmed) ? `-->|"${trimmed}"|` : match
    })

    const { default: mermaid } = await import('mermaid')
    // 每次按当前深浅色初始化，切换主题后重新渲染即可换色
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      // 字体名不带引号，避免写入 SVG 样式时转义出错
      fontFamily: 'Inter, PingFang SC, Microsoft YaHei, Noto Sans SC, sans-serif',
      flowchart: {
        padding: 20,
        htmlLabels: true,
        useMaxWidth: true,
        nodeSpacing: 46,
        rankSpacing: 46,
        curve: 'basis',
      },
      themeVariables: { ...PALETTES[isDark.value ? 'dark' : 'light'], fontSize: '14px' },
    })

    const uniqueId = `mermaid-${Math.random().toString(36).slice(2, 9)}`
    const { svg } = await mermaid.render(uniqueId, rawCode)
    svgContent.value = svg
  } catch (err) {
    console.error('[Mermaid]', err)
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  if ('IntersectionObserver' in window && wrapperRef.value) {
    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || isRendered) return
        isRendered = true
        renderDiagram()
        observer?.disconnect()
        observer = null
      },
      { rootMargin: '250px 0px' },
    )
    observer.observe(wrapperRef.value)
  } else {
    isRendered = true
    renderDiagram()
  }
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
  window.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = ''
})

watch(() => props.code, renderDiagram)
// 已渲染过的图在切换深浅色时重绘
watch(isDark, () => {
  if (isRendered) renderDiagram()
})
</script>
<style scoped>
.wk-diagram {
  margin: 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-md);
  background: var(--vp-c-bg-elv);
  overflow: hidden;
  content-visibility: auto;
  contain-intrinsic-size: 1px 300px;
}

.wk-diagram-bar,
.wk-lightbox-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.wk-diagram-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--wk-pink-text);
}

.wk-diagram-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wk-tool {
  min-width: 30px;
  height: 28px;
  padding: 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--wk-radius-sm);
  transition:
    color 0.15s,
    border-color 0.15s,
    transform 0.1s steps(2, end);
}

.wk-tool:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--wk-sky);
}

.wk-tool:active {
  transform: translateY(1px);
}

.wk-tool:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.wk-diagram-body {
  display: flex;
  justify-content: center;
  padding: 24px 16px;
  min-height: 140px;
  overflow-x: auto;
}

.wk-diagram-svg {
  display: flex;
  justify-content: center;
  width: 100%;
  transform-origin: center top;
  transition: transform 0.2s ease;
}

.wk-diagram-svg :deep(svg) {
  max-width: 100% !important;
  height: auto !important;
}

.wk-diagram-svg :deep(foreignObject),
.wk-lightbox-svg :deep(foreignObject) {
  overflow: visible !important;
}

.wk-diagram-svg :deep(.node .label) {
  line-height: 1.45 !important;
  font-weight: 500 !important;
}

.wk-diagram-svg :deep(.edgeLabel span),
.wk-diagram-svg :deep(.edgeLabel p) {
  padding: 2px 6px !important;
  border-radius: 4px !important;
  line-height: 1.35 !important;
}
.wk-diagram-state {
  align-self: center;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.wk-diagram-state.is-error {
  align-self: stretch;
  padding: 12px 14px;
  border-left: 4px solid var(--vp-c-danger-3);
  background: var(--vp-c-danger-soft);
  border-radius: 0 var(--wk-radius-sm) var(--wk-radius-sm) 0;
}

.wk-diagram-state.is-error p {
  margin: 0;
}

.wk-diagram-state pre {
  margin: 6px 0 0;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 全屏查看 */
.wk-lightbox {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  background: var(--vp-c-bg);
  background: color-mix(in srgb, var(--vp-c-bg) 92%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}

.wk-lightbox-scale {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.wk-tool.is-close {
  color: var(--vp-c-text-1);
  border-color: var(--wk-pink);
}

.wk-lightbox-canvas {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 40px;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.wk-lightbox-canvas.grabbing {
  cursor: grabbing;
}

.wk-lightbox-svg {
  transform-origin: center center;
  will-change: transform;
}

.wk-lightbox-svg :deep(svg) {
  min-width: min(600px, 90vw);
  max-width: none !important;
  height: auto !important;
}

.wk-lightbox-hint {
  margin: 0;
  padding: 10px 16px;
  font-size: 13px;
  text-align: center;
  color: var(--vp-c-text-2);
  border-top: 1px solid var(--vp-c-divider);
}

.wk-fade-enter-active,
.wk-fade-leave-active {
  transition: opacity 0.2s ease;
}

.wk-fade-enter-from,
.wk-fade-leave-to {
  opacity: 0;
}
</style>
