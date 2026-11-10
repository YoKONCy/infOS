<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { t as __t } from '../../../i18n/index'
import { usePerception } from '../../../composables/usePerception'
import { useEventListener } from '../../../composables/useEventListener'
import { PButton } from '../../pixel'

/**
 * 底部状态栏的「感知中」：点开看她现在知道什么，可以暂停 1 小时或全部停止。
 * 快照只在面板打开时读，关上就清掉，不留在界面状态里。
 */
const emit = defineEmits<{ settings: [] }>()
const { phase, label, error, act, readSnapshot } = usePerception()
const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
// 面板挂到 body 上：主界面的侧栏和输入框各有层级，留在状态栏里会被压住。
const panelStyle = ref<Record<string, string>>({})
const open = ref(false)
const snapshot = ref('')
let timer: ReturnType<typeof setInterval> | undefined

async function refresh(): Promise<void> {
  const text = await readSnapshot()
  if (open.value) snapshot.value = text
}
function stopRefresh(): void {
  clearInterval(timer)
  timer = undefined
}
watch(open, (value) => {
  stopRefresh()
  snapshot.value = ''
  if (!value) return
  const box = root.value?.getBoundingClientRect()
  if (box) panelStyle.value = { left: `${box.left}px`, bottom: `${window.innerHeight - box.top + 10}px` }
  void refresh()
  timer = setInterval(() => void refresh(), 4000)
})
onBeforeUnmount(stopRefresh)
useEventListener(document, 'pointerdown', (event) => {
  const target = event.target as Node
  if (open.value && !root.value?.contains(target) && !panel.value?.contains(target)) open.value = false
})
useEventListener(document, 'keydown', (event) => {
  if (open.value && (event as KeyboardEvent).key === 'Escape') open.value = false
})
function openSettings(): void {
  open.value = false
  emit('settings')
}
</script>

<template>
  <div v-if="phase" ref="root" class="perception-status">
    <span class="perception-status-divider" />
    <button
      type="button"
      class="perception-status-button"
      :class="`is-${phase}`"
      :aria-expanded="open"
      @click="open = !open"
    >
      <i aria-hidden="true" />
      {{ label }}
    </button>
    <Teleport to="body">
    <div v-if="open" ref="panel" class="perception-status-panel" :style="panelStyle" role="dialog" :aria-label="label">
      <strong>{{ __t('ui.desktop', '她现在知道的') }}</strong>
      <p v-if="phase === 'off'">
        {{ __t('ui.desktop', '感知没开，她不会自己知道电脑上发生了什么。') }}
      </p>
      <p v-else-if="phase === 'stopped'">
        {{ __t('ui.desktop', '已全部停止，要你手动恢复。') }}
      </p>
      <p v-else-if="snapshot" class="perception-status-text">{{ snapshot }}</p>
      <p v-else>{{ __t('ui.desktop', '现在还没有内容。') }}</p>
      <p v-if="error" class="perception-status-error" role="alert">{{ error }}</p>
      <div class="perception-status-actions">
        <PButton v-if="phase === 'stopped'" size="sm" @click="act({ type: 'resume' })">
          {{ __t('ui.desktop', '恢复感知') }}
        </PButton>
        <template v-else-if="phase !== 'off'">
          <PButton
            v-if="phase === 'paused'"
            size="sm"
            variant="ghost"
            @click="act({ type: 'resume' })"
          >
            {{ __t('ui.desktop', '现在恢复') }}
          </PButton>
          <PButton
            v-else-if="phase === 'running'"
            size="sm"
            variant="ghost"
            @click="act({ type: 'pause-hour' })"
          >
            {{ __t('ui.desktop', '暂停 1 小时') }}
          </PButton>
          <PButton size="sm" variant="ghost" @click="act({ type: 'stop-all' })">
            {{ __t('ui.desktop', '全部停止') }}
          </PButton>
        </template>
        <PButton size="sm" variant="ghost" @click="openSettings">
          {{ __t('ui.desktop', '设置') }}
        </PButton>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.perception-status {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
}
.perception-status-divider {
  width: 1px;
  height: 12px;
  background: var(--ui-border-default);
}
.perception-status-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-text-secondary);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.perception-status-button:hover {
  color: var(--ui-text-primary);
}
.perception-status-button i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ui-text-tertiary);
}
.perception-status-button.is-running i {
  background: var(--ui-success);
}
.perception-status-button.is-paused i,
.perception-status-button.is-blocked i {
  background: var(--ui-warning);
}
.perception-status-button.is-stopped i {
  background: var(--ui-danger);
}
.perception-status-panel {
  position: fixed;
  z-index: 1000;
  width: min(360px, calc(100vw - 32px));
  padding: 12px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  box-shadow: var(--ui-shadow-md);
  font-size: 12px;
}
.perception-status-panel p {
  margin-top: 6px;
  color: var(--ui-text-secondary);
  line-height: 1.6;
}
.perception-status-panel .perception-status-error {
  color: var(--ui-danger);
}
.perception-status-text {
  max-height: 220px;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.perception-status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
</style>
