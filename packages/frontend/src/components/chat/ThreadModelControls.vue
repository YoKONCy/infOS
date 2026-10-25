<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  normalizeReasoningEffort,
  reasoningEffortOptions,
  type ReasoningEffort,
  type ThreadModelSettings,
} from '@infos/shared'
import { threadsApi } from '../../api/modules/threadsApi'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { resolveModelBrand } from '../../lib/modelBrands'
import BrandIcon from '../brands/BrandIcon.vue'
import InputBarFoldout from './InputBarFoldout.vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import ReasoningEffortGlyph from './ReasoningEffortGlyph.vue'

const props = defineProps<{ threadId: string; disabled?: boolean; compact?: boolean }>()
const emit = defineEmits<{
  changed: [settings: ThreadModelSettings]
  busy: [value: boolean]
  open: []
}>()
const notify = useNotificationStore()
const settings = ref<ThreadModelSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref(false)
const modelMenu = ref<InstanceType<typeof InputBarFoldout> | null>(null)
const effortMenu = ref<InstanceType<typeof InputBarFoldout> | null>(null)
let sequence = 0
const blocked = computed(() => props.disabled || loading.value || saving.value || !settings.value)
const modelValue = computed(() => settings.value?.modelConfigId?.toString() ?? '')
const modelOptions = computed(() => [
  {
    value: '',
    get label() {
      return __t('ui.chat', '全局主模型')
    },
    brand: modelValue.value ? undefined : resolveModelBrand(settings.value?.effective.modelId),
    detail: modelValue.value ? '' : settings.value?.effective.modelId,
  },
  ...(settings.value?.models ?? []).map((model) => ({
    value: String(model.id),
    label: model.name,
    brand: resolveModelBrand(model.modelId),
    detail: model.modelId,
  })),
])
// 说明描述思考预算的用途，不把更高档位表述成回答质量保证。
const effortPresentation = computed(() => ({
  off: {
    label: __t('ui.input-controls', '关闭'),
    detail: __t('ui.input-controls', '不额外请求思考预算'),
    accent: 'var(--ui-text-secondary)',
  },
  low: {
    label: __t('ui.input-controls', '轻量'),
    detail: __t('ui.input-controls', '日常问答，轻量思考'),
    accent: 'var(--ui-accent-sky)',
  },
  medium: {
    label: __t('ui.input-controls', '均衡'),
    detail: __t('ui.input-controls', '常规分析，适中思考'),
    accent: 'var(--ui-accent-purple)',
  },
  high: {
    label: __t('ui.input-controls', '深入'),
    detail: __t('ui.input-controls', '复杂问题，深入推敲'),
    accent: 'var(--ui-accent-purple)',
  },
  xhigh: {
    label: __t('ui.input-controls', '深研'),
    detail: __t('ui.input-controls', '多步任务，更多推演'),
    accent: 'var(--ui-accent-primary)',
  },
  max: {
    label: __t('ui.input-controls', '极致'),
    detail: __t('ui.input-controls', '使用模型支持的最高思考档位'),
    accent: 'var(--ui-accent-primary)',
  },
}))
const effectiveEffortLabel = computed(() => {
  const effort = settings.value?.effective.reasoningEffort
  return effort ? effortPresentation.value[effort].label : __t('ui.chat', '服务商默认')
})
const efforts = computed(() =>
  reasoningEffortOptions(settings.value?.effective.modelId ?? '').map((option) => {
    const effort = option.value as ReasoningEffort | ''
    return {
      value: effort,
      ...(effort
        ? effortPresentation.value[effort]
        : {
            label: __t('ui.chat', '跟随模型'),
            detail: __t('ui.input-controls', '当前生效：{0}', [effectiveEffortLabel.value]),
            accent: 'var(--ui-accent-purple)',
          }),
    }
  }),
)
const rank = computed(() => {
  const effort = settings.value?.effective.reasoningEffort
  return effort ? { off: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }[effort] : 0
})
const effortLabel = computed(() =>
  settings.value?.reasoningEffort
    ? (efforts.value.find((option) => option.value === settings.value?.reasoningEffort)?.label ??
      __t('ui.chat', '默认'))
    : __t('ui.input-controls', '跟随'),
)
const modelTitle = computed(() =>
  __t('ui.chat', '本会话模型：{0} · {1}', [
    settings.value?.effective.name || __t('ui.chat', '未配置'),
    settings.value?.effective.modelId || __t('ui.chat', '请选择模型'),
  ]),
)
const effortTitle = computed(() =>
  __t('ui.chat', '本会话思考强度：{0}', [effectiveEffortLabel.value]),
)

async function load(): Promise<void> {
  const id = props.threadId
  const request = ++sequence
  saving.value = false
  emit('busy', false)
  error.value = false
  if (!id) {
    settings.value = null
    loading.value = false
    return
  }
  loading.value = true
  try {
    const response = await threadsApi.getModelSettings(id)
    if (request !== sequence || id !== props.threadId) return
    if (!response.data) throw new Error('未收到会话配置')
    settings.value = response.data
    emit('changed', response.data)
  } catch {
    if (request === sequence) error.value = true
  } finally {
    if (request === sequence) loading.value = false
  }
}

async function save(modelConfigId: number | null, effort: ReasoningEffort | null): Promise<void> {
  if (blocked.value || !settings.value) return
  const id = props.threadId
  const request = ++sequence
  saving.value = true
  emit('busy', true)
  try {
    const response = await threadsApi.updateModelSettings(id, {
      modelConfigId,
      reasoningEffort: effort,
    })
    if (request !== sequence || id !== props.threadId) return
    if (!response.data) throw new Error('保存失败')
    settings.value = response.data
    emit('changed', response.data)
  } catch (cause) {
    if (request === sequence)
      notify.toast(cause instanceof Error ? cause.message : __t('ui.chat', '保存失败'), 'error')
  } finally {
    if (request === sequence) {
      saving.value = false
      emit('busy', false)
    }
  }
}
function selectModel(value: string | number): void {
  modelMenu.value?.close(true)
  const id = value === '' ? null : Number(value)
  if (id === settings.value?.modelConfigId) return
  const model = settings.value?.models.find((item) => item.id === id)
  // 更换模型后由服务端按新模型校正档位，默认项始终保留跟随语义。
  const effort = model
    ? (normalizeReasoningEffort(model.modelId, settings.value?.reasoningEffort) ?? null)
    : (settings.value?.reasoningEffort ?? null)
  void save(id, effort)
}
function selectEffort(value: string | number): void {
  effortMenu.value?.close(true)
  if (value === (settings.value?.reasoningEffort ?? '')) return
  void save(settings.value?.modelConfigId ?? null, value ? (value as ReasoningEffort) : null)
}
function refresh(): void {
  if (!saving.value && document.visibilityState !== 'hidden') void load()
}
watch(
  () => props.threadId,
  () => {
    settings.value = null
    void load()
  },
  { immediate: true },
)
watch(
  () => props.disabled,
  (disabled) => {
    if (!disabled) refresh()
  },
)
onMounted(() => {
  window.addEventListener('infos:model-capabilities-changed', refresh)
  window.addEventListener('focus', refresh)
})
onBeforeUnmount(() => {
  sequence++
  emit('busy', false)
  window.removeEventListener('infos:model-capabilities-changed', refresh)
  window.removeEventListener('focus', refresh)
})
</script>

<template>
  <div
    class="thread-model-controls"
    :class="{ 'is-compact': compact }"
    :aria-busy="saving || loading"
    :data-effort="rank"
  >
    <InputBarFoldout
      ref="modelMenu"
      class="thread-model-picker"
      :label="
        (modelValue ? settings?.effective.name : __t('ui.chat', '主模型')) ||
        __t('ui.chat', '未配置')
      "
      :title="__t('ui.chat', '本会话模型')"
      icon="cpu"
      :disabled="blocked"
      :busy="loading || saving"
      :compact="compact"
      :scope-key="threadId"
      :width="340"
      @open="emit('open')"
    >
      <template #icon>
        <BrandIcon :brand="resolveModelBrand(settings?.effective.modelId)" size="xs" />
      </template>
      <div class="input-choice-list" role="group" :aria-label="modelTitle">
        <button
          v-for="option in modelOptions"
          :key="option.value"
          type="button"
          class="input-choice thread-config-option"
          :class="{ 'is-selected': modelValue === option.value }"
          :data-model-value="option.value"
          :aria-pressed="modelValue === option.value"
          :disabled="blocked"
          :title="option.detail || option.label"
          @click="selectModel(option.value)"
        >
          <span class="input-choice__icon" aria-hidden="true">
            <BrandIcon :brand="option.brand" size="xs" />
          </span>
          <span class="input-choice__copy">
            <strong>{{ option.label }}</strong>
            <small v-if="option.detail">{{ option.detail }}</small>
          </span>
          <span class="input-choice__check" aria-hidden="true">
            <PixelIcon v-if="modelValue === option.value" name="check" size="xs" />
          </span>
        </button>
      </div>
    </InputBarFoldout>
    <InputBarFoldout
      ref="effortMenu"
      class="thread-effort-picker"
      :label="effortLabel"
      :summary="settings && !settings.reasoningEffort ? effectiveEffortLabel : undefined"
      :title="__t('ui.chat', '本会话思考强度')"
      icon="brain"
      :accent="
        settings?.effective.reasoningEffort
          ? effortPresentation[settings.effective.reasoningEffort].accent
          : 'var(--ui-accent-purple)'
      "
      :disabled="blocked"
      :busy="loading || saving"
      :compact="compact"
      :scope-key="threadId"
      :width="296"
      @open="emit('open')"
    >
      <template #icon>
        <ReasoningEffortGlyph :effort="settings?.effective.reasoningEffort" />
      </template>
      <div class="input-choice-list thread-effort-list" role="group" :aria-label="effortTitle">
        <button
          v-for="option in efforts"
          :key="option.value"
          type="button"
          class="input-choice thread-config-option thread-effort-option"
          :style="{ '--choice-accent': option.accent }"
          :class="{ 'is-selected': (settings?.reasoningEffort ?? '') === option.value }"
          :data-effort-value="option.value"
          :aria-pressed="(settings?.reasoningEffort ?? '') === option.value"
          :disabled="blocked"
          @click="selectEffort(option.value)"
        >
          <span class="input-choice__icon" aria-hidden="true">
            <ReasoningEffortGlyph :effort="option.value || null" />
          </span>
          <span class="input-choice__copy">
            <strong>
              {{ option.label }}
              <span v-if="option.value" class="thread-effort-code">
                {{ option.value.toUpperCase() }}
              </span>
            </strong>
            <small>{{ option.detail }}</small>
          </span>
          <span class="input-choice__check" aria-hidden="true">
            <PixelIcon
              v-if="(settings?.reasoningEffort ?? '') === option.value"
              name="check"
              size="xs"
            />
          </span>
        </button>
      </div>
      <p class="thread-effort-hint">
        {{ __t('ui.input-controls', '较高档位可能增加响应时间与用量') }}
      </p>
    </InputBarFoldout>
    <button
      v-if="error"
      class="thread-model-retry"
      type="button"
      :title="__t('ui.chat', '配置加载失败，点击重试')"
      :aria-label="__t('ui.chat', '重新加载会话模型')"
      @click="refresh"
    >
      <PixelIcon name="refresh" size="xs" />
    </button>
  </div>
</template>

<style scoped src="./input-bar-choices.css"></style>

<style scoped>
.thread-model-controls {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  max-width: 100%;
  color: var(--ui-text-secondary);
}
.thread-model-controls.is-compact {
  flex-wrap: wrap;
}
.thread-model-picker :deep(.input-foldout__label) {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.is-compact .thread-model-picker :deep(.input-foldout__label) {
  max-width: 90px;
}
.thread-config-option {
  --choice-accent: var(--foldout-accent);
}
.thread-config-option .input-choice__copy strong,
.thread-config-option .input-choice__copy small {
  overflow-wrap: anywhere;
}
.thread-effort-list {
  gap: 2px;
}
.thread-effort-option {
  min-height: 52px;
  padding: 7px 9px;
}
.thread-effort-option:nth-child(2) {
  margin-top: 5px;
}
.thread-effort-option .input-choice__icon {
  flex-basis: 30px;
  height: 30px;
  color: var(--choice-accent);
  border-color: color-mix(in srgb, var(--choice-accent) 20%, var(--ui-border-subtle));
  box-shadow: none;
}
.thread-effort-option .input-choice__copy {
  gap: 3px;
}
.thread-effort-option .input-choice__copy small {
  color: var(--ui-text-secondary);
}
.thread-effort-code {
  color: var(--ui-text-tertiary);
  font: 9px/1.4 var(--ui-font-mono, monospace);
  letter-spacing: 0.04em;
}
.thread-effort-option .input-choice__check {
  border-color: transparent;
}
.thread-effort-option.is-selected .input-choice__check {
  border-color: var(--choice-accent);
}
.thread-effort-hint {
  margin: 7px 2px 0;
  padding: 8px 7px 2px;
  border-top: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-secondary);
  font: 10px/1.6 var(--ui-font-sans);
}
.thread-model-retry {
  color: var(--ui-text-secondary);
  background: none;
  border: 0;
  cursor: pointer;
}
@media (max-width: 640px) {
  .thread-model-picker :deep(.input-foldout__label) {
    max-width: 90px;
  }
}
</style>
