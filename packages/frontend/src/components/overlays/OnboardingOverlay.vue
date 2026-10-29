<script setup lang="ts">
import { t as __t } from '../../i18n/index'
import '@infos/shared/i18n/catalogs/onboarding'

/**
 * OnboardingOverlay — 新手引导遮罩
 *
 * 还原 v1 完整实现：打字机对话框 + 聚光灯高亮 + 表情-立绘映射。
 * 立绘资源位于 public/assets/onboarding/，使用相对路径，兼容打包版 file:// 加载。
 *
 * @props visible - 是否显示
 * @props steps - 引导步骤
 * @emits finish - 引导完成
 */
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import { PixelIcon, PButton } from '../pixel'
import SpotlightMask from './SpotlightMask.vue'
import { logger } from '../../lib/logger'

export interface OnboardingStep {
  /** 说话者名称 */
  speaker?: string
  /** 对话文本 */
  text: string
  /** 辅助标签 */
  eyebrow?: string
  /** 步骤标题 */
  title?: string
  /** 进入该步骤前需要展示的页面。 */
  tab?: string
  /** 表情标识 (用于立绘切换): 'normal' | 'proud' | 'none' */
  expression?: string
  /** 聚焦元素 CSS 选择器 */
  focusSelector?: string | null
  /** 选择按钮 */
  choices?: { label: string; value: string }[]
  /** 此步由真实页面按钮接续，点击对话框不能直接结束。 */
  action?: 'launch-desktop'
  placement?: 'top' | 'bottom'
}

interface Props {
  visible: boolean
  steps: OnboardingStep[]
  prepareStep?: (step: OnboardingStep, index: number, signal: AbortSignal) => Promise<void>
}

const props = defineProps<Props>()
const emit = defineEmits<{
  finish: []
  skip: []
  'update:visible': [val: boolean]
  choice: [value: string]
  step: [step: OnboardingStep, index: number]
}>()

const currentIndex = ref(0)
const displayedText = ref('')
const isTypingDone = ref(false)
const isAppearing = ref(false)
const preparing = ref(false)
const spotlight = ref<InstanceType<typeof SpotlightMask> | null>(null)
const dialog = ref<HTMLElement | null>(null)
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
const tr = (source: string) => __t('ui.onboarding', source)
let preparation: AbortController | undefined
let enterTimer: ReturnType<typeof setTimeout> | undefined
let exitTimer: ReturnType<typeof setTimeout> | undefined
let closing = false

let typeTimer: ReturnType<typeof setInterval> | null = null

const currentStep = computed(() => props.steps[currentIndex.value])

/** 当前步骤是否有聚光灯 */
const hasSpotlight = computed(() => !!spotlight.value?.rect)
const dialogOnTop = computed(
  () =>
    currentStep.value?.placement === 'top' ||
    (currentStep.value?.placement !== 'bottom' &&
      (spotlight.value?.rect?.y ?? 0) > viewport.value.height * 0.5),
)
const blockers = computed(() => {
  const rect = currentStep.value?.action && !preparing.value ? spotlight.value?.rect : null
  if (!rect) return [{ inset: '0' }]
  const { width, height } = viewport.value
  const left = Math.max(0, Math.min(width, rect.x - 8)),
    top = Math.max(0, Math.min(height, rect.y - 8))
  const right = Math.max(left, Math.min(width, rect.x + rect.width + 8))
  const bottom = Math.max(top, Math.min(height, rect.y + rect.height + 8))
  return [
    { left: '0', top: '0', width: '100%', height: `${top}px` },
    { left: '0', top: `${bottom}px`, width: '100%', bottom: '0' },
    { left: '0', top: `${top}px`, width: `${left}px`, height: `${bottom - top}px` },
    { left: `${right}px`, top: `${top}px`, right: '0', height: `${bottom - top}px` },
  ]
})

// ── 表情-立绘映射 (还原 v1) ──

interface ExpressionInfo {
  icon: string
  label: string
  image: string
}

const expressions: Record<string, ExpressionInfo> = {
  normal: {
    icon: 'cat',
    get label() {
      return __t('ui.overlays', '乖巧的 Pero')
    },
    image: 'assets/onboarding/pero_normal.png',
  },
  proud: {
    icon: 'sparkle',
    get label() {
      return __t('ui.overlays', '得意的 Pero')
    },
    image: 'assets/onboarding/pero_proud.png',
  },
}

/** 当前表情对应的图标 */
const currentExpressionIcon = computed(
  () => expressions[currentStep.value?.expression ?? '']?.icon ?? 'cat',
)

/** 当前表情对应的标签 */
const currentExpressionLabel = computed(
  () => expressions[currentStep.value?.expression ?? '']?.label ?? 'Pero',
)

/** 当前表情对应的立绘路径 */
const currentExpressionImage = computed(
  () => expressions[currentStep.value?.expression ?? '']?.image ?? null,
)

// ── 立绘预加载 ──

const preloadedImages = ref(new Set<string>())

/** 预加载所有立绘资源 */
function preloadOnboardingImages() {
  const imageUrls = Object.values(expressions)
    .map((e) => e.image)
    .filter(Boolean)

  imageUrls.forEach((url) => {
    if (preloadedImages.value.has(url)) return
    const img = new Image()
    img.src = url
    img.onload = () => {
      preloadedImages.value.add(url)
      logger.info('Onboarding', __t('logs.frontend.overlays', '立绘预加载成功: {0}', [url]))
    }
    img.onerror = () => {
      logger.error('Onboarding', __t('logs.frontend.overlays', '立绘预加载失败: {0}', [url]))
    }
  })
}

/** 当前立绘是否已就绪 */
const isImageReady = computed(() => {
  const url = currentExpressionImage.value
  return url != null && preloadedImages.value.has(url)
})

// ── 打字机效果 ──

function startTyping() {
  if (typeTimer) clearInterval(typeTimer)
  const text = currentStep.value?.text ?? ''
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    displayedText.value = text
    isTypingDone.value = true
    return
  }
  displayedText.value = ''
  isTypingDone.value = false
  let i = 0
  typeTimer = setInterval(() => {
    if (i < text.length) {
      displayedText.value += text[i]
      i++
    } else {
      isTypingDone.value = true
      if (typeTimer) clearInterval(typeTimer)
    }
  }, 35)
}

async function startStep() {
  const step = currentStep.value
  if (!step) return
  preparation?.abort()
  const controller = new AbortController()
  preparation = controller
  if (typeTimer) clearInterval(typeTimer)
  displayedText.value = ''
  isTypingDone.value = false
  preparing.value = true
  emit('step', step, currentIndex.value)
  try {
    await props.prepareStep?.(step, currentIndex.value, controller.signal)
  } catch {
    // 页面加载失败时仍可退出或继续导览，不能把用户锁在遮罩里。
  }
  if (!props.visible || controller.signal.aborted) return
  preparing.value = false
  await nextTick()
  if (!props.visible || controller.signal.aborted) return
  window.dispatchEvent(new Event('onboarding-layout-change'))
  startTyping()
}
function previous() {
  if (preparing.value || closing || currentIndex.value === 0) return
  currentIndex.value--
  void startStep()
}
function skip() {
  if (closing) return
  closing = true
  preparation?.abort()
  if (typeTimer) clearInterval(typeTimer)
  emit('skip')
  emit('update:visible', false)
}
function keyboard(event: KeyboardEvent) {
  if (!props.visible || closing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    skip()
  } else if (event.key === 'Tab') {
    const buttons = [
      ...(dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ]
    const action =
      currentStep.value?.action && currentStep.value.focusSelector
        ? document.querySelector<HTMLButtonElement>(currentStep.value.focusSelector)
        : null
    if (action && !action.disabled) buttons.push(action)
    if (!buttons.length) {
      event.preventDefault()
      dialog.value?.focus()
      return
    }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus({ preventScroll: true })
  } else if (event.target === dialog.value && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
    handleNext()
  }
}
function resize() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
}
window.addEventListener('keydown', keyboard, true)
window.addEventListener('resize', resize)
watch(
  () => currentStep.value?.text,
  () => {
    if (props.visible && isAppearing.value && !preparing.value && !closing) startTyping()
  },
)

/** 跳到完整文本 / 下一步 */
function handleNext() {
  if (preparing.value || closing) return
  if (!isTypingDone.value) {
    if (typeTimer) clearInterval(typeTimer)
    displayedText.value = currentStep.value?.text ?? ''
    isTypingDone.value = true
    return
  }
  if (currentStep.value?.choices || currentStep.value?.action) return
  advance()
}

/** 前进一步 */
function advance() {
  if (preparing.value || closing) return
  if (currentIndex.value < props.steps.length - 1) {
    currentIndex.value++
    void startStep()
  } else {
    closing = true
    isAppearing.value = false
    exitTimer = setTimeout(() => {
      emit('finish')
      emit('update:visible', false)
    }, 400)
  }
}

/** 选择 */
function handleChoice(value: string) {
  if (preparing.value || closing) return
  emit('choice', value)
  advance()
}

// 监听显示变化
watch(
  () => props.visible,
  (v) => {
    if (v) {
      clearTimeout(enterTimer)
      clearTimeout(exitTimer)
      closing = false
      preloadOnboardingImages()
      currentIndex.value = 0
      enterTimer = setTimeout(() => {
        if (!props.visible) return
        isAppearing.value = true
        void startStep()
        void nextTick(() => dialog.value?.focus({ preventScroll: true }))
      }, 200)
    } else {
      isAppearing.value = false
      preparation?.abort()
      clearTimeout(enterTimer)
      clearTimeout(exitTimer)
      if (typeTimer) clearInterval(typeTimer)
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  preparation?.abort()
  clearTimeout(enterTimer)
  clearTimeout(exitTimer)
  window.removeEventListener('keydown', keyboard, true)
  window.removeEventListener('resize', resize)
  if (typeTimer) clearInterval(typeTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="onb-fade">
      <div
        v-if="visible"
        class="onb-overlay"
        :class="{ 'is-visible': isAppearing, 'has-spotlight': hasSpotlight }"
      >
        <SpotlightMask
          ref="spotlight"
          :selector="preparing ? null : (currentStep?.focusSelector ?? null)"
        />
        <div v-for="(style, index) in blockers" :key="index" class="onb-blocker" :style="style" />

        <div
          v-if="currentStep?.expression !== 'none'"
          class="onb-character"
          :class="{ ready: isAppearing }"
        >
          <div class="onb-character__glow" />
          <img
            v-if="isImageReady"
            :key="currentExpressionImage!"
            :src="currentExpressionImage!"
            :alt="currentExpressionLabel"
          />
          <div v-else class="onb-character__fallback">
            <PixelIcon :name="currentExpressionIcon" size="3xl" />
            <strong>{{ currentExpressionLabel }}</strong>
          </div>
        </div>

        <article
          ref="dialog"
          class="onb-dialog"
          :class="{ ready: isAppearing, 'onb-dialog--top': dialogOnTop }"
          role="dialog"
          aria-modal="true"
          :aria-label="currentStep?.title || tr('Pero的小导览')"
          tabindex="-1"
          @click="handleNext"
        >
          <header>
            <div class="onb-speaker">
              <PixelIcon name="cat" size="xs" />
              {{ currentStep?.speaker ?? 'Pero' }}
            </div>
            <span>
              {{ String(currentIndex + 1).padStart(2, '0') }} /
              {{ String(steps.length).padStart(2, '0') }}
            </span>
          </header>
          <section>
            <small>{{ currentStep?.eyebrow ?? tr('Pero的小导览') }}</small>
            <h2>{{ currentStep?.title ?? __t('ui.overlays', '新手引导') }}</h2>
            <p>
              {{ preparing ? tr('等页面准备好喵…') : displayedText }}
              <i v-if="!isTypingDone && !preparing" />
            </p>
          </section>
          <footer>
            <div class="onb-progress">
              <i :style="{ width: `${((currentIndex + 1) / steps.length) * 100}%` }" />
            </div>
            <button type="button" class="onb-skip" @click.stop="skip">{{ tr('稍后再看') }}</button>
            <button
              v-if="currentIndex"
              type="button"
              class="onb-back"
              :disabled="preparing"
              @click.stop="previous"
            >
              {{ tr('上一步') }}
            </button>
            <div v-if="currentStep?.choices && isTypingDone" class="onb-choices">
              <PButton
                v-for="choice in currentStep.choices"
                :key="choice.value"
                variant="primary"
                @click.stop="handleChoice(choice.value)"
              >
                {{ choice.label }}
              </PButton>
            </div>
            <span v-else-if="currentStep?.action">
              {{ tr('点击高亮的启动按钮') }}
              <PixelIcon name="arrow-right" size="xs" />
            </span>
            <button
              v-else
              type="button"
              class="onb-next"
              :disabled="preparing"
              @click.stop="handleNext"
            >
              {{
                isTypingDone
                  ? currentIndex === steps.length - 1
                    ? __t('ui.overlays', '完成引导')
                    : __t('ui.overlays', '点击继续')
                  : __t('ui.overlays', '正在介绍…')
              }}
              <PixelIcon name="arrow-right" size="xs" />
            </button>
          </footer>
        </article>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.onb-overlay {
  position: fixed;
  z-index: 10000;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  background: rgba(15, 23, 42, 0.58);
  backdrop-filter: blur(8px);
  transition: opacity 0.35s ease;
}
.onb-overlay.is-visible {
  opacity: 1;
}
.onb-overlay.has-spotlight {
  background: transparent;
  backdrop-filter: none;
}
.onb-blocker {
  position: absolute;
  z-index: 1;
  pointer-events: auto;
}
.onb-dialog.onb-dialog--top {
  top: 68px;
  bottom: auto;
}
.onb-character {
  position: absolute;
  z-index: 10;
  right: 8%;
  bottom: 0;
  width: min(330px, 30vw);
  height: 72vh;
  opacity: 0;
  transform: translateY(30px);
  transition:
    opacity 0.45s ease,
    transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.onb-character.ready {
  opacity: 1;
  transform: translateY(0);
}
.onb-character img {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center bottom;
  filter: drop-shadow(0 18px 30px rgba(14, 165, 233, 0.25));
}
.onb-character__glow {
  position: absolute;
  right: 10%;
  bottom: 2%;
  width: 80%;
  height: 55%;
  border-radius: 50%;
  background: rgba(244, 114, 182, 0.18);
  filter: blur(70px);
}
.onb-character__fallback {
  position: absolute;
  right: 15%;
  bottom: 14%;
  display: grid;
  width: 180px;
  height: 210px;
  place-items: center;
  border: 1px solid var(--ui-accent-primary);
  background: rgba(255, 255, 255, 0.92);
  color: var(--ui-accent-primary);
  box-shadow: 7px 7px 0 rgba(236, 72, 153, 0.18);
}
.onb-character__fallback strong {
  font: 800 13px var(--ui-font-pixel);
}
.onb-dialog {
  position: absolute;
  z-index: 20;
  bottom: 34px;
  left: 50%;
  width: min(620px, calc(100vw - 64px));
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-top: 3px solid var(--ui-accent-primary);
  border-radius: var(--ui-radius-md);
  opacity: 0;
  background: var(--ui-bg-elevated);
  box-shadow:
    var(--ui-shadow-lg),
    7px 7px 0 color-mix(in srgb, var(--ui-accent-primary) 18%, transparent);
  pointer-events: auto;
  cursor: pointer;
  transform: translate(-50%, 18px);
  transition:
    opacity 0.35s ease,
    transform 0.45s ease;
}
.onb-dialog.ready {
  opacity: 1;
  transform: translate(-50%, 0);
}
.onb-dialog > header {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
}
.onb-speaker {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-accent-primary);
  font: 900 10px var(--ui-font-pixel);
}
.onb-dialog > header > span {
  color: var(--ui-text-disabled);
  font: 800 9px var(--ui-font-mono);
}
.onb-dialog section {
  padding: 16px 18px 13px;
}
.onb-dialog section small {
  display: block;
  margin-bottom: 4px;
  color: var(--ui-accent-sky);
  font: 900 8px var(--ui-font-mono);
  letter-spacing: 0.13em;
}
.onb-dialog h2 {
  margin: 0;
  color: var(--ui-text-primary);
  font: 700 19px/1.4 var(--ui-font-sans);
}
.onb-dialog p {
  min-height: 48px;
  margin: 8px 0 0;
  color: var(--ui-text-secondary);
  font: 500 13px/1.75 var(--ui-font-sans);
}
.onb-dialog p i {
  display: inline-block;
  width: 5px;
  height: 13px;
  margin-left: 3px;
  background: var(--ui-accent-primary);
  animation: onb-caret 0.8s steps(2, end) infinite;
}
.onb-dialog footer {
  position: relative;
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: flex-end;
  padding: 0 15px;
  border-top: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
}
.onb-dialog footer > span,
.onb-next,
.onb-back,
.onb-skip {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-tertiary);
  font: 800 9px var(--ui-font-mono);
}
.onb-next,
.onb-back,
.onb-skip {
  min-height: 38px;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.onb-next {
  color: var(--ui-accent-primary);
}
.onb-skip {
  margin-right: auto;
}
.onb-back {
  margin-right: 8px;
}
.onb-dialog footer button:hover:not(:disabled) {
  color: var(--ui-accent-primary);
}
.onb-dialog footer button:disabled {
  opacity: 0.45;
  cursor: default;
}
.onb-dialog button:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: -3px;
}
.onb-progress {
  position: absolute;
  top: -1px;
  right: 0;
  left: 0;
  height: 2px;
  background: var(--ui-border-subtle);
}
.onb-progress i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--ui-accent-primary), var(--ui-accent-sky));
  transition: width 0.3s ease;
}
.onb-choices {
  display: flex;
  gap: 7px;
  padding: 6px 0;
}
@keyframes onb-caret {
  50% {
    opacity: 0;
  }
}
.onb-fade-enter-active,
.onb-fade-leave-active {
  transition: opacity 0.3s;
}
.onb-fade-enter-from,
.onb-fade-leave-to {
  opacity: 0;
}
@media (max-width: 800px) {
  .onb-character {
    right: 2%;
    width: 42vw;
    opacity: 0.45;
  }
  .onb-dialog {
    bottom: 20px;
    width: calc(100vw - 32px);
  }
  .onb-dialog.onb-dialog--top {
    top: 58px;
    bottom: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .onb-overlay,
  .onb-dialog,
  .onb-character,
  .onb-progress i {
    transition: none;
  }
  .onb-dialog p i {
    animation: none;
  }
}
</style>
