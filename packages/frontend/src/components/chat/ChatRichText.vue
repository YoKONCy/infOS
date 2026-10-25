<script setup lang="ts">
import { t as __t, appLocale } from '../../i18n/index'

import { copyClientText } from '../../lib/clientPlatform'

/**
 * ChatRichText — 聊天专用安全富文本
 *
 * 统一承载 Markdown、引号、XML、LaTeX 和代码高亮，并代理代码复制操作。
 */
import { inject, onActivated, onDeactivated, onBeforeUnmount, shallowRef, ref, watch } from 'vue'
import EmbeddedWebPreview from './EmbeddedWebPreview.vue'
import StreamText from './StreamText.vue'
import { segmentChatContent } from '../../lib/embeddedWebPreview'
import { queueTextRender } from '../../compositor/renderQueue'
import {
  matchesRichTextSnapshot,
  readRichTextSnapshot,
  writeRichTextSnapshot,
  type RichTextSegment,
  type RichTextSnapshot,
} from '../../compositor/richTextSnapshot'
import { useNotificationStore } from '../../stores/useNotificationStore'
import ResourceReferenceCard from '../resources/ResourceReferenceCard.vue'
import { splitResourceCards } from '../../lib/resourceLinks'
import { openResource, openResourceLink } from '../../composables/resources/useResources'

const props = withDefaults(
  defineProps<{
    content: string
    compact?: boolean
    active?: boolean
    cache?: boolean
    stable?: boolean
    webPreview?: boolean
    agentId?: string
    threadId?: string
  }>(),
  {
    active: true,
    cache: true,
    stable: true,
    webPreview: true,
    agentId: undefined,
    threadId: undefined,
  },
)
const notify = useNotificationStore()
const mainVisible = inject('infos:main-surface-visible', shallowRef(true))
const segments = shallowRef<readonly RichTextSegment[]>([
  { type: 'rich-text', source: props.content },
])
let residentSnapshot: RichTextSnapshot | undefined
let cancelRender: (() => void) | undefined
let generation = 0
let disposed = false
const pageActive = ref(true)
// 按需加载解析器，避免首次切屏必须同步初始化公式和全部高亮语言。
let rendererPromise: Promise<typeof import('../../lib/chatRichRenderer')> | undefined
function updateSegments(): void {
  const current = ++generation
  cancelRender?.()
  if (!pageActive.value || !props.active || !mainVisible.value) return
  if (!props.stable) {
    residentSnapshot = undefined
    segments.value = [{ type: 'rich-text', source: props.content }]
    return
  }
  const input = { content: props.content, webPreview: props.webPreview, locale: appLocale.value }
  if (matchesRichTextSnapshot(residentSnapshot, input)) return
  const cached = props.cache ? readRichTextSnapshot(input) : undefined
  if (cached) {
    residentSnapshot = cached
    segments.value = cached.segments
    return
  }
  rendererPromise ??= import('../../lib/chatRichRenderer')
  void rendererPromise
    .then(({ renderChatRichText }) => {
      if (disposed || current !== generation) return
      cancelRender = queueTextRender(() => {
        if (disposed || current !== generation) return
        try {
          segments.value =
            // 流式尾部先显示源码；内容稳定后才创建 iframe，避免每个增量都取消并重启导航。
            (
              props.webPreview && props.stable
                ? segmentChatContent(props.content)
                : [{ type: 'rich-text' as const, source: props.content }]
            )
              .flatMap<{
                type: 'rich-text' | 'web-preview' | 'resource-reference'
                source: string
                label?: string
              }>((segment) =>
                segment.type === 'rich-text' ? splitResourceCards(segment.source) : [segment],
              )
              .map((segment) => ({
                ...segment,
                html:
                  segment.type === 'rich-text'
                    ? renderChatRichText(segment.source, { cache: props.cache && props.stable })
                    : '',
              }))
          residentSnapshot = { ...input, segments: segments.value }
          if (props.cache) writeRichTextSnapshot(residentSnapshot)
        } catch {
          segments.value = [{ type: 'rich-text', source: props.content }]
        }
      })
    })
    .catch(() => {
      if (!disposed && current === generation)
        segments.value = [{ type: 'rich-text', source: props.content }]
      rendererPromise = undefined
    })
}
watch(
  () => [
    props.content,
    props.stable,
    props.active,
    props.cache,
    props.webPreview,
    appLocale.value,
    mainVisible.value,
    pageActive.value,
  ],
  updateSegments,
  { immediate: true },
)
onBeforeUnmount(() => {
  disposed = true
  generation++
  cancelRender?.()
})
onDeactivated(() => {
  pageActive.value = false
  generation++
  cancelRender?.()
})
onActivated(() => {
  pageActive.value = true
})

async function handleClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-resource-source]')
  if (link) {
    event.preventDefault()
    if (!props.agentId || !props.threadId) {
      const source = (link.dataset.resourceSource || '').replace(/^resource:/i, '')
      if (/^https?:\/\//i.test(source))
        openResource({
          kind: 'web',
          name: '网页',
          mimeType: 'text/html',
          sizeBytes: 0,
          origin: { type: 'url', value: source },
        })
      else notify.toast(__t('ui.chat', '请从所属会话打开文件'), { type: 'warning' })
      return
    }
    try {
      await openResourceLink(link.dataset.resourceSource || '', {
        agentId: props.agentId,
        threadId: props.threadId,
      })
    } catch (error) {
      notify.toast(error instanceof Error ? error.message : __t('ui.chat', '无法打开资源'), {
        type: 'error',
      })
    }
    return
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]')
  if (!button) return
  try {
    const code = button.closest('.chat-code-block')?.querySelector('code')?.textContent ?? ''
    await copyClientText(code)
    notify.toast(__t('ui.chat', '代码已复制'), { type: 'success' })
  } catch {
    notify.toast(__t('ui.chat', '复制失败'), { type: 'error' })
  }
}
</script>

<template>
  <template v-for="(segment, index) in segments" :key="`${segment.type}-${index}`">
    <EmbeddedWebPreview
      v-if="segment.type === 'web-preview'"
      :source="segment.source"
      :active="active && mainVisible && pageActive"
    />
    <ResourceReferenceCard
      v-else-if="segment.type === 'resource-reference'"
      :source="segment.source"
      :label="segment.label"
      :agent-id="agentId || ''"
      :thread-id="threadId || ''"
      :active="active && mainVisible && pageActive"
    />
    <StreamText
      v-else-if="segment.html === undefined"
      :source="segment.source"
      :class="{ 'chat-rich-text--compact': compact }"
    />
    <!-- HTML已在chatRichRenderer中经过DOMPurify净化。 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div
      v-else
      :class="['chat-rich-text', { 'chat-rich-text--compact': compact }]"
      @click="handleClick"
      v-html="segment.html"
    />
  </template>
</template>

<style src="katex/dist/katex.min.css"></style>
<style src="highlight.js/styles/github-dark-dimmed.min.css"></style>
<style>
.chat-rich-text--stream {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-resource-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 1px 5px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-accent-purple) 38%, transparent);
  background: color-mix(in srgb, var(--ui-accent-purple) 8%, transparent);
  color: var(--ui-accent-purple);
  text-decoration: none;
  box-shadow: 1px 1px 0 color-mix(in srgb, var(--ui-accent-purple) 13%, transparent);
}
.chat-resource-chip span {
  font-size: 0.8em;
  opacity: 0.7;
}
.chat-resource-chip:hover {
  background: color-mix(in srgb, var(--ui-accent-purple) 14%, transparent);
}
:root,
[data-theme='light'] {
  --chat-quote-cn-double: #4f46e5;
  --chat-quote-cn-double-bg: rgba(99, 102, 241, 0.11);
  --chat-quote-en-double: #0284c7;
  --chat-quote-cn-single: #db2777;
  --chat-quote-cn-single-bg: rgba(236, 72, 153, 0.11);
  --chat-quote-en-single: #b45309;
  --chat-corner: #7c3aed;
  --chat-parenthetical: #666179;
  --chat-parenthetical-bg: rgba(112, 104, 145, 0.045);
  --chat-link: #0284c7;
  --chat-code-bg: #161b2a;
  --chat-code-head: #242b3d;
  --chat-code-border: rgba(99, 102, 241, 0.28);
  --chat-xml-tag: #db2777;
  --chat-xml-attr: #0284c7;
  --chat-xml-value: #b45309;
  --chat-math: #6d28d9;
  --chat-math-bg: rgba(224, 231, 255, 0.55);
  --chat-table-stripe: rgba(14, 165, 233, 0.045);
}

[data-theme='dark'] {
  --chat-quote-cn-double: #a5b4fc;
  --chat-quote-cn-double-bg: rgba(99, 102, 241, 0.19);
  --chat-quote-en-double: #67e8f9;
  --chat-quote-cn-single: #f9a8d4;
  --chat-quote-cn-single-bg: rgba(236, 72, 153, 0.16);
  --chat-quote-en-single: #fcd34d;
  --chat-corner: #c4b5fd;
  --chat-parenthetical: #bcb7cd;
  --chat-parenthetical-bg: rgba(176, 165, 214, 0.055);
  --chat-link: #67e8f9;
  --chat-code-bg: #0b1020;
  --chat-code-head: #161d31;
  --chat-code-border: rgba(167, 139, 250, 0.28);
  --chat-xml-tag: #f9a8d4;
  --chat-xml-attr: #67e8f9;
  --chat-xml-value: #fcd34d;
  --chat-math: #c4b5fd;
  --chat-math-bg: rgba(76, 29, 149, 0.17);
  --chat-table-stripe: rgba(56, 189, 248, 0.055);
}

.chat-rich-text {
  color: inherit;
  line-height: 1.9;
  overflow-wrap: anywhere;
}
.chat-rich-text + .chat-rich-text {
  margin-block-start: 0.85em;
}
.chat-rich-text > :first-child {
  margin-top: 0;
}
.chat-rich-text > :last-child {
  margin-bottom: 0;
}
.chat-rich-text p {
  margin: 0.85em 0;
}
/* 块内与跨渲染块使用同样的留白节奏，标题不再紧贴上一段正文。 */
.chat-rich-text
  > :is(h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table, .chat-code-block, .chat-math-block)
  + :is(p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table, .chat-code-block, .chat-math-block),
.chat-rich-text
  > p
  + :is(h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table, .chat-code-block, .chat-math-block) {
  margin-top: 1em;
}
.chat-rich-text
  > :is(p, ul, ol, blockquote, table, .chat-code-block, .chat-math-block)
  + :is(h1, h2, h3, h4, h5, h6) {
  margin-top: 1.55em;
}
.chat-rich-text h1,
.chat-rich-text h2,
.chat-rich-text h3,
.chat-rich-text h4,
.chat-rich-text h5,
.chat-rich-text h6 {
  position: relative;
  margin: 1.55em 0 0.65em;
  line-height: 1.5;
  font-weight: 750;
  text-wrap: pretty;
}
.chat-rich-text h1 {
  font-size: 1.5em;
  color: var(--ui-text-primary);
  letter-spacing: -0.015em;
}
.chat-rich-text h1::after {
  content: '';
  display: block;
  width: 64px;
  height: 2px;
  margin-top: 9px;
  background: linear-gradient(90deg, var(--ui-accent-purple), var(--ui-accent-sky), transparent);
}
.chat-rich-text h2 {
  padding-left: 12px;
  font-size: 1.25em;
  color: var(--ui-text-primary);
}
.chat-rich-text h2::before {
  content: '';
  position: absolute;
  inset: 0.23em auto 0.23em 0;
  width: 3px;
  background: linear-gradient(var(--ui-accent-purple), var(--ui-accent-sky));
}
.chat-rich-text h3 {
  color: color-mix(in srgb, var(--ui-text-primary) 76%, var(--ui-accent-purple));
  font-size: 1.12em;
}
.chat-rich-text h4 {
  color: var(--ui-accent-sky);
  font-size: 1em;
}
.chat-rich-text h5 {
  color: var(--ui-text-primary);
  font-size: 0.94em;
}
.chat-rich-text h6 {
  color: var(--ui-text-secondary);
  font-size: 0.88em;
}
.chat-rich-text strong {
  color: var(--ui-accent-primary);
  font-weight: 750;
}
.chat-rich-text em {
  color: var(--ui-accent-purple);
}
.chat-rich-text del {
  color: var(--ui-danger);
  text-decoration-color: color-mix(in srgb, var(--ui-danger) 65%, transparent);
}
.chat-rich-text a {
  color: var(--chat-link);
  font-weight: 700;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  transition:
    filter 0.15s,
    text-shadow 0.15s;
}
.chat-rich-text a:hover {
  filter: brightness(1.08);
  text-decoration-style: solid;
  text-shadow: 0 0 10px color-mix(in srgb, var(--chat-link) 32%, transparent);
}
.chat-link-mark {
  margin-left: 3px;
  font-size: 0.72em;
}
.chat-quote {
  padding: 0.04em 0.2em;
  border-radius: 3px;
  font-weight: 650;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.chat-quote-cn-double {
  color: var(--chat-quote-cn-double);
  background: var(--chat-quote-cn-double-bg);
}
.chat-quote-en-double {
  color: var(--chat-quote-en-double);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
.chat-quote-cn-single {
  color: var(--chat-quote-cn-single);
  background: var(--chat-quote-cn-single-bg);
}
.chat-quote-en-single {
  color: var(--chat-quote-en-single);
}
.chat-quote-corner,
.chat-quote-corner-double {
  color: var(--chat-corner);
  border: 1px solid color-mix(in srgb, var(--chat-corner) 35%, transparent);
  background: color-mix(in srgb, var(--chat-corner) 8%, transparent);
}
.chat-quote-corner-double {
  box-shadow:
    inset 2px 0 var(--ui-accent-primary),
    inset -2px 0 var(--ui-accent-sky);
}
.chat-rich-text .chat-parenthetical {
  color: var(--chat-parenthetical);
  background: var(--chat-parenthetical-bg);
  border-radius: 3px;
  text-decoration: none;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.chat-rich-text :not(pre) > code,
.chat-xml-inline {
  padding: 0.1em 0.38em;
  color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 22%, transparent);
  border-radius: 3px;
  font-family: var(--ui-font-mono);
  font-size: 0.9em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.chat-xml-tag {
  color: var(--chat-xml-tag);
  font-weight: 800;
}
.chat-xml-attr {
  color: var(--chat-xml-attr);
}
.chat-xml-value {
  color: var(--chat-xml-value);
}
.chat-code-block {
  margin: 1.05em 0;
  overflow: hidden;
  background: var(--chat-code-bg);
  border: 1px solid var(--chat-code-border);
  border-radius: 6px;
  box-shadow: 0 7px 20px rgba(15, 23, 42, 0.12);
}
.chat-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 31px;
  padding: 0 10px;
  color: #a5b4fc;
  background: var(--chat-code-head);
  border-bottom: 1px solid var(--chat-code-border);
  font: 700 9px var(--ui-font-pixel);
  letter-spacing: 0.1em;
}
.chat-code-head button {
  padding: 3px 7px;
  color: #67e8f9;
  background: transparent;
  border: 1px solid rgba(103, 232, 249, 0.2);
  cursor: pointer;
  font: 700 9px var(--ui-font-pixel);
}
.chat-code-head button:hover {
  background: rgba(103, 232, 249, 0.1);
}
.chat-code-block pre {
  margin: 0 !important;
  padding: 13px 15px !important;
  overflow: auto;
  background: transparent !important;
  border: 0 !important;
}
.chat-code-block code {
  padding: 0 !important;
  background: transparent !important;
  font-family: var(--ui-font-mono);
  font-size: 12px;
  line-height: 1.8;
}
.chat-math-inline {
  display: inline-flex;
  align-items: center;
  padding: 0 0.24em;
  color: var(--chat-math);
  background: var(--chat-math-bg);
  border-radius: 3px;
}
.chat-math-block {
  position: relative;
  margin: 10px 0;
  padding: 24px 14px 15px;
  overflow-x: auto;
  color: var(--chat-math);
  text-align: center;
  background-color: var(--chat-math-bg);
  background-image:
    linear-gradient(rgba(99, 102, 241, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(99, 102, 241, 0.055) 1px, transparent 1px);
  background-size: 16px 16px;
  border: 1px solid color-mix(in srgb, var(--chat-math) 24%, transparent);
  border-radius: 5px;
}
.chat-math-label {
  position: absolute;
  top: 6px;
  left: 8px;
  font: 700 8px var(--ui-font-pixel);
  letter-spacing: 0.12em;
  opacity: 0.7;
}
.chat-rich-text blockquote {
  margin: 1.05em 0;
  padding: 0.65em 1em;
  color: var(--ui-text-secondary);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-accent-purple-soft) 68%, transparent),
    transparent
  );
  border-left: 2px solid var(--ui-accent-purple);
}
.chat-rich-text blockquote > :first-child {
  margin-top: 0;
}
.chat-rich-text blockquote > :last-child {
  margin-bottom: 0;
}
.chat-rich-text ul,
.chat-rich-text ol {
  margin: 0.85em 0;
  padding-left: 1.7em;
}
.chat-rich-text li {
  margin: 0.4em 0;
  padding-left: 0.15em;
}
.chat-rich-text li > p {
  margin: 0.4em 0;
}
.chat-rich-text li > :is(ul, ol) {
  margin-block: 0.35em;
}
.chat-rich-text li::marker {
  color: var(--ui-accent-primary);
  font-weight: 800;
}
.chat-rich-text hr {
  height: 1px;
  margin: 1.6em 0;
  background: linear-gradient(
    90deg,
    transparent,
    var(--ui-accent-purple),
    var(--ui-accent-sky),
    transparent
  );
  border: 0;
}
.chat-rich-text table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin-block: 1.05em;
  font-size: 0.95em;
}
.chat-rich-text th,
.chat-rich-text td {
  padding: 9px 12px;
  border: 1px solid var(--ui-border-default);
  vertical-align: top;
}
.chat-rich-text th {
  color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
  font-weight: 700;
  line-height: 1.65;
}
.chat-rich-text tr:nth-child(even) {
  background: var(--chat-table-stripe);
}
.chat-rich-text img {
  max-width: 100%;
  border: 2px solid var(--ui-border-default);
  border-radius: 4px;
}
.chat-rich-text--compact {
  font-size: 12px;
  line-height: 1.8;
}

.msg-bubble-user .chat-rich-text {
  line-height: 1.65;
}
.msg-bubble-user .chat-rich-text p {
  margin: 0.18em 0;
}
.msg-bubble-user .chat-rich-text > :first-child {
  margin-top: 0;
}
.msg-bubble-user .chat-rich-text > :last-child {
  margin-bottom: 0;
}
.msg-bubble-user .chat-rich-text a {
  color: var(--user-bubble-link);
}
.msg-bubble-user .chat-rich-text strong {
  color: inherit;
}
.msg-bubble-user .chat-rich-text .chat-quote {
  color: inherit;
  background: var(--user-bubble-inline-bg);
  border-color: var(--user-bubble-inline-border);
}
.msg-bubble-user .chat-rich-text :not(pre) > code {
  color: var(--user-bubble-code);
  background: var(--user-bubble-inline-bg);
  border-color: var(--user-bubble-inline-border);
}

:root,
[data-theme='light'] {
  --user-bubble-link: #5f4b8b;
  --user-bubble-code: #65428a;
  --user-bubble-inline-bg: rgba(111, 82, 143, 0.08);
  --user-bubble-inline-border: rgba(111, 82, 143, 0.18);
}

[data-theme='dark'] {
  --user-bubble-link: #c8b6dc;
  --user-bubble-code: #d4bfeb;
  --user-bubble-inline-bg: rgba(190, 161, 216, 0.1);
  --user-bubble-inline-border: rgba(190, 161, 216, 0.2);
}

@media (prefers-reduced-motion: reduce) {
  .chat-rich-text *,
  .chat-code-block * {
    transition: none !important;
  }
}
</style>
