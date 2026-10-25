<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MessageResource } from '@infos/shared'
import '@infos/shared/i18n/catalogs/resourcePreview'
import { t } from '../../i18n'
import { PixelIcon } from '../pixel'
import ResourceGlyph from './ResourceGlyph.vue'
import ResourceAudioPlayer from './ResourceAudioPlayer.vue'
import ResourceVideoPlayer from './ResourceVideoPlayer.vue'
import { resourcePreviewKind } from '../../lib/resourceLinks'
import {
  resourceUrl,
  resourceTextPreview,
  resourceDocumentPreview,
  resourceHtmlPreview,
  resourcePreview,
} from '../../composables/resources/useResources'
import { useResourceVisibility } from '../../composables/resources/useResourceVisibility'

const props = withDefaults(defineProps<{ resource: MessageResource; active?: boolean }>(), {
  active: true,
})
const emit = defineEmits<{ open: [] }>()
const tr = (source: string) => t('ui.resource-preview', source)
const PdfThumbnail = defineAsyncComponent(() => import('./ResourcePdfThumbnail.vue'))
const root = ref<HTMLElement | null>(null)
const visible = useResourceVisibility(root)
const enabled = computed(() => visible.value && props.active)
const kind = computed(() => resourcePreviewKind(props.resource))
const url = computed(() => resourceUrl(props.resource))
const playable = computed(() => enabled.value && !resourcePreview.value)
const audioLoaded = ref(false)
watch(
  [enabled, url, kind],
  ([ready, source, type], previous) => {
    if (source !== previous?.[1]) audioLoaded.value = false
    // 首次进入视口才准备音频；之后离屏保留播放器，关闭卡片时再清理。
    if (ready && type === 'audio') audioLoaded.value = true
  },
  { immediate: true },
)
const mediaHeight = ref(0)
let sizeObserver: ResizeObserver | undefined
onMounted(() => {
  if (!root.value || typeof ResizeObserver === 'undefined') return
  // 离屏回收播放器时保留占位高度，避免聊天滚动位置随控件消失而跳动。
  sizeObserver = new ResizeObserver(() => {
    if (enabled.value && (kind.value === 'audio' || kind.value === 'video') && root.value)
      mediaHeight.value = root.value.getBoundingClientRect().height
  })
  sizeObserver.observe(root.value)
})
const loading = ref(false),
  failed = ref(false),
  text = ref(''),
  html = ref(''),
  frameUrl = ref('')
let request: AbortController | undefined
let revision = 0
watch(
  [enabled, () => props.resource],
  async ([ready]) => {
    const version = ++revision
    request?.abort()
    loading.value = false
    if (!ready) {
      frameUrl.value = ''
      return
    }
    failed.value = false
    text.value = ''
    html.value = ''
    frameUrl.value = ''
    if (!['text', 'markdown', 'office', 'web'].includes(kind.value)) return
    // 在线文档不代理下载；保留浏览器打开入口。HTML 可以直接沙箱预览。
    if (props.resource.origin?.type === 'url' && !props.resource.id && kind.value !== 'web') return
    const controller = new AbortController()
    request = controller
    loading.value = true
    try {
      if (kind.value === 'web') {
        const url = await resourceHtmlPreview(props.resource, controller.signal)
        if (version === revision) frameUrl.value = url
      } else {
        const result = await (
          kind.value === 'office' ? resourceDocumentPreview : resourceTextPreview
        )(props.resource, controller.signal)
        if (version !== revision) return
        text.value = result.text.slice(0, 4000)
        if (kind.value === 'office' || kind.value === 'markdown') {
          const { renderChatRichText } = await import('../../lib/chatRichRenderer')
          if (version === revision) html.value = renderChatRichText(text.value, { cache: false })
        }
      }
    } catch {
      if (!controller.signal.aborted && version === revision) failed.value = true
    } finally {
      if (version === revision) loading.value = false
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  ++revision
  request?.abort()
  sizeObserver?.disconnect()
})
</script>
<template>
  <div
    ref="root"
    class="resource-inline"
    :class="[`resource-inline--${kind}`, { 'resource-inline--audio': kind === 'audio' }]"
    :style="
      !enabled && mediaHeight && (kind === 'audio' || kind === 'video')
        ? { minHeight: `${mediaHeight}px` }
        : undefined
    "
  >
    <template v-if="kind === 'audio'">
      <ResourceAudioPlayer
        v-if="audioLoaded"
        :key="url"
        :src="url"
        :name="resource.name"
        :active="playable"
      />
      <span v-else class="resource-inline__hint">
        <ResourceGlyph kind="audio" />
        {{ tr('音频') }}
      </span>
    </template>
    <ResourceVideoPlayer
      v-else-if="kind === 'video' && enabled"
      :key="url"
      :src="url"
      :name="resource.name"
      :active="playable"
    />
    <template v-else>
      <img
        v-if="kind === 'image' && enabled && !failed"
        :src="url"
        :alt="resource.name"
        loading="lazy"
        @error="failed = true"
      />
      <PdfThumbnail
        v-else-if="kind === 'pdf' && enabled && !failed"
        :src="url"
        class="resource-inline__pdf"
        @error="failed = true"
      />
      <iframe
        v-else-if="kind === 'web' && frameUrl && enabled && !failed"
        :src="frameUrl"
        :title="resource.name"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        tabindex="-1"
        loading="lazy"
        @error="failed = true"
      />
      <!-- 摘要经过与正文相同的净化流程；小窗只读，链接由打开按钮统一接管。 -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div
        v-else-if="html && !failed"
        class="resource-inline__paper chat-rich-text"
        v-html="html"
      />
      <pre v-else-if="text && !failed" class="resource-inline__paper">{{ text }}</pre>
      <div v-else class="resource-inline__placeholder">
        <ResourceGlyph :kind="kind" />
        <span>
          {{
            loading
              ? tr('读取中…')
              : failed
                ? tr('点击打开文件')
                : resource.name.split('.').pop()?.toUpperCase() || tr('文件')
          }}
        </span>
      </div>
      <button
        type="button"
        class="resource-inline__open"
        :aria-label="tr('打开预览')"
        @click="emit('open')"
      >
        <span>
          <PixelIcon :name="kind === 'image' ? 'maximize' : 'external-link'" size="sm" />
          {{ kind === 'image' ? tr('放大') : tr('打开') }}
        </span>
      </button>
    </template>
  </div>
</template>
<style scoped>
.resource-inline {
  position: relative;
  height: 198px;
  overflow: hidden;
  background: color-mix(in srgb, var(--resource-accent) 5%, var(--ui-bg-surface-soft));
  border-bottom: 1px solid var(--ui-border-subtle);
}
.resource-inline > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.resource-inline > iframe {
  width: 200%;
  height: 396px;
  transform: scale(0.5);
  transform-origin: top left;
  border: 0;
  pointer-events: none;
  background: white;
}
.resource-inline__paper {
  margin: 12px 16px;
  padding: 14px;
  min-height: 240px;
  background: var(--ui-bg-surface);
  box-shadow: var(--ui-shadow-sm);
  font: 11px/1.6 var(--ui-font-mono);
  color: var(--ui-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  pointer-events: none;
  user-select: none;
}
.resource-inline__paper :deep(*) {
  max-width: 100%;
  font-size: 11px;
}
.resource-inline__paper :deep(img),
.resource-inline__paper :deep(button) {
  display: none;
}
.resource-inline__paper :deep(h1),
.resource-inline__paper :deep(h2) {
  font-size: 15px;
  margin: 0 0 8px;
}
.resource-inline__paper :deep(table) {
  width: 100%;
  border-collapse: collapse;
}
.resource-inline__paper :deep(td),
.resource-inline__paper :deep(th) {
  border: 1px solid var(--ui-border-default);
  padding: 3px;
}
.resource-inline__pdf {
  width: calc(100% - 32px);
  margin: 12px 16px;
  box-shadow: var(--ui-shadow-sm);
}
.resource-inline__placeholder {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 14px;
  height: 100%;
  color: var(--ui-text-tertiary);
  font: 11px var(--ui-font-mono);
}
.resource-inline__open {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.resource-inline__open > span {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border: 1px solid var(--ui-border-default);
  border-radius: 4px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-primary);
  font-size: 11px;
  opacity: 0;
  transition: opacity 140ms ease;
}
.resource-inline:hover .resource-inline__open > span,
.resource-inline__open:focus-visible > span {
  opacity: 1;
}
.resource-inline__open:focus-visible {
  outline: 2px solid var(--resource-accent);
  outline-offset: -3px;
}
.resource-inline--image {
  height: auto;
  min-height: 140px;
  max-height: 280px;
}
.resource-inline--image > img {
  max-height: 280px;
  min-height: 140px;
}
.resource-inline--audio,
.resource-inline--video {
  height: auto;
  min-height: 54px;
}
.resource-inline__hint {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  padding: 13px;
}
.resource-inline__hint :deep(.resource-glyph) {
  width: 22px;
  height: 24px;
}
.resource-inline__fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface);
  cursor: pointer;
}
@media (hover: none) {
  .resource-inline__open > span {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .resource-inline__open > span {
    transition: none;
  }
}
</style>
