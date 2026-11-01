<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import type { CanvasStore } from '../composables/useCanvas'
import { useCanvasAssistant } from '../composables/useCanvasAssistant'
import { isAssetField, isAssetsField, type useCanvasLinks } from '../composables/useCanvasLinks'
import { applyCanvasOperations, type CanvasOperation } from '../../../src/canvasDocument'
import { pictoria, fileBase64, standalone } from '../services/transport'
import { canvasCandidates } from '../services/canvasCandidates'
import {
  exportProjectPackage,
  readProjectPackage,
  remapProjectAssets,
} from '../services/projectPackage'
import type { Asset, CanvasItem, Project } from '../types'
import ImageStudio from './ImageStudio.vue'
import VideoContinuationStudio from './VideoContinuationStudio.vue'
import CanvasMinimap from './CanvasMinimap.vue'
import Icon from './PictoriaIcon.vue'
import PictoriaSelect from './PictoriaSelect.vue'
import CanvasProposalReview from './CanvasProposalReview.vue'
import CanvasAssistantSettings from './CanvasAssistantSettings.vue'
import type { AssistantSettings } from '../../../src/assistantSettings'

const props = defineProps<{
  store: CanvasStore
  links: ReturnType<typeof useCanvasLinks>
  viewport: { x: number; y: number; scale: number }
  size: { width: number; height: number }
}>()
const label = (source: string) => t('apps.pictoria.studio', source)
const settingLabel = (source: string) => t('apps.pictoria.assistant', source)
const emit = defineEmits<{
  navigate: [x: number, y: number]
  modal: [open: boolean]
  assistant: [open: boolean]
  providers: []
}>()
const store = props.store,
  assistant = useCanvasAssistant(store)
const assistantOpen = ref(false),
  assistantSettingsOpen = ref(false),
  image = ref<CanvasItem>(),
  busy = ref(false),
  failure = ref(''),
  progress = ref('')
const video = ref<CanvasItem>()
watch(
  () => `${store.agentId.value}:${store.project.id}`,
  () => {
    video.value = undefined
    assistantSettingsOpen.value = false
  },
)
function openVideo() {
  const item = store.activeItems.value[0]
  if (!busy.value && item?.content.assetId && item.content.mimeType?.startsWith('video/'))
    video.value = item
}
const candidatesOpen = ref(false)
const editStep = ref(''),
  maskMode = ref<'reference' | 'alpha' | 'white'>('reference')
const packageInput = ref<HTMLInputElement>(),
  imported = ref<Awaited<ReturnType<typeof readProjectPackage>>>()
const projectMenu = ref<HTMLDetailsElement>()
const conversationView = ref<HTMLElement>()
watch(assistantOpen, (value) => emit('assistant', value), { immediate: true })
watch(
  () => [assistantOpen.value, assistant.messages.value.length, assistant.proposals.value.length],
  async () => {
    await nextTick()
    conversationView.value?.scrollTo({ top: conversationView.value.scrollHeight })
  },
)
const assistantSource = computed(() =>
  assistant.providerId.value
    ? assistant.model.value ||
      assistant.providers.value.find((provider) => provider.id === assistant.providerId.value)
        ?.name ||
      settingLabel('模型')
    : settingLabel(standalone ? '选择供应商' : '主模型'),
)
const editOptions = computed(() =>
  editSteps.value.map((step) => ({ value: step.id, label: step.name })),
)
const maskOptions = computed(() => [
  { value: 'reference', label: label('原图与蓝色标注图参考') },
  { value: 'alpha', label: label('透明区域可编辑的蒙版') },
  { value: 'white', label: label('白色区域可编辑的蒙版') },
])
function closeMenu() {
  projectMenu.value?.removeAttribute('open')
}
function chooseExport() {
  closeMenu()
  void exportPackage()
}
function chooseImport() {
  closeMenu()
  packageInput.value?.click()
}
function selectMask(value: string) {
  if (value === 'reference' || value === 'alpha' || value === 'white') maskMode.value = value
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !projectMenu.value?.contains(event.target)) closeMenu()
}
async function saveAssistantSettings(value: AssistantSettings) {
  if (await assistant.saveSettings(value)) assistantSettingsOpen.value = false
}
function ungroup() {
  if (active.value?.content.kind === 'group') apply([{ type: 'ungroup', id: active.value.id }])
}
onMounted(() => window.addEventListener('pointerdown', outside))
onBeforeUnmount(() => window.removeEventListener('pointerdown', outside))
function openCandidates() {
  candidatesOpen.value = true
}
defineExpose({
  group,
  ungroup,
  openImage,
  openVideo,
  openCandidates,
  busy,
  refreshProviders: assistant.refreshProviders,
})
watch(
  () => Boolean(image.value || video.value || imported.value),
  (value) => emit('modal', value),
  { immediate: true },
)
const active = computed(() => store.activeItems.value[0])
const editSteps = computed(() =>
  store.steps.value.filter(
    (step) =>
      step.available &&
      Object.values(step.inputSchema.properties ?? {}).some(
        (field) => isAssetField(field) || isAssetsField(field),
      ),
  ),
)
const candidateIndex = computed(() => canvasCandidates(store.project.items, store.project.edges))
const candidateSet = computed(() =>
  active.value ? candidateIndex.value.get(active.value.id) : undefined,
)
const candidates = computed(() => candidateSet.value?.items ?? [])
const candidateParent = computed(() => candidateSet.value?.parent)
watch(
  () => candidateParent.value?.id,
  () => {
    candidatesOpen.value = false
  },
  { flush: 'sync' },
)
watch(candidates, (items) => {
  for (const item of items) void store.ensureThumbnail(item.content.assetId!)
})
function report(error: unknown) {
  failure.value =
    error instanceof Error && !/^(?:PACKAGE_|CANVAS_|IMAGE_)/.test(error.message)
      ? error.message
      : label('操作失败，请检查文件与参数后重试')
}
function apply(operations: CanvasOperation[]) {
  try {
    const result = applyCanvasOperations(store.project, operations)
    store.checkpoint()
    Object.assign(store.project, result.document)
    if (result.selected) store.selected.value = result.selected
  } catch (error) {
    report(error)
  }
}
function group() {
  apply([
    {
      type: 'group',
      id: crypto.randomUUID(),
      ids: [...store.selected.value],
      name: label('新分组'),
    },
  ])
}
async function openImage() {
  const source = active.value,
    owner = store.agentId.value,
    projectId = store.project.id
  if (!source?.content.assetId) return
  if (!editSteps.value.some((step) => step.id === editStep.value))
    editStep.value = editSteps.value[0]?.id || ''
  failure.value = ''
  try {
    await store.ensureMedia(source.content.assetId)
    if (
      owner === store.agentId.value &&
      projectId === store.project.id &&
      store.project.items.includes(source)
    )
      image.value = source
  } catch (error) {
    report(error)
  }
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
const bytes = (base64: string) =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
async function downloadAsset(item: CanvasItem) {
  try {
    const data = await pictoria.asset(store.agentId.value, item.content.assetId!)
    download(new Blob([bytes(data.base64)], { type: data.info.mimeType }), data.info.name)
  } catch (error) {
    report(error)
  }
}
async function upload(blob: Blob, name: string, owner: string) {
  if (blob.size > 20 * 1024 * 1024) throw new Error(label('单个素材不能超过 20 MiB'))
  return pictoria.upload(
    owner,
    name,
    blob.type || 'image/png',
    await fileBase64(new File([blob], name, { type: blob.type })),
  )
}
async function editResult(files: Blob[], action: string, prompt?: string, mask?: Blob) {
  const source = image.value
  if (!source || busy.value) return
  busy.value = true
  failure.value = ''
  const owner = store.agentId.value,
    projectId = store.project.id
  try {
    const step = prompt ? editSteps.value.find((step) => step.id === editStep.value) : undefined
    if (prompt && !step) throw new Error(label('请先选择局部编辑步骤'))
    let imageField: [string, import('../types').FieldSchema] | undefined,
      promptField: string | undefined,
      maskField: string | undefined
    if (step) {
      const fields = Object.entries(step.inputSchema.properties ?? {})
      imageField = fields.find(
        ([name, field]) => !/mask/i.test(name) && (isAssetField(field) || isAssetsField(field)),
      )
      maskField = fields.find(([name, field]) => /mask/i.test(name) && isAssetField(field))?.[0]
      promptField = fields.find(
        ([name, field]) =>
          field.type === 'string' && !field.enum && /prompt|instruction|text/i.test(name),
      )?.[0]
      if (!promptField) throw new Error(label('步骤缺少提示词字段，请选择兼容的编辑步骤'))
      if (
        !imageField ||
        (maskMode.value === 'reference'
          ? !isAssetsField(imageField[1]) || (imageField[1].maxItems ?? 20) < 2
          : !maskField)
      )
        throw new Error(label('步骤输入不兼容所选编辑方式，请选择多图参考或独立蒙版字段'))
    }
    const assets: Asset[] = []
    for (let i = 0; i < files.length; i++)
      assets.push(
        await upload(files[i]!, `${source.content.name || 'image'}-${action}-${i + 1}.png`, owner),
      )
    let maskAsset: Asset | undefined
    if (prompt && mask && maskMode.value !== 'reference')
      maskAsset = await upload(mask, `${source.content.name || 'image'}-mask.png`, owner)
    if (owner !== store.agentId.value || projectId !== store.project.id)
      throw new Error(label('画布已切换，素材已保留在资源库'))
    store.checkpoint()
    for (let i = 0; i < assets.length; i++) {
      const item = store.addAsset(
        assets[i]!,
        source.x + source.content.width + 70 + (i % 4) * 300,
        source.y + Math.floor(i / 4) * 280,
      )
      store.project.edges ||= []
      store.project.edges.push({
        id: crypto.randomUUID(),
        source: source.id,
        target: item.id,
        field: action,
        historical: true,
      })
    }
    if (prompt && step && imageField) {
      const inputs: Record<string, unknown> = {},
        ref = { assetId: source.content.assetId! }
      inputs[imageField[0]] = isAssetsField(imageField[1])
        ? [ref, ...(maskMode.value === 'reference' ? [{ assetId: assets[0]!.id }] : [])]
        : ref
      if (maskAsset && maskField) inputs[maskField] = { assetId: maskAsset.id }
      inputs[promptField!] =
        maskMode.value === 'reference'
          ? `${prompt}\nOnly edit the blue highlighted region in the second reference image. Preserve all other areas of the original first image. Remove the blue annotation in the result.`
          : prompt
      props.links.addDraft(step, inputs, { x: source.x + source.content.width + 390, y: source.y })
    }
    image.value = undefined
  } catch (error) {
    report(error)
  } finally {
    busy.value = false
  }
}
function choosePrimary(item: CanvasItem) {
  if (!candidateParent.value) return
  store.checkpoint()
  candidateParent.value.content.primaryAssetId = item.content.assetId
  store.selected.value = [item.id]
}
function toggleCandidates() {
  if (candidateParent.value) {
    store.checkpoint()
    candidateParent.value.content.candidatesExpanded =
      !candidateParent.value.content.candidatesExpanded
  }
}
async function retryCandidate(candidate?: CanvasItem) {
  const parent = candidateParent.value
  if (!parent?.content.step || busy.value) return
  busy.value = true
  try {
    const step = store.steps.value.find(
      (step) => step.id === parent.content.step!.id && step.available,
    )
    if (!step || step.revision !== parent.content.step.revision)
      throw new Error(label('步骤已更新，请通过创建栏使用新配置重试'))
    const inputs = JSON.parse(JSON.stringify(parent.content.inputs ?? {})) as Record<
      string,
      unknown
    >
    const count = Object.entries(step.inputSchema.properties ?? {}).find(
      ([name, field]) =>
        /^(n|count|num_images|numImages|batch_size)$/.test(name) &&
        (field.type === 'integer' || field.type === 'number'),
    )
    if (!count || (count[1].minimum ?? 1) > 1)
      throw new Error(label('该步骤未提供单张生成参数，请在创建栏重新生成'))
    inputs[count[0]] = 1
    const run = await store.createRun(
      step,
      inputs,
      { x: parent.x, y: parent.y + parent.content.height + 40 },
      crypto.randomUUID(),
    )
    if (run) {
      run.content.candidateParentId = parent.id
      if (candidate) {
        store.project.edges ||= []
        store.project.edges.push({
          id: crypto.randomUUID(),
          source: candidate.id,
          target: run.id,
          field: 'retry',
          historical: true,
        })
      }
    }
  } catch (error) {
    report(error)
  } finally {
    busy.value = false
  }
}
async function exportPackage() {
  if (busy.value) return
  busy.value = true
  failure.value = ''
  progress.value = label('正在打包项目与原始素材')
  const project = JSON.parse(JSON.stringify(store.project)) as Project,
    owner = store.agentId.value
  try {
    download(
      await exportProjectPackage(project, async (id) => {
        const data = await pictoria.asset(owner, id)
        return { info: data.info, bytes: bytes(data.base64) }
      }),
      `${project.title}.pictoria.zip`,
    )
  } catch (error) {
    failure.value =
      error instanceof Error && error.message === 'PACKAGE_TASK_ACTIVE'
        ? label('请等待正在执行的任务结束后再导出')
        : ''
    if (!failure.value) report(error)
  } finally {
    busy.value = false
    progress.value = ''
  }
}
async function previewPackage(event: Event) {
  const element = event.target as HTMLInputElement,
    file = element.files?.[0]
  element.value = ''
  if (!file || busy.value) return
  busy.value = true
  failure.value = ''
  progress.value = label('正在校验项目包')
  try {
    if (file.size > 256 * 1024 * 1024) throw new Error(label('项目包不能超过 256 MiB'))
    imported.value = await readProjectPackage(new Uint8Array(await file.arrayBuffer()))
  } catch (error) {
    report(error)
  } finally {
    busy.value = false
    progress.value = ''
  }
}
async function importPackage() {
  if (!imported.value || busy.value) return
  busy.value = true
  failure.value = ''
  const owner = store.agentId.value,
    projectId = store.project.id,
    packed = imported.value
  try {
    if (packed.manifest.assets.some((asset) => asset.sizeBytes > 20 * 1024 * 1024))
      throw new Error(label('单个素材不能超过 20 MiB'))
    const assets = new Map<string, Asset>()
    for (const asset of packed.manifest.assets) {
      progress.value = t('apps.pictoria.studio', '正在导入素材 {0}/{1}', [
        assets.size + 1,
        packed.manifest.assets.length,
      ])
      assets.set(
        asset.id,
        await upload(
          new Blob([new Uint8Array(packed.files[asset.path]!)], { type: asset.mimeType }),
          asset.name,
          owner,
        ),
      )
    }
    const copy = remapProjectAssets(packed.manifest.project, assets)
    const definition = {
      id: copy.id,
      title: copy.title,
      items: copy.items,
      edges: copy.edges ?? [],
      collectionId: null,
      dismissedRunIds: [],
      creation: copy.creation,
      viewport: copy.viewport,
    }
    const saved = await pictoria.operation<Project>(owner, 'project.save', {
      definition,
      expectedRevision: 0,
    })
    if (owner === store.agentId.value)
      store.projects.value = [
        saved,
        ...store.projects.value.filter((entry) => entry.id !== saved.id),
      ]
    if (owner !== store.agentId.value || projectId !== store.project.id)
      throw new Error(label('画布已切换，导入的项目已保存在项目列表'))
    imported.value = undefined
    await store.openProject(saved.id)
    if (store.project.id !== saved.id)
      throw new Error(label('项目已导入并保存在列表中，当前画布暂未切换'))
  } catch (error) {
    report(error)
  } finally {
    busy.value = false
    progress.value = ''
  }
}
</script>
<template>
  <div class="studio-launcher" data-ui @pointerdown.stop>
    <button
      class="quiet-button studio-assistant-toggle floating-panel"
      :class="{ active: assistantOpen }"
      :disabled="busy"
      :aria-expanded="assistantOpen"
      @click="assistantOpen = !assistantOpen"
    >
      <Icon name="sparkle" :size="15" />
      <span>{{ label('画布助手') }}</span>
      <i v-if="assistant.pending.value" class="studio-status-dot" />
    </button>
    <details ref="projectMenu" class="studio-project-menu" @keydown.esc.stop="closeMenu">
      <summary
        class="icon-button floating-panel"
        :aria-label="label('项目工具')"
        :title="label('项目工具')"
      >
        <Icon name="more" :size="18" />
      </summary>
      <nav class="studio-project-popover floating-panel" :aria-label="label('项目工具')">
        <small>{{ label('项目工具') }}</small>
        <button :disabled="busy || !store.online.value" @click="chooseExport">
          <Icon name="download" :size="16" />
          <span>{{ label('导出项目包') }}</span>
        </button>
        <button :disabled="busy || !store.online.value" @click="chooseImport">
          <Icon name="upload" :size="16" />
          <span>{{ label('导入项目包') }}</span>
        </button>
      </nav>
    </details>
    <input
      ref="packageInput"
      hidden
      type="file"
      accept=".zip,application/zip"
      @change="previewPackage"
    />
  </div>
  <Transition name="float">
    <div
      v-if="failure || progress"
      class="studio-notification floating-panel"
      :class="{ 'is-error': failure }"
      data-ui
      :role="failure ? 'alert' : 'status'"
    >
      <Icon :name="failure ? 'close' : 'refresh'" :size="15" />
      <span>{{ failure || progress }}</span>
      <button v-if="failure" class="icon-button" :aria-label="label('关闭')" @click="failure = ''">
        <Icon name="close" :size="13" />
      </button>
    </div>
  </Transition>
  <CanvasMinimap
    v-if="store.project.items.length && !assistantOpen"
    :project="store.project"
    :viewport="viewport"
    :size="size"
    @center="(x, y) => emit('navigate', x, y)"
  />
  <Transition name="float">
    <section
      v-if="candidates.length > 1 && candidatesOpen"
      class="studio-candidates floating-panel"
      data-ui
      @pointerdown.stop
    >
      <header>
        <div class="studio-section-title">
          <Icon name="image" :size="14" />
          <strong>{{ label('候选图') }}</strong>
          <small>{{ candidates.length }}</small>
        </div>
        <div class="studio-header-actions">
          <button
            class="icon-button"
            :title="
              candidateParent?.content.candidatesExpanded ? label('收起到主图') : label('展开全部')
            "
            :aria-label="
              candidateParent?.content.candidatesExpanded ? label('收起到主图') : label('展开全部')
            "
            :aria-pressed="!!candidateParent?.content.candidatesExpanded"
            @click="toggleCandidates"
          >
            <Icon
              :name="candidateParent?.content.candidatesExpanded ? 'layers' : 'grid'"
              :size="14"
            />
          </button>
          <button class="icon-button" :aria-label="label('关闭')" @click="candidatesOpen = false">
            <Icon name="close" :size="13" />
          </button>
        </div>
      </header>
      <div class="candidate-strip">
        <article
          v-for="(item, index) in candidates"
          :key="item.id"
          :class="{ primary: candidateSet?.primary?.id === item.id }"
        >
          <button
            class="candidate-preview"
            :aria-label="item.content.name || label('候选图')"
            :aria-pressed="store.selected.value.includes(item.id)"
            @click="store.selected.value = [item.id]"
          >
            <img
              :src="store.thumbnails[item.content.assetId!] || store.urls[item.content.assetId!]"
              :alt="item.content.name"
            />
            <span>{{ String(index + 1).padStart(2, '0') }}</span>
          </button>
          <button
            class="candidate-primary"
            :class="{ chosen: candidateSet?.primary?.id === item.id }"
            :aria-label="candidateSet?.primary?.id === item.id ? label('主图') : label('设为主图')"
            :title="candidateSet?.primary?.id === item.id ? label('主图') : label('设为主图')"
            :aria-pressed="candidateSet?.primary?.id === item.id"
            @click="choosePrimary(item)"
          >
            <Icon name="check" :size="12" />
          </button>
          <footer>
            <span>
              {{
                candidateSet?.primary?.id === item.id
                  ? label('主图')
                  : String(index + 1).padStart(2, '0')
              }}
            </span>
            <button
              class="icon-button"
              :aria-label="label('下载')"
              :title="label('下载')"
              @click="downloadAsset(item)"
            >
              <Icon name="download" :size="13" />
            </button>
            <button
              class="icon-button"
              :disabled="busy"
              :aria-label="label('单张重试')"
              :title="label('单张重试')"
              @click="retryCandidate(item)"
            >
              <Icon name="refresh" :size="13" />
            </button>
          </footer>
        </article>
      </div>
    </section>
  </Transition>
  <Transition name="float">
    <aside
      v-if="assistantOpen"
      class="studio-assistant floating-panel"
      data-ui
      role="dialog"
      :aria-label="label('画布助手')"
      @pointerdown.stop
    >
      <header class="studio-panel-header">
        <div class="studio-heading">
          <span class="studio-heading-icon">
            <Icon :name="assistantSettingsOpen ? 'settings' : 'sparkle'" :size="17" />
          </span>
          <div>
            <strong>
              {{ assistantSettingsOpen ? settingLabel('助手设置') : label('画布助手') }}
            </strong>
            <small>{{ assistantSettingsOpen ? settingLabel('当前画布') : assistantSource }}</small>
          </div>
        </div>
        <div class="studio-header-actions">
          <button
            class="icon-button"
            :disabled="
              !assistant.ready.value || assistant.busy.value || assistant.settingsBusy.value
            "
            :aria-expanded="assistantSettingsOpen"
            :title="settingLabel(assistantSettingsOpen ? '返回对话' : '设置')"
            :aria-label="settingLabel(assistantSettingsOpen ? '返回对话' : '设置')"
            @click="assistantSettingsOpen = !assistantSettingsOpen"
          >
            <Icon
              :name="assistantSettingsOpen ? 'chevron' : 'settings'"
              :size="15"
              :class="{ 'assistant-back-icon': assistantSettingsOpen }"
            />
          </button>
          <button
            class="icon-button"
            :disabled="assistant.busy.value || assistant.settingsBusy.value"
            :title="label('重新连接')"
            :aria-label="label('重新连接')"
            @click="assistant.reload"
          >
            <Icon name="refresh" :size="14" />
          </button>
          <button class="icon-button" :aria-label="label('关闭')" @click="assistantOpen = false">
            <Icon name="close" :size="16" />
          </button>
        </div>
      </header>
      <p v-if="assistant.failure.value" class="assistant-error" role="alert">
        {{ assistant.failure.value }}
      </p>
      <CanvasAssistantSettings
        v-if="assistantSettingsOpen"
        :settings="assistant.settings.value"
        :providers="assistant.providers.value"
        :hosted="!standalone"
        :disabled="!assistant.ready.value || assistant.busy.value"
        :saving="assistant.settingsBusy.value"
        @save="saveAssistantSettings"
        @providers="emit('providers')"
      />
      <template v-else>
        <div ref="conversationView" class="assistant-history" aria-live="polite">
          <div
            v-if="!assistant.messages.value.length && !assistant.proposals.value.length"
            class="assistant-empty"
          >
            <span><Icon name="sparkle" :size="25" /></span>
            <h3>{{ label('从一个想法开始') }}</h3>
            <p>{{ label('整理参考、补充灵感，或规划下一步创作。') }}</p>
            <button
              v-for="suggestion in ['整理选中的节点', '为画布补充创作便签', '规划下一步创作']"
              :key="suggestion"
              @click="assistant.input.value = label(suggestion)"
            >
              {{ label(suggestion) }}
              <Icon name="plus" :size="13" />
            </button>
          </div>
          <article
            v-for="message in assistant.messages.value"
            :key="message.id"
            :class="message.role"
          >
            <div class="assistant-message-author">
              <Icon v-if="message.role === 'assistant'" name="sparkle" :size="13" />
              <small>{{ message.role === 'user' ? label('我') : label('助手') }}</small>
            </div>
            <p>{{ message.text }}</p>
            <CanvasProposalReview
              v-if="message.proposal"
              :proposal="message.proposal"
              :project="store.project"
              :steps="store.steps.value"
            />
            <div v-if="message.proposal?.operations.length" class="assistant-proposal-actions">
              <button
                class="text-button"
                :disabled="assistant.busy.value"
                @click="assistant.rejectMessage(message)"
              >
                {{ label('拒绝') }}
              </button>
              <button
                class="create-button"
                :disabled="busy || assistant.busy.value"
                @click="assistant.applyMessage(message)"
              >
                <Icon name="check" :size="13" />
                {{ label('确认应用') }}
              </button>
            </div>
          </article>
          <article
            v-for="proposal in assistant.proposals.value"
            :key="proposal.id"
            class="assistant"
          >
            <div class="assistant-message-author">
              <Icon name="sparkle" :size="13" />
              <small>{{ label('助手') }}</small>
            </div>
            <p>{{ proposal.proposal.message }}</p>
            <CanvasProposalReview
              :proposal="proposal.proposal"
              :project="store.project"
              :steps="store.steps.value"
            />
            <div class="assistant-proposal-actions">
              <button class="text-button" @click="assistant.resolveExternal(proposal, false)">
                {{ label('拒绝') }}
              </button>
              <button class="create-button" @click="assistant.resolveExternal(proposal, true)">
                <Icon name="check" :size="13" />
                {{ label('确认应用') }}
              </button>
            </div>
          </article>
          <div v-if="assistant.pending.value" class="assistant-working" role="status">
            <i class="studio-status-dot" />
            <span>{{ label('助手正在构思…') }}</span>
            <button class="text-button" @click="assistant.cancel">{{ label('取消任务') }}</button>
          </div>
        </div>
        <footer class="assistant-composer">
          <label class="assistant-vision-choice">
            <input
              v-model="assistant.includeImages.value"
              type="checkbox"
              :disabled="assistant.busy.value || !assistant.selectedImages.value.length"
            />
            {{
              t('apps.pictoria.vision', '分析所选图片（{0} 张）', [
                assistant.selectedImages.value.length,
              ])
            }}
          </label>
          <div class="assistant-context">
            <Icon :name="store.selected.value.length ? 'select' : 'layers'" :size="12" />
            <span>
              {{
                assistant.settings.value.contextScope === 'selection'
                  ? t('apps.pictoria.assistant', '选中 {0} 项', [store.selected.value.length])
                  : settingLabel('全画布')
              }}
            </span>
            <small :title="label('仅勾选时发送所选图片；应用修改前请确认，可通过撤销恢复。')">
              {{ label('确认后应用 · 可撤销') }}
            </small>
          </div>
          <div class="assistant-input">
            <textarea
              v-model="assistant.input.value"
              rows="3"
              :aria-label="label('描述你想如何整理或创作…')"
              :placeholder="label('描述你想如何整理或创作…')"
              @keydown.ctrl.enter.prevent="assistant.send"
            />
            <div>
              <kbd>Ctrl ↵</kbd>
              <button
                class="create-button"
                :disabled="
                  !assistant.ready.value ||
                  assistant.busy.value ||
                  assistant.settingsBusy.value ||
                  !!assistant.pending.value ||
                  !assistant.input.value.trim() ||
                  (standalone && !assistant.providerId.value) ||
                  (assistant.settings.value.contextScope === 'selection' &&
                    !store.selected.value.length)
                "
                @click="assistant.send"
              >
                <Icon name="send" :size="14" />
                {{ label('生成修改方案') }}
              </button>
            </div>
          </div>
        </footer>
      </template>
    </aside>
  </Transition>
  <ImageStudio
    v-if="image && store.urls[image.content.assetId!]"
    :item="image"
    :url="store.urls[image.content.assetId!]!"
    :mask-convention="maskMode"
    :external-busy="busy"
    @close="image = undefined"
    @result="editResult"
  >
    <template #editing-options>
      <details class="studio-edit-provider">
        <summary>
          <Icon name="settings" :size="14" />
          <span>
            {{
              editOptions.find((entry) => entry.value === editStep)?.label || label('请选择步骤')
            }}
          </span>
          <Icon name="down" :size="12" />
        </summary>
        <div class="studio-option-fields">
          <label class="studio-field">
            {{ label('局部编辑步骤') }}
            <PictoriaSelect
              v-model="editStep"
              :label="label('局部编辑步骤')"
              :placeholder="label('请选择步骤')"
              :options="editOptions"
              :disabled="busy"
            />
          </label>
          <label class="studio-field">
            {{ label('编辑方式') }}
            <PictoriaSelect
              :model-value="maskMode"
              :label="label('编辑方式')"
              :options="maskOptions"
              :disabled="busy"
              @update:model-value="selectMask"
            />
          </label>
        </div>
      </details>
    </template>
  </ImageStudio>
  <Transition name="float">
    <div v-if="imported" class="studio-modal-backdrop" data-ui>
      <section
        class="studio-modal studio-package"
        role="dialog"
        aria-modal="true"
        :aria-label="label('导入项目包')"
      >
        <header class="studio-modal-header">
          <div class="studio-heading">
            <span class="studio-heading-icon"><Icon name="folder" :size="19" /></span>
            <div>
              <strong>{{ label('导入项目包') }}</strong>
              <small>{{ imported.manifest.project.title }}</small>
            </div>
          </div>
          <button
            class="icon-button"
            :disabled="busy"
            :aria-label="label('关闭')"
            @click="imported = undefined"
          >
            <Icon name="close" :size="17" />
          </button>
        </header>
        <div class="studio-package-body">
          <div class="studio-package-stats">
            <div>
              <strong>{{ imported.manifest.project.items.length }}</strong>
              <span>{{ label('画布节点') }}</span>
            </div>
            <div>
              <strong>{{ imported.manifest.assets.length }}</strong>
              <span>{{ label('原始素材') }}</span>
            </div>
            <span class="studio-package-verified">
              <Icon name="check" :size="13" />
              {{ label('校验完成') }}
            </span>
          </div>
          <p>{{ label('导入后创建独立项目，保留当前画布。') }}</p>
          <small>{{ label('项目包不含供应商密钥；API 步骤需在本机重新配置或确认。') }}</small>
          <p v-if="progress" role="status">{{ progress }}</p>
        </div>
        <footer class="studio-modal-footer">
          <button class="quiet-button" :disabled="busy" @click="imported = undefined">
            {{ label('取消') }}
          </button>
          <button class="create-button" :disabled="busy" @click="importPackage">
            <Icon name="upload" :size="14" />
            {{ label('确认导入') }}
          </button>
        </footer>
      </section>
    </div>
  </Transition>
  <VideoContinuationStudio
    v-if="video"
    :key="`${store.agentId.value}:${store.project.id}:${video.id}`"
    :store="store"
    :links="links"
    :item="video"
    @close="video = undefined"
    @busy="busy = $event"
    @continue="video = $event"
  />
</template>
