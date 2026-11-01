<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n'
import Icon from './PictoriaIcon.vue'
import type { Project } from '../types'
const props = defineProps<{
  project: Project
  viewport: { x: number; y: number; scale: number }
  size: { width: number; height: number }
}>()
const emit = defineEmits<{ center: [x: number, y: number] }>()
const svg = ref<SVGSVGElement>(),
  dragging = ref(false)
const collapsed = ref(false)
const bounds = computed(() => {
  const nodes = props.project.items,
    view = props.viewport
  const x = Math.min(-view.x / view.scale, ...nodes.map((item) => item.x)) - 100
  const y = Math.min(-view.y / view.scale, ...nodes.map((item) => item.y)) - 100
  const right =
    Math.max(
      (props.size.width - view.x) / view.scale,
      ...nodes.map((item) => item.x + item.content.width),
    ) + 100
  const bottom =
    Math.max(
      (props.size.height - view.y) / view.scale,
      ...nodes.map((item) => item.y + item.content.height),
    ) + 100
  return { x, y, width: right - x, height: bottom - y }
})
function navigate(event: PointerEvent) {
  const matrix = svg.value?.getScreenCTM()
  if (!matrix) return
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
  emit('center', point.x, point.y)
}
function start(event: PointerEvent) {
  dragging.value = true
  svg.value?.setPointerCapture(event.pointerId)
  navigate(event)
}
</script>
<template>
  <section class="studio-minimap-shell floating-panel" :class="{ collapsed }" data-ui>
    <button
      class="studio-minimap-heading"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <Icon name="map" :size="12" />
      <span>{{ t('apps.pictoria.studio', '画布导航') }}</span>
      <Icon name="down" :size="11" />
    </button>
    <svg
      v-if="!collapsed"
      ref="svg"
      class="studio-minimap"
      data-ui
      role="img"
      :aria-label="t('apps.pictoria.studio', '画布导航')"
      :viewBox="`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`"
      @pointerdown.stop.prevent="start"
      @pointermove.stop="dragging && navigate($event)"
      @pointerup="dragging = false"
      @pointercancel="dragging = false"
    >
      <rect
        v-for="item in project.items"
        :key="item.id"
        :x="item.x"
        :y="item.y"
        :width="item.content.width"
        :height="item.content.height"
        :class="item.content.kind === 'group' ? 'map-group' : 'map-node'"
      />
      <rect
        :x="-viewport.x / viewport.scale"
        :y="-viewport.y / viewport.scale"
        :width="size.width / viewport.scale"
        :height="size.height / viewport.scale"
        class="map-viewport"
      />
    </svg>
  </section>
</template>
