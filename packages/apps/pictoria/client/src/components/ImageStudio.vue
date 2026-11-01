<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import Icon from './PictoriaIcon.vue'
import type { CanvasItem } from '../types'
import { cropImage, splitImage, resizeImage, decodeImage, imageBlob } from '../services/imageStudio'
const props = defineProps<{
  item: CanvasItem
  url: string
  maskConvention: 'reference' | 'alpha' | 'white'
  externalBusy: boolean
}>()
const emit = defineEmits<{
  close: []
  result: [files: Blob[], action: string, prompt?: string, mask?: Blob]
}>()
const label = (source: string) => t('apps.pictoria.studio', source)
const dialog = ref<HTMLElement>()
const mode = ref<'mask' | 'crop' | 'split' | 'resize'>('mask')
const modes = [
  { id: 'mask', title: '局部编辑', icon: 'brush' },
  { id: 'crop', title: '裁剪', icon: 'crop' },
  { id: 'split', title: '切图', icon: 'grid' },
  { id: 'resize', title: '调整尺寸', icon: 'fit' },
] as const
const painter = ref<HTMLCanvasElement>(),
  width = ref(0),
  height = ref(0)
const left = ref(0),
  top = ref(0),
  cropWidth = ref(1),
  cropHeight = ref(1)
const columns = ref(2),
  rows = ref(2),
  outputWidth = ref(1),
  outputHeight = ref(1),
  pixelated = ref(false)
const brush = ref(24),
  erase = ref(false),
  prompt = ref(''),
  busy = ref(false),
  failure = ref('')
let image: HTMLImageElement | undefined,
  drawing = false,
  last: { x: number; y: number } | undefined
const strokes: Array<{ erase: boolean; width: number; points: Array<{ x: number; y: number }> }> =
  []
const future: typeof strokes = []
const historyLength = ref(0),
  futureLength = ref(0)
let mask: HTMLCanvasElement | undefined,
  tint: HTMLCanvasElement | undefined,
  cropStart: { x: number; y: number } | undefined
function redraw() {
  if (!image || !mask || !painter.value) return
  const context = mask.getContext('2d')!
  context.clearRect(0, 0, width.value, height.value)
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
    context.strokeStyle = '#fff'
    context.fillStyle = '#fff'
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = stroke.width
    context.beginPath()
    stroke.points.forEach((point, index) =>
      index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
    )
    context.stroke()
    const first = stroke.points[0]
    if (stroke.points.length === 1 && first) {
      context.beginPath()
      context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
      context.fill()
    }
  }
  context.globalCompositeOperation = 'source-over'
  const visible = painter.value.getContext('2d')!
  visible.clearRect(0, 0, width.value, height.value)
  visible.drawImage(image, 0, 0)
  if (!tint) return
  const tintContext = tint.getContext('2d')!
  tintContext.globalCompositeOperation = 'source-over'
  tintContext.clearRect(0, 0, width.value, height.value)
  tintContext.drawImage(mask, 0, 0)
  tintContext.globalCompositeOperation = 'source-in'
  tintContext.fillStyle = 'rgba(75,130,255,.45)'
  tintContext.fillRect(0, 0, width.value, height.value)
  if (mode.value === 'mask') visible.drawImage(tint, 0, 0)
  if (
    mode.value === 'crop' &&
    [left.value, top.value, cropWidth.value, cropHeight.value].every(Number.isFinite) &&
    cropWidth.value > 0 &&
    cropHeight.value > 0
  ) {
    visible.fillStyle = '#0007'
    visible.fillRect(0, 0, width.value, height.value)
    visible.drawImage(
      image,
      left.value,
      top.value,
      cropWidth.value,
      cropHeight.value,
      left.value,
      top.value,
      cropWidth.value,
      cropHeight.value,
    )
    visible.strokeStyle = '#8fb7ff'
    visible.lineWidth = Math.max(2, width.value / 400)
    visible.strokeRect(left.value, top.value, cropWidth.value, cropHeight.value)
  }
  if (mode.value === 'split') {
    visible.strokeStyle = '#8fb7ff'
    visible.lineWidth = Math.max(2, width.value / 400)
    visible.beginPath()
    for (let x = 1; x < Math.min(20, columns.value); x++) {
      visible.moveTo((x * width.value) / columns.value, 0)
      visible.lineTo((x * width.value) / columns.value, height.value)
    }
    for (let y = 1; y < Math.min(20, rows.value); y++) {
      visible.moveTo(0, (y * height.value) / rows.value)
      visible.lineTo(width.value, (y * height.value) / rows.value)
    }
    visible.stroke()
  }
  historyLength.value = strokes.length
  futureLength.value = future.length
}
function point(event: PointerEvent) {
  const rect = painter.value!.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(width.value, ((event.clientX - rect.left) * width.value) / rect.width)),
    y: Math.max(
      0,
      Math.min(height.value, ((event.clientY - rect.top) * height.value) / rect.height),
    ),
  }
}
function start(event: PointerEvent) {
  if (props.externalBusy || busy.value) return
  if (mode.value === 'crop') {
    cropStart = point(event)
    painter.value!.setPointerCapture(event.pointerId)
    return
  }
  if (mode.value !== 'mask') return
  drawing = true
  last = point(event)
  painter.value!.setPointerCapture(event.pointerId)
  strokes.push({ erase: erase.value, width: brush.value, points: [last] })
  future.splice(0)
  redraw()
}
function move(event: PointerEvent) {
  if (cropStart) {
    const end = point(event)
    left.value = Math.floor(Math.min(cropStart.x, end.x))
    top.value = Math.floor(Math.min(cropStart.y, end.y))
    cropWidth.value = Math.max(1, Math.round(Math.abs(end.x - cropStart.x)))
    cropHeight.value = Math.max(1, Math.round(Math.abs(end.y - cropStart.y)))
    return
  }
  if (!drawing) return
  last = point(event)
  strokes.at(-1)!.points.push(last)
  redraw()
}
function endDrawing() {
  drawing = false
  cropStart = undefined
}
function undo() {
  if (drawing) return
  const stroke = strokes.pop()
  if (stroke) future.push(stroke)
  redraw()
}
function redo() {
  if (drawing) return
  const stroke = future.pop()
  if (stroke) strokes.push(stroke)
  redraw()
}
function reset() {
  strokes.splice(0)
  future.splice(0)
  redraw()
}
async function apply() {
  if (!image || busy.value || props.externalBusy) return
  busy.value = true
  failure.value = ''
  try {
    if (mode.value === 'crop')
      emit(
        'result',
        [
          await cropImage(image, {
            x: left.value,
            y: top.value,
            width: cropWidth.value,
            height: cropHeight.value,
          }),
        ],
        label('裁剪'),
      )
    else if (mode.value === 'split')
      emit('result', await splitImage(image, columns.value, rows.value), label('切图'))
    else if (mode.value === 'resize')
      emit(
        'result',
        [await resizeImage(image, outputWidth.value, outputHeight.value, pixelated.value)],
        label('调整尺寸'),
      )
    else {
      if (!prompt.value.trim()) throw new Error(label('请描述要修改的内容'))
      const bytes = mask!.getContext('2d')!.getImageData(0, 0, width.value, height.value).data
      if (!bytes.some((value, index) => index % 4 === 3 && value > 0))
        throw new Error(label('请先涂抹需要修改的区域'))
      redraw()
      const exportedMask = document.createElement('canvas')
      exportedMask.width = width.value
      exportedMask.height = height.value
      const exported = exportedMask.getContext('2d')!
      if (props.maskConvention === 'alpha') {
        exported.fillStyle = '#fff'
        exported.fillRect(0, 0, width.value, height.value)
        exported.globalCompositeOperation = 'destination-out'
        exported.drawImage(mask!, 0, 0)
      } else {
        exported.fillStyle = '#000'
        exported.fillRect(0, 0, width.value, height.value)
        exported.drawImage(mask!, 0, 0)
      }
      emit(
        'result',
        [await imageBlob(painter.value!)],
        label('局部编辑'),
        prompt.value.trim(),
        await imageBlob(exportedMask),
      )
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    failure.value = code.startsWith('IMAGE_') ? label('图像参数无效或输出尺寸过大') : code
  } finally {
    busy.value = false
  }
}
onMounted(async () => {
  dialog.value?.focus()
  try {
    image = await decodeImage(props.url)
    width.value = image.naturalWidth
    height.value = image.naturalHeight
    cropWidth.value = outputWidth.value = width.value
    cropHeight.value = outputHeight.value = height.value
    if (width.value * height.value > 64_000_000) throw new Error('IMAGE_TOO_LARGE')
    await nextTick()
    mask = document.createElement('canvas')
    mask.width = width.value
    mask.height = height.value
    tint = document.createElement('canvas')
    tint.width = width.value
    tint.height = height.value
    redraw()
  } catch {
    failure.value = label('图像无法解码')
  }
})
onBeforeUnmount(() => {
  drawing = false
  image = undefined
  mask = undefined
})
watch([mode, left, top, cropWidth, cropHeight, columns, rows], redraw)
</script>
<template>
  <div
    class="studio-modal-backdrop"
    data-ui
    @keydown.stop
    @pointerdown.self="!busy && !externalBusy && emit('close')"
    @keydown.esc.stop="!busy && !externalBusy && emit('close')"
  >
    <section
      ref="dialog"
      tabindex="-1"
      class="studio-modal studio-image-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="label('图像工作室')"
    >
      <header class="studio-modal-header">
        <div class="studio-heading">
          <span class="studio-heading-icon"><Icon name="image" :size="19" /></span>
          <div>
            <strong>{{ label('图像工作室') }}</strong>
            <small :title="item.content.name">{{ item.content.name }}</small>
          </div>
        </div>
        <div class="studio-header-actions">
          <span class="studio-dimensions">{{ width || '—' }} × {{ height || '—' }}</span>
          <button
            class="icon-button"
            :disabled="busy || externalBusy"
            :aria-label="label('关闭')"
            @click="emit('close')"
          >
            <Icon name="close" :size="18" />
          </button>
        </div>
      </header>
      <nav class="studio-editor-tabs" :aria-label="label('图像工作室')">
        <button
          v-for="entry in modes"
          :key="entry.id"
          :disabled="busy || externalBusy"
          :aria-pressed="mode === entry.id"
          :class="{ active: mode === entry.id }"
          @click="mode = entry.id"
        >
          <Icon :name="entry.icon" :size="15" />
          {{ label(entry.title) }}
        </button>
      </nav>
      <div class="studio-editor-body">
        <div class="studio-editor-workspace">
          <div class="studio-image-preview">
            <canvas
              ref="painter"
              :width="width"
              :height="height"
              @pointerdown.prevent="start"
              @pointermove.prevent="move"
              @pointerup="endDrawing"
              @pointercancel="endDrawing"
            />
          </div>
          <div class="studio-preview-caption">
            <Icon
              :name="mode === 'crop' ? 'crop' : mode === 'mask' ? 'brush' : 'image'"
              :size="12"
            />
            <span>
              {{
                mode === 'mask'
                  ? label('涂抹需要修改的区域')
                  : mode === 'crop'
                    ? label('拖动选择裁剪区域')
                    : label('原图保持不变')
              }}
            </span>
            <small>{{ width }} × {{ height }} px</small>
          </div>
        </div>
        <fieldset class="studio-fields" :disabled="busy || externalBusy">
          <div class="studio-parameter-heading">
            <small>{{ label('编辑参数') }}</small>
          </div>
          <template v-if="mode === 'mask'">
            <div class="studio-brush-tools">
              <button :class="{ active: !erase }" :aria-pressed="!erase" @click="erase = false">
                <Icon name="brush" :size="15" />
                {{ label('笔刷') }}
              </button>
              <button :class="{ active: erase }" :aria-pressed="erase" @click="erase = true">
                <Icon name="eraser" :size="15" />
                {{ label('橡皮擦') }}
              </button>
            </div>
            <label class="studio-brush-size">
              <span>
                {{ label('笔刷大小') }}
                <output>{{ Math.round(brush) }} px</output>
              </span>
              <input
                v-model.number="brush"
                type="range"
                min="1"
                :max="Math.max(width, height) / 2"
              />
            </label>
            <div class="studio-mask-history">
              <button
                class="icon-button"
                :disabled="!historyLength"
                :aria-label="label('撤销')"
                :title="label('撤销')"
                @click="undo"
              >
                <Icon name="undo" :size="15" />
              </button>
              <button
                class="icon-button"
                :disabled="!futureLength"
                :aria-label="label('重做')"
                :title="label('重做')"
                @click="redo"
              >
                <Icon name="redo" :size="15" />
              </button>
              <button class="text-button" @click="reset">{{ label('重置') }}</button>
            </div>
            <slot name="editing-options" />
            <label class="studio-field">
              {{ label('修改描述') }}
              <textarea v-model="prompt" rows="4" :placeholder="label('请描述要修改的内容')" />
            </label>
            <details class="studio-help">
              <summary>
                {{ label('编辑方式说明') }}
                <Icon name="down" :size="11" />
              </summary>
              <p>
                {{ label('参考编辑的范围由模型理解；独立蒙版的黑白或透明约定需与步骤 API 一致。') }}
              </p>
            </details>
          </template>
          <template v-else-if="mode === 'crop'">
            <p class="studio-field-hint">{{ label('拖动选择裁剪区域，也可以输入精确尺寸。') }}</p>
            <div class="studio-number-grid">
              <label class="studio-field">
                {{ label('左边距') }}
                <input v-model.number="left" type="number" min="0" />
              </label>
              <label class="studio-field">
                {{ label('上边距') }}
                <input v-model.number="top" type="number" min="0" />
              </label>
              <label class="studio-field">
                {{ label('宽度') }}
                <input v-model.number="cropWidth" type="number" min="1" />
              </label>
              <label class="studio-field">
                {{ label('高度') }}
                <input v-model.number="cropHeight" type="number" min="1" />
              </label>
            </div>
          </template>
          <template v-else-if="mode === 'split'">
            <p class="studio-field-hint">{{ label('按网格生成独立素材，保留原始像素。') }}</p>
            <div class="studio-number-grid">
              <label class="studio-field">
                {{ label('列数') }}
                <input v-model.number="columns" type="number" min="1" max="20" />
              </label>
              <label class="studio-field">
                {{ label('行数') }}
                <input v-model.number="rows" type="number" min="1" max="20" />
              </label>
            </div>
            <div class="studio-output-summary">
              <Icon name="grid" :size="17" />
              <span>{{ label('切片预览') }}</span>
              <strong>{{ columns * rows }}</strong>
            </div>
            <small class="studio-field-hint">{{ label('一次最多生成 20 张切片') }}</small>
          </template>
          <template v-else>
            <p class="studio-field-hint">{{ label('设置输出宽高，生成新的图片素材。') }}</p>
            <div class="studio-number-grid">
              <label class="studio-field">
                {{ label('宽度') }}
                <input v-model.number="outputWidth" type="number" min="1" />
              </label>
              <label class="studio-field">
                {{ label('高度') }}
                <input v-model.number="outputHeight" type="number" min="1" />
              </label>
            </div>
            <label class="studio-checkbox">
              <input v-model="pixelated" type="checkbox" />
              {{ label('像素风最近邻缩放') }}
            </label>
            <small class="studio-field-hint">{{ label('这是本地重采样，不是 AI 超分。') }}</small>
          </template>
          <p v-if="failure" class="studio-field-error" role="alert">{{ failure }}</p>
        </fieldset>
      </div>
      <footer class="studio-modal-footer">
        <small>
          <Icon name="check" :size="13" />
          {{ label('原图保持不变') }}
        </small>
        <button class="quiet-button" :disabled="busy || externalBusy" @click="emit('close')">
          {{ label('取消') }}
        </button>
        <button class="create-button" :disabled="busy || externalBusy || !width" @click="apply">
          <Icon :name="busy || externalBusy ? 'refresh' : 'plus'" :size="14" />
          {{
            busy || externalBusy
              ? label('正在处理…')
              : mode === 'mask'
                ? label('建立编辑草稿')
                : label('生成新素材')
          }}
        </button>
      </footer>
    </section>
  </div>
</template>
