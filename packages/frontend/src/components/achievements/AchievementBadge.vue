<script setup lang="ts">
import badge from '../../assets/achievements/fresh-start.svg'
defineProps<{ unlocked: boolean }>()
</script>

<template>
  <img
    class="achievement-badge"
    :class="{ 'is-unlocked': unlocked }"
    :src="badge"
    alt=""
    width="80"
    height="80"
  />
</template>

<style scoped>
.achievement-badge {
  width: 80px;
  height: 80px;
  flex: 0 0 auto;
  filter: grayscale(1);
  opacity: 0.55;
  transition:
    filter 0.3s,
    opacity 0.3s,
    transform 0.3s;
}
.achievement-badge.is-unlocked {
  filter: none;
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .achievement-badge {
    transition: none;
  }
}
</style>
