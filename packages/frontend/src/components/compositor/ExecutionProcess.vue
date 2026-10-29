<script setup lang="ts">
import { ref, watch } from 'vue'
import { t as __t } from '../../i18n'
import PixelIcon from '../pixel/PixelIcon.vue'

const props = defineProps<{
  enabled: boolean
  ended: boolean
  toolCount: number
  failureCount: number
}>()

const expanded = ref(!props.ended)
// 仅在本轮结束或重新执行时调整默认折叠状态，后续结果更新不覆盖手动展开。
watch(
  () => props.ended,
  (ended) => {
    expanded.value = !ended
  },
)

function toggle(event: Event): void {
  // 内层工具和思考块也使用 details，其切换不能改变整个执行段。
  if (event.target !== event.currentTarget) return
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
}
</script>

<template>
  <details
    v-if="enabled"
    class="surface-execution"
    :class="{ 'surface-execution--live': !ended, 'surface-execution--error': failureCount > 0 }"
    :open="expanded"
    @toggle="toggle"
  >
    <summary class="surface-execution__summary">
      <span class="surface-execution__glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path
            class="surface-execution__sheet surface-execution__sheet--back"
            d="m4 13 8 4 8-4v4l-8 4-8-4z"
          />
          <path class="surface-execution__sheet" d="m4 8 8 4 8-4v4l-8 4-8-4z" />
          <path
            class="surface-execution__sheet surface-execution__sheet--front"
            d="m4 7 8-4 8 4-8 4z"
          />
          <path class="surface-execution__stroke" d="m9 7 3-1.5L15 7" />
        </svg>
        <i v-if="!ended" class="surface-execution__signal" />
      </span>
      <span class="surface-execution__copy">
        <strong>{{ __t('ui.compositor', '执行过程') }}</strong>
        <span class="surface-execution__count">
          {{ __t('ui.compositor', '{0} 次调用', [toolCount]) }}
        </span>
      </span>
      <span v-if="failureCount" class="surface-execution__error">
        <span aria-hidden="true">!</span>
        {{ __t('ui.compositor', '{0} 项异常', [failureCount]) }}
      </span>
      <span class="surface-execution__action" aria-hidden="true">
        <PixelIcon name="chevron-down" size="xs" />
      </span>
    </summary>
    <!-- 保留已挂载的卡片和内部展开状态，折叠时仅暂停重型内容。 -->
    <div class="surface-execution__body">
      <slot :expanded="expanded" />
    </div>
  </details>
  <slot v-else :expanded="true" />
</template>

<style scoped>
.surface-execution {
  --process-accent: var(--ui-accent-purple);
  margin-block: 6px;
  min-width: 0;
}
.surface-execution__summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  min-height: 30px;
  padding: 4px 7px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 4px;
  color: var(--ui-text-secondary);
  background: color-mix(in srgb, var(--ui-bg-elevated) 35%, transparent);
  cursor: pointer;
  list-style: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    background-color var(--ui-duration-fast),
    border-color var(--ui-duration-fast);
}
.surface-execution__summary::-webkit-details-marker {
  display: none;
}
.surface-execution__summary::marker {
  content: '';
}
.surface-execution__summary:focus-visible {
  outline: 2px solid var(--process-accent);
  outline-offset: 2px;
}
.surface-execution__summary:active {
  background: color-mix(in srgb, var(--process-accent) 8%, transparent);
}
.surface-execution__copy {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.surface-execution__summary strong {
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  color: var(--ui-text-secondary);
}
.surface-execution__count,
.surface-execution__error {
  font-size: 11px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.surface-execution__count {
  padding-left: 6px;
  border-left: 1px solid var(--ui-border-default);
  color: var(--ui-text-secondary);
}
.surface-execution__error {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ui-danger);
}
.surface-execution__error > span {
  font-weight: 700;
}
.surface-execution__glyph {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  color: var(--process-accent);
}
.surface-execution__glyph svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linejoin: round;
}
.surface-execution__sheet {
  fill: var(--ui-bg-surface);
}
.surface-execution__sheet--back {
  opacity: 0.5;
}
.surface-execution__sheet--front {
  fill: color-mix(in srgb, var(--process-accent) 12%, var(--ui-bg-surface));
}
.surface-execution__signal {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--process-accent);
}
.surface-execution--live {
  --process-accent: var(--ui-accent-sky);
}
.surface-execution--live .surface-execution__signal {
  animation: execution-signal 1.8s ease-in-out infinite;
}
.surface-execution--error {
  --process-accent: var(--ui-danger);
}
.surface-execution__action {
  display: grid;
  place-items: center;
  flex: 0 0 14px;
  width: 14px;
  height: 16px;
  color: var(--ui-text-secondary);
}
.surface-execution__action :deep(.pixel-icon) {
  width: 12px;
  height: 12px;
  transition: transform var(--ui-duration-fast) var(--ui-ease-emphasized);
}
.surface-execution[open] .surface-execution__action :deep(.pixel-icon) {
  transform: rotate(-180deg);
}
.surface-execution__body {
  display: flow-root;
  min-width: 0;
  margin: 4px 0 0 7px;
  padding: 2px 0 2px 12px;
  border-left: 1px solid var(--ui-border-subtle);
}
.surface-execution:not([open]) .surface-execution__body :deep(*) {
  animation-play-state: paused !important;
}
@keyframes execution-signal {
  50% {
    opacity: 0.4;
  }
}
@media (hover: hover) {
  .surface-execution__summary:hover {
    border-color: var(--ui-border-default);
    background: color-mix(in srgb, var(--process-accent) 6%, var(--ui-bg-surface));
  }
}
/* 使用声明型能力查询，兼容当前 Autoprefixer；不支持伪元素的浏览器保留原生折叠。 */
@supports (interpolate-size: allow-keywords) {
  .surface-execution {
    interpolate-size: allow-keywords;
  }
  .surface-execution::details-content {
    block-size: 0;
    overflow: clip;
    opacity: 0;
    transition:
      block-size var(--ui-duration-normal) var(--ui-ease-emphasized),
      opacity var(--ui-duration-fast) ease,
      content-visibility var(--ui-duration-normal) allow-discrete;
  }
  .surface-execution[open]::details-content {
    block-size: auto;
    opacity: 1;
  }
}
@media (pointer: coarse) {
  .surface-execution__summary {
    min-height: 44px;
  }
}
@media (max-width: 480px) {
  .surface-execution__body {
    margin-left: 5px;
    padding-left: 8px;
  }
}
[data-motion='reduced'] .surface-execution__signal,
[data-motion='off'] .surface-execution__signal {
  animation: none;
}
[data-motion='reduced'] .surface-execution::details-content,
[data-motion='off'] .surface-execution::details-content,
[data-motion='reduced'] .surface-execution__action :deep(.pixel-icon),
[data-motion='off'] .surface-execution__action :deep(.pixel-icon) {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .surface-execution::details-content,
  .surface-execution__summary,
  .surface-execution__action :deep(.pixel-icon) {
    transition: none;
  }
  .surface-execution__signal {
    animation: none;
  }
}
</style>
