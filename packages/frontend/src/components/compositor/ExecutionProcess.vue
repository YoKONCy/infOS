<script setup lang="ts">
/**
 * ExecutionProcess.vue — 轨迹外层哑光微立体折叠胶囊与双线微刻纵向主轴
 *
 * 汇总连续思考与工具执行步骤，提供四叠双调微刻图标舱、NIT/代码变更/提醒摘要徽标及微凸扳机键。
 * 执行中默认展开，结束时自动收起，手动展开后不因后续增量结果覆盖用户选择。
 */
import { computed, ref, watch } from 'vue'
import { t as __t } from '../../i18n'
import type { ExecutionStep } from '../../compositor/executionGroups'
import { resolveTrajectoryVisual } from '../tools/toolSignatures'
import TrajectoryIcon, { type TrajectoryIconName } from '../tools/TrajectoryIcon.vue'
import '../tools/trajectory-tactile.css'

interface StackBadge {
  key: string
  icon: TrajectoryIconName
  color: string
  state: 'running' | 'error' | 'ok'
}

const props = withDefaults(
  defineProps<{
    enabled: boolean
    ended: boolean
    toolCount: number
    failureCount: number
    thoughtCount?: number
    totalDurationMs?: number
    steps?: readonly ExecutionStep[]
    nitCount?: number
    hasDiff?: boolean
    diffInsertions?: number
    diffDeletions?: number
    reminderHint?: string
    headless?: boolean
    defaultExpanded?: boolean
  }>(),
  {
    thoughtCount: 0,
    totalDurationMs: 0,
    steps: () => [],
    nitCount: 0,
    hasDiff: false,
    diffInsertions: 0,
    diffDeletions: 0,
    reminderHint: '',
    headless: false,
    defaultExpanded: undefined,
  },
)

const expanded = ref(props.defaultExpanded !== undefined ? props.defaultExpanded : !props.ended)

// 仅在本轮结束或重新执行时调整默认折叠状态，后续结果更新不覆盖手动展开。
watch(
  () => props.ended,
  (ended) => {
    expanded.value = props.defaultExpanded || !ended
  },
)

watch(
  () => props.defaultExpanded,
  (val) => {
    if (val) expanded.value = true
  },
)

function resolveStepToken(step: ExecutionStep): { icon: TrajectoryIconName; color: string } {
  if (step.kind === 'thinking') {
    return { icon: 'whisper', color: 'var(--ui-accent-primary)' }
  }
  if (step.kind === 'reasoning') {
    return { icon: 'prism', color: 'var(--ui-accent-purple)' }
  }
  return resolveTrajectoryVisual(step.name ?? '', { hasChildren: step.hasChildren })
}

/** 提取最多 4 枚不重复的双调精工图标组成左侧微凹叠章栈 */
const stackBadges = computed<StackBadge[]>(() => {
  const seen = new Map<TrajectoryIconName, StackBadge>()
  for (const step of props.steps) {
    const token = resolveStepToken(step)
    const existing = seen.get(token.icon)
    if (existing) {
      if (step.state === 'error') existing.state = 'error'
      else if (step.state === 'running' && existing.state !== 'error') existing.state = 'running'
      continue
    }
    if (seen.size >= 4) continue
    seen.set(token.icon, {
      key: `${seen.size}-${token.icon}`,
      icon: token.icon,
      color: step.state === 'error' ? 'var(--ui-danger)' : token.color,
      state: step.state,
    })
  }
  if (seen.size === 0) {
    return [
      {
        key: 'fallback-prism',
        icon: 'prism',
        color: props.failureCount > 0 ? 'var(--ui-danger)' : 'var(--ui-accent-purple)',
        state: props.failureCount > 0 ? 'error' : !props.ended ? 'running' : 'ok',
      },
    ]
  }
  return [...seen.values()]
})

const totalFootprints = computed(() => Math.max(1, props.toolCount + props.thoughtCount))

const capsuleTitle = computed(() => {
  if (!props.ended) return __t('ui.compositor', '正在探索')
  return __t('ui.compositor', '走过 {0} 步足迹', [totalFootprints.value])
})

const durationLabel = computed(() => {
  const ms = props.totalDurationMs
  if (!ms || ms <= 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
})

function toggle(event: Event): void {
  // 内层工具和思考块也使用 details，其切换不能改变整个执行段。
  if (event.target !== event.currentTarget) return
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
}
</script>

<template>
  <details
    v-if="enabled && !headless"
    class="surface-execution"
    :class="{ 'surface-execution--live': !ended, 'surface-execution--error': failureCount > 0 }"
    :open="expanded"
    @toggle="toggle"
  >
    <summary
      class="surface-execution__summary traj-capsule traj-shell traj-shell--interactive"
      :class="{ 'is-open': expanded, 'is-live': !ended, 'is-error': failureCount > 0 }"
    >
      <!-- 左微凹叠标舱：最多 4 枚定制双调微刻图标悬停微张 -->
      <span class="traj-capsule__dock" aria-hidden="true">
        <span class="traj-capsule__stack">
          <span
            v-for="badge in stackBadges"
            :key="badge.key"
            class="traj-capsule__badge"
            :style="{ '--badge-c': badge.color }"
          >
            <TrajectoryIcon :name="badge.icon" size="sm" />
          </span>
        </span>
        <span v-if="!ended" class="traj-capsule__live">
          <TrajectoryIcon name="prism" size="sm" class="traj-live-spin" />
        </span>
      </span>

      <!-- 中间摘要主舱：足迹步数 + NIT/增删行/提醒/异常微标 + 总耗时 -->
      <span class="traj-capsule__main">
        <strong class="traj-capsule__title">{{ capsuleTitle }}</strong>
        <span
          v-if="nitCount > 0 || hasDiff || reminderHint || failureCount > 0 || thoughtCount > 0"
          class="traj-capsule__tags"
        >
          <span
            v-if="nitCount > 0"
            class="traj-mini-chip"
            :style="{ '--pill-c': 'var(--ui-accent-purple)' }"
          >
            <TrajectoryIcon name="nit" size="xs" />
            <span>NIT ×{{ nitCount }}</span>
          </span>
          <span
            v-if="hasDiff"
            class="traj-mini-chip traj-mono"
            :style="{ '--pill-c': 'var(--ui-success)' }"
          >
            <TrajectoryIcon name="patch" size="xs" />
            <span>
              +{{ diffInsertions }}
              <em class="surface-execution__del">−{{ diffDeletions }}</em>
            </span>
          </span>
          <span
            v-if="reminderHint"
            class="traj-mini-chip traj-mono"
            :style="{ '--pill-c': 'var(--ui-warning)' }"
          >
            <TrajectoryIcon name="alarm" size="xs" />
            <span>{{ reminderHint }}</span>
          </span>
          <span
            v-if="failureCount > 0"
            class="traj-mini-chip surface-execution__error"
            :style="{ '--pill-c': 'var(--ui-danger)' }"
          >
            <TrajectoryIcon name="error" size="xs" />
            <span>{{ __t('ui.compositor', '{0} 项异常', [failureCount]) }}</span>
          </span>
          <span
            v-else-if="!nitCount && !hasDiff && !reminderHint && thoughtCount > 0"
            class="traj-mini-chip"
            :style="{ '--pill-c': 'var(--ui-accent-purple)' }"
          >
            <TrajectoryIcon name="prism" size="xs" />
            <span>{{ __t('ui.compositor', '{0} 段思考', [thoughtCount]) }}</span>
          </span>
        </span>
        <time v-if="durationLabel" class="traj-capsule__time surface-execution__duration">
          {{ durationLabel }}
        </time>
      </span>

      <!-- 右侧独立微凸扳机小键 -->
      <span class="traj-capsule__trigger surface-execution__action" aria-hidden="true">
        <span>{{ expanded ? __t('ui.compositor', '收起') : __t('ui.compositor', '展开') }}</span>
        <TrajectoryIcon name="chev-down" size="xs" class="traj-capsule__chev" />
      </span>
    </summary>

    <!-- 保留已挂载的卡片和内部展开状态，折叠时仅暂停重型内容。 -->
    <div class="surface-execution__body traj-spine">
      <slot :expanded="expanded" />
    </div>
  </details>

  <!-- 主会话外层折叠胶囊已接管单一执行段时，仅渲染双线压痕导轨，避免双重折叠头 -->
  <div
    v-else-if="enabled && headless"
    class="surface-execution surface-execution--headless"
    :class="{ 'surface-execution--live': !ended, 'surface-execution--error': failureCount > 0 }"
  >
    <div class="surface-execution__body traj-spine">
      <slot :expanded="true" />
    </div>
  </div>

  <slot v-else :expanded="true" />
</template>

<style scoped>
.surface-execution {
  margin: 8px 0 10px;
  min-width: 0;
}

.surface-execution--headless {
  margin-top: 2px;
}

.surface-execution__del {
  margin-left: 3px;
  color: var(--ui-danger);
  font-style: normal;
}

.surface-execution:not([open]):not(.surface-execution--headless) .surface-execution__body :deep(*) {
  animation-play-state: paused !important;
}

/* 使用声明型能力查询，兼容当前 Autoprefixer；不支持伪元素的浏览器保留原生折叠。 */
@supports (interpolate-size: allow-keywords) {
  details.surface-execution {
    interpolate-size: allow-keywords;
  }
  details.surface-execution::details-content {
    block-size: 0;
    overflow: clip;
    opacity: 0;
    transition:
      block-size var(--ui-duration-normal) var(--ui-ease-emphasized),
      opacity var(--ui-duration-fast) ease,
      content-visibility var(--ui-duration-normal) allow-discrete;
  }
  details.surface-execution[open]::details-content {
    block-size: auto;
    opacity: 1;
  }
}

[data-motion='reduced'] details.surface-execution::details-content,
[data-motion='off'] details.surface-execution::details-content {
  transition: none !important;
}

@media (prefers-reduced-motion: reduce) {
  details.surface-execution::details-content {
    transition: none !important;
  }
}
</style>
