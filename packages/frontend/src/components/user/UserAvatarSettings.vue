<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { PButton, PDialog, PixelIcon, PSlider } from '../pixel'
import UserAvatar from './UserAvatar.vue'
import { useUserAvatar } from '../../composables/ui/useUserAvatar'
import {
  avatarCropRect,
  avatarCropStyle,
  clampAvatarCrop,
  type AvatarCrop,
} from '../../lib/userAvatarCrop'
import { requestApiResource } from '../../api/transport'
import { useNotificationStore } from '../../stores'
import { t } from '../../i18n'
import { useSystemSettingsPage } from '../../composables/ui/useSystemSettingsPage'
const page = useSystemSettingsPage()

const avatar = useUserAvatar()
const notifications = useNotificationStore()
const input = ref<HTMLInputElement | null>(null)
const stage = ref<HTMLDivElement | null>(null)
const viewport = ref<HTMLDivElement | null>(null)
const returnFocus = shallowRef<HTMLElement | null>(null)
const open = ref(false)
const reading = ref(false)
const saving = ref(false)
const error = ref('')
const dropTarget = ref('')
const source = ref('')
const image = shallowRef<HTMLImageElement | null>(null)
const crop = ref<AvatarCrop>({ width: 1, height: 1, zoom: 1.1, x: 0, y: 0 })
const cropStyle = computed(() => avatarCropStyle(crop.value))
const locked = computed(
  () => reading.value || saving.value || avatar.busy.value || page?.disabled.value === true,
)
const zoom = computed({
  get: () => crop.value.zoom,
  set: (value: number) => update({ zoom: value }),
})
let generation = 0
let controller: AbortController | null = null
let drag: {
  id: number
  clientX: number
  clientY: number
  x: number
  y: number
  size: number
} | null = null
const dragging = ref(false)

function update(value: Partial<AvatarCrop>) {
  crop.value = clampAvatarCrop({ ...crop.value, ...value })
}
function message(value: unknown) {
  return value instanceof Error ? value.message : t('ui.user-avatar', '操作失败，请重试')
}
function releaseSource() {
  ++generation
  controller?.abort()
  controller = null
  if (source.value) URL.revokeObjectURL(source.value)
  source.value = ''
  image.value = null
  drag = null
  dragging.value = false
  reading.value = false
  dropTarget.value = ''
}
watch(open, (value) => {
  if (value) void nextTick(() => stage.value?.focus({ preventScroll: true }))
  else {
    page?.discard('user-avatar')
    releaseSource()
    void nextTick(() => returnFocus.value?.focus({ preventScroll: true }))
  }
})
onUnmounted(releaseSource)

async function loadBlob(blob: Blob, initialZoom = 1.1) {
  const request = ++generation
  reading.value = true
  error.value = ''
  const url = URL.createObjectURL(blob)
  try {
    const candidate = new Image()
    candidate.src = url
    await candidate.decode()
    if (request !== generation) {
      URL.revokeObjectURL(url)
      return
    }
    if (
      !candidate.naturalWidth ||
      !candidate.naturalHeight ||
      candidate.naturalWidth * candidate.naturalHeight > 40_000_000
    )
      throw new Error(t('ui.user-avatar', '图片尺寸过大，请选择较小图片'))
    if (source.value) URL.revokeObjectURL(source.value)
    if (!open.value) returnFocus.value = document.activeElement as HTMLElement | null
    image.value = candidate
    source.value = url
    crop.value = {
      width: candidate.naturalWidth,
      height: candidate.naturalHeight,
      zoom: initialZoom,
      x: 0,
      y: 0,
    }
    open.value = true
  } catch (cause) {
    URL.revokeObjectURL(url)
    if (request === generation)
      error.value =
        cause instanceof DOMException
          ? t('ui.user-avatar', '图片无法读取，请重新选择')
          : message(cause)
  } finally {
    if (request === generation) reading.value = false
  }
}
function chooseFile() {
  if (locked.value) return
  if (!open.value) returnFocus.value = document.activeElement as HTMLElement | null
  input.value?.click()
}
async function acceptFile(file?: File) {
  if (!file || locked.value) return
  error.value = ''
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error.value = t('ui.user-avatar', '请选择 PNG、JPEG 或 WebP 图片')
    return
  }
  if (!file.size || file.size > 15 * 1024 * 1024) {
    error.value = t('ui.user-avatar', '图片应大于 0 且不超过 15MB')
    return
  }
  await loadBlob(file)
}
function handleFile(event: Event) {
  const element = event.target as HTMLInputElement
  void acceptFile(element.files?.[0])
  element.value = ''
}
async function edit() {
  if (locked.value || !avatar.version.value) return
  returnFocus.value = document.activeElement as HTMLElement | null
  reading.value = true
  error.value = ''
  const request = ++generation
  controller = new AbortController()
  try {
    const response = await requestApiResource(
      '/system/user-avatar/content',
      new URLSearchParams(),
      controller.signal,
    )
    const blob = await response.blob()
    if (request === generation) await loadBlob(blob, 1)
  } catch (cause) {
    if (request === generation) error.value = message(cause)
  } finally {
    if (request === generation) reading.value = false
  }
}
function dragOver(event: DragEvent, target: string) {
  if (locked.value || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  dropTarget.value = target
}
function dragLeave(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null))
    dropTarget.value = ''
}
function drop(event: DragEvent) {
  event.preventDefault()
  dropTarget.value = ''
  void acceptFile(event.dataTransfer?.files[0])
}
function beginDrag(event: PointerEvent) {
  if (locked.value || event.button !== 0 || !viewport.value) return
  const element = event.currentTarget as HTMLElement
  element.focus({ preventScroll: true })
  element.setPointerCapture(event.pointerId)
  drag = {
    id: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    x: crop.value.x,
    y: crop.value.y,
    size: viewport.value.clientWidth,
  }
  dragging.value = true
}
function moveDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  update({
    x: drag.x + (event.clientX - drag.clientX) / drag.size,
    y: drag.y + (event.clientY - drag.clientY) / drag.size,
  })
}
function endDrag(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return
  drag = null
  dragging.value = false
  const element = event.currentTarget as HTMLElement
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
}
function wheel(event: WheelEvent) {
  if (!locked.value) update({ zoom: crop.value.zoom * Math.exp(-event.deltaY * 0.0015) })
}
function keydown(event: KeyboardEvent) {
  const offsets: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  if (event.key === 'Escape' && !locked.value) {
    event.preventDefault()
    open.value = false
    return
  }
  const offset = offsets[event.key]
  if (!offset || locked.value) return
  event.preventDefault()
  const step = event.shiftKey ? 0.05 : 0.01
  update({ x: crop.value.x + offset[0] * step, y: crop.value.y + offset[1] * step })
}
async function save() {
  if (!image.value || locked.value) return
  saving.value = true
  error.value = ''
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) throw new Error(t('ui.user-avatar', '裁切失败，请重试'))
    const rect = avatarCropRect(crop.value)
    context.drawImage(image.value, rect.x, rect.y, rect.size, rect.size, 0, 0, 512, 512)
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error(t('ui.user-avatar', '裁切失败，请重试')))
      }, 'image/png'),
    )
    if (page) {
      if (!(await page.save(() => avatar.upload(png), 'user-avatar'))) return
    } else await avatar.upload(png)
    open.value = false
    notifications.toast(t('ui.user-avatar', '头像已更新'), 'success')
  } catch (cause) {
    error.value = message(cause)
  } finally {
    saving.value = false
  }
}
async function reset() {
  if (locked.value) return
  error.value = ''
  try {
    if (page) {
      if (!(await page.save(() => avatar.reset(), 'user-avatar'))) return
    } else await avatar.reset()
    notifications.toast(t('ui.user-avatar', '已恢复默认头像'), 'success')
  } catch (cause) {
    error.value = message(cause)
  }
}
</script>

<template>
  <div
    class="user-avatar-settings"
    :class="{ 'is-drag-over': dropTarget === 'settings' }"
    @dragover="dragOver($event, 'settings')"
    @dragleave="dragLeave"
    @drop="drop"
  >
    <UserAvatar :size="80" />
    <div class="user-avatar-settings__actions">
      <label>{{ t('ui.user-avatar', '用户头像') }}</label>
      <p>{{ t('ui.user-avatar', '拖入图片或选择文件') }}</p>
      <div>
        <PButton variant="secondary" size="sm" :disabled="locked" @click="chooseFile">
          <PixelIcon name="image" size="xs" />
          {{ t('ui.user-avatar', '更换头像') }}
        </PButton>
        <PButton
          variant="ghost"
          size="sm"
          :disabled="locked || !avatar.version.value"
          @click="edit"
        >
          {{ t('ui.user-avatar', '调整裁切') }}
        </PButton>
        <PButton
          variant="ghost"
          size="sm"
          :disabled="locked || !avatar.version.value"
          @click="reset"
        >
          {{ t('ui.user-avatar', '恢复默认') }}
        </PButton>
      </div>
    </div>
    <div class="user-avatar-settings__sizes">
      <UserAvatar :size="36" />
      <span>{{ t('ui.user-avatar', '消息') }}</span>
      <UserAvatar :size="24" />
      <span>HUD</span>
    </div>
    <input
      ref="input"
      type="file"
      hidden
      accept="image/png,image/jpeg,image/webp"
      @change="handleFile"
    />
  </div>
  <p v-if="reading && !open" class="user-avatar-feedback" role="status">
    {{ t('ui.user-avatar', '正在读取图片…') }}
  </p>
  <p v-if="error && !open" class="user-avatar-feedback user-avatar-feedback--error" role="alert">
    {{ error }}
  </p>
  <PDialog
    v-model="open"
    :title="t('ui.user-avatar', '调整用户头像')"
    width="min(740px, calc(100vw - 32px))"
    :loading="locked"
    :auto-close="false"
  >
    <div class="user-avatar-crop" @keydown.esc.prevent="!locked && (open = false)">
      <div class="user-avatar-crop__body">
        <div>
          <div
            ref="stage"
            class="user-avatar-crop__stage"
            :class="{ 'is-dragging': dragging, 'is-drag-over': dropTarget === 'crop' }"
            tabindex="0"
            :aria-label="t('ui.user-avatar', '拖动图片调整位置，方向键微调')"
            @pointerdown.prevent="beginDrag"
            @pointermove="moveDrag"
            @pointerup="endDrag"
            @pointercancel="endDrag"
            @lostpointercapture="endDrag"
            @wheel.prevent="wheel"
            @keydown="keydown"
            @dragover="dragOver($event, 'crop')"
            @dragleave="dragLeave"
            @drop="drop"
          >
            <div ref="viewport" class="user-avatar-crop__viewport">
              <img
                v-if="source"
                :src="source"
                :style="cropStyle"
                :alt="t('ui.user-avatar', '头像裁切预览')"
                draggable="false"
              />
            </div>
            <i class="user-avatar-crop__mask" aria-hidden="true" />
            <span v-if="dropTarget === 'crop'" class="user-avatar-crop__drop">
              {{ t('ui.user-avatar', '松开以更换图片') }}
            </span>
          </div>
          <div class="user-avatar-crop__zoom">
            <PButton
              variant="ghost"
              size="sm"
              :disabled="locked"
              :aria-label="t('ui.user-avatar', '缩小头像')"
              @click="update({ zoom: crop.zoom - 0.1 })"
            >
              −
            </PButton>
            <PSlider v-model="zoom" :min="1" :max="3" :step="0.01" :disabled="locked" />
            <PButton
              variant="ghost"
              size="sm"
              :disabled="locked"
              :aria-label="t('ui.user-avatar', '放大头像')"
              @click="update({ zoom: crop.zoom + 0.1 })"
            >
              ＋
            </PButton>
          </div>
          <p class="user-avatar-crop__hint">
            {{ t('ui.user-avatar', '拖动调整位置，滚轮或滑块缩放') }}
          </p>
          <div class="user-avatar-crop__tools">
            <PButton variant="ghost" size="sm" :disabled="locked" @click="chooseFile">
              {{ t('ui.user-avatar', '重新选图') }}
            </PButton>
            <PButton variant="ghost" size="sm" :disabled="locked" @click="update({ x: 0, y: 0 })">
              {{ t('ui.user-avatar', '重新居中') }}
            </PButton>
          </div>
        </div>
        <aside class="user-avatar-crop__samples">
          <h3>{{ t('ui.user-avatar', '显示预览') }}</h3>
          <div v-for="size in [80, 36, 24]" :key="size">
            <span class="user-avatar-crop__preview" :style="{ '--preview-size': `${size}px` }">
              <img
                v-if="source"
                :src="source"
                :style="cropStyle"
                :alt="t('ui.user-avatar', '用户头像')"
                draggable="false"
              />
            </span>
            <small>{{ size }} px</small>
          </div>
        </aside>
      </div>
      <p v-if="reading" class="user-avatar-feedback" role="status">
        {{ t('ui.user-avatar', '正在读取图片…') }}
      </p>
      <p v-if="error" class="user-avatar-feedback user-avatar-feedback--error" role="alert">
        {{ error }}
      </p>
    </div>
    <template #footer>
      <PButton variant="secondary" size="sm" :disabled="locked" @click="open = false">
        {{ t('ui.user-avatar', '取消') }}
      </PButton>
      <PButton size="sm" :loading="saving" :disabled="locked || !image" @click="save">
        {{ t('ui.user-avatar', '使用此头像') }}
      </PButton>
    </template>
  </PDialog>
</template>

<style scoped src="./user-avatar-settings.css"></style>
