<script setup lang="ts">
import { t as __t } from '../i18n'

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { isAssetField, isAssetsField } from '../composables/useCanvasLinks'
import type { FieldSchema, Step } from '../types'
import { pictoria, standalone } from '../services/transport'
import Icon from './PictoriaIcon.vue'
import PictoriaSelect from './PictoriaSelect.vue'
import WorkflowFields from './WorkflowFields.vue'
import ApiServiceEditor from './ApiServiceEditor.vue'
const props = defineProps<{
  owner: string
  step?: Step
  api?: boolean
  node?: boolean
  llmApi?: boolean
  videoApi?: boolean
}>()
const emit = defineEmits<{ close: []; saved: [step: Step] }>()
const kind = ref(
  props.api || props.llmApi || standalone
    ? 'service'
    : props.step?.implementation?.kind === 'llm'
      ? 'llm'
      : 'service',
)
const localLlm = Boolean(props.llmApi || props.step?.implementation?.kind === 'llm')
const name = ref(props.step?.name || (localLlm ? 'LLM API' : 'API'))
const usage = ref(props.step?.usageDescription || '')
const system = ref(props.step?.implementation?.system || ''),
  modelId = ref(props.step?.implementation?.modelId || ''),
  outputMode = ref(props.step?.implementation?.outputMode || 'text')
const inputSchema = ref<FieldSchema>(
  JSON.parse(
    JSON.stringify(
      props.step?.inputSchema || {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            title: __t('apps.pictoria.ui', '提示词'),
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    ),
  ),
)
const outputSchema = ref<FieldSchema>(
  JSON.parse(
    JSON.stringify(
      props.step?.outputSchema ||
        (localLlm
          ? {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  title: __t('apps.pictoria.ui', '文本'),
                },
              },
              required: ['text'],
              additionalProperties: false,
            }
          : {
              type: 'object',
              properties: {
                images: {
                  type: 'array',
                  title: __t('apps.pictoria.ui', '图片'),
                  items: {
                    type: 'object',
                    properties: { assetId: { type: 'string' } },
                    required: ['assetId'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['images'],
              additionalProperties: false,
            }),
    ),
  ),
)
const apiEditor = ref<InstanceType<typeof ApiServiceEditor> | null>(null),
  busy = ref(false),
  error = ref(''),
  dialog = ref<HTMLElement | null>(null)
if (props.videoApi && !props.step) {
  name.value = '视频生成'
  const asset: FieldSchema = {
    type: 'object',
    properties: { assetId: { type: 'string' } },
    required: ['assetId'],
    additionalProperties: false,
  }
  inputSchema.value = {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        title: __t('apps.pictoria.ui', '提示词'),
        minLength: 1,
      },
      images: {
        type: 'array',
        title: __t('apps.pictoria.ui', '参考图片'),
        items: asset,
        default: [],
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  }
  outputSchema.value = {
    type: 'object',
    properties: {
      videos: {
        type: 'array',
        title: __t('apps.pictoria.ui', '视频'),
        items: asset,
        minItems: 1,
      },
    },
    required: ['videos'],
    additionalProperties: false,
  }
}
const privateStepId = crypto.randomUUID()
const continuationField = computed({
  get: () =>
    String(
      (inputSchema.value['x-pictoria-video'] as { startFrameField?: string } | undefined)
        ?.startFrameField || '',
    ),
  set: (value: string) => {
    const schema = { ...inputSchema.value }
    if (value) schema['x-pictoria-video'] = { startFrameField: value }
    else schema['x-pictoria-video'] = { startFrameField: null }
    inputSchema.value = schema
  },
})
const continuationFields = computed(() => [
  { value: '', label: __t('apps.pictoria.video', '不提供起始帧接续') },
  ...Object.entries(inputSchema.value.properties || {})
    .filter(([, field]) => isAssetField(field) || isAssetsField(field))
    .map(([name, field]) => ({ value: name, label: field.title || name })),
])
const previousFocus = document.activeElement
function trapFocus(event: KeyboardEvent) {
  const values = Array.from(
    dialog.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
    ) || [],
  ).filter((element) => element.getClientRects().length)
  const first = values[0],
    last = values.at(-1)
  if (!first) {
    event.preventDefault()
    dialog.value?.focus()
    return
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === dialog.value)
  ) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
onMounted(() => dialog.value?.focus())
onBeforeUnmount(() => {
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
})
async function save() {
  if (busy.value || !name.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    let implementation: NonNullable<Step['implementation']>
    if (kind.value === 'service') {
      if (!apiEditor.value) throw new Error('API 配置尚未就绪')
      const service = await apiEditor.value.save()
      implementation = { kind: 'service', serviceId: service.id }
    } else {
      if (standalone) throw new Error('独立运行请配置 LLM API')
      if (modelId.value && !/^[1-9]\d*$/.test(modelId.value)) throw new Error('infOS 模型 ID 无效')
      implementation = {
        kind: 'llm',
        system: system.value,
        ...(modelId.value ? { modelId: modelId.value } : {}),
        outputMode: outputMode.value,
      }
    }
    // 节点配置保存为独立步骤与服务，不修改其他节点共用的定义。
    const overwrite = !props.node && Boolean(props.step?.revision)
    const step = await pictoria.operation<Step>(props.owner, 'step.save', {
      expectedRevision: overwrite ? props.step!.revision : 0,
      definition: {
        id: overwrite ? props.step!.id : privateStepId,
        name: name.value.trim(),
        enabled: true,
        usageDescription: usage.value,
        inputSchema: inputSchema.value,
        outputSchema:
          kind.value === 'llm' && outputMode.value === 'text'
            ? {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    title: __t('apps.pictoria.ui', '文本'),
                  },
                },
                required: ['text'],
                additionalProperties: false,
              }
            : outputSchema.value,
        implementation,
      },
    })
    emit('saved', step)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '保存失败'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="recovery-backdrop" data-ui @pointerdown.self="!busy && emit('close')">
    <section
      ref="dialog"
      class="workflow-step-settings floating-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="
        kind === 'service'
          ? __t('apps.pictoria.ui', '配置节点 API')
          : __t('apps.pictoria.ui', '配置 LLM')
      "
      tabindex="-1"
      @keydown.tab="trapFocus"
      @keydown.esc.stop="!busy && emit('close')"
    >
      <header>
        <strong>
          {{
            kind === 'service'
              ? __t('apps.pictoria.ui', '配置节点 API')
              : __t('apps.pictoria.ui', '配置 LLM')
          }}
        </strong>
        <button
          class="icon-button"
          :disabled="busy"
          :aria-label="__t('apps.pictoria.ui', '关闭')"
          @click="emit('close')"
        >
          <Icon name="close" :size="17" />
        </button>
      </header>
      <label class="panel-field">
        {{ __t('apps.pictoria.ui', '名称') }}
        <input v-model="name" maxlength="100" />
      </label>
      <PictoriaSelect
        v-if="!standalone"
        v-model="kind"
        :disabled="busy"
        :options="[
          { value: 'service', label: __t('apps.pictoria.ui', '自定义 API') },
          { value: 'llm', label: __t('apps.pictoria.ui', 'infOS LLM（可选）') },
        ]"
      />
      <ApiServiceEditor
        v-if="kind === 'service'"
        ref="apiEditor"
        :owner="owner"
        :service-id="step?.implementation?.serviceId"
        :name="name"
        :input-schema="inputSchema"
        :output-schema="outputSchema"
        :local-llm="localLlm"
      />
      <template v-else>
        <label class="panel-field">
          {{ __t('apps.pictoria.ui', 'infOS 模型 ID') }}
          <input
            v-model="modelId"
            inputmode="numeric"
            :placeholder="__t('apps.pictoria.ui', '默认模型')"
          />
        </label>
        <label class="panel-field">
          {{ __t('apps.pictoria.ui', '系统提示词') }}
          <textarea v-model="system" maxlength="32000" rows="4" />
        </label>
        <label class="panel-field">
          {{ __t('apps.pictoria.ui', '输出') }}
          <PictoriaSelect
            v-model="outputMode"
            :options="[
              { value: 'text', label: __t('apps.pictoria.ui', '文本') },
              { value: 'json', label: 'JSON' },
            ]"
          />
        </label>
      </template>
      <details class="workflow-step-fields" open>
        <summary>{{ __t('apps.pictoria.ui', '输入') }}</summary>
        <WorkflowFields v-model="inputSchema" />
      </details>
      <details v-if="kind !== 'llm' || outputMode === 'json'" class="workflow-step-fields" open>
        <summary>{{ __t('apps.pictoria.ui', '输出') }}</summary>
        <WorkflowFields v-model="outputSchema" />
      </details>
      <label class="panel-field">
        {{ __t('apps.pictoria.ui', '输入说明') }}
        <textarea v-model="usage" maxlength="16000" rows="3" />
      </label>
      <p v-if="error" class="workflow-field-error" role="alert">{{ error }}</p>
      <label v-if="videoApi || outputSchema.properties?.videos" class="panel-field">
        {{ __t('apps.pictoria.video', '起始帧字段') }}
        <PictoriaSelect
          v-model="continuationField"
          :options="continuationFields"
          :label="__t('apps.pictoria.video', '起始帧字段')"
          :disabled="busy"
        />
        <small>
          {{
            __t(
              'apps.pictoria.video',
              '仅在 API 确实把该字段作为起始帧时启用；数组的第一张为起始帧。',
            )
          }}
        </small>
      </label>
      <footer>
        <button class="text-button" :disabled="busy" @click="emit('close')">
          {{ __t('apps.pictoria.ui', '取消') }}
        </button>
        <button class="create-button" :disabled="busy || !name.trim()" @click="save">
          {{ busy ? __t('apps.pictoria.ui', '保存中') : __t('apps.pictoria.ui', '保存') }}
        </button>
      </footer>
    </section>
  </div>
</template>
