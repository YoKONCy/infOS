<script setup lang="ts">
/** 说话手册：她自己学到的规律，能改、能删、能手动加、能退回之前的版本。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t as __t, getDisplayLocale } from '../../i18n/index'
import { PBadge, PButton, PEmpty, PInputNumber, PSwitch, PTextarea } from '../pixel'
import MotionSkeleton from '../motion/MotionSkeleton.vue'
import {
  HANDBOOK_CHARS,
  LEARNING_IDLE_MINUTES,
  type ExpressionLearningRecord,
  type HandbookRule,
  type HandbookVersion,
} from './expressionTypes'
import type { ExpressionHandbookState, ExpressionSettingsState } from './useExpressionData'

const MANUAL_QUOTE = '手动添加'

const props = defineProps<{
  handbook: ExpressionHandbookState
  control: ExpressionSettingsState
}>()

const draft = ref('')
const editingId = ref<string | null>(null)
const editText = ref('')
const confirmingId = ref<string | null>(null)

const used = computed(() => props.handbook.usedChars.value ?? 0)
const settings = computed(() => props.control.settings.value)
const limit = computed(() => settings.value?.handbookMaxChars ?? props.handbook.maxChars.value ?? 0)
const busy = computed(() => props.handbook.busy.value)

const formatTime = (value: number) => new Date(value).toLocaleString(getDisplayLocale())
const formatClock = (value: number) =>
  new Date(value).toLocaleTimeString(getDisplayLocale(), { hour: '2-digit', minute: '2-digit' })

const STATUS_POLL_MS = 5000
let statusTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void props.handbook.loadLearning()
  statusTimer = setInterval(() => void props.handbook.loadLearning(), STATUS_POLL_MS)
})
onBeforeUnmount(() => {
  if (statusTimer) clearInterval(statusTimer)
})

const learning = computed(() => props.handbook.learning.value)
const statusText = computed(() => {
  const status = learning.value
  if (!status) return ''
  const when = status.nextAt ? formatClock(status.nextAt) : ''
  switch (status.state) {
    case 'learning':
      return __t('ui.chat', '她正在学，模型在回答。')
    case 'waiting':
      return __t('ui.chat', '有 {0} 条等着学，大约 {1} 开始。', [status.pending, when])
    case 'retrying':
      return status.attempts
        ? __t('ui.chat', '刚才没学成，{0} 再试（已失败 {1} 次）。', [when, status.attempts])
        : __t('ui.chat', '手册刚被改过，马上按新手册重学。')
    case 'paused':
      return __t('ui.chat', '自动学习关着，有 {0} 条等你打开。', [status.pending])
    default:
      return __t('ui.chat', '现在没有要学的内容。')
  }
})
function recordResult(record: ExpressionLearningRecord): string {
  if (record.status === 'pending') return __t('ui.chat', '等着学')
  switch (record.outcome) {
    case 'learned':
      return record.ruleTexts.length
        ? __t('ui.chat', '学到：{0}', [record.ruleTexts.join('；')])
        : __t('ui.chat', '学到过，那条规则后来被删或被合并了')
    case 'scored':
      return __t('ui.chat', '给已有规则加减了分')
    case 'nothing':
      return __t('ui.chat', '没学：模型觉得这条没有通用规律')
    case 'low_confidence':
      return __t('ui.chat', '没学：模型把握不够')
    case 'evidence':
      return __t('ui.chat', '没学：引用对不上你的原话')
    case 'forbidden':
      return __t('ui.chat', '没学：涉及权限或安全这类内容')
    case 'full':
      return __t('ui.chat', '没学：手册放不下了')
    case 'no_rule':
      return __t('ui.chat', '没学：没写批注，手册里也没有规则可加减分')
    case 'model_failed':
      return __t('ui.chat', '没学成：模型连不上或回复不完整')
    case 'error':
      return __t('ui.chat', '没学成：处理时出错了')
    case 'rejected':
      return __t('ui.chat', '没学：模型给的内容不合格')
    default:
      return record.status === 'failed'
        ? __t('ui.chat', '没学成：处理时出错了')
        : __t('ui.chat', '已处理（旧记录没有写明结果）')
  }
}
/** 记录多了不能从头翻：按结果分组，一次只看一组的几条。 */
type RecordGroup = 'attention' | 'learned' | 'skipped' | 'all'
const RECORD_PAGE = 10
const chosenGroup = ref<RecordGroup | null>(null)
const shownRecords = ref(RECORD_PAGE)
function groupOf(record: ExpressionLearningRecord): Exclude<RecordGroup, 'all'> | null {
  if (record.status === 'pending' || record.status === 'failed') return 'attention'
  if (record.outcome === 'model_failed' || record.outcome === 'error') return 'attention'
  if (record.outcome === 'learned' || record.outcome === 'scored') return 'learned'
  // 旧记录没写结果，看了也没用，只放在「全部」里。
  return record.outcome ? 'skipped' : null
}
const recordGroups = computed(() => {
  const records = learning.value?.recent ?? []
  const count = (group: RecordGroup) =>
    group === 'all' ? records.length : records.filter((record) => groupOf(record) === group).length
  return [
    { id: 'attention', label: __t('ui.chat', '要留意'), count: count('attention') },
    { id: 'learned', label: __t('ui.chat', '学到的'), count: count('learned') },
    { id: 'skipped', label: __t('ui.chat', '没学的'), count: count('skipped') },
    { id: 'all', label: __t('ui.chat', '全部'), count: count('all') },
  ] as Array<{ id: RecordGroup; label: string; count: number }>
})
/** 没选过时先看要留意的，没有就看学到的。 */
const activeGroup = computed<RecordGroup>(
  () => chosenGroup.value ?? (recordGroups.value[0]!.count ? 'attention' : 'learned'),
)
const groupRecords = computed(() =>
  (learning.value?.recent ?? []).filter(
    (record) => activeGroup.value === 'all' || groupOf(record) === activeGroup.value,
  ),
)
function chooseGroup(group: RecordGroup): void {
  chosenGroup.value = group
  shownRecords.value = RECORD_PAGE
}
function recordTitle(record: ExpressionLearningRecord): string {
  if (record.text) return record.text
  return record.reply
    ? __t('ui.chat', '整条标记：「{0}」', [record.reply])
    : __t('ui.chat', '整条标记，没写批注')
}
function sourceLabel(rule: HandbookRule): string {
  if (rule.source.kind === 'mark') return __t('ui.chat', '来自批注')
  return rule.source.quote === MANUAL_QUOTE
    ? __t('ui.chat', '手动添加')
    : __t('ui.chat', '来自聊天里的纠正')
}
function reasonLabel(version: HandbookVersion): string {
  return {
    learn: __t('ui.chat', '她学到的'),
    manual: __t('ui.chat', '手动改的'),
    rollback: __t('ui.chat', '退回的'),
  }[version.reason]
}
function startEdit(rule: HandbookRule): void {
  editingId.value = rule.id
  editText.value = rule.text
}
async function submitEdit(rule: HandbookRule): Promise<void> {
  const text = editText.value.trim()
  if (text && (await props.handbook.update(rule.id, text))) editingId.value = null
}
async function submitNew(): Promise<void> {
  const text = draft.value.trim()
  if (text && (await props.handbook.add(text))) draft.value = ''
}
/** 和批注列表一样，删除和回退都要点第二下才执行。 */
function confirmThen(id: string, action: () => unknown): void {
  if (confirmingId.value !== id) {
    confirmingId.value = id
    return
  }
  confirmingId.value = null
  void action()
}
function setLimit(value: number | null): void {
  if (value === null) return
  props.control.patchLater({
    handbookMaxChars: Math.min(Math.max(value, HANDBOOK_CHARS.min), HANDBOOK_CHARS.max),
  })
}
function setIdle(value: number | null): void {
  if (value === null) return
  props.control.patchLater({
    learningIdleMinutes: Math.min(
      Math.max(value, LEARNING_IDLE_MINUTES.min),
      LEARNING_IDLE_MINUTES.max,
    ),
  })
}
function restoreSettings(): void {
  props.control.patch({
    learningEnabled: true,
    learningIdleMinutes: LEARNING_IDLE_MINUTES.fallback,
    handbookMaxChars: HANDBOOK_CHARS.fallback,
  })
}
</script>

<template>
  <section class="expr-tune__surface" data-expression-handbook>
    <div class="expr-tune__row">
      <h3 class="expr-tune__title">{{ __t('ui.chat', '说话手册') }}</h3>
      <PBadge size="sm">{{ __t('ui.chat', '她自己学的') }}</PBadge>
      <span class="expr-tune__meta" data-expression-handbook-used>
        {{ __t('ui.chat', '已用 {0} / {1} 字', [used, limit]) }}
      </span>
    </div>
    <p class="expr-tune__hint">
      {{ __t('ui.chat', '学出的习惯由角色共享，可直接编辑或删除。') }}
      {{ __t('ui.chat', '你批注完停手一会儿，她才把这一批一起学，最多等 30 分钟。') }}
      {{ __t('ui.chat', '用哪个模型来学，在「模型配置 → 任务指派」的「学说话习惯」里指定。') }}
    </p>

    <p v-if="handbook.missing.value" class="expr-tune__banner" role="status">
      {{ __t('ui.chat', '当前后端版本还不支持表达层，更新后端后这里才能使用。') }}
    </p>
    <div v-else-if="handbook.failed.value" class="expr-tune__banner expr-tune__row" role="alert">
      {{ __t('ui.chat', '读取失败') }}
      <PButton size="sm" variant="ghost" @click="handbook.load">
        {{ __t('ui.chat', '重试') }}
      </PButton>
    </div>
    <template v-else>
      <p
        v-if="handbook.learningFailures.value"
        class="expr-tune__banner"
        role="status"
        data-expression-learning-failures
      >
        {{
          __t('ui.chat', '最近 7 天有 {0} 次没学成，多半是模型没连上。', [
            handbook.learningFailures.value,
          ])
        }}
      </p>
      <details v-if="learning" class="expr-tune__item" data-expression-learning-status>
        <summary>
          {{ __t('ui.chat', '学习状态') }}：<span data-expression-learning-state>{{ statusText }}</span>
        </summary>
        <p v-if="!learning.recent.length" class="expr-tune__meta">
          {{ __t('ui.chat', '还没有学习记录。') }}
        </p>
        <template v-else>
        <div class="expr-tune__row" data-expression-record-groups>
          <PButton
            v-for="group in recordGroups"
            :key="group.id"
            size="sm"
            :variant="activeGroup === group.id ? 'secondary' : 'ghost'"
            :aria-pressed="activeGroup === group.id"
            :data-expression-record-group="group.id"
            @click="chooseGroup(group.id)"
          >
            {{ group.label }} {{ group.count }}
          </PButton>
        </div>
        <p v-if="!groupRecords.length" class="expr-tune__meta">
          {{ __t('ui.chat', '这一类最近没有。') }}
        </p>
        <ul v-else class="expr-tune__list">
          <li
            v-for="record in groupRecords.slice(0, shownRecords)"
            :key="record.id"
            class="expr-tune__item"
            data-expression-learning-record
          >
            <p>{{ recordTitle(record) }}</p>
            <p class="expr-tune__meta">
              {{ record.kind === 'chat' ? __t('ui.chat', '聊天里说的') : __t('ui.chat', '批注') }}
              · {{ formatTime(record.at) }} · {{ recordResult(record) }}
            </p>
          </li>
        </ul>
        <div v-if="groupRecords.length > shownRecords" class="expr-tune__actions">
          <PButton
            size="sm"
            variant="ghost"
            data-expression-record-more
            @click="shownRecords += RECORD_PAGE"
          >
            {{ __t('ui.chat', '再看 {0} 条（还有 {1} 条）', [RECORD_PAGE, groupRecords.length - shownRecords]) }}
          </PButton>
        </div>
        </template>
      </details>
      <div v-if="settings" class="expr-tune__row">
        <PSwitch
          :model-value="settings.learningEnabled"
          :label="__t('ui.chat', '让她自己学')"
          data-expression-learning
          @update:model-value="control.patch({ learningEnabled: $event })"
        />
        <div class="expr-tune__number">
          <PInputNumber
            :model-value="settings.handbookMaxChars"
            :label="__t('ui.chat', '手册字数上限')"
            :min="HANDBOOK_CHARS.min"
            :max="HANDBOOK_CHARS.max"
            :step="100"
            @update:model-value="setLimit"
          />
        </div>
        <div class="expr-tune__number">
          <PInputNumber
            :model-value="settings.learningIdleMinutes"
            :label="__t('ui.chat', '停手几分钟后学')"
            :min="LEARNING_IDLE_MINUTES.min"
            :max="LEARNING_IDLE_MINUTES.max"
            @update:model-value="setIdle"
          />
        </div>
        <PButton
          size="sm"
          variant="secondary"
          :disabled="busy || !settings.learningEnabled"
          data-expression-learn-now
          @click="handbook.learnNow"
        >
          {{ __t('ui.chat', '现在就学') }}
        </PButton>
        <PButton size="sm" variant="ghost" @click="restoreSettings">
          {{ __t('ui.chat', '恢复默认') }}
        </PButton>
      </div>

      <MotionSkeleton
        v-if="handbook.loading.value && !handbook.rules.value.length"
        variant="list"
      />
      <PEmpty
        v-else-if="!handbook.rules.value.length"
        :show-paw="false"
        :description="__t('ui.chat', '手册还是空的。在聊天里标人机、写批注，她就会开始学。')"
      />
      <ul v-else class="expr-tune__list">
        <li
          v-for="rule in handbook.rules.value"
          :key="rule.id"
          class="expr-tune__item"
          :data-expression-handbook-rule="rule.id"
        >
          <template v-if="editingId === rule.id">
            <PTextarea v-model="editText" :rows="3" />
            <div class="expr-tune__actions">
              <PButton size="sm" variant="ghost" @click="editingId = null">
                {{ __t('ui.chat', '取消') }}
              </PButton>
              <PButton size="sm" :disabled="busy" @click="submitEdit(rule)">
                {{ __t('ui.chat', '保存') }}
              </PButton>
            </div>
          </template>
          <template v-else>
            <p>{{ rule.text }}</p>
            <p class="expr-tune__meta">
              {{ sourceLabel(rule) }}
              <template v-if="rule.source.quote && rule.source.quote !== MANUAL_QUOTE">
                ：「{{ rule.source.quote }}」
              </template>
              · {{ formatTime(rule.updatedAt) }}
            </p>
            <div class="expr-tune__actions">
              <PButton size="sm" variant="ghost" @click="startEdit(rule)">
                {{ __t('ui.chat', '修改') }}
              </PButton>
              <PButton
                size="sm"
                variant="danger"
                :disabled="busy"
                data-expression-handbook-delete
                @click="confirmThen(rule.id, () => handbook.remove(rule.id))"
                @blur="confirmingId = null"
              >
                {{ confirmingId === rule.id ? __t('ui.chat', '确认删除') : __t('ui.chat', '删除') }}
              </PButton>
            </div>
          </template>
        </li>
      </ul>

      <div class="expr-tune__item">
        <PTextarea
          v-model="draft"
          :rows="2"
          :label="__t('ui.chat', '自己加一条')"
          :placeholder="__t('ui.chat', '比如：先说结论，再说理由')"
        />
        <div class="expr-tune__actions">
          <PButton
            size="sm"
            variant="secondary"
            :disabled="busy || !draft.trim()"
            data-expression-handbook-add
            @click="submitNew"
          >
            {{ __t('ui.chat', '加入手册') }}
          </PButton>
        </div>
      </div>

      <details class="expr-tune__item" data-expression-handbook-versions>
        <summary>
          {{ __t('ui.chat', '之前的版本（{0}）', [handbook.versions.value.length]) }}
        </summary>
        <p v-if="!handbook.versions.value.length" class="expr-tune__meta">
          {{ __t('ui.chat', '还没有记录。') }}
        </p>
        <ul v-else class="expr-tune__list">
          <li v-for="version in handbook.versions.value" :key="version.id" class="expr-tune__item">
            <p>{{ version.summary }}</p>
            <p class="expr-tune__meta">
              {{ reasonLabel(version) }} · {{ formatTime(version.createdAt) }}
            </p>
            <div class="expr-tune__actions">
              <PButton
                size="sm"
                variant="ghost"
                :disabled="busy"
                @click="confirmThen(version.id, () => handbook.restore(version.id))"
                @blur="confirmingId = null"
              >
                {{
                  confirmingId === version.id
                    ? __t('ui.chat', '确认退回')
                    : __t('ui.chat', '退回到这里')
                }}
              </PButton>
            </div>
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>
