<script setup lang="ts">
import { t } from '../../i18n'
import PixelIcon from '../pixel/PixelIcon.vue'

defineProps<{
  active?: boolean
  pending?: boolean
  disabled?: boolean
  canReset?: boolean
  compact?: boolean
}>()
defineEmits<{ select: []; reset: [] }>()
</script>

<template>
  <div
    class="main-thread-card"
    :class="{
      'main-thread-card--active': active,
      'main-thread-card--pending': pending,
      'main-thread-card--compact': compact,
    }"
    :aria-busy="pending || undefined"
  >
    <button
      type="button"
      class="main-thread-card__select"
      :disabled="disabled"
      :aria-current="active ? 'true' : undefined"
      @click="$emit('select')"
    >
      <span class="main-thread-card__home" aria-hidden="true">
        <PixelIcon name="home" size="sm" />
      </span>
      <span class="main-thread-card__identity">
        <strong>{{ t('ui.chat', '主会话') }}</strong>
      </span>
      <span v-if="active" class="main-thread-card__current" aria-hidden="true" />
      <PixelIcon v-else name="chevron-right" size="xs" class="main-thread-card__arrow" />
    </button>
    <button
      v-if="canReset"
      type="button"
      class="main-thread-card__reset"
      :disabled="disabled"
      :title="t('ui.chat', '清空主会话')"
      :aria-label="t('ui.chat', '清空主会话')"
      @click="$emit('reset')"
    >
      <PixelIcon name="refresh" size="xs" />
    </button>
  </div>
</template>

<style scoped>
.main-thread-card {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-left: 3px solid var(--main-thread-tone, var(--ui-accent-primary));
  border-radius: 0;
  background: color-mix(in srgb, var(--main-thread-surface, var(--ui-bg-surface)) 92%, transparent);
  transition: background-color 140ms ease, border-color 140ms ease;
}
.main-thread-card--active {
  border-color: color-mix(in srgb, var(--main-thread-tone, var(--ui-accent-primary)) 40%, var(--ui-border-default));
  border-left-color: var(--main-thread-tone, var(--ui-accent-primary));
  background: color-mix(in srgb, var(--main-thread-tone, var(--ui-accent-primary)) 7%, var(--main-thread-surface, var(--ui-bg-surface)));
}
.main-thread-card--pending {
  border-style: dashed;
}
.main-thread-card__select {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: 44px;
  padding: 7px 10px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--main-thread-text, var(--ui-text-primary));
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.main-thread-card__home {
  display: grid;
  flex: 0 0 28px;
  height: 28px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--main-thread-tone, var(--ui-accent-primary)) 24%, transparent);
  background: color-mix(in srgb, var(--main-thread-tone, var(--ui-accent-primary)) 6%, transparent);
  color: var(--main-thread-tone, var(--ui-accent-primary));
}
.main-thread-card__identity {
  flex: 1;
  min-width: 0;
}
.main-thread-card__identity strong {
  display: block;
  overflow: hidden;
  font-family: var(--ui-font-pixel), sans-serif;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.main-thread-card__arrow {
  flex: 0 0 auto;
  color: var(--main-thread-tone, var(--ui-accent-primary));
}
.main-thread-card__current {
  flex: 0 0 4px;
  width: 4px;
  height: 4px;
  background: var(--main-thread-tone, var(--ui-accent-primary));
}
.main-thread-card__reset {
  display: grid;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  margin-right: 6px;
  place-items: center;
  border: 0;
  border-left: 1px solid var(--ui-border-subtle);
  border-radius: 0;
  background: transparent;
  color: var(--main-thread-muted, var(--ui-text-tertiary));
  cursor: pointer;
}
.main-thread-card__select:hover:not(:disabled) {
  background: color-mix(in srgb, var(--main-thread-tone, var(--ui-accent-primary)) 5%, transparent);
}
.main-thread-card__reset:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-danger) 9%, transparent);
  color: var(--ui-danger);
}
.main-thread-card button:focus-visible {
  outline: 2px solid var(--main-thread-tone, var(--ui-accent-primary));
  outline-offset: -3px;
}
.main-thread-card button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.main-thread-card--compact .main-thread-card__select {
  min-height: 40px;
  gap: 8px;
  padding: 6px 8px;
}
.main-thread-card--compact .main-thread-card__home {
  flex-basis: 26px;
  height: 26px;
}
@media (prefers-reduced-motion: reduce) {
  .main-thread-card {
    transition: none;
  }
}
:global([data-motion='off']) .main-thread-card,
:global([data-motion='reduced']) .main-thread-card {
  transition: none;
}
</style>
