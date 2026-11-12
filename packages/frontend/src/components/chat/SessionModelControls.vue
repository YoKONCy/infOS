<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * SessionModelControls — 会话设置面板中的模型与模型思考两段。
 *
 * 两项都保存在 Thread 的模型设置接口上：模型行展开为手风琴列表，思考强度用分档滑块。
 */
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import {
  normalizeReasoningEffort,
  reasoningEffortOptions,
  type ReasoningEffort,
  type ThreadModelSettings,
} from '@infos/shared'
import { threadsApi } from '../../api/modules/threadsApi'
import { cacheThreadUsableModel } from '../../composables/chat/sendModelGuard'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { resolveModelBrand } from '../../lib/modelBrands'
import BrandIcon from '../brands/BrandIcon.vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import ReasoningEffortGlyph from './ReasoningEffortGlyph.vue'
import SessionSlider from './SessionSlider.vue'

const props = defineProps<{
  threadId: string
  disabled?: boolean
}>()
const emit = defineEmits<{
  changed: [settings: ThreadModelSettings]
  busy: [value: boolean]
}>()
const notify = useNotificationStore()
const settings = ref<ThreadModelSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref(false)
const modelsOpen = ref(false)
const effortPreview = ref<number | null>(null)
const pendingEffort = ref<{ value: ReasoningEffort | null } | null>(null)
const effortSlider = ref<InstanceType<typeof SessionSlider> | null>(null)
const listId = `thread-model-list-${useId()}`
let sequence = 0
const blocked = computed(() => props.disabled || (loading.value && !settings.value) || !settings.value)
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
  },
  low: {
    label: __t('ui.input-controls', '轻量'),
    detail: __t('ui.input-controls', '日常问答，轻量思考'),
  },
  medium: {
    label: __t('ui.input-controls', '均衡'),
    detail: __t('ui.input-controls', '常规分析，适中思考'),
  },
  high: {
    label: __t('ui.input-controls', '深入'),
    detail: __t('ui.input-controls', '复杂问题，深入推敲'),
  },
  xhigh: {
    label: __t('ui.input-controls', '深研'),
    detail: __t('ui.input-controls', '多步任务，更多推演'),
  },
  max: {
    label: __t('ui.input-controls', '极致'),
    detail: __t('ui.input-controls', '使用模型支持的最高思考档位'),
  },
}))
const effectiveEffortLabel = computed(() => {
  const effort = settings.value?.effective.reasoningEffort
  return effort ? effortPresentation.value[effort].label : __t('ui.chat', '服务商默认')
})
/** 跟随模型独占首档，后续刻度由模型支持的实际档位生成。 */
const efforts = computed(() =>
  reasoningEffortOptions(settings.value?.effective.modelId ?? '').map((option) => {
    const value = (option.value || null) as ReasoningEffort | null
    return {
      value,
      label: value ? effortPresentation.value[value].label : __t('ui.input-controls', '跟随'),
      detail: value
        ? effortPresentation.value[value].detail
        : __t('ui.input-controls', '当前生效：{0}', [effectiveEffortLabel.value]),
    }
  }),
)
const currentEffort = computed(() =>
  pendingEffort.value ? pendingEffort.value.value : (settings.value?.reasoningEffort ?? null),
)
const effortIndex = computed(() =>
  Math.max(0, efforts.value.findIndex((option) => option.value === currentEffort.value)),
)
const nextEffort = computed(() => efforts.value[(effortIndex.value + 1) % efforts.value.length])
const effortCycleHint = computed(() =>
  __t('ui.input-controls', '模型思考，点击切换至「{0}」', [nextEffort.value?.label ?? '']),
)
const shownEffort = computed<ReasoningEffort | null>(() => {
  const index = effortPreview.value ?? effortIndex.value
  return efforts.value[index]?.value ?? null
})
const effortLabel = computed(() =>
  shownEffort.value
    ? effortPresentation.value[shownEffort.value].label
    : __t('ui.chat', '跟随模型'),
)
const modelTitle = computed(() =>
  __t('ui.chat', '本会话模型：{0} · {1}', [
    settings.value?.effective.name || __t('ui.chat', '未配置'),
    settings.value?.effective.modelId || __t('ui.chat', '请选择模型'),
  ]),
)

async function load(): Promise<void> {
  const id = props.threadId
  const request = ++sequence
  saving.value = false
  pendingEffort.value = null
  effortPreview.value = null
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
    cacheThreadUsableModel(id, Boolean(response.data.effective.modelId))
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
  const previous = settings.value
  const request = ++sequence
  saving.value = true
  pendingEffort.value = { value: effort }
  const chosenModel =
    modelConfigId !== null ? previous.models.find((item) => item.id === modelConfigId) : undefined
  // 乐观更新本地模型与思考档位，最后一次写入胜出（Last-Write-Wins），失败时回滚
  settings.value = {
    ...previous,
    modelConfigId,
    reasoningEffort: effort,
    effective: chosenModel
      ? {
          ...previous.effective,
          name: chosenModel.name,
          modelId: chosenModel.modelId,
        }
      : previous.effective,
  }
  try {
    const response = await threadsApi.updateModelSettings(id, {
      modelConfigId,
      reasoningEffort: effort,
    })
    if (request !== sequence || id !== props.threadId) return
    if (!response.data) throw new Error('保存失败')
    settings.value = response.data
    cacheThreadUsableModel(id, Boolean(response.data.effective.modelId))
    emit('changed', response.data)
  } catch (cause) {
    if (request === sequence && id === props.threadId) {
      settings.value = previous
      notify.toast(cause instanceof Error ? cause.message : __t('ui.chat', '保存失败'), 'error')
    }
  } finally {
    if (request === sequence) {
      pendingEffort.value = null
      saving.value = false
    }
  }
}
function selectModel(value: string): void {
  modelsOpen.value = false
  const id = value === '' ? null : Number(value)
  if (id === settings.value?.modelConfigId) return
  const model = settings.value?.models.find((item) => item.id === id)
  // 更换模型后由服务端按新模型校正档位，默认项始终保留跟随语义。
  const effort = model
    ? (normalizeReasoningEffort(model.modelId, settings.value?.reasoningEffort) ?? null)
    : (settings.value?.reasoningEffort ?? null)
  void save(id, effort)
}
function selectEffort(effort: ReasoningEffort | null): void {
  if (effort === (settings.value?.reasoningEffort ?? null)) return
  void save(settings.value?.modelConfigId ?? null, effort)
}
function cycleEffort(): void {
  if (nextEffort.value) selectEffort(nextEffort.value.value)
}
/** 恢复默认：思考强度跟随模型；模型选择保持不变。 */
async function reset(): Promise<void> {
  if (!settings.value?.reasoningEffort) return
  await save(settings.value.modelConfigId, null)
}
function refresh(): void {
  if (!saving.value && document.visibilityState !== 'hidden') void load()
}
function collapse(): void {
  modelsOpen.value = false
  effortSlider.value?.cancel()
}
watch(
  () => props.threadId,
  () => {
    settings.value = null
    modelsOpen.value = false
    void load()
  },
  { immediate: true },
)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) modelsOpen.value = false
  },
)
onMounted(() => {
  window.addEventListener('infos:model-capabilities-changed', refresh)
})
onBeforeUnmount(() => {
  sequence++
  emit('busy', false)
  window.removeEventListener('infos:model-capabilities-changed', refresh)
})
defineExpose({ reset, collapse })
</script>

<template>
  <div class="thread-model-controls" :aria-busy="saving || loading">
    <section class="session-item">
      <button
        type="button"
        class="thread-model-row"
        data-foldout-initial
        :class="{ 'is-open': modelsOpen }"
        :aria-expanded="modelsOpen"
        :aria-controls="listId"
        :title="modelTitle"
        :disabled="blocked"
        @click="modelsOpen = !modelsOpen"
      >
        <span class="thread-model-row__icon" aria-hidden="true">
          <PixelIcon v-if="loading && !settings" name="refresh" size="xs" animation="spin" />
          <BrandIcon v-else :brand="resolveModelBrand(settings?.effective.modelId)" size="xs" />
        </span>
        <span class="thread-model-row__name">
          {{ settings?.effective.name || __t('ui.chat', '未配置') }}
        </span>
        <small v-if="settings && !modelValue">{{ __t('ui.chat', '全局主模型') }}</small>
        <PixelIcon name="chevron-right" size="xs" class="thread-model-row__chevron" />
      </button>
      <div :id="listId" class="session-collapse" :class="{ 'is-open': modelsOpen }">
        <div
          class="thread-model-list"
          role="group"
          :aria-label="__t('ui.chat', '本会话模型')"
          :inert="!modelsOpen || undefined"
        >
          <button
            v-for="option in modelOptions"
            :key="option.value"
            type="button"
            class="thread-model-option"
            :class="{ 'is-selected': modelValue === option.value }"
            :data-model-value="option.value"
            :aria-pressed="modelValue === option.value"
            :disabled="blocked"
            :title="option.detail || option.label"
            @click="selectModel(option.value)"
          >
            <BrandIcon :brand="option.brand" size="xs" />
            <span class="thread-model-option__copy">
              <strong>{{ option.label }}</strong>
              <small v-if="option.detail">{{ option.detail }}</small>
            </span>
            <PixelIcon v-if="modelValue === option.value" name="check" size="xs" />
          </button>
        </div>
      </div>
      <button
        v-if="error"
        class="thread-model-retry"
        type="button"
        :title="__t('ui.chat', '配置加载失败，点击重试')"
        :aria-label="__t('ui.chat', '重新加载会话模型')"
        @click="refresh"
      >
        <PixelIcon name="refresh" size="xs" />
        {{ __t('ui.chat', '配置加载失败，点击重试') }}
      </button>
    </section>

    <section class="session-item" :style="{ '--item-accent': 'var(--ui-accent-sky)' }">
      <header class="session-item__head">
        <span>{{ __t('ui.input-controls', '模型思考') }}</span>
        <button
          type="button"
          class="session-item__value session-item__cycle"
          :class="{ 'is-muted': !shownEffort }"
          :disabled="blocked"
          :title="effortCycleHint"
          :aria-label="effortCycleHint"
          @click="cycleEffort"
        >
          <ReasoningEffortGlyph :effort="shownEffort" />
          {{ effortLabel }}
        </button>
      </header>
      <SessionSlider
        ref="effortSlider"
        :key="threadId"
        :options="efforts.map((option) => option.label)"
        :model-value="effortIndex"
        :label="__t('ui.input-controls', '模型思考')"
        :value-text="effortLabel"
        accent="var(--ui-accent-sky)"
        :disabled="blocked"
        @preview="effortPreview = $event"
        @update:model-value="selectEffort(efforts[$event]?.value ?? null)"
      />
      <div class="session-item__descriptions">
        <p
          v-for="(option, index) in efforts"
          :key="option.value ?? 'default'"
          class="session-item__desc"
          :class="{ 'is-current': index === (effortPreview ?? effortIndex) }"
          :aria-hidden="index !== (effortPreview ?? effortIndex) || undefined"
        >{{ option.detail }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped src="./session-settings.css"></style>

<style scoped>
.thread-model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--ui-text-primary);
  cursor: pointer;
  font: 12px/1.3 var(--ui-font-pixel);
  text-align: left;
}
.thread-model-row__icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--ui-accent-sky);
}
.thread-model-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-model-row > small {
  flex: 0 0 auto;
  color: var(--ui-text-tertiary);
  font: 10px/1 var(--ui-font-sans);
}
.thread-model-row__chevron {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--ui-text-tertiary);
  transition: transform 220ms ease;
}
.thread-model-row.is-open .thread-model-row__chevron {
  transform: rotate(90deg);
}
.thread-model-row:hover:not(:disabled) .thread-model-row__name {
  color: var(--ui-accent-sky);
}
.thread-model-row:disabled {
  cursor: not-allowed;
}
.thread-model-row:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.thread-model-list {
  display: grid;
  gap: 1px;
  padding-top: 6px;
}
.thread-model-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 6px 6px 6px 4px;
  border: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  text-align: left;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.thread-model-option__copy {
  display: grid;
  flex: 1;
  gap: 2px;
  min-width: 0;
}
.thread-model-option__copy strong {
  font: 11px/1.3 var(--ui-font-pixel);
  font-weight: 400;
  overflow-wrap: anywhere;
}
.thread-model-option__copy small {
  color: var(--ui-text-tertiary);
  font: 10px/1.3 var(--ui-font-sans);
  overflow-wrap: anywhere;
}
.thread-model-option:hover:not(:disabled) {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}
.thread-model-option.is-selected {
  color: var(--ui-accent-sky);
}
.thread-model-option:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.thread-model-option:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: -2px;
}
.thread-model-retry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-text-secondary);
  cursor: pointer;
  font: 10px/1.4 var(--ui-font-sans);
}
.session-segment.is-off {
  opacity: 0.35;
}
@media (prefers-reduced-motion: reduce) {
  .thread-model-row__chevron {
    transition: none;
  }
}
</style>
