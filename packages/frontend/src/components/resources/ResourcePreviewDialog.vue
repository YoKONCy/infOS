<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import '@infos/shared/i18n/catalogs/resourcePreview'
import { t } from '../../i18n'
import { PButton, PDialog } from '../pixel'
import ResourceAudioPlayer from './ResourceAudioPlayer.vue'
import ResourceVideoPlayer from './ResourceVideoPlayer.vue'
import ResourceGlyph from './ResourceGlyph.vue'
import WorkspaceImageViewer from '../workspace/WorkspaceImageViewer.vue'
import { createPreviewState } from '../workspace/workspacePreview'
import '../workspace/workspace-file-preview.css'
import { resourcePreviewKind } from '../../lib/resourceLinks'
import {
  openResource,
  resourcePreview,
  resourceTextPreview,
  resourceDocumentPreview,
  resourceHtmlPreview,
  resourceUrl,
  resourceSize,
} from '../../composables/resources/useResources'
const tr = (source: string) => t('ui.resource-preview', source)
const PdfViewer = defineAsyncComponent(() => import('../workspace/WorkspacePdfViewer.vue'))
const url = computed(() => (resourcePreview.value ? resourceUrl(resourcePreview.value) : ''))
const kind = computed(() =>
  resourcePreview.value ? resourcePreviewKind(resourcePreview.value) : '',
)
const text = ref(''),
  html = ref(''),
  frameUrl = ref(''),
  error = ref('')
const truncated = ref(false),
  loading = ref(false)
const camera = ref(createPreviewState())
let revision = 0
let stopMathReady: (() => void) | undefined
let controller: AbortController | undefined
function openSource() {
  const item = resourcePreview.value
  resourcePreview.value = null
  if (item) openResource(item, true)
}
watch(
  resourcePreview,
  async (item) => {
    const version = ++revision
    stopMathReady?.()
    stopMathReady = undefined
    controller?.abort()
    text.value = ''
    html.value = ''
    frameUrl.value = ''
    error.value = ''
    truncated.value = false
    loading.value = false
    camera.value = createPreviewState()
    if (!item || !['text', 'markdown', 'office', 'web'].includes(kind.value)) return
    if (item.origin?.type === 'url' && !item.id && kind.value !== 'web') return
    const request = new AbortController()
    controller = request
    loading.value = true
    try {
      if (kind.value === 'web') {
        const url = await resourceHtmlPreview(item, request.signal)
        if (version === revision) frameUrl.value = url
      } else {
        const result = await (
          kind.value === 'office' ? resourceDocumentPreview : resourceTextPreview
        )(item, request.signal)
        if (version !== revision) return
        text.value = result.text
        truncated.value = result.truncated
        if (kind.value === 'office' || kind.value === 'markdown') {
          const { prepareChatRichText, renderChatRichTextResult, onChatMathReady } =
            await import('../../lib/chatRichRenderer')
          await prepareChatRichText(text.value)
          if (version !== revision) return
          const rendered = renderChatRichTextResult(text.value, { cache: false })
          html.value = rendered.html
          if (!rendered.mathReady)
            stopMathReady = onChatMathReady(() => {
              if (version !== revision) return
              html.value = renderChatRichTextResult(text.value, { cache: false }).html
              stopMathReady?.()
              stopMathReady = undefined
            })
        }
      }
    } catch {
      if (version === revision && !request.signal.aborted)
        error.value = tr('无法预览，可打开源文件')
    } finally {
      if (version === revision) loading.value = false
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  ++revision
  stopMathReady?.()
  controller?.abort()
})
</script>
<template>
  <PDialog
    :model-value="Boolean(resourcePreview)"
    :title="resourcePreview?.name"
    :width="
      kind === 'audio' || kind === 'file'
        ? 'min(480px, calc(100vw - 24px))'
        : 'min(960px, calc(100vw - 24px))'
    "
    @update:model-value="
      (visible) => {
        if (!visible) resourcePreview = null
      }
    "
  >
    <div v-if="resourcePreview" class="resource-preview" :class="`resource-preview--${kind}`">
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="loading">{{ tr('读取中…') }}</p>
      <WorkspaceImageViewer
        v-else-if="kind === 'image'"
        :key="url"
        :src="url"
        :name="resourcePreview.name"
        :state="camera"
        :active="true"
        @state="Object.assign(camera, $event)"
        @error="error = $event"
      />
      <ResourceVideoPlayer
        v-else-if="kind === 'video'"
        :key="url"
        :src="url"
        :name="resourcePreview.name"
        expanded
      />
      <ResourceAudioPlayer
        v-else-if="kind === 'audio'"
        :key="url"
        :src="url"
        :name="resourcePreview.name"
      />
      <PdfViewer
        v-else-if="kind === 'pdf'"
        :key="url"
        :src="url"
        :state="camera"
        @state="Object.assign(camera, $event)"
        @error="error = $event"
      />
      <iframe
        v-else-if="kind === 'web' && frameUrl"
        :src="frameUrl"
        :title="resourcePreview.name"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        @error="error = tr('无法预览，可打开源文件')"
      />
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else-if="html" class="resource-preview__document chat-rich-text" v-html="html" />
      <pre v-else-if="text">{{ text }}</pre>
      <div v-else class="resource-preview__file">
        <ResourceGlyph :kind="kind" />
        <strong>{{ resourcePreview.name }}</strong>
        <small>{{ resourceSize(resourcePreview.sizeBytes) }}</small>
        <small>{{ tr('可打开源文件或下载') }}</small>
      </div>
      <small v-if="truncated">{{ tr('内容节选') }}</small>
    </div>
    <template #footer>
      <PButton
        v-if="
          resourcePreview?.origin &&
          resourcePreview.origin.type !== 'application' &&
          !(resourcePreview.origin.type === 'workspace' && resourcePreview.origin.taskId)
        "
        variant="secondary"
        size="sm"
        @click="openSource"
      >
        {{ tr('打开源文件') }}
      </PButton>
      <PButton
        v-if="resourcePreview && resourceUrl(resourcePreview, true)"
        variant="secondary"
        size="sm"
        :href="resourceUrl(resourcePreview, true)"
        :download="resourcePreview.name"
        :target="
          !resourcePreview.id && resourcePreview.origin?.type === 'url' ? '_blank' : undefined
        "
        rel="noopener noreferrer"
      >
        {{ tr('下载') }}
      </PButton>
      <PButton variant="secondary" size="sm" @click="resourcePreview = null">
        {{ tr('关闭') }}
      </PButton>
    </template>
  </PDialog>
</template>
<style scoped>
.resource-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100px;
  max-height: 70vh;
  overflow: auto;
}
.resource-preview--image,
.resource-preview--pdf {
  height: 65vh;
  min-height: 260px;
}
.resource-preview--image > :deep(.workspace-image),
.resource-preview--pdf > :deep(.workspace-pdf) {
  flex: 1;
  min-height: 0;
}
.resource-preview :deep(.resource-audio) {
  margin: 0 auto;
  width: min(100%, 440px);
  border: 1px solid var(--ui-border-subtle);
  border-radius: 10px;
}
.resource-preview :deep(.resource-video) {
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 8px;
}
.resource-preview__file {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 20px;
  overflow-wrap: anywhere;
}
.resource-preview iframe {
  width: 100%;
  height: 65vh;
  flex-shrink: 0;
  border: 1px solid var(--ui-border-default);
  background: white;
}
.resource-preview pre {
  width: 100%;
  margin: 0;
  padding: 16px;
  font: 12px/1.7 var(--ui-font-mono);
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 4;
}
.resource-preview__document {
  padding: 20px;
  background: var(--ui-bg-surface);
  user-select: text;
}
.resource-preview small,
.resource-preview p {
  color: var(--ui-text-secondary);
  font-size: 12px;
}
</style>
