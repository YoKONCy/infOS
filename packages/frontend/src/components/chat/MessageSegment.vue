<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * MessageSegment — 消息段落渲染器
 *
 * 负责渲染 assistant 消息中解析出的各种段落类型：
 * - text: 普通 Markdown 文本
 * - thinking: 思考过程 (可折叠)
 * - monologue: 内心独白 (可折叠)
 * - tool: 工具调用块 (NIT) (可折叠)
 */
import { computed, onMounted, ref } from 'vue'
import TrajectoryIcon from '../tools/TrajectoryIcon.vue'
import { resolveTrajectoryVisual } from '../tools/toolSignatures'
import ChatRichText from './ChatRichText.vue'
import '../tools/trajectory-tactile.css'
import {
  resolveToolDisplay,
  toolDisplayLabel,
} from '../../composables/tools/useToolDisplay'
import type { AgentToolDisplay } from '../../api/modules/agentApi'

export interface Segment {
  type: 'text' | 'thinking' | 'monologue' | 'tool'
  content: string
  /** 工具调用名 */
  name?: string
  /** 工具调用 ID */
  id?: string
}

interface Props {
  segment: Segment
}

const props = defineProps<Props>()

const isCollapsed = ref(true)

/** NIT 工具段显示元数据（按工具名解析，图标/名称与对话轨迹保持一致） */
const display = ref<AgentToolDisplay | undefined>(undefined)

onMounted(async () => {
  if (props.segment.type === 'tool' && props.segment.name) {
    display.value = await resolveToolDisplay(props.segment.name)
  }
})

const toolVisual = computed(() => resolveTrajectoryVisual(props.segment.name ?? 'NIT'))
const toolLabel = computed(() => toolDisplayLabel(props.segment.name ?? 'NIT', display.value))

function toggleCollapse() {
  isCollapsed.value = !isCollapsed.value
}
</script>

<template>
  <!-- 思考过程块 -->
  <div v-if="segment.type === 'thinking'" class="segment-card segment-thinking traj-shell">
    <div class="segment-header segment-thinking-header" @click="toggleCollapse">
      <div class="segment-title">
        <TrajectoryIcon name="prism" size="sm" />
        <span>{{ __t('ui.chat', '碎碎念') }}</span>
      </div>
      <TrajectoryIcon
        name="chev-down"
        size="xs"
        :class="['segment-chevron', { 'is-open': !isCollapsed }]"
      />
    </div>
    <div v-show="!isCollapsed" class="segment-body segment-thinking-body traj-recess-pane">
      {{ segment.content }}
    </div>
  </div>

  <!-- 内心独白块 -->
  <div
    v-else-if="segment.type === 'monologue'"
    class="segment-card segment-monologue traj-shell"
  >
    <div class="segment-header segment-monologue-header" @click="toggleCollapse">
      <div class="segment-title">
        <TrajectoryIcon name="whisper" size="sm" />
        <span>{{ __t('ui.chat', '内心独白') }}</span>
      </div>
      <TrajectoryIcon
        name="chev-down"
        size="xs"
        :class="['segment-chevron', { 'is-open': !isCollapsed }]"
      />
    </div>
    <div v-show="!isCollapsed" class="segment-body segment-monologue-body traj-recess-pane">
      {{ segment.content }}
    </div>
  </div>

  <!-- 工具调用块 (NIT) -->
  <div v-else-if="segment.type === 'tool'" class="segment-card segment-tool traj-shell">
    <div class="segment-header segment-tool-header" @click="toggleCollapse">
      <div class="segment-title">
        <TrajectoryIcon :name="toolVisual.icon" size="sm" :style="{ color: toolVisual.color }" />
        <span>{{ toolLabel }}</span>
      </div>
      <div class="segment-title">
        <span v-if="segment.id" class="segment-id">{{ segment.id }}</span>
        <TrajectoryIcon
          name="chev-down"
          size="xs"
          :class="['segment-chevron', { 'is-open': !isCollapsed }]"
        />
      </div>
    </div>
    <div v-show="!isCollapsed" class="segment-body segment-tool-body traj-recess-pane">
      {{ segment.content }}
    </div>
  </div>

  <!-- 普通文本 (Markdown) -->
  <div v-else class="segment-text">
    <ChatRichText :content="segment.content" />
  </div>
</template>

<style scoped>
.segment-card {
  margin: 6px 0;
  overflow: hidden;
  border-radius: 7px;
}

.segment-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7.5px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  font-weight: 600;
  transition: background 0.16s ease;
}

.segment-title {
  display: flex;
  align-items: center;
  gap: 7px;
}

.segment-thinking-header {
  color: var(--ui-accent-purple);
}

.segment-thinking-header:hover {
  background: var(--traj-face-hover, var(--ui-bg-hover));
}

.segment-monologue-header {
  color: var(--ui-accent-primary);
}

.segment-monologue-header:hover {
  background: var(--traj-face-hover, var(--ui-bg-hover));
}

.segment-tool-header {
  color: var(--ui-text-primary);
}

.segment-tool-header:hover {
  background: var(--traj-face-hover, var(--ui-bg-hover));
}

.segment-chevron {
  color: var(--ui-text-tertiary);
  transition: transform 0.16s ease;
}

.segment-chevron.is-open {
  transform: rotate(180deg);
}

.segment-body {
  margin: 0 6px 6px;
  padding: 9px 11px;
  white-space: pre-wrap;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--ui-text-secondary);
}

.segment-thinking-body,
.segment-tool-body {
  font-family: var(--ui-font-mono);
}

.segment-tool-body {
  overflow-x: auto;
  white-space: pre;
}

.segment-id {
  font-family: var(--ui-font-mono);
  font-size: 10px;
  opacity: 0.72;
}

.segment-text {
  min-height: 1.5em;
  color: var(--ui-text-primary);
}
</style>
