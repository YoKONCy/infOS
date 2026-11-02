<template>
  <div class="wave-edge" :class="{ top: flip }" aria-hidden="true">
    <svg viewBox="0 0 1440 90" preserveAspectRatio="none">
      <path class="back" d="M0 40 C 240 90, 480 0, 720 40 S 1200 90, 1440 30 V90 H0 Z" />
      <path class="front" d="M0 60 C 200 20, 420 90, 720 56 S 1180 10, 1440 58 V90 H0 Z" />
    </svg>
  </div>
</template>

<script setup lang="ts">
/** 区块之间的双层波浪分隔，颜色取 --wave（默认纸色），波浪缓慢左右摆动 */
defineProps<{ flip?: boolean }>()
</script>

<style scoped>
.wave-edge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  z-index: 3;
  height: 70px;
  overflow: hidden;
  pointer-events: none;
}

.wave-edge.top {
  top: -1px;
  bottom: auto;
  transform: scaleY(-1);
}

svg {
  width: 120%;
  height: 100%;
  margin-left: -10%;
  animation: wave 12s ease-in-out infinite alternate;
}

.back {
  fill: var(--wave, var(--paper));
  opacity: 0.5;
}

.front {
  fill: var(--wave, var(--paper));
}

@keyframes wave {
  to {
    translate: 8% 0;
  }
}
</style>
