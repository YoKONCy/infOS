<script setup lang="ts">
import { getDisplayLocale } from '../../i18n/index'

import { t as __t } from '../../i18n/index'

/**
 * ApprovalCard — 跨区域共享的紧凑工具审批卡片。
 *
 * 卡片负责决策内容；对话流、工作区、任务详情只负责选择展示容器。
 */
import { ref, computed } from 'vue'
import { PixelIcon, PButton } from '../pixel'
import AgentRequestIdentity from '../agent/AgentRequestIdentity.vue'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalAuditRecord,
  ApprovalRiskLevel,
} from '../../api/modules/approvalsApi'
import { approvalsApi } from '../../api/modules/approvalsApi'

const props = withDefaults(
  defineProps<{
    request: ApprovalRequest
    error?: string
    loading?: boolean
    compact?: boolean
  }>(),
  {
    error: undefined,
    loading: false,
    compact: false,
  },
)

const emit = defineEmits<{
  resolve: [decision: ApprovalDecision, message?: string]
}>()

const message = ref('')
const expanded = ref(false)
const auditLoading = ref(false)
const auditRecords = ref<ApprovalAuditRecord[]>([])
const command = computed(() => {
  const value = props.request.argsSummary.command ?? props.request.argsSummary.data
  return typeof value === 'string' ? value : null
})
const riskMeta: Record<ApprovalRiskLevel, { label: string; hint: string }> = {
  low: {
    get label() {
      return __t('ui.approval', '轻度提醒')
    },
    get hint() {
      return __t('ui.approval', '请核对参数后决定是否继续。')
    },
  },
  medium: {
    get label() {
      return __t('ui.approval', '需要留意')
    },
    get hint() {
      return __t('ui.approval', '此操作会改变应用或系统状态。')
    },
  },
  high: {
    get label() {
      return __t('ui.approval', '高风险')
    },
    get hint() {
      return __t('ui.approval', '此操作可能造成明显副作用，请仔细确认。')
    },
  },
  critical: {
    get label() {
      return __t('ui.approval', '严重风险')
    },
    get hint() {
      return __t('ui.approval', '此操作可能造成不可逆影响，请逐项核对。')
    },
  },
}
const risk = computed(() => riskMeta[props.request.riskLevel])

function submit(decision: ApprovalDecision): void {
  if (props.loading) return
  const note = message.value.trim()
  emit('resolve', decision, note || undefined)
}

async function toggleDetails(): Promise<void> {
  expanded.value = !expanded.value
  if (!expanded.value || auditRecords.value.length || auditLoading.value) return
  auditLoading.value = true
  try {
    const response = await approvalsApi.audit({ approvalId: props.request.id })
    auditRecords.value = response.data?.records ?? []
  } finally {
    auditLoading.value = false
  }
}

function formatAuditTime(value: string): string {
  return new Date(value).toLocaleString(getDisplayLocale(), { hour12: false })
}
</script>

<template>
  <article
    class="approval-card"
    :class="[`approval-card--${request.riskLevel}`, { 'approval-card--compact': compact }]"
  >
    <header class="approval-card__header">
      <AgentRequestIdentity
        :agent-id="request.agentId"
        :subtitle="__t('ui.approval', '确认前不会执行这项操作')"
        tone="approval"
      >
        <template #title>{{ __t('ui.approval', '请求执行一项操作') }}</template>
      </AgentRequestIdentity>
      <span class="approval-card__risk">
        <i />
        {{ risk.label }}
      </span>
      <span class="approval-card__timer">{{ __t('ui.approval', '等待操作') }}</span>
    </header>

    <div class="approval-card__body">
      <p class="approval-card__reason">{{ request.reason }}</p>
      <p class="approval-card__hint">{{ risk.hint }}</p>
      <pre v-if="command" class="approval-card__command">{{ command }}</pre>
      <div class="approval-card__tool-row">
        <span>TOOL</span>
        <code>{{ request.toolName }}</code>
      </div>

      <button class="approval-card__details-toggle" type="button" @click="toggleDetails">
        <PixelIcon :name="expanded ? 'chevron-up' : 'chevron-down'" size="xs" />
        {{ expanded ? __t('ui.approval', '收起详情') : __t('ui.approval', '参数与审计') }}
      </button>
      <template v-if="expanded">
        <pre class="approval-card__details">{{ JSON.stringify(request.argsSummary, null, 2) }}</pre>
        <div class="approval-card__audit">
          <strong>{{ __t('ui.approval', '审批记录') }}</strong>
          <span v-if="auditLoading">{{ __t('ui.approval', '正在读取…') }}</span>
          <span v-else-if="auditRecords.length === 0">{{ __t('ui.approval', '暂无记录') }}</span>
          <div v-for="record in auditRecords" :key="record.id" class="approval-card__audit-row">
            <span>{{ record.event }}</span>
            <time>{{ formatAuditTime(record.createdAt) }}</time>
          </div>
        </div>
      </template>

      <textarea
        v-model="message"
        :disabled="loading"
        maxlength="2000"
        rows="2"
        class="approval-card__message"
        :placeholder="__t('ui.approval', '可以补充要求，例如“只执行这一步，不要改动其他内容”')"
      />
    </div>

    <p v-if="error" class="approval-card__error" role="alert">{{ error }}</p>
    <footer class="approval-card__actions">
      <PButton size="sm" :disabled="loading" @click="submit('allow_once')">
        {{ __t('ui.approval', '允许本次') }}
      </PButton>
      <PButton
        v-if="
          !['high', 'critical'].includes(request.riskLevel) &&
          !request.toolName.startsWith('remote_terminal_') &&
          !['terminal_execute', 'terminal_create', 'terminal_write', 'delete_file'].includes(
            request.toolName,
          )
        "
        size="sm"
        variant="secondary"
        :disabled="loading"
        @click="submit('allow_session')"
      >
        {{ __t('ui.approval', '本轮对话允许') }}
      </PButton>
      <PButton size="sm" variant="danger" :disabled="loading" @click="submit('deny_once')">
        {{ __t('ui.approval', '拒绝') }}
      </PButton>
    </footer>
  </article>
</template>

<style scoped>
.approval-card__error {
  margin: 8px 12px;
  color: var(--color-danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.approval-card {
  --approval-tone: var(--ui-accent-primary, #db2777);
  --approval-soft: color-mix(in srgb, var(--approval-tone) 9%, var(--ui-bg-elevated, #fff));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 0;
  max-height: min(440px, 60vh);
  width: min(100%, 500px);
  margin: 4px 0 4px auto;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--approval-tone) 52%, var(--ui-border-subtle));
  border-left: 3px solid var(--approval-tone);
  border-radius: 3px;
  background: var(--ui-bg-elevated, #fff);
  color: var(--ui-text-primary, #1e293b);
  box-shadow:
    3px 3px 0 color-mix(in srgb, var(--approval-tone) 18%, transparent),
    6px 6px 0 color-mix(in srgb, var(--ui-text-primary, #0f172a) 7%, transparent);
  transition:
    transform 0.12s steps(2, end),
    box-shadow 0.12s steps(2, end);
}

.approval-card--low {
  --approval-tone: var(--ui-accent-sky, #0ea5e9);
}

.approval-card--medium {
  --approval-tone: #d97706;
}

.approval-card--high {
  --approval-tone: #ea580c;
}

.approval-card--critical {
  --approval-tone: #dc2626;
}

.approval-card__header {
  display: flex;
  flex-shrink: 0;
  min-height: 42px;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-bottom: 1px solid color-mix(in srgb, var(--approval-tone) 24%, var(--ui-border-subtle));
  background: var(--approval-soft);
  font-size: 11px;
}

.approval-card__heading {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.approval-card__heading strong {
  font-size: 12px;
  line-height: 1.2;
}

.approval-card__heading span {
  color: var(--ui-text-tertiary, #64748b);
  font-size: 9px;
  line-height: 1.2;
}

.approval-card__icon {
  display: grid;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 1px;
  background: color-mix(in srgb, var(--approval-tone) 15%, transparent);
  color: var(--approval-tone);
}

.approval-card__risk {
  display: inline-flex;
  margin-left: auto;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb, var(--approval-tone) 50%, transparent);
  border-radius: 2px;
  background: color-mix(in srgb, var(--approval-tone) 10%, transparent);
  color: var(--approval-tone);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.approval-card__risk i {
  width: 5px;
  height: 5px;
  background: currentColor;
  box-shadow: 1px 1px 0 color-mix(in srgb, currentColor 35%, transparent);
  animation: approval-blink 1.4s steps(2, end) infinite;
}

.approval-card__timer {
  flex-shrink: 0;
  min-width: 30px;
  color: var(--ui-text-tertiary, #94a3b8);
  font: 10px/1 monospace;
  text-align: right;
}

.approval-card__body {
  min-height: 0;
  overflow-y: auto;
  padding: 9px 10px 6px;
}

.approval-card__tool-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
}

.approval-card__tool-row span {
  padding: 2px 4px;
  background: var(--approval-tone);
  color: #fff;
  font:
    700 8px/1 'Cascadia Code',
    monospace;
  letter-spacing: 0.06em;
}

.approval-card__tool-row code {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-secondary, #64748b);
  font:
    10px/1.2 'Cascadia Code',
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-card__reason {
  margin: 0 0 3px;
  color: var(--ui-text-primary, #334155);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.45;
}

.approval-card__hint {
  margin: 0 0 7px;
  color: var(--ui-text-tertiary, #64748b);
  font-size: 10px;
  line-height: 1.4;
}

.approval-card__command,
.approval-card__details {
  box-sizing: border-box;
  max-height: 110px;
  margin: 6px 0;
  padding: 7px 9px;
  overflow: auto;
  border: 1px solid var(--ui-border-subtle, #e2e8f0);
  border-radius: 2px;
  background: var(--ui-bg-primary, #f8fafc);
  color: var(--ui-text-primary, #1e293b);
  font:
    10px/1.45 'Cascadia Code',
    monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.approval-card__command {
  border-left: 3px solid var(--approval-tone);
  background: color-mix(in srgb, var(--approval-tone) 4%, var(--ui-bg-primary, #f8fafc));
}

.approval-card__details-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--ui-text-tertiary, #64748b);
  font-size: 10px;
  cursor: pointer;
}

.approval-card__message {
  box-sizing: border-box;
  width: 100%;
  height: auto;
  min-height: 46px;
  margin-top: 8px;
  padding: 7px 9px;
  resize: vertical;
  border: 1px solid var(--ui-border-subtle, #cbd5e1);
  border-radius: 5px;
  outline: none;
  background: var(--ui-bg-primary, #fff);
  color: var(--ui-text-primary, #1e293b);
  font-size: 11px;
}

.approval-card__message::placeholder {
  color: var(--ui-text-tertiary, #94a3b8);
}

.approval-card__message:focus {
  border-color: var(--ui-accent-sky, #0ea5e9);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent-sky, #0ea5e9) 15%, transparent);
}

.approval-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 10px 9px;
  flex-shrink: 0;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-elevated, #fff);
}

.approval-card__audit {
  display: grid;
  gap: 4px;
  margin: 6px 0;
  padding: 7px;
  border: 1px solid var(--ui-border-subtle, #cbd5e1);
  border-radius: 2px;
  color: var(--ui-text-secondary, #64748b);
  font-size: 10px;
}

.approval-card__audit-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.approval-card__audit-row time {
  font-family: monospace;
}

.approval-card--compact {
  margin-block: 5px;
}

[data-theme='dark'] .approval-card {
  --approval-soft: color-mix(in srgb, var(--approval-tone) 13%, var(--ui-bg-elevated, #1e1b2e));
  border-color: color-mix(in srgb, var(--approval-tone) 55%, var(--ui-border-subtle));
  border-left-color: var(--approval-tone);
  background: var(--ui-bg-elevated, #1e1b2e);
  box-shadow:
    3px 3px 0 color-mix(in srgb, var(--approval-tone) 22%, transparent),
    6px 6px 0 rgba(0, 0, 0, 0.32);
}

[data-theme='dark'] .approval-card__header {
  background: var(--approval-soft);
}

[data-theme='dark'] .approval-card__reason {
  color: var(--ui-text-primary, #f1f5f9);
}

[data-theme='dark'] .approval-card__command,
[data-theme='dark'] .approval-card__details,
[data-theme='dark'] .approval-card__message {
  background: color-mix(in srgb, var(--ui-bg-primary, #11121c) 88%, #000 12%);
}

[data-theme='dark'] .approval-card__command {
  background: color-mix(in srgb, var(--approval-tone) 7%, var(--ui-bg-primary, #11121c));
}

@keyframes approval-blink {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .approval-card,
  .approval-card__risk i {
    animation: none;
    transition: none;
  }
}
</style>
