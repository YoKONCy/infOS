<script setup lang="ts">
/**
 * ToolArchetypeSignature.vue — 轨迹节点 23×23 哑光微立体双调铭牌
 *
 * 顶层工具节点渲染 23×23px 哑光微立体铭牌（骑跨于双线微刻纵向主轴或内联排布）；
 * NIT 嵌套子调用渲染无框精工双调微标，保持分叉树清爽紧凑。
 */
import { computed } from 'vue'
import TrajectoryIcon from './TrajectoryIcon.vue'
import { resolveTrajectoryVisual, type ToolVisualSignature } from './toolSignatures'
import './trajectory-tactile.css'

const props = withDefaults(
  defineProps<{
    signature: ToolVisualSignature
    icon: string
    label: string
    summary: string
    state: 'running' | 'error' | 'ok'
    toolName?: string
    hasChildren?: boolean
    nested?: boolean
  }>(),
  {
    toolName: '',
    hasChildren: false,
    nested: false,
  },
)

const visual = computed(() =>
  resolveTrajectoryVisual(props.toolName || props.signature.variant.replaceAll('-', '_'), {
    hasChildren: props.hasChildren,
    archetype: props.signature.archetype,
  }),
)

const isNitGlyph = computed(
  () => props.hasChildren || props.signature.archetype === 'script-circuit',
)
</script>

<template>
  <span
    v-if="nested"
    class="tas tas--nested"
    :class="[`tas-${signature.archetype}`, `tas-state-${state}`]"
    :style="{ '--ng-c': state === 'error' ? 'var(--ui-danger)' : visual.color }"
    aria-hidden="true"
  >
    <TrajectoryIcon :name="visual.icon" size="sm" />
  </span>
  <span
    v-else
    class="tas traj-node-glyph"
    :class="[
      `tas-${signature.archetype}`,
      `tas-state-${state}`,
      {
        'traj-node-glyph--nit': isNitGlyph,
        'traj-node-glyph--live': state === 'running',
        'traj-node-glyph--error': state === 'error',
      },
    ]"
    :style="{ '--ng-c': state === 'error' ? 'var(--ui-danger)' : visual.color }"
    aria-hidden="true"
  >
    <TrajectoryIcon :name="visual.icon" size="sm" />
  </span>
</template>

<style scoped>
.tas--nested {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
  color: var(--ng-c, var(--ui-text-secondary));
}
.tas--nested.tas-state-running {
  color: var(--ui-accent-sky);
}
.tas--nested.tas-state-error {
  color: var(--ui-danger);
}
</style>
