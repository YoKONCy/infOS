<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { HomeSettings } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { homeApi } from '../../../api/modules/homeApi'
import { MotionSkeleton } from '../../motion'
import { PButton, PDialog, PInputNumber, PTextarea } from '../../pixel'
import {
  BLOCKED_TERMS_LIMIT,
  HOME_SETTING_GROUPS,
  displayRange,
  fromDisplay,
  homeUnitLabel,
  parseBlockedTerms,
  toDisplay,
  type HomeSettingField,
} from './homeSettingsFields'
import { homeErrorText } from './homeFormat'

// 后端保险设置：分组编辑草稿，点「保存」只提交改过的字段；「恢复默认」二次确认。
const values = ref<HomeSettings | null>(null)
const defaults = ref<HomeSettings | null>(null)
const draft = ref<Record<string, number | null>>({})
const terms = ref('')
const busy = ref(false)
const error = ref('')
const saved = ref(false)
const confirmReset = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(savedTimer))

function load(settings: HomeSettings) {
  values.value = settings
  const next: Record<string, number | null> = {}
  for (const group of HOME_SETTING_GROUPS)
    for (const field of group.fields) next[field.key] = toDisplay(field, settings[field.key])
  draft.value = next
  terms.value = settings.mapBlockedTerms.join('\n')
}

onMounted(async () => {
  try {
    const data = await homeApi.settings()
    defaults.value = data.defaults
    load(data.values)
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
})

const termList = computed(() => parseBlockedTerms(terms.value))
const termsInvalid = computed(
  () =>
    termList.value.length > BLOCKED_TERMS_LIMIT.items ||
    termList.value.some((term) => term.length > BLOCKED_TERMS_LIMIT.length),
)

/** 只提交与当前值不同的字段。 */
const patch = computed(() => {
  const current = values.value
  if (!current) return {}
  const result: Partial<HomeSettings> = {}
  for (const group of HOME_SETTING_GROUPS)
    for (const field of group.fields) {
      const display = draft.value[field.key]
      if (typeof display !== 'number' || !Number.isFinite(display)) continue
      const raw = fromDisplay(field, display)
      if (raw !== current[field.key]) result[field.key] = raw
    }
  if (termList.value.join('\n') !== current.mapBlockedTerms.join('\n'))
    result.mapBlockedTerms = termList.value
  return result
})
const dirty = computed(() => Object.keys(patch.value).length > 0)
const retentionInvalid = computed(() => {
  const window = patch.value.massChangeWindowMs ?? values.value?.massChangeWindowMs ?? 0
  const retention = patch.value.activityRetentionMs ?? values.value?.activityRetentionMs ?? 0
  return retention < window
})

function defaultText(field: HomeSettingField): string {
  if (!defaults.value) return ''
  return __t('ui.desktop', '默认：{0} {1}', [
    toDisplay(field, defaults.value[field.key]),
    homeUnitLabel(field.unit),
  ])
}

async function save() {
  if (!dirty.value || termsInvalid.value || retentionInvalid.value) return
  busy.value = true
  try {
    load(await homeApi.updateSettings(patch.value))
    error.value = ''
    saved.value = true
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => (saved.value = false), 2000)
  } catch (cause) {
    error.value = homeErrorText(cause)
  } finally {
    busy.value = false
  }
}

async function reset() {
  busy.value = true
  try {
    load(await homeApi.resetSettings())
    error.value = ''
  } catch (cause) {
    error.value = homeErrorText(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="home-safety">
    <p class="home-safety-intro">
      {{
        __t(
          'ui.desktop',
          '她动你的文件和程序时的保护规则。删除前要确认、发消息和付款这类敏感操作每次都问，这些关不掉。改完点「保存」才生效。',
        )
      }}
    </p>
    <MotionSkeleton v-if="!values && !error" variant="card" :rows="2" />
    <template v-if="values">
      <div v-for="group in HOME_SETTING_GROUPS" :key="group.title" class="home-safety-group">
        <h5>{{ group.title }}</h5>
        <div v-for="field in group.fields" :key="field.key" class="home-safety-row">
          <div class="home-safety-text">
            <strong>{{ field.label }}</strong>
            <p>{{ field.hint }}</p>
            <small>{{ defaultText(field) }}</small>
          </div>
          <div class="home-safety-input">
            <PInputNumber
              :model-value="draft[field.key] ?? null"
              @update:model-value="draft[field.key] = $event"
              :min="displayRange(field).min"
              :max="displayRange(field).max"
              :aria-label="field.label"
            />
            <span>{{ homeUnitLabel(field.unit) }}</span>
          </div>
        </div>
      </div>
      <div class="home-safety-group">
        <h5>{{ __t('ui.desktop', '地图隐私') }}</h5>
        <div class="home-safety-row">
          <div class="home-safety-text">
            <strong>{{ __t('ui.desktop', '地图里不记的词') }}</strong>
            <p>
              {{
                __t(
                  'ui.desktop',
                  '含这些词的条目不会记进地图。一行一个，不分大小写；密码、账号这类信息本来就不会记。',
                )
              }}
            </p>
          </div>
        </div>
        <PTextarea v-model="terms" :rows="3" :aria-label="__t('ui.desktop', '地图里不记的词')" />
        <p v-if="termsInvalid" role="alert" class="home-error">
          {{ __t('ui.desktop', '最多 100 个词，每个不超过 128 字') }}
        </p>
      </div>
      <p v-if="retentionInvalid" role="alert" class="home-error">
        {{ __t('ui.desktop', '「活动记录留多久」不能比「一次」的时长还短。') }}
      </p>
      <div class="home-actions">
        <PButton
          size="sm"
          :disabled="!dirty || termsInvalid || retentionInvalid"
          :loading="busy"
          @click="save"
        >
          {{ __t('ui.desktop', '保存') }}
        </PButton>
        <PButton size="sm" variant="secondary" :disabled="busy" @click="confirmReset = true">
          {{ __t('ui.desktop', '恢复默认') }}
        </PButton>
        <Transition name="motion-fade">
          <span v-if="saved" class="home-ok" role="status">{{ __t('ui.desktop', '已保存') }}</span>
          <span v-else-if="dirty" class="home-muted">{{ __t('ui.desktop', '有改动还没保存') }}</span>
        </Transition>
      </div>
    </template>
    <Transition name="motion-rise">
      <p v-if="error" role="alert" class="home-error">{{ error }}</p>
    </Transition>
    <PDialog
      v-model="confirmReset"
      :title="__t('ui.desktop', '恢复默认')"
      :message="
        __t('ui.desktop', '把这些保护规则全部恢复成默认值？已经给过的授权和记录不受影响。')
      "
      @confirm="reset"
    />
  </section>
</template>

<style scoped>
.home-safety-intro {
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.home-safety-group {
  margin-top: 16px;
}
.home-safety-group h5 {
  font-size: 12px;
  font-weight: 700;
  color: var(--ui-text-secondary);
}
.home-safety-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.home-safety-text {
  flex: 1 1 240px;
  min-width: 0;
  color: var(--ui-text-primary);
}
.home-safety-text strong {
  font-size: 13px;
}
.home-safety-text p,
.home-safety-text small,
.home-muted {
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.home-safety-text small {
  color: var(--ui-text-tertiary);
}
.home-safety-input {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.home-safety-input span {
  min-width: 28px;
}
.home-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 14px;
}
.home-ok {
  color: var(--ui-success);
  font-size: 12px;
}
.home-error {
  margin-top: 10px;
  padding: 8px 10px;
  border-left: 3px solid var(--ui-danger);
  border-radius: var(--ui-radius-xs);
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
  color: var(--ui-text-primary);
  font-size: 12px;
}
</style>
