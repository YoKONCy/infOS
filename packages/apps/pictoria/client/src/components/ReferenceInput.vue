<script setup lang="ts">
import { t as __t } from '../i18n'

import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Asset, AssetReference, CanvasItem, ReferenceUse } from '../types'
import { referencePurposeNames } from '../services/referenceUses'
import Icon from './PictoriaIcon.vue'
import AssetLibraryPicker from './AssetLibraryPicker.vue'
import PictoriaSelect from './PictoriaSelect.vue'
import { pictoria } from '../services/transport'

const props = defineProps<{
  references: AssetReference[]
  candidates: CanvasItem[]
  thumbnails: Record<string, string>
  multiple: boolean
  limit: number
  online: boolean
  owner?: string
  fieldName?: string
  purposeEnabled?: boolean
  uses?: ReferenceUse[]
}>()
const emit = defineEmits<{
  add: [assetId: string]
  library: [asset: Asset]
  remove: [assetId: string]
  move: [assetId: string, direction: number]
  preview: [assetId: string]
  purpose: [assetId: string, purpose: string]
}>()
const libraryOpen = ref(false)
const purposesOpen = ref(false)
const metadata = reactive<Record<string, Asset>>({})
const resolvedReferences = computed(() =>
  props.references.map((reference) => {
    const asset = metadata[reference.assetId]
    return asset
      ? { ...reference, name: asset.meta?.title || asset.name, mimeType: asset.mimeType }
      : reference
  }),
)
watch(
  () =>
    [props.owner, props.online, props.references.map((entry) => entry.assetId).join('|')] as const,
  async ([owner, online], _previous, onCleanup) => {
    let stale = false
    onCleanup(() => {
      stale = true
    })
    if (_previous?.[0] !== owner) for (const id of Object.keys(metadata)) delete metadata[id]
    if (!owner || !online) return
    for (const reference of props.references) {
      if (reference.mimeType || metadata[reference.assetId]) continue
      try {
        const asset = await pictoria.operation<Asset>(owner, 'asset.get', { id: reference.assetId })
        if (stale) return
        metadata[reference.assetId] = asset
        if (asset.mimeType.startsWith('image/')) emit('preview', asset.id)
      } catch {
        /* 素材暂不可用时保留已有引用，不用其他图片替换。 */
      }
    }
  },
  { immediate: true },
)
const purposeOptions = computed(() => [
  { value: '', label: __t('apps.pictoria.references', '未指定') },
  ...Object.entries(referencePurposeNames).map(([value, name]) => ({
    value,
    label: __t('apps.pictoria.references', name),
  })),
])
function purposeLabel(assetId: string) {
  const purpose = props.uses?.find(
    (entry) => entry.field === props.fieldName && entry.assetId === assetId,
  )?.purpose
  return purpose && referencePurposeNames[purpose]
    ? __t('apps.pictoria.references', referencePurposeNames[purpose])
    : ''
}
const mediaType = computed(() =>
  /image|mask|图/i.test(props.fieldName || '')
    ? 'image'
    : /video|视频/i.test(props.fieldName || '')
      ? 'video'
      : /audio|音频/i.test(props.fieldName || '')
        ? 'audio'
        : 'all',
)
const root = ref<HTMLElement | null>(null),
  open = ref(false),
  query = ref('')
const choices = computed(() => {
  const seen = new Set<string>(),
    search = query.value.trim().toLocaleLowerCase()
  return props.candidates.filter((item) => {
    const id = item.content.assetId
    if (!id || seen.has(id)) return false
    seen.add(id)
    return !search || (item.content.name || '').toLocaleLowerCase().includes(search)
  })
})
const full = computed(() => props.multiple && props.references.length >= props.limit)
function picked(id: string) {
  return props.references.some((ref) => ref.assetId === id)
}
function add(id: string) {
  if (picked(id) || full.value) return
  emit('add', id)
  if (!props.multiple) open.value = false
}
function outside(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest('.select-popover')) return
  if (root.value && !root.value.contains(event.target as Node)) {
    open.value = false
    purposesOpen.value = false
  }
}
function close() {
  open.value = false
  purposesOpen.value = false
}
function key(event: KeyboardEvent) {
  if (['Delete', 'Backspace', ' '].includes(event.key)) event.stopPropagation()
}
watch(
  () => [props.references.map((ref) => ref.assetId).join('|'), props.online],
  () => {
    if (props.online)
      for (const ref of props.references)
        if (ref.mimeType?.startsWith('image/')) emit('preview', ref.assetId)
  },
  { immediate: true },
)
watch(
  () => open.value || purposesOpen.value,
  (value) => {
    if (value) {
      window.addEventListener('pointerdown', outside, true)
      window.addEventListener('blur', close)
    } else {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', close)
    }
  },
)
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('blur', close)
})
</script>

<template>
  <div ref="root" class="reference-input" data-ui @keydown="key" @keydown.esc.stop="close">
    <div
      class="reference-strip"
      role="list"
      :aria-label="__t('apps.pictoria.ui', '按顺序排列的参考素材')"
    >
      <div
        v-for="(reference, index) in resolvedReferences"
        :key="reference.assetId"
        class="reference-tile"
        role="listitem"
        :title="`${index + 1}. ${reference.name}`"
      >
        <img
          v-if="thumbnails[reference.assetId] && reference.mimeType?.startsWith('image/')"
          :src="thumbnails[reference.assetId]"
          :alt="reference.name"
          draggable="false"
        />
        <Icon
          v-else
          :name="
            reference.mimeType?.startsWith('video/')
              ? 'play'
              : reference.mimeType?.startsWith('audio/')
                ? 'sound'
                : 'image'
          "
          :size="19"
        />
        <b class="reference-number">{{ index + 1 }}</b>
        <span
          v-if="purposeLabel(reference.assetId)"
          class="reference-purpose-badge"
          :title="purposeLabel(reference.assetId)"
        >
          {{ purposeLabel(reference.assetId) }}
        </span>
        <button
          class="reference-remove"
          :aria-label="__t('apps.pictoria.ui', '移除参考 {0}：{1}', [index + 1, reference.name])"
          :title="__t('apps.pictoria.ui', '移除引用')"
          @click="emit('remove', reference.assetId)"
        >
          <Icon name="close" :size="11" />
        </button>
        <div v-if="multiple && references.length > 1" class="reference-order">
          <button
            :disabled="!index"
            :aria-label="__t('apps.pictoria.ui', '前移参考 {0}', [index + 1])"
            :title="__t('apps.pictoria.ui', '前移')"
            @click="emit('move', reference.assetId, -1)"
          >
            ←
          </button>
          <button
            :disabled="index === references.length - 1"
            :aria-label="__t('apps.pictoria.ui', '后移参考 {0}', [index + 1])"
            :title="__t('apps.pictoria.ui', '后移')"
            @click="emit('move', reference.assetId, 1)"
          >
            →
          </button>
        </div>
      </div>
      <span v-if="!references.length" class="reference-empty">
        <Icon name="link" :size="14" />
        {{ __t('apps.pictoria.ui', '连接或添加素材') }}
      </span>
    </div>
    <div class="reference-toolbar">
      <button
        v-if="
          purposeEnabled && resolvedReferences.some((entry) => entry.mimeType?.startsWith('image/'))
        "
        class="reference-add"
        :aria-expanded="purposesOpen"
        @click="
          () => {
            purposesOpen = !purposesOpen
            open = false
          }
        "
      >
        {{ __t('apps.pictoria.references', '用途') }}
      </button>
      <button
        class="reference-add"
        :aria-expanded="open"
        @click="
          () => {
            open = !open
            purposesOpen = false
            query = ''
          }
        "
      >
        <Icon name="plus" :size="12" />
        {{
          full
            ? __t('apps.pictoria.ui', '查看素材')
            : multiple
              ? __t('apps.pictoria.ui', '添加参考')
              : references.length
                ? __t('apps.pictoria.ui', '更换素材')
                : __t('apps.pictoria.ui', '添加素材')
        }}
      </button>
      <button
        v-if="owner"
        class="reference-add"
        :disabled="!online || full"
        @click="
          () => {
            open = false
            purposesOpen = false
            libraryOpen = true
          }
        "
      >
        <Icon name="image" :size="12" />
        {{ __t('apps.pictoria.ui', '资源库') }}
      </button>
      <small>
        {{ references.length }} / {{ limit }}{{ full ? __t('apps.pictoria.ui', ' · 已满') : '' }}
      </small>
    </div>
    <section
      v-if="purposesOpen && purposeEnabled"
      class="reference-purpose-picker floating-panel"
      @pointerdown.stop
    >
      <header>
        <strong>{{ __t('apps.pictoria.references', '参考图用途') }}</strong>
        <button
          class="icon-button"
          :aria-label="__t('apps.pictoria.ui', '关闭')"
          @click="purposesOpen = false"
        >
          <Icon name="close" :size="13" />
        </button>
      </header>
      <label
        v-for="reference in resolvedReferences.filter((entry) =>
          entry.mimeType?.startsWith('image/'),
        )"
        :key="reference.assetId"
      >
        <span>{{ reference.name }}</span>
        <PictoriaSelect
          :label="__t('apps.pictoria.references', '参考图用途')"
          :options="purposeOptions"
          :model-value="
            uses?.find((entry) => entry.field === fieldName && entry.assetId === reference.assetId)
              ?.purpose || ''
          "
          @update:model-value="emit('purpose', reference.assetId, $event)"
        />
      </label>
      <small>
        {{ __t('apps.pictoria.references', '用途说明随提示词发送，具体约束取决于模型。') }}
      </small>
    </section>
    <AssetLibraryPicker
      v-if="libraryOpen && owner"
      :owner="owner"
      :selected="references.map((item) => item.assetId)"
      :multiple="multiple"
      :limit="limit"
      :type="mediaType"
      @select="emit('library', $event)"
      @close="libraryOpen = false"
    />
    <Transition name="float">
      <div v-if="open" class="reference-picker floating-panel">
        <label class="reference-search">
          <Icon name="search" :size="13" />
          <input
            v-model="query"
            :placeholder="__t('apps.pictoria.ui', '搜索画布素材…')"
            :aria-label="__t('apps.pictoria.ui', '搜索画布素材')"
          />
        </label>
        <div class="reference-choices">
          <button
            v-for="item in choices"
            :key="item.id"
            class="reference-choice"
            :class="{ picked: picked(item.content.assetId!) }"
            :disabled="picked(item.content.assetId!) || full"
            @click="add(item.content.assetId!)"
          >
            <Icon
              :name="
                item.content.mimeType?.startsWith('video/')
                  ? 'play'
                  : item.content.mimeType?.startsWith('audio/')
                    ? 'sound'
                    : 'image'
              "
              :size="14"
            />
            <span>{{ item.content.name || __t('apps.pictoria.ui', '未命名素材') }}</span>
            <Icon :name="picked(item.content.assetId!) ? 'check' : 'plus'" :size="13" />
          </button>
          <p v-if="!choices.length">
            {{
              query
                ? __t('apps.pictoria.ui', '没有匹配的素材')
                : __t('apps.pictoria.ui', '先导入素材到画布')
            }}
          </p>
        </div>
        <small v-if="full">
          {{ __t('apps.pictoria.ui', '最多') }} {{ limit }} {{ __t('apps.pictoria.ui', '份') }}
        </small>
      </div>
    </Transition>
  </div>
</template>
