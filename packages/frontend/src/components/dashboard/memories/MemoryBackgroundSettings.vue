<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { memoryBackgroundAgentKey } from '@infos/shared'
import { t } from '../../../i18n'
import { configApi } from '../../../api/modules/configApi'
import { getApiBaseUrl } from '../../../api/transport'
import type { AgentListItem } from '../../../api/modules/agentApi'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { PButton, PDialog, PSwitch, PixelIcon } from '../../pixel'

const props = defineProps<{ agents: AgentListItem[]; backgroundEnabled: boolean }>()
const emit = defineEmits<{ close: [] }>()
const notify = useNotificationStore()
const enabled = ref<Record<string, boolean>>({})
const ready = ref(false)
const failed = ref(false)
const saving = ref<string | null>(null)
const failedAvatars = ref(new Set<string>())
let revision = 0
let disposed = false

function avatarSource(url?: string): string {
  if (!url) return ''
  return /^https?:\/\//i.test(url)
    ? url
    : `${getApiBaseUrl()}${url.startsWith('/') ? '' : '/'}${url}`
}

async function load(): Promise<void> {
  const requested = ++revision
  const ids = props.agents.map((agent) => agent.id)
  ready.value = false
  failed.value = false
  try {
    const values: Record<string, string | null> = {}
    for (let index = 0; index < ids.length; index += 50) {
      const result = await configApi.batch(
        ids.slice(index, index + 50).map(memoryBackgroundAgentKey),
      )
      if (!result.data) throw new Error('角色后台记忆配置响应缺少数据')
      Object.assign(values, result.data)
    }
    if (disposed || requested !== revision) return
    enabled.value = Object.fromEntries(
      ids.map((id) => [id, values[memoryBackgroundAgentKey(id)] !== 'false']),
    )
    ready.value = true
  } catch {
    if (!disposed && requested === revision) failed.value = true
  }
}

async function save(agent: AgentListItem, value: boolean): Promise<void> {
  if (!ready.value || saving.value) return
  saving.value = agent.id
  const revisionAtSave = revision
  try {
    await configApi.set(memoryBackgroundAgentKey(agent.id), String(value))
    if (!disposed) {
      if (revisionAtSave !== revision) await load()
      else enabled.value[agent.id] = value
    }
  } catch {
    if (!disposed)
      notify.toast(
        t('ui.settings', '{0}的后台记忆设置保存失败，请重试。', [agent.name || agent.id]),
        'error',
      )
  } finally {
    saving.value = null
  }
}

watch(() => props.agents.map((agent) => agent.id).join(','), load, { immediate: true })
onUnmounted(() => {
  disposed = true
})
</script>

<template>
  <PDialog
    :model-value="true"
    :title="t('ui.settings', '角色后台记忆')"
    width="520px"
    @update:model-value="!$event && emit('close')"
  >
    <p v-if="!backgroundEnabled" class="description">
      {{ t('ui.settings', '总开关已关闭，后台记忆已暂停。') }}
    </p>
    <div v-if="failed" role="status">
      <p>{{ t('ui.settings', '角色后台记忆设置加载失败。') }}</p>
      <PButton size="sm" @click="load">{{ t('ui.settings', '重新加载') }}</PButton>
    </div>
    <p v-else-if="!ready">{{ t('ui.settings', '正在读取角色设置…') }}</p>
    <div v-else class="agent-list">
      <div v-for="agent in agents" :key="agent.id" class="agent-row">
        <div class="agent-identity">
          <span class="agent-avatar" aria-hidden="true">
            <img
              v-if="avatarSource(agent.avatarUrl) && !failedAvatars.has(avatarSource(agent.avatarUrl))"
              :src="avatarSource(agent.avatarUrl)"
              alt=""
              loading="lazy"
              decoding="async"
              draggable="false"
              @error="failedAvatars.add(avatarSource(agent.avatarUrl))"
            />
            <PixelIcon v-else name="user" size="sm" />
          </span>
          <span :id="`memory-background-${agent.id}`" class="agent-name">{{ agent.name || agent.id }}</span>
        </div>
        <div class="agent-control">
          <span v-if="saving === agent.id" class="saving">{{ t('ui.settings', '保存中') }}</span>
          <PSwitch
            :model-value="enabled[agent.id] !== false"
            :aria-labelledby="`memory-background-${agent.id}`"
            :aria-busy="saving === agent.id"
            :disabled="saving !== null"
            @update:model-value="save(agent, $event)"
          />
        </div>
      </div>
    </div>
    <template #footer><PButton @click="emit('close')">{{ t('ui.settings', '完成') }}</PButton></template>
  </PDialog>
</template>

<style scoped>
.description {
  color: var(--ui-text-secondary);
  font-size: 13px;
  line-height: 1.7;
  margin: 0 0 16px;
}
.agent-list {
  display: grid;
  gap: 12px;
}
.agent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}
.agent-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.agent-avatar {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 2px;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
}
.agent-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.agent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.agent-control {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
}
.saving {
  color: var(--ui-text-secondary);
  font-size: 12px;
}
</style>
