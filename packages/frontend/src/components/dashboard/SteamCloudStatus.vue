<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import type { SteamCloudSaveStatus } from '@infos/shared'
import { t, getDisplayLocale } from '../../i18n'
import { invoke, isElectron } from '../../utils/ipcAdapter'
import { PixelIcon } from '../pixel'

const tr = (source: string) => t('ui.steam-cloud', source)
const status = ref<SteamCloudSaveStatus | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let reading = false
let disposed = false
const label = computed(() =>
  tr(
    {
      disabled: '本机云存档已停用',
      idle: '等待保存',
      saving: '正在保存…',
      saved: '已交给 Steam 同步',
      pending: '等待重试',
      conflict: '需要处理冲突',
    }[status.value?.phase ?? 'idle'],
  ),
)
const detail = computed(() => {
  if (status.value?.phase === 'disabled') return tr('远程数据由服务器备份。')
  if (status.value?.phase === 'conflict') return tr('云端写入已暂停，重新启动后选择要保留的存档。')
  if (status.value?.phase === 'pending') return tr('未完成的存档保留在本机，连接恢复后自动重试。')
  return tr('聊天和设置变化后自动保存，退出前再次保存。')
})
const time = (value: number | null) =>
  value ? new Date(value).toLocaleString(getDisplayLocale()) : tr('暂无')

async function refresh() {
  if (reading || disposed || !isElectron()) return
  reading = true
  try {
    const value = (await invoke('steam-cloud-get-status')) as SteamCloudSaveStatus
    if (!disposed) status.value = value
  } catch {
    // 状态查询失败保留上次回执，不能把未知状态显示为保存成功。
    if (!disposed && status.value) status.value = { ...status.value, phase: 'pending' }
  } finally {
    reading = false
  }
}
function start() {
  if (timer || !isElectron()) return
  void refresh()
  timer = setInterval(() => {
    void refresh()
  }, 3000)
}
function stop() {
  clearInterval(timer)
  timer = undefined
}
onMounted(start)
onActivated(start)
onDeactivated(stop)
onBeforeUnmount(() => {
  disposed = true
  stop()
})
</script>

<template>
  <section v-if="status?.isSteam" class="steam-cloud" :data-phase="status.phase" aria-live="polite">
    <div class="steam-cloud-copy">
      <div class="steam-cloud-heading">
        <PixelIcon name="database" size="sm" />
        <strong>{{ tr('Steam 云存档') }}</strong>
        <span class="steam-cloud-state" role="status">{{ label }}</span>
      </div>
      <p>{{ detail }}</p>
    </div>
    <dl>
      <div>
        <dt>{{ tr('本机已保存') }}</dt>
        <dd>{{ time(status.lastLocalSaveAt) }}</dd>
      </div>
      <div>
        <dt>{{ tr('上次交给 Steam') }}</dt>
        <dd>{{ time(status.lastSteamWriteAt) }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.steam-cloud {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px 24px;
  padding: 18px 22px;
  margin-bottom: 22px;
  border: 1px solid var(--ui-border-default);
  border-left: 3px solid var(--ui-accent-purple);
  border-radius: 3px;
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface);
}
.steam-cloud-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
}
.steam-cloud-heading strong {
  font-size: 14px;
}
.steam-cloud-state {
  font-size: 11px;
  color: var(--ui-accent-purple);
}
.steam-cloud p {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.steam-cloud dl {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: 11px;
}
.steam-cloud dl div {
  display: flex;
  justify-content: space-between;
  gap: 18px;
}
.steam-cloud dt {
  color: var(--ui-text-secondary);
}
.steam-cloud dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.steam-cloud[data-phase='pending'],
.steam-cloud[data-phase='conflict'] {
  border-left-color: var(--ui-text-secondary);
}
</style>
