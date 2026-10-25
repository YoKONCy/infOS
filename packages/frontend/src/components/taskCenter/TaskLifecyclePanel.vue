<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import './task-pixel.css'
import { ref, watch, onUnmounted } from 'vue'
import type { TaskControlInput } from '@infos/shared'
import type { BackgroundTaskInfo } from '../../api/modules/backgroundTasksApi'
import { backgroundTasksApi } from '../../api/modules/backgroundTasksApi'
import PButton from '../pixel/PButton.vue'
import TodoPlanCard from '../chat/TodoPlanCard.vue'
import { useDesktopControl } from '../../composables/useDesktopControl'
const desktop = useDesktopControl()

const props = defineProps<{ task: BackgroundTaskInfo }>()
const emit = defineEmits<{ updated: [] }>()
const busy = ref(false)
const error = ref('')
const instruction = ref('')
const criteria = ref('')
const confirmed = ref(false)
const deadline = ref('')
const readOnly = ref(false)
const budgetSegments = ref(48)
const budgetLlm = ref(192)
const budgetTools = ref(768)
const editing = ref(false)
let draftRevision = 1
const deliveries = ref<
  Array<{ id: string; channel: string; status: string; attempts: number; lastError: string | null }>
>([])
const deliveryError = ref(false)
let generation = 0
watch(
  () => [props.task.id, props.task.revision],
  (value, previous) => {
    if (value[0] !== previous?.[0]) {
      editing.value = false
      error.value = ''
    }
    confirmed.value = false
    if (!editing.value) resetDraft()
  },
  { immediate: true },
)
function resetDraft(): void {
  draftRevision = props.task.revision ?? 1
  instruction.value = props.task.instruction
  criteria.value = props.task.lifecycle?.successCriteria ?? ''
  budgetSegments.value = props.task.lifecycle?.maxSegments ?? 48
  budgetLlm.value = props.task.lifecycle?.maxLlmCalls ?? 192
  budgetTools.value = props.task.lifecycle?.maxToolCalls ?? 768
  readOnly.value = props.task.lifecycle?.recovery === 'read_only'
  const date = props.task.lifecycle?.deadline ? new Date(props.task.lifecycle.deadline) : null
  deadline.value = date
    ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : ''
}
function toggleEditing(event: Event): void {
  const open = (event.target as HTMLDetailsElement).open
  if (open && !editing.value) resetDraft()
  editing.value = open
}
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
async function loadDeliveries() {
  const sequence = ++generation
  clearTimeout(timer)
  try {
    const result = await backgroundTasksApi.deliveries(props.task.id)
    if (sequence === generation) {
      deliveries.value = result.data ?? []
      deliveryError.value = false
    }
  } catch {
    if (sequence === generation) deliveryError.value = true
  } finally {
    if (
      !disposed &&
      sequence === generation &&
      (!deliveries.value.length ||
        deliveries.value.some((item) => ['pending', 'sending'].includes(item.status)))
    )
      timer = setTimeout(() => void loadDeliveries(), 5000)
  }
}
watch(
  () => [props.task.id, props.task.updatedAt],
  (value, previous) => {
    if (value[0] !== previous?.[0]) deliveries.value = []
    void loadDeliveries()
  },
  { immediate: true },
)
onUnmounted(() => {
  disposed = true
  generation++
  clearTimeout(timer)
})

async function control(action: TaskControlInput['action']) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (action === 'resume' && props.task.lifecycle?.pendingEffect && !confirmed.value)
      throw new Error(__t('ui.taskCenter', '请先核验上一次动作的执行结果'))
    if (
      action === 'resume' &&
      desktop.supported &&
      (desktop.state.value.taskId === props.task.id ||
        /DESKTOP_/.test(props.task.errorMessage || '')) &&
      ['paused', 'unavailable'].includes(desktop.state.value.phase)
    ) {
      if (!(await desktop.control('resume'))) throw new Error(desktop.error.value)
    }
    await backgroundTasksApi.control(props.task.agentId, {
      action,
      taskId: props.task.id,
      expectedRevision: action === 'update' ? draftRevision : (props.task.revision ?? 1),
      ...(action === 'update'
        ? {
            instruction: instruction.value,
            successCriteria: criteria.value,
            maxSegments: budgetSegments.value,
            maxLlmCalls: budgetLlm.value,
            maxToolCalls: budgetTools.value,
            recovery: readOnly.value ? 'read_only' : 'confirm',
            ...(deadline.value ? { deadline: new Date(deadline.value).toISOString() } : {}),
          }
        : {}),
      ...(action === 'resume' ? { confirmUncertain: confirmed.value } : {}),
    })
    if (action === 'update') editing.value = false
    emit('updated')
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : __t('ui.taskCenter', '操作失败，请刷新后重试')
  } finally {
    busy.value = false
  }
}

async function resolveDelivery(id: string, decision: 'sent' | 'retry') {
  if (busy.value) return
  busy.value = true
  try {
    await backgroundTasksApi.resolveDelivery(props.task.id, id, decision)
    await loadDeliveries()
    emit('updated')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : __t('ui.taskCenter', '投递操作失败')
  } finally {
    busy.value = false
  }
}
const deliveryLabels: Record<string, string> = {
  get pending() {
    return __t('ui.taskCenter', '待投递')
  },
  get sending() {
    return __t('ui.taskCenter', '发送中')
  },
  get sent() {
    return __t('ui.taskCenter', '已送达')
  },
  get uncertain() {
    return __t('ui.taskCenter', '送达待核验')
  },
  get failed() {
    return __t('ui.taskCenter', '投递失败')
  },
  get superseded() {
    return __t('ui.taskCenter', '已失效')
  },
}
</script>

<template>
  <section v-if="task.lifecycle" class="task-lifecycle task-pixel-surface">
    <p v-if="task.lifecycle.successCriteria">
      <span>{{ __t('ui.taskCenter', '完成条件') }}</span>
      {{ task.lifecycle.successCriteria }}
    </p>
    <p v-if="task.lifecycle.continuation">
      <span>{{ __t('ui.taskCenter', '当前交接') }}</span>
      {{ task.lifecycle.continuation }}
    </p>
    <TodoPlanCard v-if="task.plan" :plan="task.plan" :dismissible="false" />
    <ol v-else-if="task.lifecycle.plan.length">
      <li v-for="(step, index) in task.lifecycle.plan" :key="index">
        <span>{{ step.done ? '✓' : '·' }}</span>
        {{ step.title }}
      </li>
    </ol>
    <p v-if="task.lifecycle.wait">
      <span>{{ __t('ui.taskCenter', '等待') }}</span>
      {{
        task.lifecycle.wait.kind === 'time'
          ? new Date(task.lifecycle.wait.key).toLocaleString()
          : task.lifecycle.wait.kind === 'task'
            ? __t('ui.taskCenter', '关联任务 {0}', [task.lifecycle.wait.key])
            : __t('ui.taskCenter', '你的决定')
      }}
    </p>
    <p v-if="task.status === 'completed'">
      <span>{{ __t('ui.taskCenter', '结果依据') }}</span>
      {{
        task.lifecycle.verification === 'evidence_available'
          ? __t('ui.taskCenter', '有工具记录可查')
          : task.lifecycle.verification === 'reported'
            ? __t('ui.taskCenter', '执行器已交付')
            : __t('ui.taskCenter', '未核验')
      }}
    </p>
    <details v-if="task.lifecycle.evidence.length || task.lifecycle.artifacts.length">
      <summary>{{ __t('ui.taskCenter', '查看依据与产出') }}</summary>
      <ul>
        <li v-for="item in task.lifecycle.evidence" :key="item.toolCallId">
          {{ item.description }} · {{ item.toolCallId }}
        </li>
        <li v-for="item in task.lifecycle.artifacts" :key="item">{{ item }}</li>
      </ul>
    </details>
    <p class="lifecycle-muted">
      {{ __t('ui.taskCenter', '已执行') }} {{ task.lifecycle.segments }}
      {{ __t('ui.taskCenter', '段 · 模型') }} {{ task.lifecycle.usage.llmCalls }}/{{
        task.lifecycle.maxLlmCalls
      }}
      {{ __t('ui.taskCenter', '· 工具') }} {{ task.lifecycle.usage.toolCalls }}/{{
        task.lifecycle.maxToolCalls
      }}
    </p>
    <template v-if="!['completed', 'cancelled'].includes(task.status)">
      <label v-if="task.lifecycle.pendingEffect">
        <input v-model="confirmed" type="checkbox" :disabled="busy" />
        {{
          __t('ui.taskCenter', '我已核验「{0}」的执行结果', [task.lifecycle.pendingEffect.toolName])
        }}
      </label>
      <PButton
        v-if="['blocked', 'paused', 'failed', 'waiting'].includes(task.status)"
        size="sm"
        :disabled="busy || (!!task.lifecycle.pendingEffect && !confirmed)"
        @click="control('resume')"
      >
        {{ __t('ui.taskCenter', '继续任务') }}
      </PButton>
      <details :open="editing" @toggle="toggleEditing">
        <summary>{{ __t('ui.taskCenter', '调整任务') }}</summary>
        <label>
          {{ __t('ui.taskCenter', '任务要求') }}
          <textarea v-model="instruction" rows="3" maxlength="4000" :disabled="busy" />
        </label>
        <label>
          {{ __t('ui.taskCenter', '完成条件') }}
          <textarea v-model="criteria" rows="2" maxlength="2000" :disabled="busy" />
        </label>
        <label>
          {{ __t('ui.taskCenter', '截止时间') }}
          <input v-model="deadline" type="datetime-local" :disabled="busy" />
        </label>
        <label>
          <input v-model="readOnly" type="checkbox" :disabled="busy" />
          {{ __t('ui.taskCenter', '仅查询与读取，重启后自动继续') }}
        </label>
        <div class="lifecycle-budgets">
          <label>
            {{ __t('ui.taskCenter', '执行段上限') }}
            <input v-model.number="budgetSegments" type="number" min="1" max="1000" />
          </label>
          <label>
            {{ __t('ui.taskCenter', '模型调用上限') }}
            <input v-model.number="budgetLlm" type="number" min="1" max="10000" />
          </label>
          <label>
            {{ __t('ui.taskCenter', '工具调用上限') }}
            <input v-model.number="budgetTools" type="number" min="1" max="50000" />
          </label>
        </div>
        <PButton size="sm" :disabled="busy || !instruction.trim()" @click="control('update')">
          {{ __t('ui.taskCenter', '保存调整') }}
        </PButton>
      </details>
    </template>
    <details v-if="deliveries.length" open class="lifecycle-deliveries">
      <summary>{{ __t('ui.taskCenter', '结果投递') }}</summary>
      <div v-for="item in deliveries" :key="item.id" class="delivery-item">
        <span>
          {{
            item.channel === 'social'
              ? __t('ui.taskCenter', '来源会话')
              : item.channel === 'chat'
                ? __t('ui.taskCenter', '主应用对话')
                : item.channel === 'resume'
                  ? __t('ui.taskCenter', '会话接续')
                  : __t('ui.taskCenter', '应用通知')
          }}
          ·
          {{
            item.status === 'sent'
              ? item.channel === 'app'
                ? __t('ui.taskCenter', '已记录')
                : item.channel === 'resume'
                  ? __t('ui.taskCenter', '已加入处理队列')
                  : __t('ui.taskCenter', '已发送')
              : (deliveryLabels[item.status] ?? item.status)
          }}
        </span>
        <small v-if="item.lastError">{{ item.lastError }}</small>
        <small v-if="item.attempts > 1">
          {{ __t('ui.taskCenter', '已尝试 {0} 次', [item.attempts]) }}
        </small>
        <div v-if="item.status === 'uncertain'">
          <PButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="resolveDelivery(item.id, 'sent')"
          >
            {{ __t('ui.taskCenter', '已送达') }}
          </PButton>
          <PButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="resolveDelivery(item.id, 'retry')"
          >
            {{ __t('ui.taskCenter', '确认未送达，重发') }}
          </PButton>
        </div>
      </div>
    </details>
    <p v-if="deliveryError" class="lifecycle-muted" role="status">
      {{ __t('ui.taskCenter', '投递状态暂时无法读取，正在重试。') }}
    </p>
    <p v-if="error" role="alert" class="lifecycle-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.task-lifecycle {
  display: grid;
  gap: 12px;
  color: var(--ui-text-primary);
  font-size: 13px;
  font-family: var(--ui-font-sans);
}
p {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
p > span {
  display: block;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  margin-bottom: 5px;
}
ol,
ul {
  margin: 0;
  padding-left: 20px;
}
li {
  padding-block: 3px;
  overflow-wrap: anywhere;
}
li > span {
  margin-right: 7px;
}
summary {
  cursor: pointer;
  color: var(--ui-text-secondary);
  padding-block: 6px;
}
label {
  display: grid;
  gap: 6px;
  margin-block: 8px;
  color: var(--ui-text-secondary);
}
label:has(input[type='checkbox']) {
  display: flex;
  align-items: center;
}
textarea,
input[type='number'],
input[type='datetime-local'] {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  padding: 8px;
  font: inherit;
  box-shadow: var(--task-inset);
}
textarea:focus-visible,
input:focus-visible {
  outline: 1px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.lifecycle-budgets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.lifecycle-muted,
small {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.delivery-item {
  display: grid;
  gap: 5px;
  padding-block: 8px;
  border-left: 2px solid var(--ui-accent-sky);
  padding: 8px 10px;
  background: var(--ui-bg-hover);
  margin-top: 7px;
  border-radius: var(--ui-radius-xs);
}
.lifecycle-error {
  color: var(--ui-danger);
}
</style>
