<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import type { PerceptionAction } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { usePerception } from '../../../composables/usePerception'
import { useMainNav } from '../../../composables/main/useMainNav'
import { useEventListener } from '../../../composables/useEventListener'
import { PixelIcon } from '../../pixel'

/**
 * 底部状态栏左下角的「桌面感知」HUD 胶囊与上弹卡片：
 * - 支持在卡片内直接开启/恢复/暂停/停止常驻感知，或一键跳转「感知与桌宠」「桌面权限与安全」
 * - 快照仅在卡片展开且感知处于运行采样态（running）时按需读取，关闭或非采样态下零后台轮询
 * - 独立定义浅色/深色不透明实体面板令牌，避免自定义应用壁纸半透明渗透导致发糊发脏
 */
const emit = defineEmits<{
  settings: []
  'desktop-security': []
}>()

const { phase, blockedReason, label, shortLabel, error, act, readSnapshot } = usePerception()
const { settingsOpen } = useMainNav()

const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
// 浮层挂到 body 上，避免被主界面侧栏、输入框或状态栏局部层叠上下文遮挡
const panelStyle = ref<Record<string, string>>({})
const open = ref(false)
const snapshot = ref('')
const acting = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

function updatePanelPosition(): void {
  const box = root.value?.getBoundingClientRect()
  if (!box) return
  const maxWidth = Math.min(348, Math.max(240, window.innerWidth - 24))
  const clampedLeft = Math.min(
    Math.max(12, Math.round(box.left)),
    Math.max(12, window.innerWidth - maxWidth - 12),
  )
  const bottomOffset = Math.max(12, Math.round(window.innerHeight - box.top + 8))
  panelStyle.value = {
    left: `${clampedLeft}px`,
    bottom: `${bottomOffset}px`,
  }
}

async function refresh(): Promise<void> {
  if (!open.value || phase.value !== 'running') return
  const text = await readSnapshot()
  if (open.value && phase.value === 'running') {
    snapshot.value = text
  }
}

function stopRefresh(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

watch(
  [open, phase],
  ([isOpen, currentPhase]) => {
    stopRefresh()
    if (!isOpen || !currentPhase) {
      snapshot.value = ''
      return
    }
    updatePanelPosition()
    if (currentPhase === 'running') {
      void refresh()
      timer = setInterval(() => void refresh(), 4000)
    } else {
      snapshot.value = ''
    }
  },
  { flush: 'post' },
)

// 设置中心打开时主动收起浮层，避免与模态层交叠
watch(settingsOpen, (modalOpen) => {
  if (modalOpen && open.value) {
    open.value = false
  }
})

onDeactivated(() => {
  open.value = false
  stopRefresh()
})
onBeforeUnmount(stopRefresh)

useEventListener(window, 'resize', () => {
  if (open.value) updatePanelPosition()
})

useEventListener(document, 'pointerdown', (event) => {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && !root.value?.contains(target) && !panel.value?.contains(target)) {
    open.value = false
  }
})

useEventListener(document, 'keydown', (event) => {
  if (open.value && (event as KeyboardEvent).key === 'Escape') {
    open.value = false
  }
})

function releaseStatusFocus(): void {
  const activeEl = typeof document !== 'undefined' ? document.activeElement : null
  if (
    activeEl instanceof HTMLElement &&
    (root.value?.contains(activeEl) || panel.value?.contains(activeEl))
  ) {
    activeEl.blur()
  }
}

async function handleAct(action: PerceptionAction): Promise<void> {
  if (acting.value) return
  acting.value = true
  try {
    await act(action)
  } finally {
    acting.value = false
  }
}

function openSettings(): void {
  releaseStatusFocus()
  open.value = false
  emit('settings')
}

function openDesktopSecurity(): void {
  releaseStatusFocus()
  open.value = false
  emit('desktop-security')
}
</script>

<template>
  <div v-if="phase" ref="root" class="perception-status">
    <span class="perception-status-divider" aria-hidden="true" />
    <button
      type="button"
      class="perception-status-button"
      :class="[`is-${phase}`, { 'is-open': open }]"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="open = !open"
    >
      <i class="perception-status-dot" aria-hidden="true" />
      <span class="perception-status-label">{{ label }}</span>
      <PixelIcon
        name="chevron-up"
        size="xs"
        class="perception-status-chevron"
        aria-hidden="true"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="perception-status-panel"
        :class="`is-${phase}`"
        :style="panelStyle"
        role="dialog"
        aria-labelledby="perception-card-title"
      >
        <!-- 顶部 HUD 标题栏 -->
        <header class="perception-card__head">
          <div class="perception-card__head-left">
            <span class="perception-card__icon" aria-hidden="true">
              <PixelIcon name="eye" size="xs" />
            </span>
            <strong id="perception-card-title" class="perception-card__title">
              {{ __t('ui.desktop', '桌面感知') }}
            </strong>
            <span class="perception-card__badge">
              <i aria-hidden="true" />
              {{ shortLabel }}
            </span>
          </div>
          <button
            type="button"
            class="perception-card__close"
            :title="__t('ui.desktop', '关闭')"
            :aria-label="__t('ui.desktop', '关闭')"
            @click="open = false"
          >
            <PixelIcon name="close" size="xs" />
          </button>
        </header>

        <!-- 中部感知读数与状态说明舱 -->
        <div class="perception-card__body">
          <div v-if="phase === 'off'" class="perception-card__well perception-card__well--muted">
            <p class="perception-card__desc">
              {{
                __t(
                  'ui.desktop',
                  '常驻感知未开启。开启后她可感知当前窗口与声音，仅观察不操作电脑。',
                )
              }}
            </p>
          </div>

          <div
            v-else-if="phase === 'stopped'"
            class="perception-card__well perception-card__well--muted"
          >
            <p class="perception-card__desc">
              {{ __t('ui.desktop', '感知已全部停止，可手动恢复。') }}
            </p>
          </div>

          <template v-else-if="phase === 'blocked' || phase === 'paused'">
            <div class="perception-card__reason" role="status">
              <PixelIcon name="alert" size="xs" class="perception-card__reason-icon" />
              <span>{{ label }}</span>
            </div>
            <div v-if="snapshot" class="perception-card__well">
              <span class="perception-card__caption">
                {{ __t('ui.desktop', '当前感知内容') }}
              </span>
              <p class="perception-card__snapshot settings-scrollbar">{{ snapshot }}</p>
            </div>
          </template>

          <div v-else class="perception-card__well">
            <span class="perception-card__caption">
              {{ __t('ui.desktop', '当前感知内容') }}
            </span>
            <p v-if="snapshot" class="perception-card__snapshot settings-scrollbar">
              {{ snapshot }}
            </p>
            <p v-else class="perception-card__desc">
              {{ __t('ui.desktop', '暂无感知内容。') }}
            </p>
          </div>

          <p v-if="error" class="perception-card__error" role="alert">
            {{ error }}
          </p>
        </div>

        <!-- 底部操作栏 -->
        <footer class="perception-card__foot">
          <div class="perception-card__actions-left">
            <button
              v-if="phase === 'off'"
              type="button"
              class="perception-card__btn perception-card__btn--primary"
              :disabled="acting"
              @click="handleAct({ type: 'set-enabled', enabled: true })"
            >
              <PixelIcon name="eye" size="xs" />
              <span>{{ __t('ui.desktop', '开启感知') }}</span>
            </button>

            <button
              v-else-if="phase === 'stopped'"
              type="button"
              class="perception-card__btn perception-card__btn--primary"
              :disabled="acting"
              @click="handleAct({ type: 'resume' })"
            >
              <PixelIcon name="play" size="xs" />
              <span>{{ __t('ui.desktop', '恢复感知') }}</span>
            </button>

            <template v-else-if="phase === 'paused'">
              <button
                type="button"
                class="perception-card__btn perception-card__btn--primary"
                :disabled="acting"
                @click="handleAct({ type: 'resume' })"
              >
                <PixelIcon name="play" size="xs" />
                <span>{{ __t('ui.desktop', '现在恢复') }}</span>
              </button>
              <button
                type="button"
                class="perception-card__btn perception-card__btn--danger"
                :disabled="acting"
                @click="handleAct({ type: 'stop-all' })"
              >
                <span>{{ __t('ui.desktop', '全部停止') }}</span>
              </button>
            </template>

            <template v-else-if="phase === 'blocked'">
              <button
                v-if="blockedReason === 'desktop-disabled'"
                type="button"
                class="perception-card__btn perception-card__btn--primary"
                @click="openDesktopSecurity"
              >
                <PixelIcon name="shield" size="xs" />
                <span>{{ __t('ui.desktop', '前往桌面操作') }}</span>
              </button>
              <button
                type="button"
                class="perception-card__btn perception-card__btn--danger"
                :disabled="acting"
                @click="handleAct({ type: 'stop-all' })"
              >
                <span>{{ __t('ui.desktop', '全部停止') }}</span>
              </button>
            </template>

            <template v-else-if="phase === 'running'">
              <button
                type="button"
                class="perception-card__btn"
                :disabled="acting"
                @click="handleAct({ type: 'pause-hour' })"
              >
                <PixelIcon name="pause" size="xs" />
                <span>{{ __t('ui.desktop', '暂停 1 小时') }}</span>
              </button>
              <button
                type="button"
                class="perception-card__btn perception-card__btn--danger"
                :disabled="acting"
                @click="handleAct({ type: 'stop-all' })"
              >
                <span>{{ __t('ui.desktop', '全部停止') }}</span>
              </button>
            </template>
          </div>

          <button
            type="button"
            class="perception-card__btn perception-card__btn--settings"
            @click="openSettings"
          >
            <PixelIcon name="settings" size="xs" />
            <span>{{ __t('ui.desktop', '感知设置') }}</span>
          </button>
        </footer>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── 状态栏左侧触发胶囊 ── */
.perception-status {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.perception-status-divider {
  width: 1px;
  height: 12px;
  background: var(--ui-border-default);
  flex-shrink: 0;
}

.perception-status-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 7px 0 6px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--ui-text-secondary);
  font: inherit;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition:
    color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}

.perception-status-button:hover {
  color: var(--ui-text-primary);
  background: var(--ui-bg-hover);
  border-color: var(--ui-border-default);
}

.perception-status-button.is-open {
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface);
  border-color: var(--ui-border-strong);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.perception-status-button:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 1px;
}

.perception-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  flex-shrink: 0;
  border: 1.5px solid var(--ui-text-tertiary);
  background: transparent;
}

.perception-status-button.is-running .perception-status-dot {
  border-color: var(--ui-success);
  background: var(--ui-success);
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.45);
}

.perception-status-button.is-paused .perception-status-dot,
.perception-status-button.is-blocked .perception-status-dot {
  border-color: var(--ui-warning);
  background: var(--ui-warning);
}

.perception-status-button.is-stopped .perception-status-dot {
  border-color: var(--ui-danger);
  background: var(--ui-danger);
}

.perception-status-label {
  white-space: nowrap;
}

.perception-status-chevron {
  width: 11px !important;
  height: 11px !important;
  opacity: 0.6;
  transition:
    transform var(--ui-duration-fast) var(--ui-ease-standard),
    opacity var(--ui-duration-fast) var(--ui-ease-standard);
}

.perception-status-button:hover .perception-status-chevron,
.perception-status-button.is-open .perception-status-chevron {
  opacity: 0.95;
}

.perception-status-button.is-open .perception-status-chevron {
  transform: rotate(180deg);
}

/* ── 上弹 HUD 实体卡片（浅色/深色独立不透明令牌，隔离壁纸半透明干扰） ── */
.perception-status-panel {
  --pcard-bg: #ffffff;
  --pcard-head-bg: #f2f5fa;
  --pcard-well-bg: #f6f8fc;
  --pcard-foot-bg: #f3f6fb;
  --pcard-btn-bg: #ffffff;
  --pcard-btn-hover: #eef2f8;
  --pcard-border: rgba(15, 23, 42, 0.22);
  --pcard-subtle: rgba(15, 23, 42, 0.1);
  --pcard-text: #141824;
  --pcard-text-sub: #475166;
  --pcard-text-muted: #6d778e;
  --pcard-bevel: inset 0 1px 0 rgba(255, 255, 255, 0.92), inset 0 -1px 0 rgba(15, 23, 42, 0.05);
  --pcard-shadow: 0 14px 30px -8px rgba(15, 23, 42, 0.2), 0 3px 8px rgba(15, 23, 42, 0.08);
  --pcard-accent: #64748b;
  --pcard-accent-soft: rgba(100, 116, 139, 0.12);
  --pcard-cta: var(--ui-accent-primary, #ec4899);
  --pcard-cta-soft: rgba(236, 72, 153, 0.11);

  position: fixed;
  z-index: 1000;
  width: min(348px, calc(100vw - 24px));
  border: 1px solid var(--pcard-border);
  border-top: 2px solid var(--pcard-accent);
  border-radius: 2px;
  background: var(--pcard-bg);
  color: var(--pcard-text);
  box-shadow: var(--pcard-bevel), var(--pcard-shadow);
  font-family: var(--ui-font-sans);
  font-size: 12px;
  transform-origin: bottom left;
  animation: perception-card-in 140ms cubic-bezier(0.2, 0, 0, 1);
}

[data-theme='dark'] .perception-status-panel {
  --pcard-bg: #171c28;
  --pcard-head-bg: #1c2231;
  --pcard-well-bg: #111520;
  --pcard-foot-bg: #141926;
  --pcard-btn-bg: #1e2536;
  --pcard-btn-hover: #262f44;
  --pcard-border: rgba(148, 163, 184, 0.24);
  --pcard-subtle: rgba(148, 163, 184, 0.12);
  --pcard-text: #eef2ff;
  --pcard-text-sub: #a9b4d0;
  --pcard-text-muted: #7884a3;
  --pcard-bevel: inset 0 1px 0 rgba(255, 255, 255, 0.07), inset 0 -1px 0 rgba(0, 0, 0, 0.42);
  --pcard-shadow: 0 18px 38px -8px rgba(0, 0, 0, 0.65), 0 4px 12px rgba(0, 0, 0, 0.4);
  --pcard-accent: #8b9bb7;
  --pcard-accent-soft: rgba(139, 155, 183, 0.15);
  --pcard-cta: var(--ui-accent-purple, #a855f7);
  --pcard-cta-soft: rgba(168, 85, 247, 0.16);
}

.perception-status-panel.is-running {
  --pcard-accent: var(--ui-success, #10b981);
  --pcard-accent-soft: rgba(16, 185, 129, 0.14);
}

.perception-status-panel.is-paused,
.perception-status-panel.is-blocked {
  --pcard-accent: var(--ui-warning, #f59e0b);
  --pcard-accent-soft: rgba(245, 158, 11, 0.14);
}

.perception-status-panel.is-stopped {
  --pcard-accent: var(--ui-danger, #ef4444);
  --pcard-accent-soft: rgba(239, 68, 68, 0.14);
}

@keyframes perception-card-in {
  from {
    opacity: 0;
    transform: translate3d(0, 5px, 0) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

/* ── 卡片头部 ── */
.perception-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px 9px 12px;
  background: var(--pcard-head-bg);
  border-bottom: 1px solid var(--pcard-subtle);
}

.perception-card__head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.perception-card__icon {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid color-mix(in srgb, var(--pcard-accent) 36%, var(--pcard-subtle));
  border-radius: 2px;
  background: var(--pcard-accent-soft);
  color: var(--pcard-accent);
  flex-shrink: 0;
}

.perception-card__title {
  font-family: var(--ui-font-pixel);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--pcard-text);
  white-space: nowrap;
}

.perception-card__badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 19px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--pcard-accent) 34%, var(--pcard-subtle));
  border-radius: 2px;
  background: var(--pcard-accent-soft);
  color: var(--pcard-text);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.perception-card__badge i {
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: var(--pcard-accent);
  flex-shrink: 0;
}

.perception-card__close {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--pcard-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard);
}

.perception-card__close:hover {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  border-color: color-mix(in srgb, var(--ui-danger) 35%, var(--pcard-subtle));
}

/* ── 卡片内容区 ── */
.perception-card__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
}

.perception-card__well {
  padding: 9px 10px;
  border: 1px solid var(--pcard-subtle);
  border-radius: 2px;
  background: var(--pcard-well-bg);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.06);
}

.perception-card__well--muted {
  border-left: 2px solid var(--pcard-accent);
}

.perception-card__caption {
  display: block;
  margin-bottom: 4px;
  font-family: var(--ui-font-pixel);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--pcard-text-muted);
  letter-spacing: 0.02em;
}

.perception-card__desc {
  margin: 0;
  color: var(--pcard-text-sub);
  font-size: 12px;
  line-height: 1.55;
}

.perception-card__snapshot {
  max-height: 196px;
  margin: 0;
  overflow-y: auto;
  color: var(--pcard-text);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.perception-card__reason {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 38%, var(--pcard-subtle));
  border-left: 2px solid var(--ui-warning);
  border-radius: 2px;
  background: var(--pcard-accent-soft);
  color: var(--pcard-text);
  font-size: 11.5px;
  line-height: 1.5;
}

.perception-card__reason-icon {
  margin-top: 2px;
  color: var(--ui-warning);
  flex-shrink: 0;
}

.perception-card__error {
  margin: 0;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--ui-danger) 36%, var(--pcard-subtle));
  border-left: 2px solid var(--ui-danger);
  border-radius: 2px;
  background: rgba(239, 68, 68, 0.1);
  color: var(--ui-danger);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* ── 卡片底部操作栏 ── */
.perception-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  background: var(--pcard-foot-bg);
  border-top: 1px solid var(--pcard-subtle);
}

.perception-card__actions-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.perception-card__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--pcard-border);
  border-radius: 2px;
  background: var(--pcard-btn-bg);
  color: var(--pcard-text);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}

.perception-card__btn:hover:not(:disabled) {
  background: var(--pcard-btn-hover);
  border-color: color-mix(in srgb, var(--pcard-text) 28%, var(--pcard-border));
}

.perception-card__btn:active:not(:disabled) {
  transform: translateY(1px);
}

.perception-card__btn:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

.perception-card__btn--primary {
  border-color: color-mix(in srgb, var(--pcard-cta) 52%, var(--pcard-border));
  background: var(--pcard-cta-soft);
  color: var(--pcard-cta);
}

[data-theme='dark'] .perception-card__btn--primary {
  color: #e9d5ff;
  border-color: color-mix(in srgb, var(--pcard-cta) 60%, var(--pcard-border));
}

.perception-card__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--pcard-cta) 22%, var(--pcard-btn-bg));
  border-color: var(--pcard-cta);
}

.perception-card__btn--danger:hover:not(:disabled) {
  color: var(--ui-danger);
  background: rgba(239, 68, 68, 0.1);
  border-color: color-mix(in srgb, var(--ui-danger) 48%, var(--pcard-border));
}

.perception-card__btn--settings {
  margin-left: auto;
  color: var(--pcard-text-sub);
}

.perception-card__btn--settings:hover:not(:disabled) {
  color: var(--pcard-text);
}

[data-motion='off'] .perception-status-panel {
  animation: none;
}

[data-motion='reduced'] .perception-status-panel {
  animation-duration: 90ms;
}

[data-motion='off'] .perception-status-button,
[data-motion='reduced'] .perception-status-button,
[data-motion='off'] .perception-status-chevron,
[data-motion='reduced'] .perception-status-chevron,
[data-motion='off'] .perception-card__btn,
[data-motion='reduced'] .perception-card__btn {
  transition: none;
}
</style>
