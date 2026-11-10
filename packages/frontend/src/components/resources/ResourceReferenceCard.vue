<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { MessageResource } from '@infos/shared'
import '@infos/shared/i18n/catalogs/resourcePreview'
import { t } from '../../i18n'
import ResourceGlyph from './ResourceGlyph.vue'
import ResourceCard from './ResourceCard.vue'
import { PixelIcon } from '../pixel'
import { resolveResourceLink, openResourceLink } from '../../composables/resources/useResources'
import { useResourceVisibility } from '../../composables/resources/useResourceVisibility'
import { resourceLinkKind } from '../../lib/resourceLinks'
import { useNotificationStore } from '../../stores'
import { isMissingReference } from '../../lib/missingResourceReference'
const props = withDefaults(
  defineProps<{
    source: string
    label?: string
    agentId: string
    threadId: string
    active?: boolean
  }>(),
  { active: true, label: undefined },
)
const root = ref<HTMLElement | null>(null)
const visible = useResourceVisibility(root)
const enabled = computed(() => visible.value && props.active)
const item = shallowRef<MessageResource | null>(null)
const pending = ref(false)
const opening = ref(false)
/** 后端确认找不到文件时的说明；有值时卡片显示为失效，不再提供打开入口。 */
const missing = ref('')
const notification = useNotificationStore()
const name = computed(
  () => props.label || props.source.split(/[\\/]/).pop() || t('ui.resource-preview', '文件'),
)
let controller: AbortController | undefined
let revision = 0
let lastKey = ''
watch(
  [() => props.source, () => props.agentId, () => props.threadId, enabled],
  async ([source, agentId, threadId, ready]) => {
    const version = ++revision
    controller?.abort()
    pending.value = false
    const key = JSON.stringify([source, agentId, threadId])
    if (lastKey !== key) {
      item.value = null
      missing.value = ''
      lastKey = key
    }
    if (!ready || item.value || missing.value) return
    controller = new AbortController()
    pending.value = true
    try {
      const resource = await resolveResourceLink(source, { agentId, threadId }, controller.signal)
      if (version === revision) item.value = resource
    } catch (error) {
      // 确认找不到文件时显示为失效；其他失败仍保留引用卡片，用户可以点击重新打开。
      if (version === revision && isMissingReference(error))
        missing.value = (error as Error).message
    } finally {
      if (version === revision) pending.value = false
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  ++revision
  controller?.abort()
})
async function open() {
  if (opening.value) return
  opening.value = true
  try {
    await openResourceLink(props.source, props)
  } catch (error) {
    if (isMissingReference(error)) missing.value = (error as Error).message
    notification.toast(
      (!props.agentId || !props.threadId) && !/^(?:resource:)?https?:\/\//i.test(props.source)
        ? t('ui.resource-preview', '请从所属会话打开文件')
        : error instanceof Error
          ? error.message
          : t('ui.resource-preview', '无法打开文件'),
      { type: 'error' },
    )
  } finally {
    opening.value = false
  }
}
</script>
<template>
  <div ref="root" class="resource-reference">
    <ResourceCard v-if="item" :resource="item" :label="label" :active="enabled" />
    <div v-else-if="missing" class="resource-reference__missing" role="note" :title="missing">
      <span class="resource-reference__body">
        <ResourceGlyph :kind="resourceLinkKind(source)" />
        <strong>{{ name }}</strong>
      </span>
      <small>{{ missing }}</small>
    </div>
    <button
      v-else
      type="button"
      class="resource-reference__fallback"
      :disabled="opening"
      :title="source"
      @click="open"
    >
      <span class="resource-reference__window">
        <ResourceGlyph :kind="resourceLinkKind(source)" />
        <span>
          {{
            pending ? t('ui.resource-preview', '读取中…') : t('ui.resource-preview', '点击打开文件')
          }}
        </span>
      </span>
      <span class="resource-reference__body">
        <ResourceGlyph :kind="resourceLinkKind(source)" />
        <strong>{{ name }}</strong>
        <PixelIcon
          :name="opening ? 'refresh' : 'external-link'"
          size="sm"
          :animation="opening ? 'spin' : undefined"
        />
      </span>
    </button>
  </div>
</template>
<style scoped>
.resource-reference {
  width: min(100%, 380px);
  margin: 10px 0 12px;
}
.resource-reference :deep(.resource-card) {
  width: 100%;
  margin: 0;
}
.resource-reference__fallback {
  --resource-accent: var(--ui-accent-purple);
  display: grid;
  width: 100%;
  padding: 0;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  text-align: left;
  cursor: pointer;
  font: inherit;
  box-shadow: 2px 3px 0 var(--ui-border-subtle);
}
.resource-reference__window {
  display: grid;
  height: 160px;
  align-content: center;
  justify-items: center;
  gap: 12px;
  color: var(--ui-text-tertiary);
  background: var(--ui-bg-surface-soft);
  border-bottom: 1px solid var(--ui-border-subtle);
  font-size: 11px;
}
.resource-reference__body {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px;
}
.resource-reference__body > strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.resource-reference__body > .resource-glyph {
  width: 24px;
  height: 27px;
}
.resource-reference__missing {
  display: grid;
  border: 1px dashed var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-tertiary);
}
.resource-reference__missing > small {
  padding: 0 12px 12px;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.resource-reference__fallback:focus-visible {
  outline: 2px solid var(--ui-accent-purple);
  outline-offset: 2px;
}
</style>
