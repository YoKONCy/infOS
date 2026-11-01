<script setup lang="ts">
import { t as __t } from '../i18n'

import { computed, nextTick, ref, watch } from 'vue'
import type { CanvasItem, OutputPort } from '../types'
import Icon from './PictoriaIcon.vue'
import NodeAnnotation from './NodeAnnotation.vue'
const props = defineProps<{
  item: CanvasItem
  selected: boolean
  url?: string
  missing?: boolean
  candidateCount?: number
}>()
const emit = defineEmits<{
  pointer: [event: PointerEvent]
  resize: [event: PointerEvent]
  text: [value: string]
  comment: [value: string]
  edit: []
  cancel: []
  recover: []
  candidates: []
  connect: [event: PointerEvent, port: OutputPort]
}>()
const editing = ref(false)
const editor = ref<HTMLTextAreaElement | null>(null)
watch(editing, async (value) => {
  if (value) {
    await nextTick()
    editor.value?.focus()
  }
})
const caption = computed(() => props.item.content.name || __t('apps.pictoria.ui', '未命名素材'))
const video = computed(() => props.item.content.mimeType?.startsWith('video/'))
const audio = computed(() => props.item.content.mimeType?.startsWith('audio/'))
const states: Record<string, string> = {
  queued: '已加入创作队列',
  running: '正在创作',
  waiting: '需要确认执行状态',
  completed: '创作完成',
  partial: '部分完成',
  failed: '创作未完成',
  cancelled: '已取消',
}
</script>
<template>
  <article
    class="canvas-card"
    :data-canvas-item="item.id"
    :class="[`card-${item.content.kind}`, { selected }]"
    :style="{
      width: `${item.content.width}px`,
      height: `${item.content.height}px`,
      transform: `translate(${item.x}px, ${item.y}px)`,
    }"
    @pointerdown.stop="emit('pointer', $event)"
    @dblclick.stop="item.content.kind === 'text' ? ((editing = true), emit('edit')) : undefined"
  >
    <NodeAnnotation
      :text="item.content.comment"
      :selected="selected"
      @save="
        ($event) => {
          emit('edit')
          emit('comment', $event)
        }
      "
    />
    <div v-if="item.content.kind === 'text'" class="text-card-content">
      <span class="note-eyebrow">
        <Icon name="note" :size="13" />
        {{ __t('apps.pictoria.ui', '灵感便签') }}
      </span>
      <textarea
        v-if="editing"
        ref="editor"
        :value="item.content.text"
        maxlength="64000"
        :placeholder="__t('apps.pictoria.ui', '写下一个想法…')"
        @input="emit('text', ($event.target as HTMLTextAreaElement).value)"
        @blur="editing = false"
        @keydown.esc.stop="editing = false"
      />
      <p v-else :class="{ empty: !item.content.text }">
        {{ item.content.text || __t('apps.pictoria.ui', '双击，写下一个想法…') }}
      </p>
    </div>
    <div
      v-else-if="item.content.kind === 'run'"
      class="run-card-content"
      :class="{ 'is-recovering': item.content.state === 'queued' && item.content.error }"
    >
      <div
        class="run-orbit"
        :class="{ spinning: ['queued', 'running'].includes(item.content.state || '') }"
      >
        <Icon :name="item.content.state === 'completed' ? 'check' : 'sparkle'" :size="25" />
      </div>
      <strong>{{ item.content.name }}</strong>
      <span>{{ states[item.content.state || 'queued'] || item.content.state }}</span>
      <p v-if="item.content.error" class="run-error">{{ item.content.error }}</p>
      <div class="run-card-actions">
        <button
          v-if="(candidateCount || 0) > 1"
          class="text-button"
          @pointerdown.stop
          @click.stop="emit('candidates')"
        >
          {{ __t('apps.pictoria.studio', '候选图') }} · {{ candidateCount }}
        </button>
        <button
          v-if="['waiting', 'failed', 'partial'].includes(item.content.state || '')"
          class="text-button"
          @click.stop="emit('recover')"
        >
          {{ __t('apps.pictoria.ui', '恢复任务') }}
        </button>
        <button
          v-if="!['completed', 'partial', 'failed', 'cancelled'].includes(item.content.state || '')"
          class="text-button"
          @click.stop="emit('cancel')"
        >
          {{ __t('apps.pictoria.ui', '取消创作') }}
        </button>
      </div>
    </div>
    <template v-else>
      <div class="asset-body" :class="{ 'audio-body': audio }">
        <video v-if="url && video" :src="url" controls preload="metadata" @pointerdown.stop />
        <audio v-else-if="url && audio" :src="url" controls preload="metadata" @pointerdown.stop />
        <img v-else-if="url" :src="url" :alt="caption" draggable="false" />
        <div v-else class="asset-placeholder">
          <Icon :name="video ? 'play' : audio ? 'sound' : 'image'" :size="27" />
          <span>
            {{
              missing
                ? __t('apps.pictoria.ui', '预览暂不可用')
                : __t('apps.pictoria.ui', '正在载入素材')
            }}
          </span>
        </div>
      </div>
      <footer>
        <span>{{ caption }}</span>
        <button
          v-if="(candidateCount || 0) > 1"
          class="candidate-card-count"
          @pointerdown.stop
          @click.stop="emit('candidates')"
        >
          <Icon name="layers" :size="12" />
          <span>{{ __t('apps.pictoria.studio', '候选图') }} · {{ candidateCount }}</span>
        </button>
        <small v-else>{{ video ? 'VIDEO' : audio ? 'AUDIO' : 'IMAGE' }}</small>
      </footer>
    </template>
    <template v-if="item.content.kind === 'asset' || item.content.kind === 'text'">
      <button
        class="output-port"
        :class="{ visible: selected }"
        :title="__t('apps.pictoria.ui', '拖到步骤或下方创作栏')"
        :aria-label="__t('apps.pictoria.ui', '从右侧拖动引用连线')"
        @pointerdown.stop="emit('connect', $event, 'right')"
      >
        <span />
      </button>
      <button
        class="output-port output-port-bottom"
        :class="{ visible: selected }"
        :title="__t('apps.pictoria.ui', '拖到步骤或下方创作栏')"
        :aria-label="__t('apps.pictoria.ui', '从下方拖动引用连线')"
        @pointerdown.stop="emit('connect', $event, 'bottom')"
      >
        <span />
      </button>
    </template>
    <span
      v-if="selected"
      class="card-resize-handle"
      :aria-label="__t('apps.pictoria.ui', '调整大小')"
      @pointerdown.stop="emit('resize', $event)"
    />
  </article>
</template>
