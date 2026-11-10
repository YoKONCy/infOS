<script setup lang="ts">
/** 本轮素材：程序每轮挑一点相关内容给她，这里决定挑哪些、最多多少字。 */
import { computed } from 'vue'
import { t as __t } from '../../i18n/index'
import { PBadge, PButton, PInputNumber, PSwitch } from '../pixel'
import { MATERIALS_CHARS, type ExpressionMaterials } from './expressionTypes'
import type { ExpressionSettingsState } from './useExpressionData'

const props = defineProps<{ control: ExpressionSettingsState }>()

type MaterialKey = 'notes' | 'goodQuotes' | 'memories' | 'repetition' | 'activity'
const items = computed<Array<{ key: MaterialKey; label: string; hint: string }>>(() => [
  {
    key: 'notes',
    label: __t('ui.chat', '批注'),
    hint: __t('ui.chat', '当前会话中尚未学入手册的反馈。'),
  },
  {
    key: 'goodQuotes',
    label: __t('ui.chat', '对味原话'),
    hint: __t('ui.chat', '当前会话里标过对味的短句。'),
  },
  {
    key: 'memories',
    label: __t('ui.chat', '回忆'),
    hint: __t('ui.chat', '记忆里和这句相关的事。'),
  },
  {
    key: 'repetition',
    label: __t('ui.chat', '口癖提醒'),
    hint: __t('ui.chat', '她最近总重复的词，提醒她换个说法。'),
  },
  {
    key: 'activity',
    label: __t('ui.chat', '正在做的事'),
    hint: __t('ui.chat', '你这会儿在电脑上做什么。'),
  },
])
const materials = computed(() => props.control.settings.value?.materials ?? null)

function set(next: Partial<ExpressionMaterials>): void {
  if (materials.value) props.control.patch({ materials: { ...materials.value, ...next } })
}
function setLimit(value: number | null): void {
  if (value === null || !materials.value) return
  props.control.patchLater({
    materials: {
      ...materials.value,
      maxChars: Math.min(Math.max(value, MATERIALS_CHARS.min), MATERIALS_CHARS.max),
    },
  })
}
function restore(): void {
  set({
    enabled: true,
    notes: true,
    goodQuotes: true,
    memories: true,
    repetition: true,
    activity: true,
    maxChars: MATERIALS_CHARS.fallback,
  })
}
</script>

<template>
  <section class="expr-tune__surface" data-expression-materials>
    <div class="expr-tune__row expr-tune__row--apart">
      <div class="expr-tune__row">
        <h3 class="expr-tune__title">{{ __t('ui.chat', '本轮素材') }}</h3>
        <PBadge size="sm">{{ __t('ui.chat', '程序每轮挑的') }}</PBadge>
      </div>
      <PButton v-if="materials" size="sm" variant="ghost" @click="restore">
        {{ __t('ui.chat', '恢复默认') }}
      </PButton>
    </div>
    <p class="expr-tune__hint">
      {{ __t('ui.chat', '每轮程序挑一点相关内容给她看，没有相关的就不带。') }}
    </p>

    <p v-if="control.missing.value" class="expr-tune__banner" role="status">
      {{ __t('ui.chat', '当前后端版本还不支持表达层，更新后端后这里才能使用。') }}
    </p>
    <div v-else-if="control.failed.value" class="expr-tune__banner expr-tune__row" role="alert">
      {{ __t('ui.chat', '读取失败') }}
      <PButton size="sm" variant="ghost" @click="control.load">
        {{ __t('ui.chat', '重试') }}
      </PButton>
    </div>
    <template v-else-if="materials">
      <div class="expr-tune__row">
        <PSwitch
          :model-value="materials.enabled"
          :label="__t('ui.chat', '带上本轮素材')"
          data-expression-materials-enabled
          @update:model-value="set({ enabled: $event })"
        />
        <div class="expr-tune__number">
          <PInputNumber
            :model-value="materials.maxChars"
            :label="__t('ui.chat', '每轮最多多少字')"
            :min="MATERIALS_CHARS.min"
            :max="MATERIALS_CHARS.max"
            :step="50"
            :disabled="!materials.enabled"
            @update:model-value="setLimit"
          />
        </div>
      </div>
      <ul class="expr-tune__list">
        <li v-for="item in items" :key="item.key" class="expr-tune__item">
          <PSwitch
            :model-value="materials[item.key]"
            :label="item.label"
            :disabled="!materials.enabled"
            :data-expression-material="item.key"
            @update:model-value="set({ [item.key]: $event })"
          />
          <p class="expr-tune__meta">{{ item.hint }}</p>
        </li>
      </ul>
    </template>
  </section>
</template>
