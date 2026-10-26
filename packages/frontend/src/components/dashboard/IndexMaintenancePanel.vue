<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  maintenanceApi,
  type IndexMaintenanceStatus,
  type IndexScope,
} from '../../api/modules/maintenanceApi'
import { useAgentStore, useNotificationStore } from '../../stores'
import { getApiBaseUrl } from '../../api/transport'
import { PButton, PCard, PixelIcon, PSelect } from '../pixel'
import type { IndexMaintenanceDiagnostic } from '@infos/shared'

const props = defineProps<{ socialAgentId?: string }>()
const agents = useAgentStore()
const notification = useNotificationStore()
const selectedAgent = ref(agents.activeAgentId)
const status = ref<IndexMaintenanceStatus | null>(null)
const error = ref('')
const submitting = ref(false)
const failedAvatars = ref(new Set<string>())
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let loading = false
const social = computed(() => props.socialAgentId !== undefined)
const target = computed(() => (social.value ? props.socialAgentId : selectedAgent.value))
const names: Record<IndexScope, string> = {
  main: '主记忆',
  social: '社交图谱',
  facts: '共享事实',
  knowledge: '文档知识库',
}
const sourceIcons: Record<IndexScope, string> = {
  main: 'brain',
  social: 'network',
  facts: 'database',
  knowledge: 'file',
}
const agentProfiles = computed(() => new Map(agents.agents.map((agent) => [agent.id, agent])))
function avatarSource(agentId: string): string {
  const url = agentProfiles.value.get(agentId)?.avatarUrl
  if (!url) return ''
  return /^https?:\/\//i.test(url)
    ? url
    : `${getApiBaseUrl()}${url.startsWith('/') ? '' : '/'}${url}`
}
const choices = computed(() => [
  {
    value: '',
    get label() {
      return __t('ui.settings', '全部角色')
    },
  },
  ...agents.agents.map((agent) => ({ value: agent.id, label: agent.name })),
])
const indexes = computed(
  () =>
    status.value?.indexes
      .filter((item) => {
        if (item.agentId && !agentProfiles.value.has(item.agentId)) return false
        return social.value
          ? item.scope === 'social' && item.agentId === target.value
          : !item.agentId || !target.value || item.agentId === target.value
      })
      .map((item) => ({
        ...item,
        agentName: item.agentId
          ? (agentProfiles.value.get(item.agentId)?.name ?? item.agentId)
          : '',
        avatarUrl: item.agentId ? avatarSource(item.agentId) : '',
      })) ?? [],
)
const job = computed(() =>
  status.value?.jobs
    .filter(
      (item) =>
        !social.value ||
        (['social', 'all'].includes(item.scope) &&
          (!item.agentId || item.agentId === target.value)),
    )
    .at(-1),
)
const jobIssues = computed(
  () => job.value?.results?.filter((item) => item.error || item.warnings?.length) ?? [],
)
const phases: Record<string, string> = {
  drain: '等待在途操作',
  build: '构建新索引',
  'close-candidate': '关闭候选库',
  validate: '校验新索引',
  'close-active': '关闭原索引',
  publish: '发布新索引',
  rollback: '回滚原索引',
  cleanup: '清理旧文件',
  access: '访问索引',
  snapshot: '捕获快照',
  rebuild: '重建索引',
}
function diagnosticText(value: IndexMaintenanceDiagnostic, depth = 0): string {
  const phase = phases[value.phase]
    ? __t('ui.index-maintenance', phases[value.phase]!)
    : value.phase
  return [
    `${phase} · ${value.code}`,
    value.path,
    value.message,
    ...(depth < 4 ? (value.causes ?? []).map((cause) => diagnosticText(cause, depth + 1)) : []),
  ]
    .filter(Boolean)
    .join('\n')
}
const stateNames: Record<string, string> = {
  queued: '排队中',
  running: '重建中',
  waiting: '等待中',
  waiting_io: '等待响应',
  waiting_approval: '等待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '已超时',
  suspended: '已暂停',
}

async function refresh() {
  if (loading || disposed) return
  loading = true
  try {
    const result = await maintenanceApi.indexes()
    if (!disposed) {
      status.value = result.data ?? null
      error.value = ''
    }
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '索引状态加载失败'
  } finally {
    loading = false
    if (!disposed)
      timer = setTimeout(
        () => {
          void refresh()
        },
        status.value?.busy ? 1500 : 10_000,
      )
  }
}
async function rebuild(scope: IndexScope | 'all', agentId = target.value) {
  if (submitting.value || status.value?.busy) return
  submitting.value = true
  try {
    await maintenanceApi.reindex(agentId || undefined, scope)
    notification.toast(__t('ui.settings', '索引重建已安排'), 'success')
    if (timer) clearTimeout(timer)
    await refresh()
  } catch (cause) {
    notification.toast(
      cause instanceof Error ? cause.message : __t('ui.settings', '重建失败'),
      'error',
    )
  } finally {
    submitting.value = false
  }
}
watch(target, () => {
  if (timer) clearTimeout(timer)
  void refresh()
})
watch(agentProfiles, (profiles) => {
  if (selectedAgent.value && !profiles.has(selectedAgent.value))
    selectedAgent.value = profiles.has(agents.activeAgentId) ? agents.activeAgentId : ''
})
onMounted(() => {
  void refresh()
})
onUnmounted(() => {
  disposed = true
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <PCard pixel padding="lg" overflow-visible>
    <div class="index-header">
      <div>
        <h4>
          <PixelIcon name="database" size="sm" />
          {{ social ? __t('ui.settings', '社交图谱维护') : __t('ui.settings', '索引维护') }}
        </h4>
        <p v-if="status">
          {{ status.model || __t('ui.settings', '未配置向量模型') }} · {{ status.dimension }}
          {{ __t('ui.settings', '维') }}
        </p>
      </div>
      <PSelect v-if="!social" v-model="selectedAgent" :options="choices" size="sm" teleport />
      <PButton
        v-else
        size="sm"
        variant="secondary"
        :disabled="submitting || status?.busy || !target"
        @click="rebuild('social')"
      >
        {{ __t('ui.settings', '重建图谱') }}
      </PButton>
    </div>
    <p class="index-hint">
      {{
        social
          ? __t('ui.settings', '重建社交检索索引，保留摘要与关系。')
          : __t('ui.settings', '保留记忆和原文，按当前模型重建索引。')
      }}
    </p>
    <p v-if="status && !status.embeddingAvailable" class="index-warning">
      {{ __t('ui.settings', '未配置 Embedding，主记忆和文档仅建立文本索引。') }}
    </p>
    <p v-if="error" class="index-warning" role="alert">{{ error }}</p>
    <div
      v-for="item in indexes"
      :key="`${item.scope}:${item.agentId ?? ''}`"
      class="index-row"
      :data-scope="item.scope"
    >
      <div class="index-identity">
        <span v-if="item.agentId" class="index-avatar" :title="item.agentName">
          <img
            v-if="item.avatarUrl && !failedAvatars.has(item.avatarUrl)"
            :src="item.avatarUrl"
            alt=""
            loading="lazy"
            decoding="async"
            draggable="false"
            @error="failedAvatars.add(item.avatarUrl)"
          />
          <PixelIcon v-else name="user" size="md" aria-hidden="true" />
        </span>
        <span v-else class="index-shared-symbol" aria-hidden="true">
          <PixelIcon :name="sourceIcons[item.scope]" size="md" />
        </span>
        <div class="index-copy">
          <strong class="index-title">
            <PixelIcon
              v-if="item.agentId"
              :name="sourceIcons[item.scope]"
              size="sm"
              class="index-source-icon"
              aria-hidden="true"
            />
            <span>{{ __t('ui.settings', names[item.scope]) }}</span>
            <span v-if="item.agentId" class="index-agent-name">· {{ item.agentName }}</span>
          </strong>
          <small
            :class="{
              'index-warning':
                item.error || (item.dimension !== null && item.dimension !== status?.dimension),
            }"
          >
            {{
              (item.maintenance ? __t('ui.index-maintenance', '索引维护中') : item.error) ||
              (!item.exists
                ? __t('ui.settings', '未建立')
                : __t('ui.settings', '{0} 维 · {1} 节点', [
                    item.dimension ?? '未知',
                    item.nodeCount ?? '未知',
                  ]))
            }}
            <span v-if="item.dimension !== null && item.dimension !== status?.dimension">
              {{ __t('ui.settings', '· 待重建') }}
            </span>
          </small>
          <details v-if="item.diagnostic || item.warnings?.length" class="index-diagnostics">
            <summary>
              {{
                __t(
                  'ui.index-maintenance',
                  item.diagnostic ? '查看维护详情' : '索引可用，部分清理待重试',
                )
              }}
            </summary>
            <pre v-if="item.diagnostic" class="index-warning">{{
              diagnosticText(item.diagnostic)
            }}</pre>
            <pre v-for="(warning, index) in item.warnings" :key="index">{{
              diagnosticText(warning)
            }}</pre>
          </details>
        </div>
      </div>
      <PButton
        v-if="!social"
        class="index-rebuild"
        size="sm"
        variant="ghost"
        :disabled="submitting || status?.busy"
        @click="rebuild(item.scope, item.agentId)"
      >
        {{ __t('ui.settings', '重建') }}
      </PButton>
    </div>
    <div v-if="!social" class="index-footer">
      <small>{{ __t('ui.settings', '主记忆和文档重建可能产生 Embedding 调用。') }}</small>
      <PButton
        size="sm"
        variant="secondary"
        :disabled="submitting || status?.busy"
        @click="rebuild('all')"
      >
        {{ __t('ui.settings', '重建全部') }}
      </PButton>
    </div>
    <div v-if="job" class="index-progress" role="status" aria-live="polite">
      <span>
        {{ __t('ui.settings', stateNames[job.state] ?? job.state) }} ·
        {{
          __t('ui.index-maintenance', '已处理 {0}/{1} · 成功 {2} · 失败 {3}', [
            job.processed ?? job.completed,
            job.total,
            job.completed,
            job.failed ?? 0,
          ])
        }}
      </span>
      <progress :value="job.processed ?? job.completed" :max="Math.max(1, job.total)" />
      <small v-if="job.error && !jobIssues.some((item) => item.error)" class="index-warning">
        {{ job.error }}
      </small>
      <details v-if="jobIssues.length" class="index-diagnostics">
        <summary>{{ __t('ui.index-maintenance', '查看维护详情') }}</summary>
        <div
          v-for="item in jobIssues"
          :key="`${item.scope}:${item.agentId ?? ''}`"
          class="index-issue"
        >
          <strong>
            {{ __t('ui.settings', names[item.scope]) }}
            <template v-if="item.agentId">
              · {{ agentProfiles.get(item.agentId)?.name ?? item.agentId }}
            </template>
          </strong>
          <pre v-if="item.error" class="index-warning">{{ diagnosticText(item.error) }}</pre>
          <pre v-for="(warning, index) in item.warnings" :key="index">{{
            diagnosticText(warning)
          }}</pre>
        </div>
      </details>
    </div>
  </PCard>
</template>

<style scoped>
.index-header,
.index-row,
.index-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.index-header h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}
.index-header p,
.index-hint {
  margin: 6px 0;
  color: var(--text-muted);
  font-size: 11px;
}
.index-header :deep(.p-select) {
  min-width: 160px;
}
.index-row {
  --index-accent: var(--color-violet-500, #8b5cf6);
  padding: 12px 0;
  border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
}
.index-row[data-scope='social'] {
  --index-accent: var(--color-sky-500, #0ea5e9);
}
.index-row[data-scope='facts'] {
  --index-accent: var(--color-emerald-500, #10b981);
}
.index-row[data-scope='knowledge'] {
  --index-accent: var(--color-amber-500, #f59e0b);
}
.index-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.index-avatar,
.index-shared-symbol {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--index-accent);
  border: 1px solid color-mix(in srgb, var(--index-accent) 24%, transparent);
  background: color-mix(in srgb, var(--index-accent) 9%, transparent);
}
.index-avatar {
  overflow: hidden;
}
.index-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.index-copy {
  min-width: 0;
}
.index-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  line-height: 1.6;
}
.index-source-icon {
  flex: 0 0 auto;
  color: var(--index-accent);
}
.index-agent-name {
  color: var(--text-secondary, inherit);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.index-rebuild {
  flex-shrink: 0;
}
.index-row strong {
  font-size: 12px;
  color: var(--text-primary);
}
.index-row small {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 11px;
}
.index-footer {
  border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
  padding-top: 12px;
}
.index-footer small {
  color: var(--text-muted);
  font-size: 11px;
}
.index-warning {
  color: var(--color-rose-500, #f87171) !important;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.index-progress {
  display: grid;
  gap: 8px;
  margin-top: 14px;
  color: var(--text-secondary);
  font-size: 12px;
}
.index-progress progress {
  width: 100%;
  height: 5px;
  accent-color: var(--color-sky-400, #38bdf8);
}
.index-diagnostics {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}
.index-diagnostics summary {
  cursor: pointer;
  color: var(--color-amber-400, #d4a35a);
}
.index-issue {
  margin-top: 8px;
  padding: 8px 10px;
  border-left: 2px solid var(--border-color);
  background: var(--bg-secondary, transparent);
}
.index-diagnostics pre {
  margin: 6px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  line-height: 1.7;
}
</style>
