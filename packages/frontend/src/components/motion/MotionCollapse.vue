<script setup lang="ts">
/**
 * MotionCollapse — 展开收起
 *
 * 用 grid-template-rows 0fr → 1fr 过渡高度，不需要测量内容，也不对 height 做动画。
 * 收起后内容设为 inert，键盘和读屏不会进入隐藏区域。
 *
 * @prop open - 是否展开
 * @prop lazy - 首次展开前不渲染内容（内容很重时使用）
 */
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{ open: boolean; lazy?: boolean }>(), { lazy: false })
const rendered = ref(props.open || !props.lazy)
watch(
  () => props.open,
  (open) => {
    if (open) rendered.value = true
  },
)
</script>

<template>
  <div class="motion-collapse" :class="{ 'is-open': open }" :inert="!open || undefined">
    <div class="motion-collapse__inner">
      <slot v-if="rendered" />
    </div>
  </div>
</template>
