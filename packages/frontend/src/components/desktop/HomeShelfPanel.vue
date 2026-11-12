<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { HomeScope, HomeShelfItem } from '@infos/shared'
import { apiClient } from '../../api'
import { t } from '../../i18n'
import { useHomeCollection } from '../../composables/useHomeCollection'
import { MotionCollapse, MotionList, MotionSkeleton } from '../motion'
import { PixelIcon } from '../pixel'
import { formatBytes } from './home/homeFormat'
import { fileBase64, shelfBlob } from './homeShelfFiles'

const props = defineProps<{ scope: HomeScope | null; refreshKey?: number }>()
const emit = defineEmits<{ changed: [] }>()
const { items, busy, error, execute, refresh, key } = useHomeCollection<HomeShelfItem>(
  () => props.scope,
  'shelf',
)
const title = ref(''),
  text = ref(''),
  showDeleted = ref(false),
  dragging = ref(false),
  writing = ref(false)
type Feedback = { source: string; args?: unknown[] }
const uploading = ref(false),
  localError = shallowRef<Feedback | null>(null),
  notice = shallowRef<Feedback | null>(null)
const input = ref<HTMLInputElement>()
const selected = shallowRef<(HomeShelfItem & { content?: string }) | null>(null)
const preview = ref(''),
  isImage = ref(false)
const disabled = computed(() => !props.scope || busy.value || uploading.value)
const visible = computed(() =>
  items.value.filter((item) => (showDeleted.value ? Boolean(item.deletedAt) : !item.deletedAt)),
)
const tr = (source: string, args: unknown[] = []) => t('home.shelf', source, args)
// 「已递给她」这类轻提示几秒后自己收起
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(notice, (value) => {
  clearTimeout(noticeTimer)
  if (value) noticeTimer = setTimeout(() => (notice.value = null), 4000)
})
onScopeDispose(() => clearTimeout(noticeTimer))

function clearPreview() {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = ''
  selected.value = null
}
watch(key, () => {
  clearPreview()
  title.value = ''
  text.value = ''
  localError.value = null
  notice.value = null
})
watch(
  () => props.refreshKey,
  () => void refresh(),
)
onScopeDispose(clearPreview)

async function changed() {
  await refresh()
  emit('changed')
}
async function giveText(value = text.value, name = title.value) {
  if (disabled.value || !value.trim()) return
  localError.value = null
  notice.value = null
  const result = await execute<HomeShelfItem>({
    action: 'put',
    kind: 'text',
    name: name.trim() || value.trim().slice(0, 80),
    value,
  })
  if (result) {
    title.value = ''
    text.value = ''
    writing.value = false
    notice.value = { source: '已经递给她了。' }
    await changed()
  }
}
async function giveFiles(files: File[]) {
  if (disabled.value || !files.length) return
  uploading.value = true
  localError.value = null
  notice.value = null
  const owner = key.value
  let added = 0
  try {
    const settings = (await apiClient.get<{ values: { fileMaxBytes: number } }>('/home/settings'))
      .data
    for (const file of files) {
      if (key.value !== owner) return
      // base64 的传输硬上限为 44 MiB，同时遵守后端当前的单件上限。
      if (
        file.size > Math.min(settings?.values.fileMaxBytes ?? 32 * 1024 * 1024, 33 * 1024 * 1024)
      ) {
        localError.value = { source: '文件过大：{0}。请缩小后再试。', args: [file.name] }
        break
      }
      const content = await fileBase64(file)
      if (key.value !== owner) return
      const result = await execute<HomeShelfItem>({
        action: 'put',
        kind: file.type.startsWith('image/') ? 'image' : 'file',
        name: file.name,
        content,
      })
      if (!result) {
        localError.value = { source: '文件读取或上传失败，请重试。' }
        break
      }
      added++
    }
    if (key.value === owner && added) {
      notice.value = { source: '已递给她 {0} 件物品。', args: [added] }
      await changed()
    }
  } catch {
    if (key.value === owner) localError.value = { source: '文件读取或上传失败，请重试。' }
  } finally {
    uploading.value = false
    if (input.value) input.value.value = ''
  }
}
function drop(event: DragEvent) {
  dragging.value = false
  const transfer = event.dataTransfer
  if (!transfer || disabled.value) return
  if (transfer.files.length) void giveFiles(Array.from(transfer.files))
  else void giveText(transfer.getData('text/plain'))
}
async function view(item: HomeShelfItem) {
  clearPreview()
  const result = await execute<HomeShelfItem & { content?: string }>({
    action: 'take',
    id: item.id,
  })
  if (!result) return
  selected.value = result
  if (result.content !== undefined) {
    const blob = shelfBlob(result.content)
    preview.value = URL.createObjectURL(blob)
    isImage.value = blob.type.startsWith('image/')
  }
}
async function mutate(item: HomeShelfItem, action: 'delete' | 'restore') {
  const result = await execute({ action, id: item.id })
  if (result) {
    clearPreview()
    await changed()
  }
}
function shelfKindIcon(kind: HomeShelfItem['kind']): string {
  if (kind === 'text') return 'quote'
  if (kind === 'image') return 'image'
  return 'file'
}
</script>

<template>
  <section class="home-panel home-shelf">
    <header>
      <div class="panel-brand">
        <span class="panel-emblem" aria-hidden="true">
          <PixelIcon name="inbox" size="sm" />
        </span>
        <div>
          <div class="panel-title-row">
            <h4>{{ tr('置物架') }}</h4>
            <span v-if="scope" class="panel-count">{{ visible.length }}</span>
          </div>
          <p class="home-muted">
            {{ tr('你们互相递东西的地方。拖进来就是给她，她给你的也放在这里。') }}
          </p>
        </div>
      </div>
      <button type="button" class="mech-btn" :disabled="disabled" @click="refresh">
        <PixelIcon name="refresh" size="xs" :animation="busy ? 'spin' : ''" />
        <span>{{ tr('刷新') }}</span>
      </button>
    </header>

    <div v-if="!scope" class="home-empty-state">
      <span class="home-empty-state__icon" aria-hidden="true">
        <PixelIcon name="chat" size="sm" />
      </span>
      <p>{{ tr('先在上面选一段对话。') }}</p>
    </div>

    <div
      class="dropzone"
      :class="{ dragging, disabled: !scope }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="drop"
    >
      <div class="dropzone-lead">
        <span class="dropzone-icon" aria-hidden="true">
          <PixelIcon :name="uploading ? 'loader' : 'download'" size="sm" :animation="uploading ? 'spin' : ''" />
        </span>
        <span class="dropzone-text">
          <strong>{{ tr('拖文件或文字到这里，就是给她。') }}</strong>
          <small v-if="uploading" role="status">{{ tr('正在递给她…') }}</small>
        </span>
      </div>
      <span class="dropzone-actions">
        <button
          type="button"
          class="mech-btn"
          :class="{ 'is-active': writing }"
          :disabled="disabled"
          @click="writing = !writing"
        >
          <PixelIcon :name="writing ? 'chevron-up' : 'pencil'" size="xs" />
          <span>{{ writing ? tr('收起') : tr('写几句给她') }}</span>
        </button>
        <button
          type="button"
          class="mech-btn mech-btn--split mech-btn--primary"
          :disabled="disabled"
          @click="input?.click()"
        >
          <span class="mech-btn__chamber" aria-hidden="true">
            <PixelIcon
              :name="uploading ? 'loader' : 'folder'"
              size="xs"
              :animation="uploading ? 'spin' : ''"
            />
          </span>
          <span class="mech-btn__label">{{ tr('选择文件') }}</span>
        </button>
      </span>
      <input
        ref="input"
        type="file"
        multiple
        hidden
        :disabled="disabled"
        @change="giveFiles(Array.from(($event.target as HTMLInputElement).files ?? []))"
      />
    </div>

    <MotionCollapse :open="writing">
      <form class="give-text" @submit.prevent="giveText()">
        <label>
          {{ tr('起个名字（可不填）') }}
          <input v-model="title" maxlength="200" :disabled="disabled" />
        </label>
        <label>
          {{ tr('想递给她的文字') }}
          <textarea v-model="text" rows="3" maxlength="65536" :disabled="disabled" />
        </label>
        <div class="actions">
          <button
            type="submit"
            class="mech-btn mech-btn--split mech-btn--primary"
            :disabled="disabled || !text.trim()"
          >
            <span class="mech-btn__chamber" aria-hidden="true">
              <PixelIcon name="send" size="xs" />
            </span>
            <span class="mech-btn__label">{{ tr('给她') }}</span>
          </button>
        </div>
      </form>
    </MotionCollapse>

    <Transition name="motion-rise">
      <p v-if="error || localError" role="alert" class="home-error">
        {{ error || (localError && tr(localError.source, localError.args)) }}
      </p>
    </Transition>
    <Transition name="motion-rise">
      <p v-if="notice" role="status" class="home-ok">{{ tr(notice.source, notice.args) }}</p>
    </Transition>

    <div v-if="scope" class="toolbar">
      <label class="check" :class="{ 'is-checked': showDeleted }">
        <input v-model="showDeleted" type="checkbox" />
        <span class="check-box" aria-hidden="true">
          <PixelIcon v-if="showDeleted" name="check" size="xs" />
        </span>
        <PixelIcon name="trash" size="xs" />
        <span>{{ tr('看已删除的') }}</span>
      </label>
    </div>

    <MotionSkeleton v-if="scope && busy && !items.length" :rows="2" />
    <div v-else-if="scope && !visible.length" class="home-empty-state">
      <span class="home-empty-state__icon" aria-hidden="true">
        <PixelIcon :name="showDeleted ? 'trash' : 'archive'" size="sm" />
      </span>
      <p>{{ showDeleted ? tr('没有删掉的东西。') : tr('置物架还是空的。') }}</p>
    </div>

    <MotionList tag="ul" class="home-list">
      <li v-for="item in visible" :key="item.id" class="item">
        <span class="item-badge item-badge--sky" aria-hidden="true">
          <PixelIcon :name="shelfKindIcon(item.kind)" size="xs" />
        </span>
        <div class="item-name">
          <strong>{{ item.name }}</strong>
          <small class="item-meta">
            <span
              class="item-chip"
              :class="item.from === 'user' ? 'item-chip--user' : 'item-chip--agent'"
            >
              {{ item.from === 'user' ? tr('你给她的') : tr('她给你的') }}
            </span>
            <span>{{ formatBytes(item.size) }}</span>
          </small>
        </div>
        <span class="home-row-actions">
          <button
            v-if="!item.deletedAt"
            type="button"
            class="mech-btn mech-btn--sm"
            :disabled="disabled"
            @click="view(item)"
          >
            <PixelIcon name="eye" size="xs" />
            <span>{{ tr('查看') }}</span>
          </button>
          <button
            type="button"
            class="mech-btn mech-btn--sm"
            :class="{ 'mech-btn--danger': !item.deletedAt }"
            :disabled="disabled"
            @click="mutate(item, item.deletedAt ? 'restore' : 'delete')"
          >
            <PixelIcon :name="item.deletedAt ? 'repeat' : 'trash'" size="xs" />
            <span>{{ item.deletedAt ? tr('恢复') : tr('删除') }}</span>
          </button>
        </span>
      </li>
    </MotionList>

    <Transition name="motion-rise">
      <section v-if="selected" class="preview" :aria-label="tr('物品内容')">
        <header>
          <strong>{{ selected.name }}</strong>
          <button type="button" class="mech-btn mech-btn--sm" @click="clearPreview">
            <PixelIcon name="close" size="xs" />
            <span>{{ tr('关闭') }}</span>
          </button>
        </header>
        <pre v-if="selected.value !== undefined">{{ selected.value }}</pre>
        <img v-if="preview && isImage" :src="preview" :alt="selected.name" />
        <a
          v-if="preview"
          class="preview-download"
          :href="preview"
          :download="selected.name.replace(/[/\\]/g, '_')"
        >
          <PixelIcon name="download" size="xs" />
          <span>{{ tr('下载文件') }}</span>
        </a>
      </section>
    </Transition>
  </section>
</template>

<style scoped src="./home/homePanel.css"></style>
<style scoped src="./homePanels.css"></style>
