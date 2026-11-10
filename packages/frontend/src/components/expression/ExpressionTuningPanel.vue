<script setup lang="ts">
/**
 * ExpressionTuningPanel — 「提示词 → 表达调教」整页。
 *
 * 顶部一条流程：她这一轮按顺序读到什么，点哪块看哪块。规则块改的是提示词草稿里的同一份组件；
 * 手册和开关存在表达层，改完马上生效。接口缺失时各块自己显示「后端还不支持」。
 */
import { computed, onMounted, ref } from 'vue'
import { t as __t } from '../../i18n/index'
import { useAgentStore } from '../../stores/useAgentStore'
import { PBadge, PButton, PDialog, PSelect, PixelIcon } from '../pixel'
import MotionSkeleton from '../motion/MotionSkeleton.vue'
import ExpressionHandbookBlock from './ExpressionHandbookBlock.vue'
import ExpressionMarksPanel from './ExpressionMarksPanel.vue'
import ExpressionMaterialsBlock from './ExpressionMaterialsBlock.vue'
import ExpressionPreviewBlock from './ExpressionPreviewBlock.vue'
import ExpressionRuleBlock from './ExpressionRuleBlock.vue'
import { useExpressionHandbook, useExpressionSettings } from './useExpressionData'
import {
  RULE_KEYS,
  countRuleChars,
  ruleDocumentId,
  useExpressionRules,
  type ExpressionWorkspace,
  type RuleKey,
} from './useExpressionRules'
import './expressionTuning.css'

type BlockKey = RuleKey | 'handbook' | 'materials' | 'marks' | 'preview'

const props = defineProps<{ workspace: ExpressionWorkspace }>()

const agentStore = useAgentStore()
const agentId = ref(agentStore.activeAgentId)
const active = ref<BlockKey>('thinking')

const rules = useExpressionRules(props.workspace)
const control = useExpressionSettings(agentId)
const handbook = useExpressionHandbook(agentId)

const agentOptions = computed(() => {
  const options = agentStore.agents.map((agent) => ({
    label: agent.name || agent.id,
    value: agent.id,
  }))
  return options.some((option) => option.value === agentId.value)
    ? options
    : [{ label: agentId.value, value: agentId.value }, ...options]
})

const ruleTexts = computed<Record<RuleKey, { title: string; hint: string }>>(() => ({
  thinking: {
    title: __t('ui.chat', '表达规则'),
    hint: __t('ui.chat', '调整角色回应时的语气与表达习惯。'),
  },
}))

const charsLabel = (value: number) => __t('ui.chat', '{0} 字', [value])
const flow = computed<Array<{ key: BlockKey; label: string; chars: string; tag: string }>>(() => {
  const materials = control.settings.value?.materials
  const rule = (key: RuleKey) => ({
    key,
    label: ruleTexts.value[key].title,
    chars: charsLabel(countRuleChars(rules.documentOf(ruleDocumentId(key))?.body ?? '')),
    tag: '',
  })
  return [
    ...RULE_KEYS.slice(0, RULE_KEYS.indexOf('thinking')).map(rule),
    {
      key: 'handbook',
      label: __t('ui.chat', '手册'),
      chars: handbook.usedChars.value === null ? '—' : charsLabel(handbook.usedChars.value),
      tag: __t('ui.chat', '她自己学的'),
    },
    ...RULE_KEYS.slice(RULE_KEYS.indexOf('thinking')).map(rule),
    {
      key: 'materials',
      label: __t('ui.chat', '本轮素材'),
      chars: !materials
        ? '—'
        : materials.enabled
          ? __t('ui.chat', '最多 {0} 字', [materials.maxChars])
          : __t('ui.chat', '已关闭'),
      tag: __t('ui.chat', '程序每轮挑的'),
    },
  ]
})
const extras = computed<Array<{ key: BlockKey; label: string; icon: string }>>(() => [
  { key: 'marks', label: __t('ui.chat', '批注'), icon: 'edit' },
  { key: 'preview', label: __t('ui.chat', '预览'), icon: 'list' },
])
const activeRule = computed(() =>
  (RULE_KEYS as readonly string[]).includes(active.value) ? (active.value as RuleKey) : null,
)
const dialogOpen = computed({
  get: () => Boolean(rules.pending.value),
  set: (open: boolean) => {
    if (!open) rules.cancelPending()
  },
})
const failures = computed(() =>
  props.workspace.issues.value.filter((issue) => issue.level === 'error'),
)

onMounted(async () => {
  if (!agentStore.agents.length) await agentStore.fetchAgents().catch(() => undefined)
  void control.load()
  void handbook.load()
})
</script>

<template>
  <div class="expr-tune" data-expression-tuning>
    <div class="expr-tune__row">
      <div class="expr-tune__agent">
        <PSelect
          v-model="agentId"
          size="sm"
          teleport
          :label="__t('ui.chat', '角色')"
          :options="agentOptions"
        />
      </div>
    </div>

    <nav class="expr-tune__flow" :aria-label="__t('ui.chat', '她这一轮读到什么')">
      <template v-for="(step, index) in flow" :key="step.key">
        <PixelIcon v-if="index" name="chevron-right" size="xs" class="expr-tune__arrow" />
        <button
          type="button"
          class="expr-tune__step"
          :class="{ active: active === step.key }"
          :aria-current="active === step.key ? 'true' : undefined"
          :data-expression-step="step.key"
          @click="active = step.key"
        >
          <span>{{ step.label }}</span>
          <small>{{ step.chars }}</small>
          <PBadge v-if="step.tag" size="sm">{{ step.tag }}</PBadge>
        </button>
      </template>
    </nav>
    <nav class="expr-tune__tabs" :aria-label="__t('ui.chat', '表达调教')">
      <button
        v-for="extra in extras"
        :key="extra.key"
        type="button"
        class="expr-tune__step"
        :class="{ active: active === extra.key }"
        :data-expression-step="extra.key"
        @click="active = extra.key"
      >
        <PixelIcon :name="extra.icon" size="sm" />
        {{ extra.label }}
      </button>
    </nav>

    <ul v-if="failures.length" class="expr-tune__banner" role="alert">
      <li v-for="issue in failures" :key="issue.source + issue.message">
        {{ issue.source }}：{{ issue.message }}
      </li>
    </ul>

    <template v-if="activeRule">
      <MotionSkeleton v-if="!workspace.view.value" variant="text" />
      <ExpressionRuleBlock
        v-else
        :key="activeRule"
        :document-id="ruleDocumentId(activeRule)"
        :title="ruleTexts[activeRule].title"
        :hint="ruleTexts[activeRule].hint"
        :rules="rules"
      />
    </template>
    <ExpressionHandbookBlock
      v-else-if="active === 'handbook'"
      :handbook="handbook"
      :control="control"
    />
    <ExpressionMaterialsBlock v-else-if="active === 'materials'" :control="control" />
    <section v-else-if="active === 'marks'" class="expr-tune__surface">
      <h3 class="expr-tune__title">{{ __t('ui.chat', '批注') }}</h3>
      <p class="expr-tune__hint">
        {{ __t('ui.chat', '批注和原话用于来源会话，学出的手册由角色共享。') }}
      </p>
      <ExpressionMarksPanel :agent-id="agentId" />
    </section>
    <ExpressionPreviewBlock
      v-else-if="active === 'preview'"
      :agent-id="agentId"
      :workspace="workspace"
    />

    <PDialog
      v-model="dialogOpen"
      :title="__t('ui.chat', '草稿里还有别的改动')"
      width="min(580px, calc(100vw - 48px))"
    >
      <p class="expr-tune__hint">
        {{ __t('ui.chat', '发布是整份一起发的，现在发布会把下面这些也一起生效：') }}
      </p>
      <ul data-expression-other-changes>
        <li v-for="item in rules.pending.value?.others" :key="item.id">{{ item.name }}</li>
      </ul>
      <p class="expr-tune__hint">
        {{ __t('ui.chat', '不想一起生效，就先只存草稿，这块改动也不会生效；别的改动都不会丢。') }}
      </p>
      <template #footer>
        <PButton size="sm" variant="ghost" @click="rules.cancelPending">
          {{ __t('ui.chat', '取消') }}
        </PButton>
        <PButton
          size="sm"
          variant="secondary"
          :disabled="rules.blocked.value"
          data-expression-save-draft
          @click="rules.saveDraftOnly"
        >
          {{ __t('ui.chat', '只存草稿') }}
        </PButton>
        <PButton
          size="sm"
          :disabled="rules.blocked.value"
          data-expression-publish-all
          @click="rules.publishAll"
        >
          {{ __t('ui.chat', '一起发布') }}
        </PButton>
      </template>
    </PDialog>
  </div>
</template>
