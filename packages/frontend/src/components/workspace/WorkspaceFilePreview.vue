<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import type { WorkspaceFileDescriptor } from '@infos/shared'
import { workspaceApi } from '../../api/modules/approvalsApi'
import { isElectronRuntime } from '../../api/transport'
import { invoke, listen } from '../../utils/ipcAdapter'
import WorkspaceFileGlyph from './WorkspaceFileGlyph.vue'
import WorkspaceImageViewer from './WorkspaceImageViewer.vue'
import WorkspaceMediaViewer from './WorkspaceMediaViewer.vue'
import type { WorkspacePreviewState } from './workspacePreview'
import './workspace-file-preview.css'

const props = defineProps<{
  file: WorkspaceFileDescriptor
  session: { agentId: string; threadId: string }
  state: WorkspacePreviewState
  active: boolean
}>()
const emit = defineEmits<{
  reload: []
  state: [state: WorkspacePreviewState, patch: Partial<WorkspacePreviewState>]
  fullscreen: []
}>()
const PdfViewer = defineAsyncComponent({
  loader: () => import('./WorkspacePdfViewer.vue'),
  onError(_error, _retry, fail) {
    failure.value = 'PDF 阅读组件无法加载，请重新载入'
    fail()
  },
})
const failure = ref(''),
  actionError = ref(''),
  svgUrl = ref(''),
  svgLoading = ref(false),
  opening = ref(false)
const documentVisible = ref(document.visibilityState !== 'hidden')
const nativeVisible = ref(true)
const visible = computed(() => props.active && documentVisible.value && nativeVisible.value)
const url = computed(() =>
  workspaceApi.contentUrl(props.session, props.file.path, props.file.version),
)
const downloadUrl = computed(() =>
  workspaceApi.contentUrl(props.session, props.file.path, props.file.version, true),
)
const label = computed(
  () =>
    ({
      image:
        props.file.mimeType === 'image/gif'
          ? __t('ui.workspace', 'GIF 动图')
          : __t('ui.workspace', '图片'),
      get svg() {
        return __t('ui.workspace', 'SVG 矢量图')
      },
      get pdf() {
        return __t('ui.workspace', 'PDF 文档')
      },
      get audio() {
        return __t('ui.workspace', '音频')
      },
      video: '视频',
      get text() {
        return __t('ui.workspace', '文本')
      },
      get file() {
        return __t('ui.workspace', '文件')
      },
    })[props.file.kind],
)
const size = computed(() =>
  props.file.sizeBytes < 1024
    ? `${props.file.sizeBytes} B`
    : props.file.sizeBytes < 1024 ** 2
      ? `${(props.file.sizeBytes / 1024).toFixed(1)} KB`
      : `${(props.file.sizeBytes / 1024 ** 2).toFixed(1)} MB`,
)
let svgRequest: AbortController | undefined
let stopWindowVisibility: (() => void) | undefined
let disposed = false
let visibilityRevision = 0
function releaseSvg() {
  svgRequest?.abort()
  svgRequest = undefined
  if (svgUrl.value) URL.revokeObjectURL(svgUrl.value)
  svgUrl.value = ''
}
async function loadSvg() {
  releaseSvg()
  const controller = new AbortController()
  svgRequest = controller
  svgLoading.value = true
  try {
    if (props.file.sizeBytes > 4 * 1024 * 1024)
      throw new Error('SVG 超过 4 MB，可下载或用系统应用查看')
    const response = await workspaceApi.fileContent(
      props.session,
      props.file.path,
      props.file.version,
      controller.signal,
    )
    const source = await response.text()
    controller.signal.throwIfAborted()
    const clean = DOMPurify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'a'],
    })
    const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml')
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg')
      throw new Error('SVG 内容无效')
    // 只保留片段引用与内嵌图像；以 img 显示，SVG 不获得应用 DOM 的权限。
    for (const element of parsed.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        if (
          attribute.localName === 'href' &&
          !/^(?:#|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(attribute.value.trim())
        )
          element.removeAttributeNode(attribute)
      }
    }
    parsed.documentElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    svgUrl.value = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(parsed)], { type: 'image/svg+xml' }),
    )
  } catch (error) {
    if (!controller.signal.aborted)
      failure.value = error instanceof Error ? error.message : 'SVG 无法显示'
  } finally {
    if (svgRequest === controller) svgLoading.value = false
  }
}
async function openSystem() {
  if (opening.value) return
  opening.value = true
  actionError.value = ''
  try {
    const result = await workspaceApi.openFile(props.session, props.file.path, !isElectronRuntime())
    if (isElectronRuntime() && result.data) await invoke('open-local-path', result.data.path)
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '无法打开文件'
  } finally {
    opening.value = false
  }
}
function visibilityChanged() {
  documentVisible.value = document.visibilityState !== 'hidden'
}
watch(
  [() => props.file.version, visible],
  () => {
    if (props.file.kind !== 'svg') return
    if (visible.value) {
      if (!svgUrl.value) void loadSvg()
    } else {
      releaseSvg()
      svgLoading.value = false
    }
  },
  { immediate: true },
)
onMounted(async () => {
  document.addEventListener('visibilitychange', visibilityChanged)
  if (!isElectronRuntime()) return
  try {
    const stop = await listen('window-visibility-changed', (value) => {
      if (typeof value === 'boolean') {
        ++visibilityRevision
        nativeVisible.value = value
      }
    })
    if (disposed) {
      stop()
      return
    }
    stopWindowVisibility = stop
    const revision = visibilityRevision
    const value = await invoke('window-is-visible')
    if (!disposed && revision === visibilityRevision && typeof value === 'boolean')
      nativeVisible.value = value
  } catch {
    /* 旧客户端没有窗口可见性接口时，仍使用页面与工作区状态。 */
  }
})
onBeforeUnmount(() => {
  disposed = true
  stopWindowVisibility?.()
  releaseSvg()
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>
<template>
  <div class="workspace-file-preview">
    <div class="file-view-controls workspace-file-preview__meta">
      <WorkspaceFileGlyph :kind="file.kind" />
      <span>{{ label }}</span>
      <small>{{ size }}</small>
      <span class="file-view-spacer" />
      <button type="button" @click="emit('reload')">{{ __t('ui.workspace', '重新载入') }}</button>
      <a :href="downloadUrl" :download="file.name">{{ __t('ui.workspace', '下载') }}</a>
      <button type="button" :disabled="opening" @click="openSystem">
        {{ __t('ui.workspace', '系统打开') }}
      </button>
    </div>
    <small v-if="actionError" class="workspace-file-preview__action-error" role="alert">
      {{ actionError }}
    </small>
    <div v-if="failure" class="file-view-state" role="alert">
      <WorkspaceFileGlyph :kind="file.kind" />
      <span>{{ failure }}</span>
      <small>{{ __t('ui.workspace', '重新载入，或用系统应用查看') }}</small>
    </div>
    <template v-else>
      <WorkspaceImageViewer
        v-if="file.kind === 'image' || (file.kind === 'svg' && svgUrl)"
        :src="file.kind === 'svg' ? svgUrl : url"
        :name="file.name"
        :state="state"
        :active="visible"
        :allow-expand="false"
        @state="emit('state', state, $event)"
        @error="failure = $event"
      />
      <div v-else-if="file.kind === 'svg'" class="file-view-state">
        {{
          svgLoading ? __t('ui.workspace', '正在读取 SVG…') : __t('ui.workspace', 'SVG 预览已暂停')
        }}
      </div>
      <template v-else-if="file.kind === 'pdf'">
        <PdfViewer
          v-if="visible"
          :src="url"
          :state="state"
          @state="emit('state', state, $event)"
          @error="failure = $event"
        />
        <div v-else class="file-view-state">{{ __t('ui.workspace', 'PDF 预览已暂停') }}</div>
      </template>
      <WorkspaceMediaViewer
        v-else-if="file.kind === 'audio' || file.kind === 'video'"
        :src="url"
        :name="file.name"
        :kind="file.kind"
        :state="state"
        :active="visible"
        @fullscreen="emit('fullscreen')"
        @state="emit('state', state, $event)"
        @error="failure = $event"
      />
      <div v-else class="file-view-state">
        <WorkspaceFileGlyph kind="file" />
        <span>{{ file.name }}</span>
        <small>{{ __t('ui.workspace', '可下载或用系统应用打开') }}</small>
      </div>
    </template>
  </div>
</template>
<style scoped>
.workspace-file-preview {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--ui-bg-surface);
}
.workspace-file-preview__meta a {
  display: inline-flex;
  min-height: 25px;
  align-items: center;
  box-sizing: border-box;
  padding: 3px 8px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface);
  box-shadow:
    inset 1px 1px color-mix(in srgb, white 11%, transparent),
    1px 1px 0 var(--ui-border-subtle);
  text-decoration: none;
}
.workspace-file-preview__meta a:hover {
  color: var(--ui-accent-sky);
  border-color: var(--ui-accent-sky);
  background: var(--ui-accent-sky-soft);
}
.workspace-file-preview__meta a:focus-visible {
  outline: 1px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.workspace-file-preview__action-error {
  padding: 6px 12px;
  color: var(--ui-danger);
  font: 10px/1.6 var(--ui-font-mono);
}
.file-view-state :deep(.workspace-file-glyph) {
  width: 32px;
  height: 32px;
}
</style>
