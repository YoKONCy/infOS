<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Ajv from 'ajv'
import { t } from '../i18n'
import type { Asset, CanvasItem, VideoContinuation } from '../types'
import type { CanvasStore } from '../composables/useCanvas'
import type { useCanvasLinks } from '../composables/useCanvasLinks'
import { videoStartField, referencePromptField } from '../../../src/creativeInputs'
import { isAssetsField } from '../composables/useCanvasLinks'
import {
  continuationStep,
  tailFrameTimes,
  openFrameVideo,
  releaseFrameVideo,
  extractVideoFrame,
  continuationParameters,
  continuationReferences,
  continuationParameterFields,
  videoAncestors,
} from '../services/videoContinuation'
import { pictoria, fileBase64 } from '../services/transport'
import Icon from './PictoriaIcon.vue'
import PictoriaSelect from './PictoriaSelect.vue'

const props = defineProps<{
  store: CanvasStore
  links: ReturnType<typeof useCanvasLinks>
  item: CanvasItem
}>()
const emit = defineEmits<{ close: []; busy: [value: boolean]; continue: [item: CanvasItem] }>()
const label = (key: string) => t('apps.pictoria.video', key)
const store = props.store,
  source = props.item
const owner = store.agentId.value,
  projectId = store.project.id,
  sourceAssetId = source.content.assetId!
const abort = new AbortController(),
  validator = new Ajv({ strict: false, allErrors: true })
const dialog = ref<HTMLElement>(),
  player = ref<HTMLVideoElement>(),
  sequencePlayer = ref<HTMLVideoElement>()
const tab = ref<'create' | 'sequence'>('create'),
  busy = ref(false),
  loading = ref(true),
  failure = ref(''),
  notice = ref('')
const duration = ref(0),
  selectedTime = ref(0),
  sourceUrl = ref(''),
  prompt = ref(''),
  inherit = ref(true)
const frames = ref<Array<{ time: number; blob: Blob; url: string }>>([])
const steps = computed(() => store.steps.value.filter(continuationStep))
const stepId = ref(''),
  parameters = ref<Record<string, unknown>>({})
const step = computed(() => steps.value.find((entry) => entry.id === stepId.value))
const stepOptions = computed(() =>
  steps.value.map((entry) => ({ value: entry.id, label: entry.name })),
)
const parentRun = computed(() =>
  store.project.items.find(
    (entry) =>
      Boolean(source.content.runId && entry.content.runId === source.content.runId) ||
      entry.id === source.content.candidateGroupId,
  ),
)
const previousInputs = computed(() => parentRun.value?.content.inputs ?? {})
const parameterFields = computed(() => continuationParameterFields(step.value))
const selectedFrame = computed(() =>
  frames.value.find((entry) => Math.abs(entry.time - selectedTime.value) < 0.0001),
)
const ancestors = computed(() => videoAncestors(store.project.items, source))
const children = computed(() =>
  store.project.items.filter(
    (item) =>
      item.content.mimeType?.startsWith('video/') &&
      item.content.continuation?.source.assetId === sourceAssetId,
  ),
)
const drafts = computed(() =>
  store.project.items.filter(
    (item) =>
      item.content.kind === 'draft' && item.content.continuation?.source.assetId === sourceAssetId,
  ),
)
const runs = computed(() =>
  store.project.items.filter(
    (item) =>
      item.content.kind === 'run' && item.content.continuation?.source.assetId === sourceAssetId,
  ),
)
const playback = ref<CanvasItem[]>([]),
  playbackIndex = ref(0),
  draftId = ref('')
const editingDraft = computed(() =>
  store.project.items.find((item) => item.id === draftId.value && item.content.kind === 'draft'),
)
const referenceInputs = computed(() => editingDraft.value?.content.inputs ?? previousInputs.value)
const auxiliary = computed(() =>
  step.value
    ? continuationReferences(
        step.value,
        referenceInputs.value,
        editingDraft.value?.content.referenceUses ?? parentRun.value?.content.referenceUses ?? [],
      )
    : { inputs: {}, uses: [] },
)
const auxiliaryUses = computed(() => auxiliary.value.uses)
const uploaded = new Map<number, Asset>()
const unpinSource = store.pinMedia(sourceAssetId)
let decoder: HTMLVideoElement | undefined,
  disposed = false
let advancing = false
let playbackRevision = 0
let unpinPlayback: (() => void) | undefined
const previousFocus = document.activeElement
const taskLabels: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  completed: '已完成',
  partial: '部分完成',
  waiting: '等待核验',
  failed: '失败',
  cancelled: '已取消',
}
const taskState = (state?: string) => label(taskLabels[state || 'queued'] || '等待核验')
watch(tab, () => {
  player.value?.pause()
  sequencePlayer.value?.pause()
})
function current() {
  return (
    !disposed &&
    store.agentId.value === owner &&
    store.project.id === projectId &&
    store.project.items.some(
      (item) => item.id === source.id && item.content.assetId === sourceAssetId,
    )
  )
}
function assertCurrent() {
  if (!current()) throw new Error(label('画布或源视频已变化，请重新打开接续'))
}
function report(error: unknown) {
  const key = error instanceof Error ? error.message : ''
  failure.value = ['VIDEO_DECODE_FAILED', 'VIDEO_DURATION_INVALID'].includes(key)
    ? label('视频无法解码或定位，请使用其他视频')
    : error instanceof Error
      ? error.message
      : label('接续操作失败')
}
function close() {
  if (!busy.value) emit('close')
}
function focusTrap(event: KeyboardEvent) {
  const elements = [
    ...(dialog.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[href]',
    ) ?? []),
  ].filter((element) => element.getClientRects().length)
  const first = elements[0],
    last = elements.at(-1)
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === dialog.value)
  ) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
watch(stepId, () => {
  if (step.value) parameters.value = continuationParameters(step.value, previousInputs.value)
})
watch(busy, (value) => emit('busy', value), { flush: 'sync' })
watch(
  () => `${store.agentId.value}:${store.project.id}`,
  () => {
    abort.abort()
    emit('close')
  },
)
async function selectFrame(time: number) {
  if (!decoder || busy.value || loading.value) return
  selectedTime.value = time
  if (player.value) {
    player.value.pause()
    if (player.value.readyState >= 1) player.value.currentTime = time
  }
}
async function captureCurrent() {
  if (!decoder || !player.value || loading.value || busy.value) return
  busy.value = true
  failure.value = ''
  try {
    const time = Math.min(player.value.currentTime, Math.max(0, duration.value - 0.001))
    player.value.pause()
    if (!frames.value.some((entry) => Math.abs(entry.time - time) < 0.0001)) {
      const blob = await extractVideoFrame(decoder, time, abort.signal)
      assertCurrent()
      frames.value.push({ time, blob, url: URL.createObjectURL(blob) })
      frames.value.sort((a, b) => a.time - b.time)
    }
    selectedTime.value = time
  } catch (error) {
    if (!disposed) report(error)
  } finally {
    busy.value = false
  }
}
async function saveDraft(generate = false) {
  if (busy.value || loading.value || !step.value || !selectedFrame.value) return
  busy.value = true
  failure.value = notice.value = ''
  try {
    assertCurrent()
    const chosenStep = step.value,
      frame = selectedFrame.value
    let asset = uploaded.get(frame.time)
    if (!asset) {
      const name = t('apps.pictoria.video', '{0} · 接续帧 {1}s', [
        source.content.name || label('上一段'),
        frame.time.toFixed(3),
      ])
      asset = await pictoria.upload(
        owner,
        name,
        frame.blob.type,
        await fileBase64(new File([frame.blob], name, { type: frame.blob.type })),
      )
      assertCurrent()
      uploaded.set(frame.time, asset)
    }
    const startField = videoStartField(chosenStep.inputSchema)!,
      textField = referencePromptField(chosenStep.inputSchema)!
    const startSchema = chosenStep.inputSchema.properties![startField]!
    const inputs = {
      ...parameters.value,
      [textField]: prompt.value,
      [startField]: isAssetsField(startSchema) ? [{ assetId: asset.id }] : { assetId: asset.id },
    }
    const uses = inherit.value ? auxiliaryUses.value : []
    if (inherit.value) Object.assign(inputs, auxiliary.value.inputs)
    if (
      !validator.compile({
        ...chosenStep.inputSchema,
        required: generate ? chosenStep.inputSchema.required : [],
      })(inputs)
    )
      throw new Error(label('请补齐下一段内容与步骤要求的参数'))
    const continuation: VideoContinuation = {
      version: 1,
      source: { assetId: sourceAssetId },
      sourceItemId: source.id,
      sourceName: source.content.name || label('上一段'),
      sourceTime: frame.time,
      sourceDuration: duration.value,
      frame: { assetId: asset.id },
    }
    let draft = store.project.items.find(
      (entry) => entry.id === draftId.value && entry.content.kind === 'draft',
    )
    if (draft) {
      store.checkpoint()
      Object.assign(draft.content, {
        inputs,
        step: JSON.parse(JSON.stringify(chosenStep)),
        continuation,
        referenceUses: uses,
      })
      store.project.edges = store.project.edges?.filter(
        (edge) => edge.historical || edge.target !== draft!.id,
      )
    } else {
      draft = props.links.addDraft(chosenStep, inputs, {
        x: source.x + source.content.width + 110,
        y: source.y,
      })
      Object.assign(draft.content, { continuation, referenceUses: uses })
      draftId.value = draft.id
      store.project.edges ||= []
      if (store.project.edges.length < 8000)
        store.project.edges.push({
          id: crypto.randomUUID(),
          source: source.id,
          target: draft.id,
          field: 'continuation',
          historical: true,
        })
    }
    if (!(await store.save())) throw new Error(label('接续草稿尚未保存，请重试保存'))
    assertCurrent()
    if (generate) {
      if (!(await props.links.submit(draft)))
        throw new Error(store.error.value || label('接续操作失败'))
      notice.value = label('接续任务已提交')
      tab.value = 'sequence'
    } else notice.value = label('接续草稿已保存')
  } catch (error) {
    if (!disposed) report(error)
  } finally {
    busy.value = false
  }
}
async function editDraft(draft: CanvasItem) {
  if (busy.value || loading.value) return
  const relation = draft.content.continuation
  const chosenStep = steps.value.find(
    (entry) =>
      entry.id === draft.content.step?.id && entry.revision === draft.content.step?.revision,
  )
  if (!relation || !chosenStep) {
    failure.value = label('草稿步骤不可用，请先更新配置')
    return
  }
  busy.value = true
  failure.value = ''
  try {
    const asset = await pictoria.operation<Asset>(owner, 'asset.get', {
      id: relation.frame.assetId,
    })
    if (!frames.value.some((frame) => Math.abs(frame.time - relation.sourceTime) < 0.0001)) {
      const url = await store.ensureMedia(asset.id)
      if (!url) throw new Error(label('视频无法解码或定位，请使用其他视频'))
      const blob = await (await fetch(url)).blob()
      assertCurrent()
      frames.value.push({ time: relation.sourceTime, blob, url: URL.createObjectURL(blob) })
      frames.value.sort((a, b) => a.time - b.time)
    }
    assertCurrent()
    uploaded.set(relation.sourceTime, asset)
    draftId.value = draft.id
    stepId.value = chosenStep.id
    tab.value = 'create'
    await nextTick()
    parameters.value = continuationParameters(chosenStep, draft.content.inputs ?? {})
    prompt.value = String(
      draft.content.inputs?.[referencePromptField(chosenStep.inputSchema)!] ?? '',
    )
    selectedTime.value = relation.sourceTime
    if (player.value?.readyState && player.value.readyState >= 1)
      player.value.currentTime = selectedTime.value
  } catch (error) {
    if (!disposed) report(error)
  } finally {
    busy.value = false
  }
}
async function playSequence(child?: CanvasItem) {
  playbackRevision++
  playback.value = [...ancestors.value, ...(child ? [child] : [])]
  playbackIndex.value = 0
  await playClip()
}
async function playClip() {
  const revision = playbackRevision
  const item = playback.value[playbackIndex.value]
  if (!item?.content.assetId || !sequencePlayer.value) return
  let previousRelease: (() => void) | undefined
  try {
    const release = store.pinMedia(item.content.assetId)
    previousRelease = unpinPlayback
    unpinPlayback = release
    const url = await store.ensureMedia(item.content.assetId)
    if (!current() || revision !== playbackRevision || !url || !sequencePlayer.value) return
    sequencePlayer.value.src = url
    await sequencePlayer.value.play()
  } catch (error) {
    if (!disposed) report(error)
  } finally {
    previousRelease?.()
  }
}
async function nextClip() {
  const video = sequencePlayer.value
  if (!video || !playback.value.length || advancing) return
  const next = playback.value[playbackIndex.value + 1]
  const out = next?.content.continuation?.sourceTime
  if (next && (video.ended || (typeof out === 'number' && video.currentTime >= out))) {
    advancing = true
    video.pause()
    playbackIndex.value++
    try {
      await playClip()
    } finally {
      advancing = false
    }
  }
}
onMounted(async () => {
  dialog.value?.focus()
  try {
    const options = steps.value
    stepId.value =
      options.find((entry) => entry.id === parentRun.value?.content.step?.id)?.id ||
      options[0]?.id ||
      ''
    sourceUrl.value = (await store.ensureMedia(sourceAssetId)) || ''
    assertCurrent()
    if (!sourceUrl.value) throw new Error(label('视频无法解码或定位，请使用其他视频'))
    decoder = await openFrameVideo(sourceUrl.value, abort.signal)
    duration.value = decoder.duration
    for (const time of tailFrameTimes(duration.value)) {
      const blob = await extractVideoFrame(decoder, time, abort.signal)
      assertCurrent()
      frames.value.push({ time, blob, url: URL.createObjectURL(blob) })
    }
    selectedTime.value = frames.value.at(-1)!.time
    await nextTick()
    if (player.value) player.value.currentTime = selectedTime.value
  } catch (error) {
    if (!disposed) report(error)
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => {
  disposed = true
  abort.abort()
  if (decoder) releaseFrameVideo(decoder)
  sequencePlayer.value?.pause()
  unpinSource()
  unpinPlayback?.()
  frames.value.forEach((entry) => URL.revokeObjectURL(entry.url))
  emit('busy', false)
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
})
</script>
<template>
  <div
    class="studio-modal-backdrop"
    data-ui
    @pointerdown.self="close"
    @keydown.stop
    @keydown.esc.stop="close"
  >
    <section
      ref="dialog"
      class="studio-modal video-continuation-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="label('视频接续')"
      tabindex="-1"
      @keydown.tab="focusTrap"
    >
      <header class="studio-modal-header">
        <div class="studio-heading">
          <span class="studio-heading-icon"><Icon name="play" :size="19" /></span>
          <div>
            <strong>{{ label('视频接续') }}</strong>
            <small>{{ source.content.name }}</small>
          </div>
        </div>
        <div class="studio-header-actions">
          <span class="studio-dimensions">{{ duration.toFixed(3) }} s</span>
          <button class="icon-button" :disabled="busy" :aria-label="label('关闭')" @click="close">
            <Icon name="close" :size="18" />
          </button>
        </div>
      </header>
      <nav class="studio-editor-tabs" :aria-label="label('视频接续')">
        <button
          :class="{ active: tab === 'create' }"
          :aria-pressed="tab === 'create'"
          @click="tab = 'create'"
        >
          <Icon name="sparkle" :size="15" />
          {{ label('接续创作') }}
        </button>
        <button
          :class="{ active: tab === 'sequence' }"
          :aria-pressed="tab === 'sequence'"
          @click="tab = 'sequence'"
        >
          <Icon name="layers" :size="15" />
          {{ label('片段序列') }}
        </button>
      </nav>
      <div v-if="tab === 'create'" class="studio-editor-body">
        <div class="studio-editor-workspace">
          <video
            ref="player"
            class="continuation-source-video"
            :src="sourceUrl"
            controls
            playsinline
            preload="auto"
            @loadedmetadata="player && (player.currentTime = selectedTime)"
          />
          <div class="continuation-frame-heading">
            <span>{{ label('结尾附近的画面') }}</span>
            <button class="text-button" :disabled="loading || busy" @click="captureCurrent">
              {{ label('使用当前播放画面') }}
            </button>
            <button
              class="text-button"
              :disabled="loading || busy || !frames.length"
              @click="selectFrame(frames[frames.length - 1]!.time)"
            >
              {{ label('使用尾帧') }}
            </button>
          </div>
          <div v-if="loading" class="studio-field-hint" role="status">
            {{ label('正在提取接续画面…') }}
          </div>
          <div class="continuation-frame-strip">
            <button
              v-for="frame in frames"
              :key="frame.time"
              :disabled="busy"
              :class="{ selected: frame === selectedFrame }"
              :aria-pressed="frame === selectedFrame"
              @click="selectFrame(frame.time)"
            >
              <img
                :src="frame.url"
                :alt="t('apps.pictoria.video', '接续帧 {0}s', [frame.time.toFixed(3)])"
              />
              <span>{{ frame.time.toFixed(3) }} s</span>
            </button>
          </div>
          <p class="studio-preview-caption">{{ label('序列从所选画面接续，原视频保留。') }}</p>
        </div>
        <aside class="studio-fields">
          <div v-if="selectedFrame" class="continuation-binding">
            <img :src="selectedFrame.url" :alt="label('下一段的起始画面')" />
            <div>
              <strong>{{ label('下一段的起始画面') }}</strong>
              <small>{{ selectedTime.toFixed(3) }} s</small>
            </div>
          </div>
          <label class="studio-field">
            <span>{{ label('生成步骤') }}</span>
            <PictoriaSelect
              v-model="stepId"
              :options="stepOptions"
              :disabled="busy"
              :label="label('生成步骤')"
            />
          </label>
          <p v-if="!steps.length" class="studio-field-hint">
            {{ label('没有声明起始帧能力的视频步骤，请先配置。') }}
          </p>
          <label class="studio-field">
            <span>{{ label('接下来发生什么？') }}</span>
            <textarea
              v-model="prompt"
              rows="4"
              :disabled="busy"
              :placeholder="label('描述下一段的动作、镜头与变化')"
            />
          </label>
          <div class="studio-number-grid">
            <label v-for="[name, field] in parameterFields" :key="name" class="studio-field">
              <span>{{ field.title || name }}</span>
              <PictoriaSelect
                v-if="field.enum"
                :model-value="String(parameters[name] ?? '')"
                :options="
                  field.enum.map((value) => ({ value: String(value), label: String(value) }))
                "
                :disabled="busy"
                :label="field.title || name"
                @update:model-value="
                  parameters[name] = field.enum!.find((value) => String(value) === $event)
                "
              />
              <input
                v-else-if="field.type === 'boolean'"
                v-model="parameters[name]"
                type="checkbox"
                :disabled="busy"
              />
              <input
                v-else-if="field.type === 'integer' || field.type === 'number'"
                v-model.number="parameters[name]"
                type="number"
                :min="field.minimum"
                :max="field.maximum"
                :step="field.type === 'integer' ? 1 : 'any'"
                :disabled="busy"
              />
              <input v-else v-model="parameters[name]" type="text" :disabled="busy" />
            </label>
          </div>
          <label v-if="auxiliaryUses.length" class="assistant-vision-choice">
            <input v-model="inherit" type="checkbox" :disabled="busy" />
            {{ label('沿用人物与风格参考') }}
          </label>
          <small class="studio-field-hint">{{ label('旧起始帧与尾帧不会自动带入新任务。') }}</small>
        </aside>
      </div>
      <div v-else class="continuation-sequence">
        <video
          ref="sequencePlayer"
          controls
          playsinline
          :poster="selectedFrame?.url"
          @timeupdate="nextClip"
          @ended="nextClip"
        />
        <div class="continuation-sequence-actions">
          <button class="quiet-button outlined" @click="playSequence()">
            <Icon name="play" :size="15" />
            {{ label('播放至当前片段') }}
          </button>
        </div>
        <div class="continuation-clip-strip">
          <article v-for="(clip, index) in ancestors" :key="clip.id">
            <strong>{{ index + 1 }} · {{ clip.content.name }}</strong>
            <small>
              {{
                clip.content.continuation
                  ? t('apps.pictoria.video', '接续自 {0} · {1}s', [
                      clip.content.continuation.sourceName,
                      clip.content.continuation.sourceTime.toFixed(3),
                    ])
                  : label('起始片段')
              }}
            </small>
          </article>
          <article v-for="child in children" :key="child.id">
            <strong>{{ child.content.name }}</strong>
            <button class="text-button" @click="playSequence(child)">
              <Icon name="play" :size="15" />
              {{ label('播放此接续分支') }}
            </button>
            <button class="text-button" :disabled="busy" @click="emit('continue', child)">
              {{ label('从这一段继续') }}
            </button>
          </article>
          <article v-for="run in runs" :key="run.id">
            <strong>{{ run.content.name }}</strong>
            <small>
              {{ t('apps.pictoria.video', '任务状态：{0}', [taskState(run.content.state)]) }}
            </small>
            <small v-if="run.content.error">{{ run.content.error }}</small>
          </article>
          <button
            v-for="draft in drafts"
            :key="draft.id"
            :disabled="busy || loading"
            @click="editDraft(draft)"
          >
            <Icon name="note" :size="16" />
            <strong>{{ label('接续草稿') }}</strong>
            <small>{{ draft.content.continuation?.sourceTime.toFixed(3) }} s</small>
          </button>
        </div>
      </div>
      <p v-if="failure" class="studio-field-error" role="alert">{{ failure }}</p>
      <footer class="studio-modal-footer">
        <small role="status">
          {{ notice || label('原视频保留；接续固定到所选视频版本与画面。') }}
        </small>
        <button
          class="quiet-button"
          :disabled="busy || loading || !step || !selectedFrame"
          @click="saveDraft()"
        >
          {{ label('保存接续草稿') }}
        </button>
        <button
          class="create-button"
          :disabled="busy || loading || !step || !selectedFrame || !prompt.trim()"
          @click="saveDraft(true)"
        >
          <Icon name="sparkle" :size="15" />
          {{ label('生成下一段') }}
        </button>
      </footer>
    </section>
  </div>
</template>
