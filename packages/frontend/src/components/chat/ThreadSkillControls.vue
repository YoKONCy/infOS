<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../i18n'
import { threadsApi, type ThreadSkillsData } from '../../api/modules/threadsApi'
import { useNotificationStore } from '../../stores/useNotificationStore'
import InputBarFoldout from './InputBarFoldout.vue'
import PixelIcon from '../pixel/PixelIcon.vue'

const props = defineProps<{ threadId: string; disabled?: boolean; compact?: boolean }>()
const emit = defineEmits<{ changed: []; busy: [value: boolean]; open: [] }>()
const notify = useNotificationStore()
const menu = ref<InstanceType<typeof InputBarFoldout> | null>(null)
const data = ref<ThreadSkillsData | null>(null)
const loading = ref(false)
const saving = ref(false)
const failed = ref(false)
const query = ref('')
let revision = 0
let disposed = false
const count = computed(() => data.value?.enabledSkills.length ?? 0)
const blocked = computed(() => props.disabled || loading.value || saving.value || !data.value)
const visibleSkills = computed(() => {
  const search = query.value.trim().toLowerCase()
  return (data.value?.skills ?? []).filter((skill) =>
    `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(search),
  )
})

async function load(): Promise<void> {
  if (saving.value) return
  const request = ++revision
  const threadId = props.threadId
  failed.value = false
  if (!threadId) return
  loading.value = true
  try {
    const response = await threadsApi.getSkills(threadId)
    if (disposed || request !== revision || props.threadId !== threadId) return
    if (!response.data) throw new Error('会话技能配置响应缺少数据')
    data.value = response.data
  } catch {
    if (!disposed && request === revision) {
      failed.value = true
      data.value = null
    }
  } finally {
    if (!disposed && request === revision) loading.value = false
  }
}

async function save(enabledSkills: string[]): Promise<void> {
  if (blocked.value) return
  const request = ++revision
  const threadId = props.threadId
  saving.value = true
  emit('busy', true)
  try {
    const response = await threadsApi.updateSkills(threadId, enabledSkills)
    if (disposed || request !== revision || props.threadId !== threadId) return
    if (!response.data) throw new Error('会话技能配置响应缺少数据')
    data.value = response.data
    emit('changed')
  } catch {
    if (!disposed && request === revision)
      notify.toast(t('ui.chat', 'Skills 设置保存失败，请重试。'), 'error')
  } finally {
    if (!disposed && request === revision) {
      saving.value = false
      emit('busy', false)
    }
  }
}

function toggle(id: string): void {
  const selected = data.value?.enabledSkills ?? []
  void save(selected.includes(id) ? selected.filter((skill) => skill !== id) : [...selected, id])
}

function close(): void {
  menu.value?.close()
}

watch(
  () => props.threadId,
  () => {
    revision++
    data.value = null
    loading.value = false
    saving.value = false
    query.value = ''
    emit('busy', false)
    void load()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  disposed = true
  revision++
  emit('busy', false)
})
defineExpose({ close })
</script>

<template>
  <InputBarFoldout
    ref="menu"
    variant="text"
    :label="t('ui.chat', 'Skills')"
    :title="t('ui.chat', '本会话 Skills')"
    icon="skill"
    :summary="String(count)"
    :scope-key="threadId"
    :compact="compact"
    :busy="loading || saving"
    :disabled="disabled || !threadId"
    :width="350"
    @open="emit('open'); load()"
  >
    <template #trigger="{ open }">
      <PixelIcon name="skill" size="xs" aria-hidden="true" />
      <span v-if="!compact">{{ t('ui.chat', 'Skills') }}</span>
      <small v-if="count && !compact" class="skill-trigger-count">{{ count }}</small>
      <PixelIcon
        v-if="!compact"
        name="chevron-down"
        size="xs"
        class="skill-trigger-chevron"
        :class="{ 'is-open': open }"
        aria-hidden="true"
      />
    </template>
    <div class="skill-head">
      <span>{{ t('ui.chat', '仅选中的 Skills 会用于本会话。') }}</span>
      <button v-if="count" type="button" :disabled="blocked" @click="save([])">
        {{ t('ui.chat', '全部关闭') }}
      </button>
    </div>
    <input
      v-if="(data?.skills.length ?? 0) > 6"
      v-model="query"
      class="skill-search"
      :placeholder="t('ui.chat', '搜索 Skills')"
      :aria-label="t('ui.chat', '搜索 Skills')"
    />
    <button v-if="failed" type="button" class="skill-empty" @click="load">
      {{ t('ui.chat', 'Skills 加载失败，点击重试') }}
    </button>
    <p v-else-if="loading && !data" class="skill-empty">{{ t('ui.chat', '正在读取 Skills…') }}</p>
    <div v-else class="skill-list">
      <button
        v-for="skill in visibleSkills"
        :key="skill.id"
        type="button"
        class="skill-row"
        :class="{ 'is-enabled': skill.enabled }"
        role="switch"
        :aria-checked="skill.enabled"
        :disabled="blocked"
        @click="toggle(skill.id)"
      >
        <PixelIcon name="skill" size="sm" aria-hidden="true" />
        <span class="skill-copy">
          <strong>{{ skill.name }}</strong>
          <small v-if="skill.description">{{ skill.description }}</small>
        </span>
        <span class="skill-check" aria-hidden="true"><PixelIcon v-if="skill.enabled" name="check" size="xs" /></span>
      </button>
      <p v-if="!visibleSkills.length" class="skill-empty">{{ t('ui.chat', '暂无可用 Skills') }}</p>
    </div>
  </InputBarFoldout>
</template>

<style scoped>
.skill-trigger-count {
  color: var(--ui-text-tertiary);
  font: 9px/1 var(--ui-font-mono);
}
.skill-trigger-chevron {
  color: var(--ui-text-tertiary);
  transition: transform 180ms ease;
}
.skill-trigger-chevron.is-open {
  transform: rotate(180deg);
}
.skill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.skill-head button {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--ui-accent-primary);
  cursor: pointer;
}
.skill-search {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 10px;
  padding: 8px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 2px;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
}
.skill-list { display: grid; gap: 6px; }
.skill-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 2px;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
  text-align: left;
  cursor: pointer;
}
.skill-row.is-enabled { border-color: var(--ui-accent-primary); color: var(--ui-text-primary); }
.skill-copy { display: grid; gap: 4px; min-width: 0; flex: 1; }
.skill-copy strong { font-size: 13px; overflow-wrap: anywhere; }
.skill-copy small { color: var(--ui-text-secondary); font-size: 11px; line-height: 1.5; }
.skill-check {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border: 1px solid var(--ui-border-strong);
  color: var(--ui-accent-primary);
}
.skill-empty { padding: 12px 0; color: var(--ui-text-secondary); font-size: 12px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) {
  .skill-trigger-chevron {
    transition: none;
  }
}
:global([data-motion='off']) .skill-trigger-chevron,
:global([data-motion='reduced']) .skill-trigger-chevron {
  transition: none;
}
</style>
