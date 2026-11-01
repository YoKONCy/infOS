<script setup lang="ts">
import { t as __t } from '../i18n'

import { computed, reactive, watch } from 'vue'
import type { Asset, CanvasItem, CanvasEdge, FieldSchema } from '../types'
import {
  inputFields,
  cardFields,
  canConnect,
  isAssetField,
  isAssetsField,
  acceptsAsset,
  assetReferences,
  draftHeight,
  fieldHeight,
  topPortX,
} from '../composables/useCanvasLinks'
import Icon from './PictoriaIcon.vue'
import ReferenceInput from './ReferenceInput.vue'
import { referencePromptField } from '../../../src/creativeInputs'
import { setReferenceUse } from '../services/referenceUses'
import PictoriaSelect from './PictoriaSelect.vue'
import { promptPlaceholder, stepLabel } from '../services/labels'
import NodeAnnotation from './NodeAnnotation.vue'
const props = defineProps<{
  item: CanvasItem
  items: CanvasItem[]
  edges: CanvasEdge[]
  thumbnails: Record<string, string>
  modelName?: string
  owner: string
  selected: boolean
  busy: boolean
  online: boolean
  outdated: boolean
}>()
const emit = defineEmits<{
  pointer: [event: PointerEvent]
  checkpoint: []
  submit: []
  refresh: []
  disconnect: [id: string]
  connect: [source: string, field: string]
  removeReference: [field: string, assetId: string]
  reorderReference: [field: string, assetId: string, direction: number]
  preview: [assetId: string]
  content: [patch: Partial<CanvasItem['content']>]
}>()
const fields = computed(() => cardFields(props.item))
const ports = computed(() => inputFields(props.item).filter(([, field]) => canConnect(field)))
const hasAdvanced = computed(() => inputFields(props.item).some(([, field]) => !canConnect(field)))
function toggleAdvanced() {
  emit('checkpoint')
  emit('content', { showAdvanced: !props.item.content.showAdvanced })
}
watch(
  () => draftHeight(props.item),
  (height) => {
    if (height !== props.item.content.height) emit('content', { height })
  },
  { immediate: true },
)
const references = (name: string) =>
  props.edges.filter(
    (edge) => edge.target === props.item.id && edge.field === name && !edge.historical,
  )
const libraryDetails = reactive<Record<string, Asset>>({})
const assets = (name: string) =>
  assetReferences(props.item, name, props.items, props.edges).map((reference) =>
    libraryDetails[reference.assetId]
      ? {
          ...reference,
          name:
            libraryDetails[reference.assetId]!.meta?.title ||
            libraryDetails[reference.assetId]!.name,
          mimeType: libraryDetails[reference.assetId]!.mimeType,
        }
      : reference,
  )
const sourceName = (id: string) =>
  props.items.find((item) => item.id === id)?.content.name || '画布内容'
const value = (name: string) => props.item.content.inputs?.[name]
function setValue(name: string, value: unknown, remove = false) {
  const inputs = { ...props.item.content.inputs }
  if (remove) delete inputs[name]
  else inputs[name] = value
  emit('content', { inputs })
}
function set(name: string, event: Event, field: FieldSchema) {
  const target = event.target as HTMLInputElement
  if (field.enum) {
    setValue(
      name,
      field.enum.find((value) => String(value) === target.value),
    )
    return
  }
  if (target.value === '' && field.type !== 'string') {
    setValue(name, undefined, true)
    return
  }
  setValue(
    name,
    field.type === 'boolean'
      ? target.checked
      : ['integer', 'number'].includes(field.type || '')
        ? Number(target.value)
        : target.value,
  )
}
function pickAsset(name: string, id: string) {
  if (!id) return
  const source = props.items.find((item) => item.content.assetId === id)
  if (source) emit('connect', source.id, name)
}
function pickLibrary(name: string, asset: Asset) {
  const field = props.item.content.step?.inputSchema.properties?.[name]
  if (!field) return
  const current = assets(name)
  if (
    current.some((reference) => reference.assetId === asset.id) ||
    (isAssetsField(field) && current.length >= (field.maxItems ?? 20))
  )
    return
  emit('checkpoint')
  if (!isAssetsField(field)) for (const edge of references(name)) emit('disconnect', edge.id)
  setValue(
    name,
    isAssetsField(field)
      ? [...current.map((reference) => ({ assetId: reference.assetId })), { assetId: asset.id }]
      : { assetId: asset.id },
  )
  libraryDetails[asset.id] = asset
  emit('preview', asset.id)
}
function structured(name: string, event: Event) {
  const target = event.target as HTMLTextAreaElement
  try {
    setValue(name, target.value.trim() ? JSON.parse(target.value) : undefined)
    target.setCustomValidity('')
  } catch {
    target.setCustomValidity(__t('apps.pictoria.ui', '请填写有效的 JSON'))
    target.reportValidity()
  }
}
</script>
<template>
  <article
    class="canvas-card card-draft"
    :data-canvas-item="item.id"
    :class="{ selected }"
    :style="{
      width: `${item.content.width}px`,
      height: `${item.content.height}px`,
      transform: `translate(${item.x}px, ${item.y}px)`,
    }"
    @pointerdown.stop="emit('pointer', $event)"
  >
    <NodeAnnotation
      :text="item.content.comment"
      :selected="selected"
      @save="
        ($event) => {
          emit('checkpoint')
          emit('content', { comment: $event })
        }
      "
    />
    <header class="draft-heading">
      <span class="draft-symbol"><Icon name="sparkle" :size="18" /></span>
      <div>
        <strong :title="stepLabel(item.content.step, modelName)">
          {{ stepLabel(item.content.step, modelName) }}
        </strong>
      </div>
      <span class="draft-label">{{ __t('apps.pictoria.ui', '待执行') }}</span>
    </header>
    <button
      v-for="[name, field] in ports"
      :key="`top-${name}`"
      class="input-port input-port-top"
      :class="{ linked: references(name).length }"
      :style="{ left: `${topPortX(item, name)}px` }"
      :data-link-target="item.id"
      :data-link-field="name"
      data-link-port="top"
      :title="__t('apps.pictoria.ui', '{0}输入', [field.title || name])"
      :aria-label="__t('apps.pictoria.ui', '{0}顶部连接点', [field.title || name])"
      @pointerdown.stop
    >
      <span class="port-caption">{{ field.title || name }}</span>
    </button>
    <div class="draft-inputs" data-ui>
      <div
        v-for="[name, field] in fields"
        :key="name"
        class="draft-field"
        :style="{ height: `${fieldHeight(field)}px` }"
      >
        <button
          v-if="canConnect(field)"
          class="input-port"
          :class="{ linked: references(name).length }"
          :data-link-target="item.id"
          :data-link-field="name"
          :title="__t('apps.pictoria.ui', '把素材或文字连到{0}', [field.title || name])"
          :aria-label="__t('apps.pictoria.ui', '{0}输入连接点', [field.title || name])"
          @pointerdown.stop
        />
        <div class="draft-field-content">
          <span class="draft-field-title">
            {{ field.title || name }}
            <small v-if="item.content.step?.inputSchema.required?.includes(name)">*</small>
          </span>
          <ReferenceInput
            v-if="isAssetField(field) || isAssetsField(field)"
            :owner="owner"
            :field-name="name"
            :uses="item.content.referenceUses"
            :purpose-enabled="
              !!item.content.step && !!referencePromptField(item.content.step.inputSchema)
            "
            :references="assets(name)"
            :candidates="items.filter((item) => acceptsAsset(name, item))"
            :thumbnails="thumbnails"
            :multiple="isAssetsField(field)"
            :limit="isAssetsField(field) ? (field.maxItems ?? 20) : 1"
            :online="online"
            @library="pickLibrary(name, $event)"
            @add="pickAsset(name, $event)"
            @remove="emit('removeReference', name, $event)"
            @move="(id, direction) => emit('reorderReference', name, id, direction)"
            @preview="emit('preview', $event)"
            @purpose="
              (id, purpose) => {
                emit('checkpoint')
                emit('content', {
                  referenceUses: setReferenceUse(
                    item.content.referenceUses || [],
                    name,
                    id,
                    purpose,
                  ),
                })
              }
            "
          />
          <span v-else-if="references(name).length" class="draft-reference-list">
            <span v-for="edge in references(name)" :key="edge.id" class="draft-reference">
              <span>{{ sourceName(edge.source) }}</span>
              <button
                :title="__t('apps.pictoria.ui', '断开引用')"
                :aria-label="__t('apps.pictoria.ui', '断开引用')"
                @click="emit('disconnect', edge.id)"
              >
                <Icon name="close" :size="11" />
              </button>
            </span>
          </span>
          <PictoriaSelect
            v-else-if="field.enum"
            :aspect-ratio="
              String(
                value('aspect_ratio') ??
                  item.content.step?.inputSchema.properties?.aspect_ratio?.default ??
                  '',
              )
            "
            :model-value="String(value(name) ?? field.default ?? '')"
            :options="
              field.enum.map((option) => ({ value: String(option), label: String(option) }))
            "
            :label="field.title || name"
            @focus="emit('checkpoint')"
            @update:model-value="
              setValue(
                name,
                field.enum?.find((option) => String(option) === $event),
              )
            "
          />
          <input
            v-else-if="field.type === 'boolean'"
            type="checkbox"
            :checked="Boolean(value(name))"
            @focus="emit('checkpoint')"
            @change="set(name, $event, field)"
          />
          <input
            v-else-if="field.type === 'integer' || field.type === 'number'"
            type="number"
            :value="value(name) as number"
            :min="field.minimum"
            :max="field.maximum"
            :step="field.type === 'integer' ? 1 : 'any'"
            @focus="emit('checkpoint')"
            @input="set(name, $event, field)"
          />
          <textarea
            v-else-if="field.type === 'object' || field.type === 'array'"
            :value="value(name) ? JSON.stringify(value(name)) : ''"
            rows="1"
            placeholder="JSON"
            @focus="emit('checkpoint')"
            @change="structured(name, $event)"
          />
          <textarea
            v-else
            :value="(value(name) as string) || ''"
            :maxlength="field.maxLength || 64000"
            :placeholder="promptPlaceholder(item.content.step)"
            rows="1"
            @focus="emit('checkpoint')"
            @input="set(name, $event, field)"
          />
        </div>
      </div>
    </div>
    <footer data-ui>
      <button v-if="outdated" class="text-button" @click="emit('refresh')">
        {{ __t('apps.pictoria.ui', '更新配置') }}
      </button>
      <button
        v-else-if="hasAdvanced"
        class="text-button"
        :aria-expanded="Boolean(item.content.showAdvanced)"
        @click="toggleAdvanced"
      >
        <Icon name="settings" :size="13" />
        {{
          item.content.showAdvanced
            ? __t('apps.pictoria.ui', '收起参数')
            : __t('apps.pictoria.ui', '参数')
        }}
      </button>
      <span v-else />
      <button class="create-button" :disabled="busy || !online || outdated" @click="emit('submit')">
        <Icon :name="busy ? 'refresh' : 'sparkle'" :size="15" />
        {{ busy ? __t('apps.pictoria.ui', '提交中') : __t('apps.pictoria.ui', '生成') }}
      </button>
    </footer>
  </article>
</template>
