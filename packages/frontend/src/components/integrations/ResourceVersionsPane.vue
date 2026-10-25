<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { EditableResourceKind, ResourceRevision, ResourceVersionsView } from '@infos/shared'
import { apiClient } from '../../api/client'
import { t } from '../../i18n'
import { invoke, isElectron } from '../../utils/ipcAdapter'
import { PButton, PCard, PDialog, PixelIcon } from '../pixel'

const view = ref<ResourceVersionsView>()
const busy = ref(false),
  error = ref('')
const kind = ref<EditableResourceKind>('skills')
const kinds: EditableResourceKind[] = ['skills', 'custom', 'agents', 'packages']
const labels: Record<EditableResourceKind, string> = {
  skills: '技能',
  custom: '自定义资源',
  agents: '角色资源',
  packages: '插件资源',
}
const states = {
  draft: '候选版本',
  pending: '等待重启',
  applied: '已应用',
  'rolled-back': '已回退',
}
const confirmation = ref<{ revision: ResourceRevision; action: 'apply' | 'rollback' | 'discard' }>()
const selected = ref<string>()
const changes = ref<Array<{ file: string; kind: string }>>([])
const preview = ref<{ file: string; before: string | null; after: string | null }>()
async function refresh() {
  view.value = (await apiClient.get<ResourceVersionsView>('/resource-versions')).data
}
async function perform(action: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
    await refresh()
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : t('ui.resource-versions', '操作失败，请重试。')
  } finally {
    busy.value = false
  }
}
async function confirm() {
  const pending = confirmation.value
  if (!pending) return
  confirmation.value = undefined
  await perform(() =>
    pending.action === 'discard'
      ? apiClient.delete(`/resource-versions/${pending.revision.id}`)
      : apiClient.post(`/resource-versions/${pending.revision.id}/${pending.action}`),
  )
}
async function inspect(revision: ResourceRevision) {
  await perform(async () => {
    preview.value = undefined
    changes.value =
      (await apiClient.get<typeof changes.value>(`/resource-versions/${revision.id}/changes`))
        .data ?? []
    selected.value = revision.id
  })
}
async function readPreview(id: string, file: string) {
  await perform(async () => {
    preview.value = (
      await apiClient.get<NonNullable<typeof preview.value>>(
        `/resource-versions/${id}/preview?file=${encodeURIComponent(file)}`,
      )
    ).data
  })
}
onMounted(() => perform(refresh))
</script>
<template>
  <section class="resource-versions" :aria-busy="busy">
    <header class="resource-heading">
      <div>
        <h2>
          <PixelIcon name="folder" size="sm" />
          {{ t('ui.resource-versions', '资源版本') }}
        </h2>
        <p>{{ t('ui.resource-versions', '先备份，再修改候选目录；应用与回退均在重启后生效。') }}</p>
      </div>
      <PButton size="sm" variant="secondary" :disabled="busy" @click="perform(refresh)">
        {{ t('ui.resource-versions', '刷新') }}
      </PButton>
    </header>
    <p v-if="error" role="alert" class="resource-error">{{ error }}</p>
    <PCard v-if="view?.safeMode" pixel padding="md" class="resource-recovery">
      <h3>{{ t('ui.resource-versions', '拓展恢复模式') }}</h3>
      <p>
        {{ t('ui.resource-versions', '第三方拓展已暂停。可先回退资源，再退出恢复模式并重启。') }}
      </p>
      <PButton
        size="sm"
        variant="secondary"
        :disabled="busy"
        @click="perform(() => apiClient.put('/resource-versions/safe-mode', { enabled: false }))"
      >
        {{ t('ui.resource-versions', '下次启动恢复拓展') }}
      </PButton>
    </PCard>
    <div class="resource-create">
      <select v-model="kind" :disabled="busy" :aria-label="t('ui.resource-versions', '资源分类')">
        <option v-for="item in kinds" :key="item" :value="item">
          {{ t('ui.resource-versions', labels[item]) }}
        </option>
      </select>
      <PButton
        size="sm"
        :disabled="busy"
        @click="perform(() => apiClient.post('/resource-versions/checkout', { kind }))"
      >
        <PixelIcon name="plus" size="xs" />
        {{ t('ui.resource-versions', '创建备份与候选') }}
      </PButton>
    </div>
    <div
      v-if="view?.restartRequired || view?.pending.length"
      class="resource-pending"
      role="status"
    >
      <p>
        {{ t('ui.resource-versions', '已安排资源切换，请重启后端。网页部署请由管理员重启服务。') }}
      </p>
      <PButton
        v-if="isElectron()"
        size="sm"
        :disabled="busy"
        @click="perform(() => invoke('resource-recovery:restart'))"
      >
        {{ t('ui.resource-versions', '重启应用') }}
      </PButton>
    </div>
    <PCard
      v-for="revision in [...(view?.revisions ?? [])].reverse()"
      :key="revision.id"
      pixel
      padding="lg"
    >
      <header class="resource-heading">
        <h3>{{ t('ui.resource-versions', labels[revision.kind]) }}</h3>
        <span>{{ t('ui.resource-versions', states[revision.state]) }}</span>
      </header>
      <code>{{ revision.id }} · {{ new Date(revision.createdAt).toLocaleString() }}</code>
      <p>{{ t('ui.resource-versions', '候选目录') }}</p>
      <code class="resource-path">{{ revision.candidateDirectory }}</code>
      <div class="resource-actions">
        <PButton size="sm" variant="secondary" :disabled="busy" @click="inspect(revision)">
          {{ t('ui.resource-versions', '查看修改') }}
        </PButton>
        <PButton
          v-if="revision.state === 'draft'"
          size="sm"
          :disabled="busy"
          @click="confirmation = { revision, action: 'apply' }"
        >
          {{ t('ui.resource-versions', '应用并等待重启') }}
        </PButton>
        <PButton
          v-if="revision.state === 'applied'"
          size="sm"
          variant="secondary"
          :disabled="busy"
          @click="confirmation = { revision, action: 'rollback' }"
        >
          {{ t('ui.resource-versions', '回退到修改前') }}
        </PButton>
        <PButton
          v-if="view?.pending.some((item) => item.id === revision.id)"
          size="sm"
          variant="ghost"
          :disabled="busy"
          @click="perform(() => apiClient.delete(`/resource-versions/${revision.id}/pending`))"
        >
          {{ t('ui.resource-versions', '取消待执行操作') }}
        </PButton>
        <PButton
          v-if="['draft', 'rolled-back'].includes(revision.state)"
          size="sm"
          variant="ghost"
          :disabled="busy"
          @click="confirmation = { revision, action: 'discard' }"
        >
          {{ t('ui.resource-versions', '删除此记录与备份') }}
        </PButton>
      </div>
      <ul v-if="selected === revision.id" class="resource-changes">
        <li v-for="change in changes" :key="change.file">
          <span>
            {{
              t(
                'ui.resource-versions',
                change.kind === 'added' ? '新增' : change.kind === 'deleted' ? '删除' : '修改',
              )
            }}
          </span>
          <button type="button" :disabled="busy" @click="readPreview(revision.id, change.file)">
            {{ change.file }}
          </button>
        </li>
        <li v-if="!changes.length">{{ t('ui.resource-versions', '没有文件修改') }}</li>
      </ul>
      <div v-if="selected === revision.id && preview" class="resource-preview">
        <section>
          <p>{{ t('ui.resource-versions', '修改前') }}</p>
          <pre>{{ preview.before ?? t('ui.resource-versions', '此文件不提供文本预览') }}</pre>
        </section>
        <section>
          <p>{{ t('ui.resource-versions', '候选内容') }}</p>
          <pre>{{ preview.after ?? t('ui.resource-versions', '此文件不提供文本预览') }}</pre>
        </section>
      </div>
    </PCard>
    <PDialog
      :model-value="!!confirmation"
      :title="t('ui.resource-versions', '确认资源切换')"
      :message="
        confirmation?.action === 'discard'
          ? t('ui.resource-versions', '删除此候选及其备份？已应用的资源不会被修改。')
          : confirmation?.action === 'rollback'
            ? t(
                'ui.resource-versions',
                '重启后恢复修改前的资源。当前版本会保留，业务数据不受影响。',
              )
            : t(
                'ui.resource-versions',
                '将候选版本登记为下次启动使用的资源。插件仍须经过原有审核授权。',
              )
      "
      @update:model-value="
        (value) => {
          if (!value) confirmation = undefined
        }
      "
      @cancel="confirmation = undefined"
      @confirm="confirm"
    />
  </section>
</template>
<style scoped>
.resource-versions {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.resource-heading,
.resource-create,
.resource-actions,
.resource-pending {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.resource-heading {
  justify-content: space-between;
}
h2,
h3 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-weight: 400;
}
h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
}
h3 {
  font-size: 14px;
}
p,
.resource-heading > span {
  font-size: 12px;
  line-height: 1.8;
  color: var(--ui-text-secondary);
}
code {
  font: 11px/1.8 var(--ui-font-mono);
  color: var(--ui-text-tertiary);
  overflow-wrap: anywhere;
}
.resource-path {
  display: block;
  user-select: all;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-default);
  background: var(--app-soft-fill, var(--ui-bg-surface));
}
.resource-actions {
  margin-top: 16px;
}
select {
  padding: 8px 12px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  font-family: var(--ui-font-pixel);
}
.resource-error {
  color: var(--ui-accent-pink);
}
.resource-pending {
  border-left: 3px solid var(--ui-accent-cyan);
  padding-left: 14px;
}
.resource-changes {
  max-height: 220px;
  overflow: auto;
  padding: 12px 0 0;
  list-style: none;
  border-top: 1px solid var(--ui-border-default);
}
.resource-changes li {
  display: flex;
  gap: 16px;
  padding: 5px 0;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.resource-changes button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ui-accent-cyan);
  font: 11px var(--ui-font-mono);
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.resource-preview {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.resource-preview pre {
  max-height: 320px;
  min-height: 60px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--ui-border-default);
  padding: 12px;
  font: 11px/1.8 var(--ui-font-mono);
  color: var(--ui-text-secondary);
}
@media (max-width: 700px) {
  .resource-preview {
    grid-template-columns: 1fr;
  }
}
.resource-recovery {
  border-left: 3px solid var(--ui-accent-pink);
}
</style>
