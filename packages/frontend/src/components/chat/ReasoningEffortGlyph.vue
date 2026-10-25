<script setup lang="ts">
import { computed } from 'vue'
import type { ReasoningEffort } from '@infos/shared'

const props = defineProps<{ effort?: ReasoningEffort | null }>()
const levels = { off: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 } as const
const level = computed(() => (props.effort ? levels[props.effort] : 0))
</script>

<template>
  <svg
    class="effort-glyph"
    :data-effort-glyph="effort || 'inherit'"
    viewBox="0 0 20 20"
    fill="currentColor"
    shape-rendering="crispEdges"
    aria-hidden="true"
    focusable="false"
  >
    <!-- 跟随、关闭与固定档位使用不同轮廓，低饱和环境下仍能区分。 -->
    <path
      v-if="!effort"
      d="M3 5h11V3h2v2h2v2h-2v2h-2V7H5v3H3z M17 15H6v2H4v-2H2v-2h2v-2h2v2h9v-3h2z"
    />
    <path
      v-else-if="effort === 'off'"
      d="M4 3h12v2H4z M3 5h2v10H3z M15 5h2v10h-2z M4 15h12v2H4z M7 9h6v2H7z"
    />
    <template v-else>
      <rect
        v-for="step in 5"
        :key="step"
        :x="step * 3 - 1"
        :y="18 - step * 3"
        width="2"
        :height="step * 3"
        :class="{ 'is-lit': step <= level }"
      />
      <path v-if="effort === 'max'" d="M3 1h2v2h2v2H5v2H3V5H1V3h2z" />
    </template>
  </svg>
</template>

<style scoped>
.effort-glyph {
  display: block;
  flex: none;
  width: 20px;
  height: 20px;
}
.effort-glyph rect {
  opacity: 0.16;
}
.effort-glyph rect.is-lit {
  opacity: 1;
}
</style>
