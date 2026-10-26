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
        <i class="surface-execution__signal" />
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
  --process-ink: color-mix(in srgb, var(--process-accent) 72%, var(--ui-text-primary));
  --process-edge: color-mix(in srgb, var(--process-accent) 27%, var(--ui-border-default));
  --process-side: color-mix(in srgb, var(--process-accent) 24%, var(--ui-border-strong));
  position: relative;
  margin-block: 12px;
  min-width: 0;
}
.surface-execution::before {
  position: absolute;
  top: 39px;
  bottom: 5px;
  left: 17px;
  width: 1px;
  background: linear-gradient(var(--process-edge), var(--ui-border-subtle));
  content: '';
  transform: scaleY(0);
  transform-origin: top;
  transition: transform var(--ui-duration-normal) var(--ui-ease-emphasized);
  pointer-events: none;
}
.surface-execution[open]::before {
  transform: scaleY(1);
}
.surface-execution__summary {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  width: fit-content;
  max-width: 100%;
  min-height: 42px;
  padding: 7px 8px 7px 9px;
  border: 1px solid var(--process-edge);
  border-radius: 2px;
  color: var(--ui-text-secondary);
  background:
    linear-gradient(
      115deg,
      color-mix(in srgb, var(--process-accent) 9%, transparent),
      transparent 75%
    ),
    color-mix(in srgb, var(--ui-bg-elevated) 94%, transparent);
  box-shadow:
    inset 1px 1px color-mix(in srgb, white 13%, transparent),
    inset -1px -1px color-mix(in srgb, var(--ui-text-primary) 5%, transparent),
    2px 3px 0 var(--process-side),
    0 5px 10px color-mix(in srgb, var(--ui-text-primary) 5%, transparent);
  cursor: pointer;
  list-style: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform var(--ui-duration-fast) var(--ui-ease-emphasized),
    border-color var(--ui-duration-fast),
    box-shadow var(--ui-duration-fast);
}
/* 折角与两格索引是固定装饰，不额外占据点击区域。 */
.surface-execution__summary::before {
  position: absolute;
  top: -1px;
  left: 10px;
  width: 18px;
  height: 2px;
  background: var(--process-accent);
  box-shadow: 22px 0 color-mix(in srgb, var(--process-accent) 35%, transparent);
  content: '';
  pointer-events: none;
}
.surface-execution__summary::after {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 5px;
  height: 5px;
  background: color-mix(in srgb, var(--process-accent) 34%, transparent);
  clip-path: polygon(0 0, 100% 0, 100% 100%);
  content: '';
  pointer-events: none;
}
.surface-execution__summary::-webkit-details-marker {
  display: none;
}
.surface-execution__summary:active {
  transform: translate(2px, 2px);
  box-shadow:
    inset 1px 1px color-mix(in srgb, var(--ui-text-primary) 6%, transparent),
    0 1px 0 var(--process-side);
}
.surface-execution__summary:focus-visible {
  outline: 2px solid var(--process-accent);
  outline-offset: 5px;
}
.surface-execution[open] > .surface-execution__summary {
  border-color: color-mix(in srgb, var(--process-accent) 48%, var(--ui-border-default));
}
.surface-execution__copy {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.surface-execution__summary strong {
  font: 400 13px/1.5 var(--ui-font-pixel);
  letter-spacing: 0.04em;
  color: var(--process-ink);
}
.surface-execution__count,
.surface-execution__error {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.surface-execution__count {
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--process-edge) 65%, transparent);
  color: var(--ui-text-secondary);
  background: color-mix(in srgb, var(--ui-bg-canvas) 45%, transparent);
}
.surface-execution__error {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-danger);
}
.surface-execution__error > span {
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
  border: 1px solid currentColor;
  font: 700 9px/1 monospace;
}
.surface-execution__glyph {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 27px;
  width: 27px;
  height: 27px;
  border: 1px solid color-mix(in srgb, var(--process-accent) 22%, transparent);
  background: color-mix(in srgb, var(--process-accent) 10%, var(--ui-bg-surface));
  box-shadow:
    inset 1px 1px color-mix(in srgb, white 12%, transparent),
    1px 1px 0 var(--process-edge);
  color: var(--process-ink);
}
.surface-execution__glyph svg {
  width: 22px;
  height: 22px;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linejoin: round;
  overflow: visible;
}
.surface-execution__sheet {
  fill: var(--ui-bg-surface);
  transition: transform var(--ui-duration-normal) var(--ui-ease-bouncy);
}
.surface-execution__sheet--back {
  opacity: 0.5;
}
.surface-execution__sheet--front {
  fill: color-mix(in srgb, var(--process-accent) 18%, var(--ui-bg-elevated));
}
.surface-execution__signal {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 6px;
  height: 6px;
  border: 1px solid var(--ui-bg-elevated);
  background: var(--process-accent);
}
.surface-execution--live {
  --process-accent: var(--ui-accent-sky);
}
.surface-execution--live .surface-execution__signal {
  animation: execution-signal 1.8s steps(2, end) infinite;
}
.surface-execution--error {
  --process-accent: var(--ui-danger);
}
.surface-execution__action {
  display: grid;
  place-items: center;
  width: 23px;
  height: 23px;
  margin-left: 2px;
  border: 1px solid var(--process-edge);
  background: color-mix(in srgb, var(--process-accent) 7%, var(--ui-bg-surface));
  color: var(--process-ink);
  box-shadow: inset 1px 1px color-mix(in srgb, white 10%, transparent);
  transition: background-color var(--ui-duration-fast);
}
.surface-execution__action :deep(.pixel-icon) {
  transition: transform var(--ui-duration-normal) var(--ui-ease-emphasized);
}
.surface-execution[open] .surface-execution__action :deep(.pixel-icon) {
  transform: rotate(-180deg);
}
.surface-execution__body {
  display: flow-root;
  min-width: 0;
  padding: 9px 0 2px 29px;
}
.surface-execution:not([open]) .surface-execution__body :deep(*) {
  animation-play-state: paused !important;
}
@keyframes execution-signal {
  50% {
    opacity: 0.35;
  }
}
@media (hover: hover) {
  .surface-execution__summary:hover {
    border-color: color-mix(in srgb, var(--process-accent) 65%, var(--ui-border-default));
    box-shadow:
      inset 1px 1px color-mix(in srgb, white 17%, transparent),
      2px 4px 0 var(--process-side),
      0 7px 13px color-mix(in srgb, var(--process-accent) 10%, transparent);
    transform: translateY(-1px);
  }
  .surface-execution__summary:hover .surface-execution__sheet--front {
    transform: translateY(-1.5px);
  }
  .surface-execution__summary:hover .surface-execution__sheet--back {
    transform: translateY(1px);
  }
  .surface-execution__summary:active {
    transform: translate(2px, 2px);
    box-shadow:
      inset 1px 1px color-mix(in srgb, var(--ui-text-primary) 6%, transparent),
      0 1px 0 var(--process-side);
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
    min-height: 46px;
  }
}
@media (max-width: 480px) {
  .surface-execution__body {
    padding-left: 18px;
  }
  .surface-execution::before {
    left: 8px;
  }
}
[data-motion='reduced'] .surface-execution__summary,
[data-motion='off'] .surface-execution__summary {
  transform: none;
}
[data-motion='reduced'] .surface-execution__sheet,
[data-motion='off'] .surface-execution__sheet {
  transform: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .surface-execution::before,
  .surface-execution::details-content,
  .surface-execution__summary,
  .surface-execution__sheet,
  .surface-execution__action :deep(.pixel-icon) {
    transition: none;
  }
  .surface-execution__summary,
  .surface-execution__sheet {
    transform: none !important;
  }
  .surface-execution__signal {
    animation: none;
  }
}
</style>
