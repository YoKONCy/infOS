<script setup lang="ts">
/** 一块规则的正文：和预设里对应的区块是同一份，点一次保存就生效。编辑框里不出现模板标记。 */
import { computed } from 'vue'
import { t as __t } from '../../i18n/index'
import { PButton } from '../pixel'
import {
  countRuleChars,
  ruleBodyToText,
  ruleTextToBody,
  type useExpressionRules,
} from './useExpressionRules'

const props = defineProps<{
  documentId: string
  title: string
  hint: string
  rules: ReturnType<typeof useExpressionRules>
}>()

const current = computed(() => props.rules.documentOf(props.documentId))
const body = computed({
  get: () => ruleBodyToText(current.value?.body ?? ''),
  set: (value: string) => {
    if (current.value) current.value.body = ruleTextToBody(value, current.value.body)
  },
})
const preset = computed(() => props.rules.presetBlock(props.documentId))
const rawMarks = computed(() => /\{\{|\{%|\{#/.test(body.value))
const changed = computed(() => props.rules.hasChanges(props.documentId))
const blocked = computed(() => props.rules.blocked.value)
</script>

<template>
  <section class="expr-tune__surface" :data-expression-rule-block="documentId">
    <div class="expr-tune__row expr-tune__row--apart">
      <div class="expr-tune__row">
        <h3 class="expr-tune__title">{{ title }}</h3>
        <span class="expr-tune__chip" :class="{ changed }">
          {{ changed ? __t('ui.chat', '还没生效') : __t('ui.chat', '已生效') }}
        </span>
        <span class="expr-tune__meta">
          {{ __t('ui.chat', '{0} 字', [countRuleChars(current?.body ?? '')]) }}
        </span>
        <span v-if="preset" class="expr-tune__meta" data-expression-rule-preset>
          {{
            preset.enabled
              ? __t('ui.chat', '预设里的「{0}」', [preset.name])
              : __t('ui.chat', '预设里的「{0}」已关闭，不会发送', [preset.name])
          }}
        </span>
      </div>
      <div class="expr-tune__actions">
        <PButton
          size="sm"
          variant="ghost"
          :disabled="blocked || rules.isDefault(documentId)"
          data-expression-rule-reset
          @click="rules.restoreDefault(documentId)"
        >
          {{ __t('ui.chat', '恢复默认') }}
        </PButton>
        <PButton
          size="sm"
          :disabled="blocked || !current || !changed"
          data-expression-rule-save
          @click="rules.saveRule(documentId)"
        >
          {{ __t('ui.chat', '保存') }}
        </PButton>
      </div>
    </div>
    <p class="expr-tune__hint">{{ hint }}</p>
    <slot />
    <textarea
      v-if="current"
      v-model="body"
      class="expr-tune__editor"
      spellcheck="false"
      :aria-label="title"
      :disabled="blocked"
      data-expression-rule-editor
      @keydown.ctrl.s.prevent="changed && rules.saveRule(documentId)"
    />
    <p v-else class="expr-tune__banner" role="status">
      {{ __t('ui.chat', '这一块在当前版本里找不到，更新后才能修改。') }}
    </p>
    <p class="expr-tune__meta">
      {{ __t('ui.chat', '〔〕里的内容发送时会换成实际内容或条件，改字时留着。') }}
      <template v-if="rawMarks">{{ __t('ui.chat', '花括号标记也别删。') }}</template>
      <template v-if="rules.hasPreset.value && !preset">
        {{ __t('ui.chat', '请在使用的提示词框架中引用此组件。') }}
      </template>
    </p>
  </section>
</template>
