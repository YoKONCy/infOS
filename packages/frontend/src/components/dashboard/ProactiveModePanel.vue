<script setup lang="ts">
import { getDisplayLocale } from '../../i18n/index'

import { t as __t } from '../../i18n/index'

import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import type { ProactiveMode, ProactiveSettings, ProactiveState } from '@infos/shared'
import { schedulerApi } from '../../api/modules/schedulerApi'
import { getApiBaseUrl } from '../../api/transport'
import { PButton, PCard, PInputNumber, PSelect, PixelIcon } from '../pixel'
import { useAgentStore, useNotificationStore } from '../../stores'

const notify = useNotificationStore()
const agentStore = useAgentStore()
const state = ref<ProactiveState | null>(null)
const saving = ref(false)
const pendingMode = ref<ProactiveMode | null>(null)
const checking = ref(false)
const dirty = ref(false)
const error = ref('')
const draft = ref<Pick<ProactiveSettings, 'companionIntervalMinutes' | 'autonomousIntervalMinutes' | 'maxDailyRuns' | 'goal' | 'timeZone'>>({
  companionIntervalMinutes: 3,
  autonomousIntervalMinutes: 15,
  maxDailyRuns: 48,
  goal: '',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
})
const modes: Array<{ value: ProactiveMode; label: string; icon: string; description: string }> = [
  {
    value: 'off',
    get label() {
      return __t('ui.settings', '关闭')
    },
    icon: 'close',
    get description() {
      return __t('ui.settings', '暂停主动唤醒，已安排的定时任务继续运行。')
    },
  },
  {
    value: 'companion',
    get label() {
      return __t('ui.settings', '智能陪伴')
    },
    icon: 'chat',
    get description() {
      return __t('ui.settings', '适时主动交流，未回应时减少打扰。')
    },
  },
  {
    value: 'autonomous',
    get label() {
      return __t('ui.settings', '自主行动')
    },
    icon: 'flash',
    get description() {
      return __t('ui.settings', '主动搜索、整理信息并推进事项。')
    },
  },
]
const currentMode = computed(() => state.value?.settings.mode ?? 'off')
const current = computed(() => modes.find((mode) => mode.value === currentMode.value)!)
const phaseText = computed(() => {
  if (!state.value) return __t('ui.settings', '正在读取')
  return {
    get off() {
      return __t('ui.settings', '已关闭')
    },
    get waiting() {
      return __t('ui.settings', '等待唤醒')
    },
    get running() {
      return __t('ui.settings', '执行中')
    },
    get error() {
      return __t('ui.settings', '运行异常')
    },
  }[state.value.phase]
})
const recent = computed(() => [...(state.value?.recent ?? [])].reverse())
const modeOptions = computed(() => [
  { value: 'inherit', label: __t('ui.settings', '跟随全局') },
  ...modes.map((mode) => ({ value: mode.value, label: mode.label })),
])
const activityOptions = computed(() => [
  { value: 'inherit', label: __t('ui.settings', '跟随全局') },
  { value: 'on', label: __t('ui.settings', '开启') },
  { value: 'off', label: __t('ui.settings', '关闭') },
])
let disposed = false
let active = true
let sequence = 0
let timer: ReturnType<typeof setInterval> | undefined

function agentName(id: string): string {
  return agentStore.agents.find((agent) => agent.id === id)?.name || id
}
function time(value?: number | null): string {
  return value
    ? new Date(value).toLocaleString(getDisplayLocale(), {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
}
function syncDraft(settings: ProactiveSettings): void {
  draft.value = {
    companionIntervalMinutes: settings.companionIntervalMinutes,
    autonomousIntervalMinutes: settings.autonomousIntervalMinutes,
    maxDailyRuns: settings.maxDailyRuns,
    goal: settings.goal,
    timeZone: settings.timeZone,
  }
}
function setNumber(
  key: 'companionIntervalMinutes' | 'autonomousIntervalMinutes' | 'maxDailyRuns',
  value: number | null,
): void {
  if (value === null) return
  draft.value[key] = value
  dirty.value = true
}
async function refresh(): Promise<void> {
  const request = ++sequence
  try {
    const response = await schedulerApi.proactive()
    if (disposed || !active || request !== sequence || !response.data) return
    state.value = response.data
    if (!dirty.value && !saving.value) syncDraft(response.data.settings)
    error.value = ''
  } catch (failure) {
    if (!disposed && request === sequence)
      error.value = failure instanceof Error ? failure.message : '读取主动行为设置失败'
  }
}
async function selectMode(mode: ProactiveMode): Promise<void> {
  if (saving.value || !state.value || mode === currentMode.value) return
  sequence++
  saving.value = true
  pendingMode.value = mode
  try {
    const response = await schedulerApi.configureProactive({ mode })
    if (disposed || !response.data) return
    state.value = response.data
    if (!dirty.value) syncDraft(response.data.settings)
    error.value = ''
    notify.toast(
      __t('ui.settings', '已更新全局默认模式'),
      'success',
    )
  } catch (failure) {
    notify.toast(
      failure instanceof Error ? failure.message : __t('ui.settings', '切换失败'),
      'error',
    )
  } finally {
    saving.value = false
    pendingMode.value = null
  }
}
async function saveSettings(): Promise<void> {
  if (saving.value) return
  sequence++
  saving.value = true
  try {
    const response = await schedulerApi.configureProactive({ ...draft.value })
    if (disposed || !response.data) return
    state.value = response.data
    syncDraft(response.data.settings)
    dirty.value = false
    error.value = ''
    notify.toast(__t('ui.settings', '调度设置已保存'), 'success')
  } catch (failure) {
    notify.toast(
      failure instanceof Error ? failure.message : __t('ui.settings', '保存失败'),
      'error',
    )
  } finally {
    saving.value = false
  }
}
async function setActivity(agentId: string | null, key: 'mode' | 'strongholdActivity', value: string | number): Promise<void> {
  if (saving.value || !state.value) return
  sequence++
  saving.value = true
  try {
    const patch = key === 'mode'
      ? { mode: value === 'inherit' ? null : value as ProactiveMode }
      : { strongholdActivity: value === 'inherit' ? null : value === 'on' }
    const response = agentId
      ? await schedulerApi.configureAgentProactive(agentId, patch)
      : await schedulerApi.configureProactive({ strongholdActivity: value === 'on' })
    if (!disposed && response.data) {
      state.value = response.data
      error.value = ''
    }
  } catch (failure) {
    notify.toast(failure instanceof Error ? failure.message : __t('ui.settings', '保存失败'), 'error')
  } finally {
    saving.value = false
  }
}
async function check(): Promise<void> {
  if (checking.value || saving.value) return
  checking.value = true
  try {
    await schedulerApi.checkProactive()
    await refresh()
  } catch (failure) {
    notify.toast(
      failure instanceof Error ? failure.message : __t('ui.settings', '唤醒失败'),
      'error',
    )
  } finally {
    checking.value = false
  }
}
function startPolling(): void {
  if (timer) clearInterval(timer)
  if (!disposed && active)
    timer = setInterval(() => {
      if (!document.hidden && !saving.value && !checking.value) void refresh()
    }, 10_000)
}
onMounted(() => {
  void refresh()
  startPolling()
})
onActivated(() => {
  active = true
  void refresh()
  startPolling()
})
onDeactivated(() => {
  active = false
  sequence++
  if (timer) clearInterval(timer)
  timer = undefined
})
onUnmounted(() => {
  disposed = true
  sequence++
  if (timer) clearInterval(timer)
})
</script>

<template>
  <PCard pixel padding="none" class="proactive-panel">
    <header class="proactive-heading">
      <span class="proactive-heading__icon"><PixelIcon name="clock" size="md" /></span>
      <div>
        <h3>{{ __t('ui.settings', '主动行为') }}</h3>
        <p>{{ __t('ui.settings', '全局默认 · 角色可单独配置') }}</p>
      </div>
      <span class="proactive-label" :class="{ 'proactive-label--on': currentMode !== 'off' }">
        {{ current.label }}
      </span>
    </header>

    <div class="proactive-mode-row">
      <div class="proactive-mode-copy">
        <p>{{ current.description }}</p>
        <small>{{ __t('ui.settings', '角色选择跟随全局时使用此设置。') }}</small>
      </div>
      <div
        class="proactive-segment"
        role="group"
        :aria-label="__t('ui.settings', '全局主动模式')"
        :aria-busy="saving"
      >
        <button
          v-for="mode in modes"
          :key="mode.value"
          type="button"
          :disabled="saving || !state"
          :aria-pressed="currentMode === mode.value"
          @click="selectMode(mode.value)"
        >
          <PixelIcon
            :name="pendingMode === mode.value ? 'refresh' : mode.icon"
            size="xs"
            :animation="pendingMode === mode.value ? 'spin' : undefined"
          />
          {{ mode.label }}
        </button>
      </div>
    </div>

    <div class="proactive-mode-row">
      <div class="proactive-mode-copy">
        <p>{{ __t('ui.settings', '据点自由活动') }}</p>
        <small>{{ __t('ui.settings', '允许角色主动聊天、走动和邀请伙伴。') }}</small>
      </div>
      <PSelect
        :model-value="state?.settings.strongholdActivity ? 'on' : 'off'"
        :options="activityOptions.filter((option) => option.value !== 'inherit')"
        :disabled="saving || !state"
        size="sm"
        @update:model-value="setActivity(null, 'strongholdActivity', $event)"
      />
    </div>

    <details class="proactive-details">
      <summary>
        <PixelIcon name="users" size="xs" />
        <span>{{ __t('ui.settings', '角色设置') }}</span>
        <PixelIcon class="proactive-chevron" name="chevron-down" size="xs" />
      </summary>
      <div class="proactive-agent-list">
        <div v-for="agent in agentStore.agents" :key="agent.id" class="proactive-agent">
          <span class="proactive-agent__identity">
            <img v-if="agent.avatarUrl" :src="`${getApiBaseUrl()}${agent.avatarUrl}`" alt="" />
            <PixelIcon v-else name="paw" size="sm" />
            <span>
              {{ agent.name }}
              <small v-if="state?.activities?.[agent.id] === 'wait_message'">{{ __t('ui.settings', '等待回答') }}</small>
              <small v-else-if="state?.activities?.[agent.id] === 'wait_task'">{{ __t('ui.settings', '等待任务') }}</small>
            </span>
          </span>
          <PSelect
            :model-value="state?.settings.agents?.[agent.id]?.mode ?? 'inherit'"
            :options="modeOptions"
            :label="__t('ui.settings', '主动模式')"
            :disabled="saving || !state"
            size="sm"
            @update:model-value="setActivity(agent.id, 'mode', $event)"
          />
          <PSelect
            :model-value="state?.settings.agents?.[agent.id]?.strongholdActivity === undefined ? 'inherit' : state?.settings.agents?.[agent.id]?.strongholdActivity ? 'on' : 'off'"
            :options="activityOptions"
            :label="__t('ui.settings', '据点自由活动')"
            :disabled="saving || !state"
            size="sm"
            @update:model-value="setActivity(agent.id, 'strongholdActivity', $event)"
          />
        </div>
      </div>
    </details>

    <div class="proactive-status" aria-live="polite">
      <span class="proactive-phase" :class="`proactive-phase--${state?.phase ?? 'off'}`">
        <i />
        {{ phaseText }}
        <template v-if="state?.agentId">· {{ agentName(state.agentId) }}</template>
      </span>
      <template v-if="state && state.phase !== 'off'">
        <span>{{ __t('ui.settings', '下次') }} {{ time(state.nextRunAt) }}</span>
        <span>
          {{ __t('ui.settings', '今日') }} {{ state.dailyRuns }} / {{ state.settings.maxDailyRuns }}
          {{ __t('ui.settings', '回合') }}
        </span>
      </template>
      <PButton
        v-if="state && state.phase !== 'off'"
        size="sm"
        variant="ghost"
        :loading="checking"
        :disabled="saving || !state || state.phase === 'running'"
        @click="check"
      >
        <PixelIcon name="refresh" size="xs" />
        {{ __t('ui.settings', '立即唤醒') }}
      </PButton>
    </div>
    <p v-if="error || state?.lastError" class="proactive-error proactive-notice" role="alert">
      {{ error || state?.lastError }}
    </p>

    <details class="proactive-details">
      <summary>
        <PixelIcon name="settings" size="xs" />
        <span>{{ __t('ui.settings', '调度设置') }}</span>
        <small v-if="dirty">{{ __t('ui.settings', '有未保存修改') }}</small>
        <PixelIcon class="proactive-chevron" name="chevron-down" size="xs" />
      </summary>
      <div class="proactive-settings">
        <div class="proactive-settings__numbers">
          <label>
            <span>
              {{ __t('ui.settings', '陪伴间隔') }}
              <small>{{ __t('ui.settings', '分钟') }}</small>
            </span>
            <PInputNumber
              :model-value="draft.companionIntervalMinutes"
              :min="1"
              :max="1440"
              :disabled="saving"
              @update:model-value="setNumber('companionIntervalMinutes', $event)"
            />
          </label>
          <label>
            <span>
              {{ __t('ui.settings', '自主行动间隔') }}
              <small>{{ __t('ui.settings', '分钟') }}</small>
            </span>
            <PInputNumber
              :model-value="draft.autonomousIntervalMinutes"
              :min="1"
              :max="1440"
              :disabled="saving"
              @update:model-value="setNumber('autonomousIntervalMinutes', $event)"
            />
          </label>
          <label>
            <span>
              {{ __t('ui.settings', '每日回合上限') }}
              <small>{{ __t('ui.settings', '全部角色合计') }}</small>
            </span>
            <PInputNumber
              :model-value="draft.maxDailyRuns"
              :min="1"
              :max="1440"
              :disabled="saving"
              @update:model-value="setNumber('maxDailyRuns', $event)"
            />
          </label>
        </div>
        <label class="proactive-goal">
          <span>
            {{ __t('ui.settings', '行动偏好') }}
            <small>{{ __t('ui.settings', '选填') }}</small>
          </span>
          <textarea
            v-model="draft.goal"
            :disabled="saving"
            rows="2"
            maxlength="8000"
            :placeholder="__t('ui.settings', '优先关注的事项（可选）')"
            @input="dirty = true"
          />
        </label>
        <footer>
          <small>{{ __t('ui.settings', '间隔与冷却共同决定唤醒时间，用户交互优先。') }}</small>
          <PButton
            type="button"
            size="sm"
            variant="secondary"
            :loading="saving && pendingMode === null"
            :disabled="saving || !state || !dirty"
            @click="saveSettings"
          >
            {{ __t('ui.settings', '保存设置') }}
          </PButton>
        </footer>
      </div>
    </details>
    <details v-if="recent.length" class="proactive-details proactive-records">
      <summary>
        <PixelIcon name="list" size="xs" />
        <span>{{ __t('ui.settings', '最近运行') }}</span>
        <small>{{ time(recent[0]?.at) }}</small>
        <PixelIcon class="proactive-chevron" name="chevron-down" size="xs" />
      </summary>
      <ol>
        <li v-for="(record, index) in recent" :key="index">
          <time>{{ time(record.at) }}</time>
          <span v-if="record.agentId" class="proactive-records__agent">
            {{ agentName(record.agentId) }}
          </span>
          <span :class="{ 'proactive-error': record.error }">
            {{ record.error || record.outcome }}
          </span>
        </li>
      </ol>
    </details>
  </PCard>
</template>

<style scoped>
.proactive-agent-list {
  display: grid;
  gap: 16px;
  padding: 12px 20px 20px;
}
.proactive-agent {
  display: grid;
  grid-template-columns: minmax(100px, 1fr) repeat(2, minmax(140px, 1fr));
  align-items: center;
  gap: 12px;
}
.proactive-agent__identity {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.proactive-agent__identity img {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}
.proactive-agent__identity small {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
@media (max-width: 600px) {
  .proactive-agent { grid-template-columns: 1fr 1fr; }
  .proactive-agent__identity { grid-column: 1 / -1; }
}
.proactive-panel {
  --proactive-accent: var(--ui-accent-sky);
}
.proactive-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.proactive-heading__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  color: var(--proactive-accent);
  background: var(--ui-accent-sky-soft);
  border: 1px solid color-mix(in srgb, var(--proactive-accent) 25%, transparent);
}
.proactive-heading h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--ui-text-primary);
}
.proactive-heading p {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
.proactive-label {
  margin-left: auto;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--ui-text-secondary);
  border: 1px solid var(--ui-border-subtle);
  white-space: nowrap;
}
.proactive-label--on {
  color: var(--proactive-accent);
  background: var(--ui-accent-sky-soft);
  border-color: color-mix(in srgb, var(--proactive-accent) 25%, transparent);
}
.proactive-mode-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 20px 20px 14px;
}
.proactive-mode-copy {
  min-width: 0;
}
.proactive-mode-copy p {
  margin: 0 0 5px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ui-text-primary);
}
.proactive-mode-copy small {
  color: var(--ui-text-tertiary);
  font-size: 11px;
  line-height: 1.7;
}
.proactive-segment {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--ui-border-default);
  background: var(--dash-panel-soft);
}
.proactive-segment button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid transparent;
  color: var(--ui-text-secondary);
  background: transparent;
  font:
    12px/1.5 var(--font-pixel),
    sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.proactive-segment button:hover:not(:disabled) {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}
.proactive-segment button[aria-pressed='true'] {
  color: var(--proactive-accent);
  border-color: color-mix(in srgb, var(--proactive-accent) 35%, var(--ui-border-subtle));
  background: var(--ui-accent-sky-soft);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ui-bg-surface) 70%, transparent);
}
.proactive-segment button:focus-visible,
.proactive-details summary:focus-visible {
  outline: 2px solid var(--proactive-accent);
  outline-offset: 2px;
}
.proactive-segment button:disabled {
  cursor: wait;
  opacity: 0.6;
}
.proactive-status {
  display: flex;
  align-items: center;
  gap: 10px 20px;
  flex-wrap: wrap;
  min-height: 28px;
  padding: 0 20px 16px;
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
.proactive-status > :last-child:is(.p-btn) {
  margin-left: auto;
}
.proactive-status :deep(.p-btn) {
  min-height: 26px;
  box-shadow: none;
}
.proactive-phase {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ui-text-secondary);
}
.proactive-phase i {
  width: 6px;
  height: 6px;
  background: var(--ui-text-disabled);
}
.proactive-phase--waiting i {
  background: var(--proactive-accent);
}
.proactive-phase--running i {
  background: var(--ui-success);
  box-shadow: 0 0 8px var(--ui-success-soft);
}
.proactive-phase--error i {
  background: var(--ui-danger);
}
.proactive-details {
  border-top: 1px solid var(--ui-border-subtle);
}
.proactive-details summary {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 40px;
  padding: 8px 20px;
  box-sizing: border-box;
  color: var(--ui-text-secondary);
  font-size: 12px;
  cursor: pointer;
  list-style: none;
}
.proactive-details summary::-webkit-details-marker {
  display: none;
}
.proactive-details summary:hover {
  background: var(--ui-bg-hover);
}
.proactive-details summary small {
  margin-left: auto;
  font-size: 10px;
  color: var(--ui-text-tertiary);
}
.proactive-chevron {
  margin-left: auto;
  color: var(--ui-text-tertiary);
}
.proactive-details[open] .proactive-chevron {
  transform: rotate(180deg);
}
.proactive-details summary small + .proactive-chevron {
  margin-left: 4px;
}
.proactive-settings {
  display: grid;
  gap: 18px;
  padding: 8px 20px 18px;
  background: var(--dash-panel-soft);
}
.proactive-settings__numbers {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  max-width: 760px;
}
.proactive-settings label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.proactive-settings label small {
  margin-left: 6px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.proactive-goal textarea {
  width: 100%;
  min-height: 66px;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--dash-input-bg);
  color: var(--ui-text-primary);
  font: inherit;
  line-height: 1.7;
  resize: vertical;
}
.proactive-goal textarea:focus {
  outline: 1px solid var(--proactive-accent);
  border-color: var(--proactive-accent);
}
.proactive-settings footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.proactive-settings footer small {
  font-size: 11px;
  line-height: 1.7;
  color: var(--ui-text-tertiary);
}
.proactive-records ol {
  display: flex;
  flex-direction: column;
  gap: 0;
  max-height: 240px;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 0 20px 12px;
}
.proactive-records li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  padding: 9px 0;
  border-top: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.7;
}
.proactive-records time {
  color: var(--ui-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.proactive-records__agent {
  color: var(--proactive-accent);
}
.proactive-error {
  margin: 0;
  color: var(--ui-danger);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.proactive-notice {
  padding: 0 20px 14px;
}
@media (max-width: 900px) {
  .proactive-mode-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  .proactive-segment {
    align-self: stretch;
  }
  .proactive-segment button {
    flex: 1;
  }
}
@media (max-width: 520px) {
  .proactive-heading,
  .proactive-mode-row,
  .proactive-details summary {
    padding-left: 14px;
    padding-right: 14px;
  }
  .proactive-status {
    padding-left: 14px;
    padding-right: 14px;
  }
  .proactive-settings {
    padding-left: 14px;
    padding-right: 14px;
  }
  .proactive-settings__numbers {
    grid-template-columns: 1fr;
    gap: 14px;
  }
  .proactive-settings footer {
    align-items: flex-start;
  }
  .proactive-segment button {
    padding: 6px 8px;
  }
}
</style>
