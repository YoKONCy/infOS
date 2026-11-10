<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { ref } from 'vue'
import type { KnowledgePartInfo, KnowledgeSearchHit } from '@infos/shared'
import { knowledgeApi } from '../../api/modules/knowledgeApi'
import { PixelIcon } from '../pixel'
import MotionCollapse from '../motion/MotionCollapse.vue'

const props = defineProps<{ part: KnowledgePartInfo; hit?: KnowledgeSearchHit }>()
const open = ref(false)
const body = ref('')
const offset = ref<number | undefined>()
const loading = ref(false)
const error = ref('')
async function expand(more = false): Promise<void> {
  if (loading.value) return
  if (open.value && !more) {
    open.value = false
    return
  }
  if (body.value && !more) {
    open.value = true
    return
  }
  loading.value = true
  error.value = ''
  try {
    const response = await knowledgeApi.search({
      partIds: [props.part.id],
      expand: true,
      offset: more ? offset.value : undefined,
    })
    const result = response.data?.items[0]
    if (!result) throw new Error('这段资料已更新或删除，请刷新列表')
    body.value = more ? body.value + (result.content ?? '') : (result.content ?? '')
    offset.value = result.nextOffset
    open.value = true
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <article class="knowledge-part">
    <header>
      <span class="part-order font-pixel">{{ String(part.ordinal + 1).padStart(2, '0') }}</span>
      <h4>{{ part.title }}</h4>
      <small>{{ part.tokenCount.toLocaleString() }} Token</small>
    </header>
    <p v-if="hit" class="part-source">{{ hit.documentTitle }} · {{ hit.source }}</p>
    <p class="part-summary">{{ part.summary }}</p>
    <div class="part-keywords">
      <span v-for="keyword in part.keywords" :key="keyword">{{ keyword }}</span>
    </div>
    <blockquote v-if="hit?.excerpt && !open">{{ hit.excerpt }}</blockquote>
    <footer>
      <small v-if="hit">
        {{
          hit.matchedBy
            .map(
              (method) =>
                ({
                  bm25: __t('ui.knowledge', '关键词'),
                  vector: __t('ui.knowledge', '语义'),
                  regex: __t('ui.knowledge', '正则'),
                  id: '指定片段',
                })[method],
            )
            .join(' · ')
        }}
      </small>
      <button :disabled="loading" @click="expand()">
        <PixelIcon
          :name="loading ? 'refresh' : 'file'"
          size="xs"
          :animation="loading ? 'spin' : undefined"
        />
        {{ open ? __t('ui.knowledge', '收起原文') : __t('ui.knowledge', '查看原文') }}
      </button>
    </footer>
    <p v-if="error" class="part-error" role="alert">{{ error }}</p>
    <MotionCollapse :open="open" lazy>
      <div class="part-original">
        <pre>{{ body }}</pre>
        <button v-if="offset !== undefined" :disabled="loading" @click="expand(true)">
          {{ loading ? __t('ui.knowledge', '读取中…') : __t('ui.knowledge', '继续展开') }}
        </button>
      </div>
    </MotionCollapse>
  </article>
</template>

<style scoped>
.knowledge-part {
  padding: 16px 18px;
  border: 1px solid var(--ui-border-subtle);
  border-left: 2px solid var(--ui-success);
  background: var(--ui-bg-elevated);
  box-shadow: 2px 2px 0 var(--ui-shadow-color, rgba(0, 0, 0, 0.08));
}
header {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
}
h4 {
  margin: 0;
  font-size: 14px;
  flex: 1;
  overflow-wrap: anywhere;
}
.part-order {
  font-size: 12px;
  color: var(--ui-success);
}
small,
.part-source {
  font-size: 11px;
  color: var(--ui-text-tertiary);
  overflow-wrap: anywhere;
}
.part-source {
  margin: 8px 0 0;
}
.part-summary {
  color: var(--ui-text-primary);
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 12px 0;
}
.part-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.part-keywords span {
  padding: 3px 6px;
  border: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-secondary);
  font-size: 11px;
  background: var(--ui-bg-hover);
}
blockquote {
  border-left: 2px solid var(--ui-border-default);
  margin: 14px 0 0;
  padding: 8px 12px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--dash-input-bg);
  max-height: 240px;
  overflow: auto;
}
footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 12px;
}
footer small {
  margin-right: auto;
}
button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-success);
  background: transparent;
  border: 0;
  font-size: 12px;
  cursor: pointer;
  padding: 4px;
}
button:disabled {
  opacity: 0.5;
  cursor: wait;
}
.part-original {
  margin-top: 12px;
  border-top: 1px solid var(--ui-border-subtle);
  padding-top: 12px;
}
pre {
  margin: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 420px;
  overflow: auto;
  color: var(--ui-text-secondary);
}
.part-error {
  color: var(--ui-danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
