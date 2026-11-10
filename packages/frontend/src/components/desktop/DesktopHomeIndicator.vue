<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed } from 'vue'
import { useDesktopHome } from '../../composables/useDesktopHome'
import { PButton } from '../pixel'

// 录音标识：她在听电脑的声音（或在陪看）时一直显示，带「停止」。这一处不能在设置里关掉。
const home = useDesktopHome()
const status = home.status
const visible = computed(() => home.supported && !!status.value?.listening)
const detail = computed(() => {
  const value = status.value
  if (!value?.companionTitle) return __t('ui.desktop', '只录电脑放出的声音，不开麦克风。')
  return value.companionPaused
    ? __t('ui.desktop', '陪看「{0}」：已暂停', [value.companionTitle])
    : __t('ui.desktop', '陪看「{0}」', [value.companionTitle])
})
</script>

<template>
  <section v-if="visible" class="desktop-home-indicator" role="status" aria-live="polite">
    <span class="desktop-home-dot" aria-hidden="true" />
    <div>
      <strong>{{ __t('ui.desktop', '正在听电脑的声音') }}</strong>
      <small>{{ detail }}</small>
    </div>
    <PButton size="sm" variant="ghost" @click="home.stopListening()">
      {{ __t('ui.desktop', '停止') }}
    </PButton>
  </section>
</template>

<style scoped>
.desktop-home-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border-strong);
  border-left: 3px solid var(--ui-accent-red, #d14343);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
}
.desktop-home-indicator div {
  flex: 1;
  min-width: 0;
}
.desktop-home-indicator small {
  display: block;
  margin-top: 2px;
  color: var(--ui-text-secondary);
  overflow-wrap: anywhere;
}
.desktop-home-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ui-accent-red, #d14343);
  animation: desktop-home-blink 1.4s ease-in-out infinite;
}
@keyframes desktop-home-blink {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .desktop-home-dot {
    animation: none;
  }
}
</style>
