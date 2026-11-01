<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { t } from '../i18n'
import {
  assistantGenerationSchema,
  assistantSettingsSchema,
  defaultAssistantSettings,
  type AssistantSettings,
} from '../../../src/assistantSettings'
import type { ModelProvider } from '../types'
import PictoriaSelect from './PictoriaSelect.vue'

const props = defineProps<{
  settings: AssistantSettings
  providers: ModelProvider[]
  hosted: boolean
  disabled: boolean
  saving: boolean
}>()
const emit = defineEmits<{ save: [settings: AssistantSettings]; providers: [] }>()
const label = (key: string) => t('apps.pictoria.assistant', key)
const draft = ref<AssistantSettings>(JSON.parse(JSON.stringify(props.settings))),
  failure = ref('')
const form = ref<HTMLFormElement>(),
  invalid = ref('')
watch(
  () => props.settings,
  (value) => {
    draft.value = JSON.parse(JSON.stringify(value))
    failure.value = ''
    invalid.value = ''
  },
)
const providers = computed(() => [
  { value: '', label: label(props.hosted ? '主模型' : '选择供应商'), disabled: !props.hosted },
  ...props.providers.map((provider) => ({ value: provider.id, label: provider.name })),
])
const reasoning = computed(() => [
  { value: '', label: label('默认') },
  ...[
    ['off', '关闭'],
    ['low', '低'],
    ['medium', '中'],
    ['high', '高'],
    ['xhigh', '很高'],
    ['max', '最高'],
  ].map(([value, name]) => ({ value: value!, label: label(name!) })),
])
const scopes = computed(() => [
  { value: 'canvas', label: label('全画布') },
  { value: 'selection', label: label('选中项') },
])
function chooseProvider(value: string) {
  draft.value.providerId = value
  draft.value.model = props.providers.find((provider) => provider.id === value)?.defaultModel || ''
}
function setNumber(name: 'temperature' | 'topP' | 'maxTokens', event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value === '') delete draft.value.generation[name]
  else draft.value.generation[name] = Number(value)
}
function setReasoning(value: string) {
  const result = assistantGenerationSchema.shape.reasoningEffort.safeParse(value || undefined)
  if (result.success) draft.value.generation.reasoningEffort = result.data
}
function setScope(value: string) {
  if (value === 'canvas' || value === 'selection') draft.value.contextScope = value
}
function reset() {
  draft.value = {
    ...defaultAssistantSettings(),
    providerId: draft.value.providerId,
    model: draft.value.model,
  }
  failure.value = ''
  invalid.value = ''
}
function save() {
  if (props.disabled || props.saving) return
  if (!props.hosted && !draft.value.providerId) {
    failure.value = label('选择供应商')
    return
  }
  if (
    draft.value.providerId &&
    !draft.value.model.trim() &&
    !props.providers.find((provider) => provider.id === draft.value.providerId)?.defaultModel
  ) {
    failure.value = label('填写模型名称')
    return
  }
  const result = assistantSettingsSchema.safeParse(draft.value)
  if (!result.success) {
    const field = result.error.issues[0]?.path.join('.') || ''
    const names: Record<string, string> = {
      'generation.temperature': '温度',
      'generation.topP': 'Top P',
      'generation.maxTokens': '输出上限',
      historyMessages: '历史',
      contextCharacters: '上下文上限',
      timeoutSeconds: '超时',
      instructions: '创作偏好',
    }
    invalid.value = field
    failure.value = names[field]
      ? t('apps.pictoria.assistant', '检查{0}', [label(names[field])])
      : label('请检查参数范围')
    void nextTick(() => {
      const control = form.value?.elements.namedItem(field)
      if (control instanceof HTMLElement) control.focus()
    })
    return
  }
  failure.value = ''
  emit('save', result.data)
}
</script>

<template>
  <form
    ref="form"
    class="assistant-settings"
    novalidate
    @submit.prevent="save"
    @input="
      () => {
        failure = ''
        invalid = ''
      }
    "
  >
    <fieldset class="assistant-settings-body" :disabled="disabled || saving">
      <section class="assistant-settings-section">
        <h3>
          {{ label('模型') }}
          <button type="button" class="text-button" @click="emit('providers')">
            {{ label('管理') }}
          </button>
        </h3>
        <PictoriaSelect
          :model-value="draft.providerId"
          :options="providers"
          :label="label('模型来源')"
          :disabled="disabled || saving"
          @update:model-value="chooseProvider"
        />
        <input
          v-if="draft.providerId"
          v-model="draft.model"
          type="text"
          maxlength="200"
          :aria-label="label('模型名称')"
          :placeholder="label('模型名称')"
        />
        <small v-else>{{ label('沿用 infOS 主模型') }}</small>
      </section>
      <section class="assistant-settings-section">
        <h3>
          {{ label('生成') }}
          <small>{{ label('留空沿用模型') }}</small>
        </h3>
        <div class="assistant-settings-grid">
          <label>
            <span>{{ label('温度') }}</span>
            <input
              name="generation.temperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
              :value="draft.generation.temperature"
              :aria-invalid="invalid === 'generation.temperature'"
              :placeholder="label('默认')"
              @input="setNumber('temperature', $event)"
            />
          </label>
          <label>
            <span>{{ label('Top P') }}</span>
            <input
              name="generation.topP"
              type="number"
              min="0"
              max="1"
              step="0.05"
              :value="draft.generation.topP"
              :aria-invalid="invalid === 'generation.topP'"
              :placeholder="label('默认')"
              @input="setNumber('topP', $event)"
            />
          </label>
          <label>
            <span>{{ label('输出上限') }}</span>
            <div class="assistant-number-field">
              <input
                name="generation.maxTokens"
                type="number"
                min="1"
                max="262144"
                step="1"
                :value="draft.generation.maxTokens"
                :aria-invalid="invalid === 'generation.maxTokens'"
                :placeholder="label('默认')"
                @input="setNumber('maxTokens', $event)"
              />
              <small>{{ label('tokens') }}</small>
            </div>
          </label>
          <label>
            <span>{{ label('思考') }}</span>
            <PictoriaSelect
              :model-value="draft.generation.reasoningEffort || ''"
              :options="reasoning"
              :label="label('思考')"
              :disabled="disabled || saving"
              @update:model-value="setReasoning"
            />
          </label>
        </div>
      </section>
      <section class="assistant-settings-section">
        <h3>{{ label('上下文') }}</h3>
        <div class="assistant-settings-grid">
          <label>
            <span>{{ label('范围') }}</span>
            <PictoriaSelect
              :model-value="draft.contextScope"
              :options="scopes"
              :label="label('范围')"
              :disabled="disabled || saving"
              @update:model-value="setScope"
            />
          </label>
          <label>
            <span>{{ label('历史') }}</span>
            <div class="assistant-number-field">
              <input
                v-model.number="draft.historyMessages"
                name="historyMessages"
                type="number"
                min="0"
                max="40"
                step="1"
                :aria-invalid="invalid === 'historyMessages'"
              />
              <small>{{ label('条') }}</small>
            </div>
          </label>
          <label>
            <span>{{ label('上下文上限') }}</span>
            <div class="assistant-number-field">
              <input
                v-model.number="draft.contextCharacters"
                name="contextCharacters"
                type="number"
                min="4000"
                max="64000"
                step="1000"
                :aria-invalid="invalid === 'contextCharacters'"
              />
              <small>{{ label('字符') }}</small>
            </div>
          </label>
          <label>
            <span>{{ label('超时') }}</span>
            <div class="assistant-number-field">
              <input
                v-model.number="draft.timeoutSeconds"
                name="timeoutSeconds"
                type="number"
                min="30"
                max="600"
                step="1"
                :aria-invalid="invalid === 'timeoutSeconds'"
              />
              <small>{{ label('秒') }}</small>
            </div>
          </label>
        </div>
      </section>
      <section class="assistant-settings-section">
        <h3>
          <label for="canvas-assistant-preferences">{{ label('创作偏好') }}</label>
        </h3>
        <textarea
          id="canvas-assistant-preferences"
          v-model="draft.instructions"
          name="instructions"
          rows="3"
          maxlength="8000"
          :aria-invalid="invalid === 'instructions'"
          :placeholder="label('风格、语气或创作约束')"
        />
      </section>
      <p v-if="failure" class="assistant-settings-error" role="alert">{{ failure }}</p>
    </fieldset>
    <footer class="assistant-settings-footer">
      <small>{{ label('当前画布') }}</small>
      <button class="quiet-button" type="button" :disabled="disabled || saving" @click="reset">
        {{ label('重置') }}
      </button>
      <button class="create-button" type="submit" :disabled="disabled || saving">
        {{ label(saving ? '保存中' : '保存') }}
      </button>
    </footer>
  </form>
</template>
