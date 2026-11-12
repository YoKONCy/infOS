<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * CardTile — 「桌面卡片」页单卡组件：预览视窗、元信息、机械状态微开关与底部硬朗分仓操控条
 *
 * - 将散乱的静态标签 + 7 个无边界文字按钮收敛为两层清晰结构：
 *   1. 机械状态微开关行（收藏 / 置顶 / 开机打开）：激活时仅以左侧 2px 指示条与图标着色表达；
 *   2. 底部硬朗分仓操控条：左侧紧凑双仓主动作（打开/关闭或收藏捡回），右侧哑光辅助键（改名、源码、删除）。
 * - 内置预制件（如收纳框）由宿主直接渲染，无用户 HTML 源码，自动隐藏无效的「源码」入口。
 */
import { computed } from 'vue'
import type { DesktopCardListItem } from '@infos/shared'
import { PixelIcon } from '../../pixel'

const props = defineProps<{ card: DesktopCardListItem; busy: boolean; recent?: boolean }>()
const emit = defineEmits<{
  open: []
  close: []
  save: [saved: boolean]
  pin: [pinned: boolean]
  autoOpen: [enabled: boolean]
  rename: []
  source: []
  remove: []
}>()

const isFence = computed(() => props.card.prefab?.kind === 'fence')
const hasSource = computed(() => !props.card.prefab)

/** 时间按当前界面语言显示到分钟。 */
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const created = computed(() =>
  __t('ui.desktop-shell', '创建于 {0}', [formatTime(props.card.createdAt)]),
)
const expires = computed(() =>
  props.card.expiresAt
    ? __t('ui.desktop-shell', '{0} 后清理', [formatTime(props.card.expiresAt)])
    : '',
)
</script>

<template>
  <article
    class="card-tile"
    :class="{
      'card-tile--open': card.open,
      'card-tile--recent': recent,
    }"
  >
    <!-- 1. 像素取景预览窗 -->
    <div class="card-tile__thumb">
      <img v-if="card.thumbnail" :src="card.thumbnail" :alt="card.name" />
      <div v-else class="card-tile__placeholder" aria-hidden="true">
        <span class="card-tile__placeholder-emblem">
          <PixelIcon :name="isFence ? 'folder' : 'layout'" size="md" />
        </span>
        <span class="card-tile__placeholder-label">
          {{ isFence ? __t('ui.desktop-shell', '收纳框') : __t('ui.desktop-shell', '桌面卡片') }}
        </span>
      </div>

      <span v-if="card.open" class="card-tile__status card-tile__status--open">
        <i class="card-tile__status-dot" />
        {{ __t('ui.desktop-shell', '已打开') }}
      </span>
      <span v-else-if="!recent" class="card-tile__status card-tile__status--idle">
        <i class="card-tile__status-dot" />
        {{ __t('ui.desktop-shell', '待机') }}
      </span>
    </div>

    <!-- 2. 卡片信息与快捷状态拨片 -->
    <div class="card-tile__body">
      <div class="card-tile__title-row">
        <h3 :title="card.name">{{ card.name }}</h3>
        <span v-if="isFence" class="card-tile__kind">
          {{ __t('ui.desktop-shell', '收纳框') }}
        </span>
      </div>

      <p class="card-tile__meta">{{ created }}</p>

      <!-- 最近关闭过期提示 -->
      <p v-if="recent && expires" class="card-tile__expires">
        <PixelIcon name="clock" size="xs" />
        <span>{{ expires }}</span>
      </p>

      <!-- 常驻状态切换拨片：兼具状态展示与一键开关 -->
      <div v-else-if="!recent" class="card-tile__toggles">
        <button
          type="button"
          class="card-chip"
          :class="{ 'is-active is-gold': card.saved }"
          :disabled="busy"
          :aria-pressed="card.saved"
          :title="
            card.saved
              ? __t('ui.desktop-shell', '取消收藏')
              : __t('ui.desktop-shell', '收藏')
          "
          @click="emit('save', !card.saved)"
        >
          <PixelIcon name="star" size="xs" />
          <span>
            {{
              card.saved ? __t('ui.desktop-shell', '已收藏') : __t('ui.desktop-shell', '收藏')
            }}
          </span>
        </button>

        <button
          type="button"
          class="card-chip"
          :class="{ 'is-active is-violet': card.alwaysOnTop }"
          :disabled="busy"
          :aria-pressed="card.alwaysOnTop"
          :title="
            card.alwaysOnTop
              ? __t('ui.desktop-shell', '取消置顶')
              : __t('ui.desktop-shell', '置顶')
          "
          @click="emit('pin', !card.alwaysOnTop)"
        >
          <PixelIcon name="map-pin" size="xs" />
          <span>{{ __t('ui.desktop-shell', '置顶') }}</span>
        </button>

        <button
          type="button"
          class="card-chip"
          :class="{ 'is-active is-sky': card.autoOpen }"
          :disabled="busy"
          :aria-pressed="card.autoOpen"
          :title="__t('ui.desktop-shell', '启动 infOS 时自动打开（会一并收藏）')"
          @click="emit('autoOpen', !card.autoOpen)"
        >
          <PixelIcon name="power" size="xs" />
          <span>{{ __t('ui.desktop-shell', '开机打开') }}</span>
        </button>
      </div>
    </div>

    <!-- 3. 底部硬朗分仓操控条 -->
    <footer class="card-tile__footer">
      <template v-if="recent">
        <button
          type="button"
          class="card-btn card-btn--chambered card-btn--save"
          :disabled="busy"
          @click="emit('save', true)"
        >
          <span class="card-btn__emblem" aria-hidden="true">
            <PixelIcon name="star" size="xs" />
          </span>
          <span class="card-btn__label">{{ __t('ui.desktop-shell', '收藏捡回') }}</span>
        </button>
        <button
          type="button"
          class="card-btn"
          :disabled="busy"
          @click="emit('open')"
        >
          <PixelIcon name="play" size="xs" />
          <span>{{ __t('ui.desktop-shell', '打开') }}</span>
        </button>
      </template>

      <template v-else>
        <button
          v-if="card.open"
          type="button"
          class="card-btn card-btn--chambered card-btn--stop"
          :disabled="busy"
          @click="emit('close')"
        >
          <span class="card-btn__emblem" aria-hidden="true">
            <PixelIcon name="close" size="xs" />
          </span>
          <span class="card-btn__label">{{ __t('ui.desktop-shell', '关闭') }}</span>
        </button>
        <button
          v-else
          type="button"
          class="card-btn card-btn--chambered card-btn--open"
          :disabled="busy"
          @click="emit('open')"
        >
          <span class="card-btn__emblem" aria-hidden="true">
            <PixelIcon name="play" size="xs" />
          </span>
          <span class="card-btn__label">{{ __t('ui.desktop-shell', '打开') }}</span>
        </button>
      </template>

      <div class="card-tile__tools">
        <button
          v-if="!recent"
          type="button"
          class="card-btn"
          :disabled="busy"
          :title="__t('ui.desktop-shell', '改名')"
          @click="emit('rename')"
        >
          <PixelIcon name="edit" size="xs" />
          <span>{{ __t('ui.desktop-shell', '改名') }}</span>
        </button>

        <button
          v-if="hasSource"
          type="button"
          class="card-btn"
          :class="{ 'card-btn--icon': recent }"
          :disabled="busy"
          :title="__t('ui.desktop-shell', '查看源码')"
          :aria-label="__t('ui.desktop-shell', '源码')"
          @click="emit('source')"
        >
          <PixelIcon name="code" size="xs" />
          <span v-if="!recent">{{ __t('ui.desktop-shell', '源码') }}</span>
        </button>

        <button
          type="button"
          class="card-btn card-btn--icon card-btn--danger"
          :disabled="busy"
          :title="__t('ui.desktop-shell', '删除')"
          :aria-label="__t('ui.desktop-shell', '删除')"
          @click="emit('remove')"
        >
          <PixelIcon name="trash" size="xs" />
        </button>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.card-tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-default));
  background: var(--cards-surface, var(--ui-bg-surface));
  box-shadow: var(--cards-panel-shadow, none);
  transition: border-color 140ms ease;
}

.card-tile:hover {
  border-color: var(--cards-border-strong, var(--ui-border-strong));
}

.card-tile--open {
  box-shadow:
    inset 0 2px 0 var(--ui-success),
    var(--cards-panel-shadow, none);
}

.card-tile--recent {
  background: var(--cards-surface-soft, var(--ui-bg-surface-soft));
}

/* ── 1. 预览取景窗（深色内凹点阵视窗，无彩色光晕污染） ── */
.card-tile__thumb {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-subtle));
  background: var(--cards-inset-bg, var(--ui-bg-canvas));
}

.card-tile__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}

.card-tile__placeholder {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  background-image: radial-gradient(circle, rgba(148, 163, 184, 0.2) 1px, transparent 1px);
  background-size: 12px 12px;
}

[data-theme='dark'] .card-tile__placeholder {
  background-image: radial-gradient(circle, rgba(148, 163, 184, 0.12) 1px, transparent 1px);
}

.card-tile__placeholder-emblem {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 0;
  border: 1px solid var(--cards-key-border, var(--ui-border-default));
  background: var(--cards-key-bg, var(--ui-bg-surface));
  box-shadow: var(--cards-key-shadow, none);
  color: var(--ui-text-secondary);
}

.card-tile__placeholder-label {
  font-family: var(--ui-font-pixel);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--ui-text-tertiary);
}

/* 左上角运行状态读数块 */
.card-tile__status {
  position: absolute;
  top: 7px;
  left: 7px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 0;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(13, 16, 23, 0.86);
  font-family: var(--ui-font-pixel);
  font-size: 10px;
  line-height: 1.4;
}

.card-tile__status-dot {
  width: 5px;
  height: 5px;
  border-radius: 0;
}

.card-tile__status--open {
  color: #d1fae5;
}

.card-tile__status--open .card-tile__status-dot {
  background: #34d399;
}

.card-tile__status--idle {
  color: #cbd5e1;
}

.card-tile__status--idle .card-tile__status-dot {
  background: #64748b;
}

/* ── 2. 标题与机械状态微开关区 ── */
.card-tile__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.card-tile__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.card-tile__body h3 {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 800;
  color: var(--ui-text-primary);
}

.card-tile__kind {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-subtle));
  background: var(--cards-inset-bg, var(--ui-bg-surface-soft));
  font-family: var(--ui-font-pixel);
  font-size: 10px;
  color: var(--ui-text-tertiary);
}

.card-tile__meta {
  margin: 0;
  font-size: 11px;
  color: var(--ui-text-tertiary);
}

.card-tile__expires {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 3px 0 0;
  padding: 2px 7px;
  align-self: flex-start;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-default));
  border-left: 2px solid var(--ui-warning);
  background: var(--cards-inset-bg, var(--ui-bg-surface-soft));
  font-size: 11px;
  color: var(--ui-warning);
}

/* 状态微开关：未激活为内凹暗槽，激活时仅左侧 2px 指示灯条 + 图标着色，拒绝大面积彩色底块 */
.card-tile__toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 4px;
}

.card-chip {
  --chip-accent: var(--ui-text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-default));
  background: var(--cards-inset-bg, var(--ui-bg-surface-soft));
  color: var(--ui-text-tertiary);
  font-family: var(--ui-font-pixel);
  font-size: 10px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.card-chip:hover:not(:disabled) {
  border-color: var(--cards-border-strong, var(--ui-border-strong));
  color: var(--ui-text-primary);
}

.card-chip:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.card-chip.is-gold {
  --chip-accent: var(--ui-warning);
}

.card-chip.is-violet {
  --chip-accent: var(--ui-accent-sky);
}

.card-chip.is-sky {
  --chip-accent: var(--ui-success);
}

.card-chip.is-active {
  border-color: var(--cards-border-strong, var(--ui-border-strong));
  border-left: 2px solid var(--chip-accent);
  background: var(--cards-key-bg, var(--ui-bg-surface));
  color: var(--ui-text-primary);
}

.card-chip.is-active :deep(.pixel-icon) {
  color: var(--chip-accent);
}

/* ── 3. 底部硬朗分仓操控条（紧凑不拉伸，无油腻紫色渐变） ── */
.card-tile__footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--cards-border, var(--ui-border-subtle));
}

.card-tile__tools {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
}

.card-btn {
  --btn-accent: var(--ui-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 9px;
  border-radius: 0;
  border: 1px solid var(--cards-key-border, var(--ui-border-default));
  background: var(--cards-key-bg, var(--ui-bg-surface));
  box-shadow: var(--cards-key-shadow, none);
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-pixel);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 130ms ease,
    border-color 130ms ease,
    color 130ms ease;
}

.card-btn--chambered {
  justify-content: flex-start;
  gap: 0;
  padding: 0;
}

.card-btn__emblem {
  display: grid;
  flex: 0 0 28px;
  align-self: stretch;
  place-items: center;
  border-right: 1px solid var(--ui-border-subtle);
  background: color-mix(in srgb, var(--btn-accent) 6%, transparent);
  color: var(--btn-accent);
}

.card-btn__label {
  padding: 0 10px;
}

.card-btn:hover:not(:disabled) {
  background: var(--cards-key-hover, var(--ui-bg-hover));
  border-color: var(--cards-border-strong, var(--ui-border-strong));
  color: var(--ui-text-primary);
}

.card-btn:active:not(:disabled) {
  transform: translate(1px, 1px);
  box-shadow: inset 1px 1px 0 var(--cards-step-shadow, rgba(0, 0, 0, 0.25));
}

.card-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

/* 打开卡片：翠绿状态图标微槽 + 哑光底面 */
.card-btn--open {
  --btn-accent: var(--ui-success);
  border-color: color-mix(
    in srgb,
    var(--ui-success) 38%,
    var(--cards-key-border, var(--ui-border-default))
  );
  color: var(--ui-text-primary);
}

.card-btn--open:hover:not(:disabled) {
  border-color: var(--ui-success);
  color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 7%, var(--cards-key-bg, var(--ui-bg-surface)));
}

/* 关闭运行中卡片：克制中性分仓机械键，悬停时琥珀提示 */
.card-btn--stop {
  --btn-accent: var(--ui-text-secondary);
  color: var(--ui-text-secondary);
}

.card-btn--stop:hover:not(:disabled) {
  --btn-accent: var(--ui-warning);
  border-color: var(--ui-warning);
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 7%, var(--cards-key-bg, var(--ui-bg-surface)));
}

/* 收藏捡回：琥珀星标微槽 + 哑光底面 */
.card-btn--save {
  --btn-accent: var(--ui-warning);
  border-color: color-mix(
    in srgb,
    var(--ui-warning) 42%,
    var(--cards-key-border, var(--ui-border-default))
  );
  color: var(--ui-text-primary);
}

.card-btn--save:hover:not(:disabled) {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 7%, var(--cards-key-bg, var(--ui-bg-surface)));
}

/* 方形纯图标键（删除） */
.card-btn--icon {
  width: 30px;
  padding: 0;
  flex-shrink: 0;
}

.card-btn--danger:hover:not(:disabled) {
  border-color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 10%, var(--cards-key-bg, var(--ui-bg-surface)));
  color: var(--ui-danger);
}
</style>
