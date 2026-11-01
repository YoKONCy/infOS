<script setup lang="ts">
import { t as __t } from '../i18n'

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type {
  Asset,
  AssetReference,
  CanvasItem,
  CreationPreferences,
  InputConnection,
  OutputPort,
  Step,
  ReferenceUse,
} from '../types'
import { acceptsAsset, isAssetField, isAssetsField } from '../composables/useCanvasLinks'
import Icon from './PictoriaIcon.vue'
import ReferenceInput from './ReferenceInput.vue'
import { referencePromptField } from '../../../src/creativeInputs'
import { setReferenceUse } from '../services/referenceUses'
import PictoriaSelect from './PictoriaSelect.vue'
import { promptPlaceholder, stepLabel } from '../services/labels'

const props = defineProps<{
  steps: Step[]
  selected: CanvasItem[]
  items: CanvasItem[]
  thumbnails: Record<string, string>
  contextKey: string
  owner: string
  busy: boolean
  online: boolean
}>()
const emit = defineEmits<{
  run: [
    step: Step,
    inputs: Record<string, unknown>,
    key: string,
    connections: InputConnection[],
    uses: ReferenceUse[],
  ]
  draft: [
    step: Step,
    inputs: Record<string, unknown>,
    connections: InputConnection[],
    uses: ReferenceUse[],
  ]
  note: [text: string]
  upload: []
  clear: []
  configure: []
  preview: [assetId: string]
  connections: [connections: InputConnection[]]
  anchor: [point: { x: number; y: number }]
}>()
const creation = defineModel<CreationPreferences>('creation')
const preferences = computed<CreationPreferences>(
  () => creation.value ?? { stepId: '', text: '', inputsByStep: {} },
)
const stepId = computed({
  get: () => preferences.value.stepId,
  set: (value) => {
    creation.value = { ...preferences.value, stepId: value }
  },
})
const text = computed({
  get: () => preferences.value.text,
  set: (value) => {
    creation.value = { ...preferences.value, text: value }
  },
})
const picker = ref(false),
  settings = ref(false),
  validation = ref('')
// 参数直接归属画布，并按步骤分别保存；切换模型不会覆盖之前的比例、分辨率或思考选项。
watch(
  () => [preferences.value.inputsByStep, stepId.value] as const,
  ([inputs, id]) => {
    if (!inputs[id])
      creation.value = { ...preferences.value, inputsByStep: { ...inputs, [id]: {} } }
  },
  { immediate: true, flush: 'sync' },
)
const fields = computed(() => preferences.value.inputsByStep[stepId.value] ?? {})
const referenceUses = computed(() => preferences.value.referenceUsesByStep?.[stepId.value] ?? [])
function setPurpose(field: string, assetId: string, purpose: string) {
  creation.value = {
    ...preferences.value,
    referenceUsesByStep: {
      ...preferences.value.referenceUsesByStep,
      [stepId.value]: setReferenceUse(referenceUses.value, field, assetId, purpose),
    },
  }
}
const details = reactive<Record<string, AssetReference>>({})
const sourcePorts = reactive<Record<string, { source: string; port: OutputPort }>>({})
const noteSource = ref<{ id: string; port: OutputPort }>()
const dock = ref<HTMLElement | null>(null),
  inputPort = ref<HTMLButtonElement | null>(null)
let previous: { fingerprint: string; key: string } | undefined, observer: ResizeObserver | undefined
const step = computed(() => props.steps.find((item) => item.id === stepId.value && item.available))
const properties = computed(() => step.value?.inputSchema.properties || {})
const primary = computed(() => {
  const entries = Object.entries(properties.value).filter(
    ([, schema]) => schema.type === 'string' && !schema.enum,
  )
  return entries.find(([name]) => name === 'prompt')?.[0] || entries[0]?.[0]
})
const assetFields = computed(() =>
  Object.entries(properties.value).filter(
    ([, schema]) => isAssetField(schema) || isAssetsField(schema),
  ),
)
const extraFields = computed(() =>
  Object.entries(properties.value).filter(
    ([key, schema]) => key !== primary.value && !isAssetField(schema) && !isAssetsField(schema),
  ),
)
const referenceCount = computed(() =>
  assetFields.value.reduce((sum, [key]) => sum + references(key).length, 0),
)
const connections = computed<InputConnection[]>(() => {
  const result: InputConnection[] = []
  for (const [field] of assetFields.value)
    for (const reference of references(field)) {
      const saved = sourcePorts[`${field}:${reference.assetId}`]
      const source =
        props.items.find(
          (item) => item.id === saved?.source && item.content.assetId === reference.assetId,
        ) || props.items.find((item) => item.content.assetId === reference.assetId)
      if (source)
        result.push({
          source: source.id,
          field,
          sourcePort: saved?.port || 'bottom',
          targetPort: 'top',
        })
    }
  const source = props.items.find((item) => item.id === noteSource.value?.id)
  if (
    (!step.value || primary.value) &&
    source?.content.kind === 'text' &&
    source.content.text === text.value
  )
    result.push({
      source: source.id,
      field: primary.value || 'text',
      sourcePort: noteSource.value?.port || 'bottom',
      targetPort: 'top',
    })
  return result
})
function references(key: string): AssetReference[] {
  const value = fields.value[key],
    values = Array.isArray(value) ? value : value ? [value] : []
  return values.flatMap((ref) => {
    const id = ref && typeof ref === 'object' ? (ref as { assetId?: string }).assetId : undefined
    if (typeof id !== 'string') return []
    const source = props.items.find((item) => item.content.assetId === id)
    return [
      {
        assetId: id,
        name: source?.content.name || details[id]?.name || '素材引用',
        mimeType: source?.content.mimeType || details[id]?.mimeType,
      },
    ]
  })
}
function addReference(key: string, id: string, port: OutputPort = 'bottom', sourceId?: string) {
  const field = properties.value[key],
    source =
      props.items.find((item) => item.id === sourceId && item.content.assetId === id) ||
      props.items.find((item) => item.content.assetId === id)
  if (!field || !source || !acceptsAsset(key, source)) return
  const refs = references(key)
  if (!refs.some((ref) => ref.assetId === id)) {
    if (isAssetsField(field) && refs.length >= (field.maxItems ?? 20)) {
      validation.value = `${field.title || key}最多引用 ${field.maxItems ?? 20} 份素材`
      return
    }
    const added = { assetId: id }
    fields.value[key] = isAssetsField(field)
      ? [...refs.map((ref) => ({ assetId: ref.assetId })), added]
      : added
  }
  sourcePorts[`${key}:${id}`] = { source: source.id, port }
  details[id] = {
    assetId: id,
    name: source.content.name || '素材引用',
    mimeType: source.content.mimeType,
  }
}
function removeReference(key: string, id: string) {
  const field = properties.value[key]
  fields.value[key] = isAssetsField(field || {})
    ? references(key)
        .filter((ref) => ref.assetId !== id)
        .map((ref) => ({ assetId: ref.assetId }))
    : undefined
  delete sourcePorts[`${key}:${id}`]
  setPurpose(key, id, '')
  validation.value = ''
}
function addLibraryReference(key: string, asset: Asset) {
  const field = properties.value[key],
    refs = references(key)
  if (
    !field ||
    refs.some((reference) => reference.assetId === asset.id) ||
    (isAssetsField(field) && refs.length >= (field.maxItems ?? 20))
  )
    return
  fields.value[key] = isAssetsField(field)
    ? [...refs.map((reference) => ({ assetId: reference.assetId })), { assetId: asset.id }]
    : { assetId: asset.id }
  details[asset.id] = {
    assetId: asset.id,
    name: asset.meta?.title || asset.name,
    mimeType: asset.mimeType,
  }
  emit('preview', asset.id)
}
function moveReference(key: string, id: string, direction: number) {
  const refs = references(key),
    index = refs.findIndex((ref) => ref.assetId === id),
    other = index + direction
  if (index < 0 || other < 0 || other >= refs.length) return
  const current = refs[index]!
  refs[index] = refs[other]!
  refs[other] = current
  fields.value[key] = refs.map((ref) => ({ assetId: ref.assetId }))
}
function adoptSelection() {
  for (const [key, schema] of assetFields.value) {
    const selected = props.selected.filter((item) => acceptsAsset(key, item))
    for (const item of isAssetsField(schema) ? selected : selected.slice(0, 1)) {
      const saved = sourcePorts[`${key}:${item.content.assetId}`]
      addReference(key, item.content.assetId!, saved?.port || 'bottom', saved?.source || item.id)
    }
  }
}
watch(
  () => [stepId.value, step.value?.revision, props.contextKey],
  () => {
    for (const key of Object.keys(sourcePorts)) delete sourcePorts[key]
    for (const [key, schema] of Object.entries(properties.value))
      if (schema.default !== undefined && fields.value[key] === undefined)
        fields.value[key] = JSON.parse(JSON.stringify(schema.default))
    if (!text.value && primary.value && typeof fields.value[primary.value] === 'string')
      text.value = fields.value[primary.value] as string
    settings.value = extraFields.value.some(([key]) =>
      step.value?.inputSchema.required?.includes(key),
    )
    validation.value = ''
    adoptSelection()
  },
  { flush: 'sync' },
)
watch(
  () => props.selected.map((item) => item.id).join('|'),
  () => {
    const note = props.selected.find((item) => item.content.kind === 'text')
    if (note?.content.text && !text.value) {
      text.value = note.content.text
      noteSource.value = { id: note.id, port: 'bottom' }
    }
    adoptSelection()
  },
)
watch(
  () => props.contextKey,
  () => {
    noteSource.value = undefined
    previous = undefined
    for (const key of Object.keys(sourcePorts)) delete sourcePorts[key]
    for (const key of Object.keys(details)) delete details[key]
    picker.value = false
    settings.value = false
    validation.value = ''
  },
  { flush: 'sync' },
)
function structuredText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined
      ? ''
      : JSON.stringify(value, null, 2)
}
watch(connections, (value) => emit('connections', value), { immediate: true })
function choose(value: Step) {
  if (!value.available) return
  stepId.value = value.id
  picker.value = false
}
function acceptConnection(sourceId: string, port: OutputPort) {
  const source = props.items.find((item) => item.id === sourceId)
  if (!source) return
  validation.value = ''
  picker.value = false
  if (source.content.kind === 'text') {
    text.value = source.content.text || ''
    noteSource.value = { id: source.id, port }
    return
  }
  if (!source.content.assetId) return
  let field = assetFields.value.find(([key]) => acceptsAsset(key, source))?.[0]
  if (!field) {
    const compatible = props.steps.filter(
      (step) =>
        step.available &&
        Object.entries(step.inputSchema.properties || {}).some(
          ([key, schema]) =>
            (isAssetField(schema) || isAssetsField(schema)) && acceptsAsset(key, source),
        ),
    )
    const next = compatible.find((step) => step.id === 'builtin.image-edit') || compatible[0]
    if (!next) {
      validation.value = '先配置支持此素材的创作步骤'
      return
    }
    choose(next)
    field = assetFields.value.find(([key]) => acceptsAsset(key, source))?.[0]
  }
  if (field) addReference(field, source.content.assetId, port, source.id)
}
function submit(asDraft = false) {
  validation.value = ''
  if (!step.value) {
    if (text.value.trim()) {
      emit('note', text.value)
      text.value = ''
      noteSource.value = undefined
    }
    return
  }
  try {
    const inputs: Record<string, unknown> = {}
    for (const [key, schema] of Object.entries(properties.value)) {
      let value = key === primary.value ? text.value : fields.value[key]
      if (isAssetField(schema))
        value = references(key)[0] ? { assetId: references(key)[0]!.assetId } : undefined
      else if (isAssetsField(schema))
        value = references(key).length
          ? references(key).map((ref) => ({ assetId: ref.assetId }))
          : undefined
      else if (schema.type === 'number' || schema.type === 'integer') {
        value = value === '' || value === undefined ? undefined : Number(value)
        if (
          value !== undefined &&
          (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)))
        )
          throw new Error(`${schema.title || key}需要有效数字`)
      } else if (
        (schema.type === 'object' || schema.type === 'array') &&
        typeof value === 'string' &&
        value.trim()
      )
        value = JSON.parse(value)
      if (value === '' && !step.value.inputSchema.required?.includes(key)) value = undefined
      if (!asDraft && value === undefined && step.value.inputSchema.required?.includes(key))
        throw new Error(`请填写${schema.title || key}`)
      if (value !== undefined) inputs[key] = value
    }
    const snapshot = connections.value.map((connection) => ({ ...connection }))
    if (asDraft) {
      emit('draft', step.value, inputs, snapshot, referenceUses.value)
      return
    }
    const fingerprint = JSON.stringify([
      step.value.id,
      step.value.revision,
      inputs,
      referenceUses.value,
    ])
    if (!previous || previous.fingerprint !== fingerprint)
      previous = { fingerprint, key: crypto.randomUUID() }
    emit('run', step.value, inputs, previous.key, snapshot, referenceUses.value)
  } catch (e) {
    validation.value = e instanceof Error ? e.message : '请检查输入参数'
    settings.value = true
  }
}
function removeConnection(field: string, source: string) {
  const item = props.items.find((item) => item.id === source)
  if (item?.content.assetId) removeReference(field, item.content.assetId)
  else if (noteSource.value?.id === source) noteSource.value = undefined
}
function measureAnchor() {
  const box = inputPort.value?.getBoundingClientRect()
  if (box) emit('anchor', { x: box.left + box.width / 2, y: box.top + box.height / 2 })
}
function acceptNewRequest() {
  previous = undefined
}
function focus() {
  picker.value = true
  settings.value = false
  document.querySelector<HTMLTextAreaElement>('.creation-prompt')?.focus()
}
function insertPrompt(value: string) {
  text.value = value
  noteSource.value = undefined
  picker.value = false
  document.querySelector<HTMLTextAreaElement>('.creation-prompt')?.focus()
}
onMounted(() => {
  observer = new ResizeObserver(measureAnchor)
  if (dock.value) observer.observe(dock.value)
  window.addEventListener('resize', measureAnchor)
  void nextTick(measureAnchor)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', measureAnchor)
})
defineExpose({
  acceptNewRequest,
  acceptConnection,
  removeConnection,
  measureAnchor,
  focus,
  insertPrompt,
})
</script>

<template>
  <div ref="dock" class="creation-dock" data-ui>
    <Transition name="float">
      <section v-if="picker" class="step-picker floating-panel">
        <header>
          <strong>{{ __t('apps.pictoria.ui', '选择步骤') }}</strong>
          <button
            class="icon-button"
            :aria-label="__t('apps.pictoria.ui', '关闭步骤选择')"
            @click="picker = false"
          >
            <Icon name="close" :size="16" />
          </button>
        </header>
        <button
          class="step-option"
          :class="{ active: !stepId }"
          @click="
            () => {
              stepId = ''
              picker = false
            }
          "
        >
          <span class="step-symbol"><Icon name="note" /></span>
          <span>
            <strong>{{ __t('apps.pictoria.ui', '便签') }}</strong>
          </span>
          <Icon v-if="!stepId" name="check" :size="16" />
        </button>
        <button
          v-for="item in steps"
          :key="item.id"
          class="step-option"
          :class="{ active: item.id === stepId }"
          :disabled="!item.available"
          :title="item.reason"
          @click="choose(item)"
        >
          <span class="step-symbol"><Icon name="sparkle" /></span>
          <span>
            <strong>{{ stepLabel(item) }}</strong>
          </span>
          <Icon v-if="item.id === stepId" name="check" :size="16" />
        </button>
        <div v-if="!steps.length" class="step-empty">
          <button
            class="text-button"
            @click="
              () => {
                emit('configure')
                picker = false
              }
            "
          >
            {{ __t('apps.pictoria.ui', '配置模型') }}
            <Icon name="chevron" :size="13" />
          </button>
        </div>
      </section>
    </Transition>
    <Transition name="float">
      <section v-if="settings && step" class="step-fields floating-panel">
        <header>
          <strong>{{ step.name }} {{ __t('apps.pictoria.ui', '· 参数') }}</strong>
          <button
            class="icon-button"
            :aria-label="__t('apps.pictoria.ui', '收起输入配置')"
            @click="settings = false"
          >
            <Icon name="close" :size="16" />
          </button>
        </header>
        <label v-for="[key, schema] in extraFields" :key="key" class="step-field">
          <span>
            {{ schema.title || key }}
            <small v-if="step.inputSchema.required?.includes(key)">
              {{ __t('apps.pictoria.ui', '必填') }}
            </small>
          </span>
          <PictoriaSelect
            v-if="schema.enum"
            :aspect-ratio="String(fields.aspect_ratio ?? properties.aspect_ratio?.default ?? '')"
            :model-value="String(fields[key] ?? '')"
            :options="schema.enum.map((value) => ({ value: String(value), label: String(value) }))"
            :label="schema.title || key"
            @update:model-value="
              fields[key] = schema.enum?.find((value) => String(value) === $event)
            "
          />
          <input v-else-if="schema.type === 'boolean'" v-model="fields[key]" type="checkbox" />
          <input
            v-else-if="schema.type === 'number' || schema.type === 'integer'"
            v-model="fields[key]"
            type="number"
            :min="schema.minimum"
            :max="schema.maximum"
            :step="schema.type === 'integer' ? 1 : 'any'"
          />
          <textarea
            v-else-if="schema.type === 'object' || schema.type === 'array'"
            :value="structuredText(fields[key])"
            rows="3"
            :placeholder="__t('apps.pictoria.ui', '填写 JSON 结构化参数')"
            @input="fields[key] = ($event.target as HTMLTextAreaElement).value"
          />
          <textarea
            v-else
            :value="structuredText(fields[key])"
            rows="2"
            :placeholder="schema.description"
            @input="fields[key] = ($event.target as HTMLTextAreaElement).value"
          />
        </label>
      </section>
    </Transition>
    <div class="creation-topline">
      <button
        class="creation-step"
        @click="
          () => {
            picker = !picker
            settings = false
          }
        "
      >
        <Icon :name="step ? 'sparkle' : 'note'" :size="15" />
        {{ stepLabel(step) }}
        <Icon name="down" :size="13" />
      </button>
      <span class="creation-spacer" />
      <button
        v-if="step"
        class="icon-button"
        :aria-label="__t('apps.pictoria.ui', '步骤输入设置')"
        @click="
          () => {
            settings = !settings
            picker = false
          }
        "
      >
        <Icon name="settings" :size="17" />
      </button>
    </div>
    <div class="creation-body" data-composer-link>
      <button
        ref="inputPort"
        class="composer-input-port"
        data-composer-link
        :title="__t('apps.pictoria.ui', '把素材或便签连到这里')"
        :aria-label="__t('apps.pictoria.ui', '下方创作栏输入连接点')"
        @pointerdown.stop
      >
        <Icon name="link" :size="13" />
        <span>
          {{
            referenceCount
              ? __t('apps.pictoria.ui', '{0} 份参考', [referenceCount])
              : __t('apps.pictoria.ui', '连接输入')
          }}
        </span>
      </button>
      <div v-if="assetFields.length" class="composer-asset-fields">
        <section v-for="[key, schema] in assetFields" :key="key">
          <header>
            {{ schema.title || key }}
            <small v-if="step?.inputSchema.required?.includes(key)">*</small>
          </header>
          <ReferenceInput
            :owner="owner"
            :field-name="key"
            :uses="referenceUses"
            :purpose-enabled="!!step && !!referencePromptField(step.inputSchema)"
            :references="references(key)"
            :candidates="items.filter((item) => acceptsAsset(key, item))"
            :thumbnails="thumbnails"
            :multiple="isAssetsField(schema)"
            :limit="isAssetsField(schema) ? (schema.maxItems ?? 20) : 1"
            :online="online"
            @library="addLibraryReference(key, $event)"
            @add="addReference(key, $event)"
            @remove="removeReference(key, $event)"
            @move="(id, direction) => moveReference(key, id, direction)"
            @preview="emit('preview', $event)"
            @purpose="(id, purpose) => setPurpose(key, id, purpose)"
          />
        </section>
      </div>
      <div v-else-if="!step && selected.length" class="creation-references">
        <span v-for="item in selected.slice(0, 4)" :key="item.id">
          <Icon :name="item.content.kind === 'text' ? 'note' : 'image'" :size="12" />
          {{ item.content.name || __t('apps.pictoria.ui', '画布内容') }}
        </span>
        <small v-if="selected.length > 4">+{{ selected.length - 4 }}</small>
        <button
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '取消画布选择')"
          @click="emit('clear')"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>
      <textarea
        v-model="text"
        class="creation-prompt"
        :placeholder="promptPlaceholder(step)"
        maxlength="64000"
        rows="2"
        @keydown.ctrl.enter.prevent="submit()"
        @keydown.meta.enter.prevent="submit()"
      />
      <footer>
        <button
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '导入素材')"
          :title="__t('apps.pictoria.ui', '导入素材')"
          @click="emit('upload')"
        >
          <Icon name="plus" :size="20" />
        </button>
        <small v-if="referenceCount">
          {{ referenceCount }} {{ __t('apps.pictoria.ui', '份参考') }}
        </small>
        <span />
        <button v-if="step" class="text-button" :disabled="busy" @click="submit(true)">
          {{ __t('apps.pictoria.ui', '加入画布') }}
        </button>
        <kbd>Ctrl ↵</kbd>
        <button
          class="create-button"
          :disabled="busy || (step ? !online : !text.trim())"
          @click="submit()"
        >
          <Icon :name="busy ? 'refresh' : step ? 'sparkle' : 'plus'" :size="17" />
          {{
            busy
              ? __t('apps.pictoria.ui', '提交中')
              : step
                ? __t('apps.pictoria.ui', '开始创作')
                : __t('apps.pictoria.ui', '放入画布')
          }}
        </button>
      </footer>
      <p v-if="validation" class="composer-error" role="alert">{{ validation }}</p>
    </div>
  </div>
</template>
