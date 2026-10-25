<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { InteractionMode, RuntimeDebugStatus } from '@infos/shared'
import { apiClient } from '../../api/client'
import { t } from '../../i18n'
import { useNotificationStore } from '../../stores'
import PixelIcon from '../pixel/PixelIcon.vue'
const props = defineProps<{
  threadId: string | null
  mode: InteractionMode
  disabled?: boolean
  ensureThread: () => Promise<string>
  layout?: 'toolbar' | 'menu'
}>()
const emit = defineEmits<{ change: []; state: [value: { enabled: boolean; busy: boolean }] }>()
const enabled = ref(false)
const busy = ref(false)
watch([enabled, busy], ([enabled, busy]) => emit('state', { enabled, busy }), { immediate: true })
const notify = useNotificationStore()
let revision = 0
watch(
  () => [props.threadId, props.mode] as const,
  async ([id, mode]) => {
    const request = ++revision
    enabled.value = false
    if (!id || mode !== 'work') return
    try {
      const result = await apiClient.get<RuntimeDebugStatus>(
        `/runtime-debug/${encodeURIComponent(id)}`,
      )
      if (request === revision) enabled.value = result.data?.enabled ?? false
    } catch {
      if (request === revision) enabled.value = false
    }
  },
  { immediate: true },
)
async function toggle() {
  if (busy.value || props.mode !== 'work' || (props.disabled && !enabled.value)) return
  busy.value = true
  const target = !enabled.value
  try {
    const id = props.threadId ?? (await props.ensureThread())
    await nextTick()
    if (props.mode !== 'work' || (props.threadId && props.threadId !== id)) return
    const request = ++revision
    const result = await apiClient.put<RuntimeDebugStatus>(
      `/runtime-debug/${encodeURIComponent(id)}`,
      { enabled: target },
    )
    if ((!props.threadId || id === props.threadId) && request === revision)
      enabled.value = result.data?.enabled ?? false
    emit('change')
  } catch (error) {
    notify.toast(
      error instanceof Error ? error.message : t('ui.runtime-debug', '调试模式切换失败'),
      { type: 'error' },
    )
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <span class="runtime-debug-control" :class="{ 'runtime-debug-control--menu': layout === 'menu' }">
    <button
      type="button"
      class="runtime-debug-toggle"
      :class="{ 'is-active': enabled, 'is-busy': busy }"
      :aria-pressed="enabled"
      :aria-busy="busy"
      :aria-label="t('ui.runtime-debug', '调试')"
      :title="
        mode !== 'work'
          ? t('ui.runtime-debug', '工作模式下可开启调试')
          : enabled
            ? t('ui.runtime-debug', '关闭当前会话调试')
            : t('ui.runtime-debug', '开启当前会话调试')
      "
      :disabled="busy || mode !== 'work' || (disabled && !enabled)"
      @click="toggle"
    >
      <span class="runtime-debug-emblem" aria-hidden="true">
        <PixelIcon
          :name="busy ? 'refresh' : 'cpu'"
          size="xs"
          :animation="busy ? 'spin' : undefined"
        />
      </span>
      <span class="runtime-debug-label">
        <span>{{ t('ui.runtime-debug', '调试') }}</span>
        <small v-if="layout === 'menu'">
          {{
            t(
              'ui.runtime-debug',
              mode !== 'work'
                ? '工作模式下可开启调试'
                : enabled
                  ? '调试工具已启用'
                  : '为当前会话启用调试工具',
            )
          }}
        </small>
      </span>
      <span class="runtime-debug-switch" aria-hidden="true">
        <span class="runtime-debug-switch-thumb" />
      </span>
    </button>
  </span>
</template>
<style scoped>
/* 包裹层隔开输入栏的通用按钮规则，给硬阴影留出空间。 */
.runtime-debug-control {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 2px;
}
.runtime-debug-toggle {
  --debug-accent: var(--ui-accent-purple);
  --debug-surface: var(--app-soft-fill, var(--ui-bg-surface));
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  box-sizing: border-box;
  min-height: 30px;
  margin: 0;
  padding: 3px 8px 3px 4px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--debug-surface);
  color: var(--ui-text-secondary);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ui-text-primary) 5%, transparent),
    2px 2px 0 var(--ui-border-subtle);
  font-family: var(--font-pixel, var(--ui-font-pixel));
  font-size: 11px;
  font-weight: 400;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.runtime-debug-emblem {
  display: inline-flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  height: 20px;
  border-right: 1px solid var(--ui-border-subtle);
  padding-right: 4px;
  color: var(--ui-text-tertiary);
}
.runtime-debug-label {
  padding-block: 1px;
}
.runtime-debug-switch {
  position: relative;
  display: inline-block;
  flex: 0 0 20px;
  box-sizing: border-box;
  width: 20px;
  height: 10px;
  margin-left: 2px;
  border: 1px solid var(--ui-border-strong);
  background: color-mix(in srgb, var(--ui-text-primary) 5%, transparent);
  box-shadow: inset 1px 1px 0 var(--ui-border-subtle);
}
.runtime-debug-switch-thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 6px;
  height: 6px;
  background: var(--ui-text-tertiary);
  transition:
    transform var(--ui-duration-fast) steps(3, end),
    background-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.runtime-debug-toggle:hover:not(:disabled) {
  color: var(--debug-accent);
  border-color: color-mix(in srgb, var(--debug-accent) 55%, var(--ui-border-default));
  background: color-mix(in srgb, var(--debug-accent) 5%, var(--debug-surface));
}
.runtime-debug-toggle.is-active {
  color: var(--debug-accent);
  border-color: color-mix(in srgb, var(--debug-accent) 65%, var(--ui-border-default));
  background: color-mix(in srgb, var(--debug-accent) 9%, var(--debug-surface));
  box-shadow:
    inset 2px 0 0 var(--debug-accent),
    inset 0 1px 0 color-mix(in srgb, var(--debug-accent) 12%, transparent),
    2px 2px 0 color-mix(in srgb, var(--debug-accent) 16%, transparent);
}
.runtime-debug-toggle.is-active .runtime-debug-emblem {
  color: var(--debug-accent);
  border-right-color: color-mix(in srgb, var(--debug-accent) 22%, transparent);
}
.runtime-debug-toggle.is-active .runtime-debug-switch {
  border-color: color-mix(in srgb, var(--debug-accent) 55%, transparent);
  background: color-mix(in srgb, var(--debug-accent) 15%, transparent);
}
.runtime-debug-toggle.is-active .runtime-debug-switch-thumb {
  transform: translateX(10px);
  background: var(--debug-accent);
}
.runtime-debug-toggle:active:not(:disabled) {
  translate: 1px 1px;
  box-shadow: inset 1px 1px 0 var(--ui-border-subtle);
}
.runtime-debug-toggle:focus-visible {
  outline: 2px solid var(--ui-focus-color);
  outline-offset: -2px;
}
.runtime-debug-toggle:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.runtime-debug-toggle.is-busy {
  opacity: 0.75;
  cursor: progress;
}
.runtime-debug-control--menu {
  display: flex;
  width: 100%;
  padding: 0;
}
.runtime-debug-control--menu .runtime-debug-toggle {
  width: 100%;
  min-height: 58px;
  padding: 9px;
  gap: 10px;
  justify-content: flex-start;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  text-align: left;
}
.runtime-debug-control--menu .runtime-debug-emblem {
  flex-basis: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--ui-border-subtle);
  background: var(--app-soft-fill, var(--ui-bg-surface-soft));
  box-shadow: inset 1px 1px 0 var(--ui-border-subtle);
}
.runtime-debug-control--menu .runtime-debug-label {
  display: grid;
  flex: 1;
  gap: 5px;
  min-width: 0;
  font-size: 12px;
}
.runtime-debug-control--menu .runtime-debug-label small {
  color: var(--ui-text-tertiary);
  font: 11px/1.4 var(--ui-font-sans);
}
.runtime-debug-control--menu .runtime-debug-switch {
  flex-basis: 24px;
  width: 24px;
  height: 12px;
  margin-left: auto;
}
.runtime-debug-control--menu .runtime-debug-switch-thumb {
  width: 8px;
  height: 8px;
}
.runtime-debug-control--menu .runtime-debug-toggle.is-active .runtime-debug-switch-thumb {
  transform: translateX(12px);
}
.runtime-debug-control--menu .runtime-debug-toggle:hover:not(:disabled),
.runtime-debug-control--menu .runtime-debug-toggle.is-active {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 35%, transparent);
  background: color-mix(in srgb, var(--ui-accent-purple) 7%, transparent);
  box-shadow: inset 2px 0 0 var(--ui-accent-purple);
}
.runtime-debug-control--menu .runtime-debug-toggle:disabled {
  opacity: 0.55;
}
@media (prefers-reduced-motion: reduce) {
  .runtime-debug-switch-thumb {
    transition: none;
  }
}
</style>
