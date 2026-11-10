<script setup lang="ts">
/**
 * ConversationQueueBody — 消息队列的展开区。
 *
 * 用 MotionCollapse 过渡展开收起（首次展开前不渲染内容），
 * 内层保留 .queue-body 的内边距与滚动；队列条目由插槽传入，样式仍归 ConversationQueue。
 */
import MotionCollapse from '../motion/MotionCollapse.vue'

defineProps<{ open: boolean }>()
</script>

<template>
  <MotionCollapse :open="open" lazy>
    <div class="queue-body"><slot /></div>
  </MotionCollapse>
</template>

<style scoped>
.queue-body {
  padding: 0 12px 10px;
  max-height: min(32vh, 300px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
@media (max-width: 520px) {
  .queue-body {
    padding: 0 8px 8px;
  }
}
</style>
