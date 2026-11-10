<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { HomeScope, HomeShelfItem } from '@infos/shared'
import { apiClient } from '../../api'
import { t } from '../../i18n'
import { useHomeCollection } from '../../composables/useHomeCollection'
import { MotionCollapse, MotionList, MotionSkeleton } from '../motion'
import { PButton } from '../pixel'
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
</script>

<template>
  <section class="home-panel home-shelf">
    <header>
      <div>
        <h4>{{ tr('置物架') }}</h4>
        <p class="home-muted">{{ tr('你们互相递东西的地方。拖进来就是给她，她给你的也放在这里。') }}</p>
      </div>
      <PButton size="sm" variant="ghost" :disabled="disabled" :loading="busy" @click="refresh">
        {{ tr('刷新') }}
      </PButton>
    </header>
    <p v-if="!scope" class="home-empty">{{ tr('先在上面选一段对话。') }}</p>
    <div
      class="dropzone"
      :class="{ dragging, disabled: !scope }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="drop"
    >
      <span class="dropzone-text">
        <strong>{{ tr('拖文件或文字到这里，就是给她。') }}</strong>
        <small v-if="uploading" role="status">{{ tr('正在递给她…') }}</small>
      </span>
      <span class="dropzone-actions">
        <PButton size="sm" variant="ghost" :disabled="disabled" @click="writing = !writing">
          {{ writing ? tr('收起') : tr('写几句给她') }}
        </PButton>
        <PButton
          size="sm"
          variant="secondary"
          :disabled="disabled"
          :loading="uploading"
          @click="input?.click()"
        >
          {{ tr('选择文件') }}
        </PButton>
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
          <PButton type="submit" size="sm" :disabled="disabled || !text.trim()">
            {{ tr('给她') }}
          </PButton>
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
      <label class="check">
        <input v-model="showDeleted" type="checkbox" />
        {{ tr('看已删除的') }}
      </label>
    </div>
    <MotionSkeleton v-if="scope && busy && !items.length" :rows="2" />
    <p v-else-if="scope && !visible.length" class="home-empty">
      {{ showDeleted ? tr('没有删掉的东西。') : tr('置物架还是空的。') }}
    </p>
    <MotionList tag="ul" class="home-list">
      <li v-for="item in visible" :key="item.id" class="item">
        <div class="item-name">
          <strong>{{ item.name }}</strong>
          <small>
            {{ item.from === 'user' ? tr('你给她的') : tr('她给你的') }} ·
            {{ formatBytes(item.size) }}
          </small>
        </div>
        <span class="home-row-actions">
          <PButton
            v-if="!item.deletedAt"
            size="sm"
            variant="ghost"
            :disabled="disabled"
            @click="view(item)"
          >
            {{ tr('查看') }}
          </PButton>
          <PButton
            size="sm"
            variant="ghost"
            :disabled="disabled"
            @click="mutate(item, item.deletedAt ? 'restore' : 'delete')"
          >
            {{ item.deletedAt ? tr('恢复') : tr('删除') }}
          </PButton>
        </span>
      </li>
    </MotionList>
    <Transition name="motion-rise">
      <section v-if="selected" class="preview" :aria-label="tr('物品内容')">
        <header>
          <strong>{{ selected.name }}</strong>
          <PButton size="sm" variant="ghost" @click="clearPreview">{{ tr('关闭') }}</PButton>
        </header>
        <pre v-if="selected.value !== undefined">{{ selected.value }}</pre>
        <img v-if="preview && isImage" :src="preview" :alt="selected.name" />
        <a v-if="preview" :href="preview" :download="selected.name.replace(/[/\\]/g, '_')">
          {{ tr('下载文件') }}
        </a>
      </section>
    </Transition>
  </section>
</template>

<style scoped src="./home/homePanel.css"></style>
<style scoped src="./homePanels.css"></style>
