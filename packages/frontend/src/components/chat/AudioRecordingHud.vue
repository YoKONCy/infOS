<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../../i18n'
import PixelIcon from '../pixel/PixelIcon.vue'
const props = defineProps<{
  state: 'idle' | 'preparing' | 'recording' | 'processing' | 'error'
  mode: 'asr' | 'native'
  seconds: number
  level: number
  error?: string
}>()
const emit = defineEmits<{ stop: []; cancel: [] }>()
const title = computed(() =>
  props.state === 'error'
    ? t('ui.audio-input', '录音未完成')
    : props.state === 'preparing'
      ? t('ui.audio-input', '准备麦克风…')
      : props.state === 'recording'
        ? t('ui.audio-input', '正在录音')
        : props.mode === 'native'
          ? t('ui.audio-input', '正在准备原音附件…')
          : t('ui.audio-input', '正在转写…'),
)
const time = computed(
  () =>
    String(Math.floor(props.seconds / 60)).padStart(2, '0') +
    ':' +
    String(props.seconds % 60).padStart(2, '0'),
)
</script>
<template>
  <Transition name="voice-hud">
    <section
      v-if="state !== 'idle'"
      class="audio-hud"
      :class="[`is-${state}`]"
      :aria-label="t('ui.audio-input', '录音控制')"
      @keydown.esc.stop="emit('cancel')"
    >
      <div class="audio-hud__mark">
        <PixelIcon
          :name="state === 'error' ? 'alert' : state === 'recording' ? 'mic' : 'refresh'"
          :animation="state === 'preparing' || state === 'processing' ? 'spin' : undefined"
          size="sm"
        />
      </div>
      <div class="audio-hud__copy">
        <strong role="status">{{ title }}</strong>
        <span>
          {{
            state === 'error'
              ? error
              : mode === 'native'
                ? t('ui.audio-input', '停止后可试听，再发送给 Gemini')
                : t('ui.audio-input', '转写后可编辑，再发送')
          }}
        </span>
      </div>
      <div v-if="state === 'recording'" class="audio-hud__wave" aria-hidden="true">
        <i
          v-for="bar in 16"
          :key="bar"
          :style="{
            height: `${Math.min(100, 12 + level * 900 * (0.35 + Math.abs(Math.sin(bar * 1.3))))}%`,
          }"
        />
      </div>
      <time v-if="state === 'recording'">
        {{ time }}
        <small>/ 02:00</small>
      </time>
      <button
        v-if="state === 'recording'"
        class="audio-hud__stop"
        type="button"
        @click="emit('stop')"
      >
        <span aria-hidden="true">■</span>
        {{ t('ui.audio-input', '停止') }}
      </button>
      <button
        class="audio-hud__cancel"
        type="button"
        :aria-label="
          state === 'error' ? t('ui.audio-input', '关闭') : t('ui.audio-input', '取消录音')
        "
        @click="emit('cancel')"
      >
        <PixelIcon name="close" size="xs" />
      </button>
    </section>
  </Transition>
</template>
<style scoped>
.audio-hud {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  margin: 0 12px 10px;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface);
  box-shadow: 0 4px 20px color-mix(in srgb, var(--ui-text-primary) 5%, transparent);
  color: var(--ui-text-primary);
  font-family: var(--ui-font-sans);
}
.audio-hud__mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: var(--ui-radius-xs);
  color: var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
}
.is-recording .audio-hud__mark {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}
.is-error .audio-hud__mark {
  color: var(--ui-warning);
  background: var(--ui-bg-hover);
}
.audio-hud__copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.audio-hud__copy strong {
  font: 12px var(--ui-font-pixel);
}
.audio-hud__copy > span {
  color: var(--ui-text-tertiary);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.audio-hud__wave {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 26px;
  width: 70px;
  flex-shrink: 0;
}
.audio-hud__wave i {
  width: 2px;
  background: var(--ui-accent-sky);
  transition: height 100ms;
}
time {
  color: var(--ui-text-primary);
  font: 12px var(--ui-font-mono);
  white-space: nowrap;
}
time small {
  margin-left: 3px;
  color: var(--ui-text-tertiary);
  font-size: 9px;
}
.audio-hud button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-radius: var(--ui-radius-xs);
  cursor: pointer;
  font: 11px var(--ui-font-pixel);
  min-height: 30px;
  flex-shrink: 0;
}
.audio-hud__stop {
  padding-inline: 10px;
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  border: 1px solid transparent;
}
.audio-hud__cancel {
  width: 30px;
  border: 0;
  color: var(--ui-text-tertiary);
  background: transparent;
}
.audio-hud button:hover {
  background: var(--ui-bg-hover);
}
.audio-hud button:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.voice-hud-enter-active,
.voice-hud-leave-active {
  transition:
    opacity 150ms,
    transform 150ms;
}
.voice-hud-enter-from,
.voice-hud-leave-to {
  opacity: 0;
  transform: translateY(5px);
}
@media (max-width: 640px) {
  .audio-hud {
    gap: 8px;
    padding: 12px;
    margin-inline: 6px;
    flex-wrap: wrap;
  }
  .audio-hud__wave {
    display: none;
  }
  time small {
    display: none;
  }
  .audio-hud button {
    min-height: 40px;
  }
  .audio-hud__copy {
    flex-basis: calc(100% - 50px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .voice-hud-enter-active,
  .voice-hud-leave-active,
  .audio-hud__wave i {
    transition: none;
  }
}
</style>
