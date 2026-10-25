<script setup lang="ts">
import { getDisplayLocale } from '../../i18n/index'

import { t as __t } from '../../i18n/index'

import { copyClientText } from '../../lib/clientPlatform'

/**
 * MessageBubble — 单条消息气泡
 *
 * 根据消息角色 (user/assistant) 渲染不同样式的气泡。
 * F3: 支持 v-html Markdown 渲染 + 工具调用展示 + 流式光标。
 */
import { ref, computed } from 'vue'
import type { AttachmentSurfaceProps } from '@infos/shared'
import PixelIcon from '../pixel/PixelIcon.vue'
import ThinkingIndicator from './ThinkingIndicator.vue'
import RunPulse from './RunPulse.vue'
import ChatRichText from './ChatRichText.vue'
import ConversationSurface from '../compositor/ConversationSurface.vue'
import { attachmentsApi } from '../../api/modules/attachmentsApi'
import type { CompositorSurface } from '../../stores'
import AgentStateHover from '../agent/AgentStateHover.vue'
import UserAvatar from '../user/UserAvatar.vue'
import ReplySelection from './ReplySelection.vue'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  spokenReply?: string
  /** 从原始转写中提取的 Thinking 内容。 */
  thinkingContent?: string
  timestamp?: number
  /** Assistant 可见输出的总 Token。 */
  outputTokens?: number
  senderId?: string
  /** 本轮 Embedding / RAG 降级轨迹。 */
  ragFailureTrace?: { kind: 'embedding' | 'rag'; message: string }
  /** 消息的唯一系统 Surface。 */
  surface?: CompositorSurface
  /** 图片理解文字档案。 */
  imageTranscription?: boolean
}

interface Props {
  /** 由会话入口确认身份，不能将社交联系人的 user 消息套用本地用户头像。 */
  isOwnerMessage?: boolean
  message: ChatMessage
  agentId?: string
  agentName?: string
  /** Agent 头像 URL。 */
  agentAvatarUrl?: string
  /** 是否显示编辑/删除等仅 desktop 支持的持久化操作。 */
  allowMutations?: boolean
  /** 允许显示的持久化操作按钮（配合 allowMutations）。据点多角色场景通常只需删除。 */
  mutationActions?: Array<'edit' | 'delete'>
  /** 删除按钮的悬浮提示（据点群聊为“删除消息”，桌面为“删除对话对”）。 */
  deleteActionLabel?: string
  /** 系统消息视觉变体；旁白不复用普通系统提示样式。 */
  systemVariant?: 'default' | 'narration'
  isStreaming?: boolean
  /** 模型调用前自动 RAG 的实时阶段文案。 */
  progressLabel?: string
  /** 本轮永久展示的 Embedding / RAG 降级轨迹。 */
  ragFailure?: { kind: 'embedding' | 'rag'; message: string } | null
  /** 当前正在播放 TTS 的消息 ID */
  playingMsgId?: string | null
  /** TTS 音频加载中 */
  isLoadingAudio?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isOwnerMessage: false,
  agentName: '助手',
  agentId: '',
  agentAvatarUrl: '',
  allowMutations: true,
  mutationActions: () => ['edit' as const, 'delete' as const],
  deleteActionLabel: '删除对话对',
  systemVariant: 'default',
  isStreaming: false,
  progressLabel: '',
  ragFailure: null,
  playingMsgId: null,
  isLoadingAudio: false,
})

const emit = defineEmits<{
  edit: [msg: ChatMessage]
  deletePair: [id: string]
  copy: [content: string]
  /** TTS 播放/停止切换 */
  ttsPlay: [msg: ChatMessage]
}>()

const isThinkingExpanded = ref(false)
const generationStats = computed(() => props.message.surface?.generationStats)
const generationRate = computed(() => {
  const stats = generationStats.value
  return stats && stats.modelDurationMs > 0
    ? ((stats.outputTokens * 1000) / stats.modelDurationMs).toFixed(1)
    : null
})
const generationHint = computed(() => {
  const stats = generationStats.value
  if (!stats) return ''
  return (
    __t('ui.chat', '{0} 次模型调用；速率按模型耗时计算。', [stats.modelCalls]) +
    (stats.estimated ? __t('ui.chat', '含估算用量。') : '')
  )
})
const previewImageUrl = ref<string | null>(null)
const userImages = computed(
  () =>
    props.message.surface?.nodes
      .filter((node) => node.kind === 'attachment')
      .map((node) => node.props as AttachmentSurfaceProps)
      .filter((attachment) => attachment.kind === 'image') ?? [],
)
const userHasBubbleContent = computed(
  () =>
    props.message.surface?.nodes.some(
      (node) => node.kind !== 'attachment' || (node.props as { kind?: string }).kind !== 'image',
    ) ?? Boolean(props.message.content.trim()),
)
const thinkingSections = computed(() =>
  (props.message.thinkingContent ?? '')
    .split(/\n\s*\n+/)
    .map((section) => section.trim())
    .filter(Boolean),
)

async function copyThinking() {
  if (!props.message.thinkingContent) return
  await copyClientText(props.message.thinkingContent)
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}
</script>

<template>
  <!-- 据点管家旁白：独立于Agent和系统提示的叙事卡片。 -->
  <div
    v-if="message.role === 'system' && systemVariant === 'narration'"
    class="msg-row msg-row-narration"
    :data-message-id="message.id"
    :data-surface-id="message.surface?.surfaceId"
  >
    <article class="msg-narration-card">
      <span class="msg-narration-glow" aria-hidden="true" />
      <header class="msg-narration-header">
        <span class="msg-narration-ornament" aria-hidden="true">◇</span>
        <span>{{ agentName }}</span>
        <time v-if="message.timestamp">{{ formatTime(message.timestamp) }}</time>
      </header>
      <div class="msg-narration-content">
        <ConversationSurface v-if="message.surface" :surface="message.surface" />
        <span v-else>{{ __t('ui.chat', '消息 Surface 不可用') }}</span>
      </div>
      <div class="msg-narration-actions">
        <button
          class="msg-action-btn"
          :title="__t('ui.chat', '复制')"
          @click="emit('copy', message.content)"
        >
          <PixelIcon name="copy" size="xs" />
        </button>
        <button
          v-if="allowMutations && mutationActions.includes('delete')"
          class="msg-action-btn msg-action-btn-danger"
          :title="deleteActionLabel"
          @click="emit('deletePair', message.id)"
        >
          <PixelIcon name="trash" size="xs" />
        </button>
      </div>
    </article>
  </div>

  <!-- 普通系统消息：中性提示形态。 -->
  <div
    v-else-if="message.role === 'system'"
    class="msg-row msg-row-system"
    :data-message-id="message.id"
    :data-surface-id="message.surface?.surfaceId"
  >
    <div :class="['msg-system-pill', { 'msg-image-transcription': message.imageTranscription }]">
      <PixelIcon :name="message.imageTranscription ? 'image' : 'bot'" size="xs" />
      <strong>{{ message.imageTranscription ? __t('ui.chat', '图片理解记录') : agentName }}</strong>
      <ConversationSurface v-if="message.surface" :surface="message.surface" />
      <span v-else>{{ __t('ui.chat', '消息 Surface 不可用') }}</span>
    </div>
  </div>

  <!-- 用户消息 -->
  <div
    v-else-if="message.role === 'user'"
    class="msg-row msg-row-user"
    :class="{ 'msg-row-user--owner': isOwnerMessage }"
    :data-message-id="message.id"
    :data-surface-id="message.surface?.surfaceId"
  >
    <div class="msg-bubble-container msg-user-container">
      <!-- 图片附件挂在气泡下方，正文气泡只承载文字与普通文件。 -->
      <div v-if="userHasBubbleContent" class="msg-bubble msg-bubble-user">
        <ConversationSurface
          v-if="message.surface"
          :surface="message.surface"
          display-mode="content"
        />
        <span v-else>{{ __t('ui.chat', '消息 Surface 不可用') }}</span>
        <span v-if="message.timestamp" class="msg-user-time">
          {{ formatTime(message.timestamp) }}
        </span>
      </div>
      <div
        v-if="userImages.length"
        class="msg-user-images"
        :aria-label="__t('ui.chat', '图片附件')"
      >
        <button
          v-for="(image, index) in userImages"
          :key="image.id"
          type="button"
          class="msg-user-image-note"
          :class="`msg-user-image-note--${index % 4}`"
          :aria-label="__t('ui.chat', '查看原图')"
          @click="previewImageUrl = attachmentsApi.contentUrl(image.id)"
        >
          <img :src="attachmentsApi.contentUrl(image.id)" :alt="__t('ui.chat', '用户发送的图片')" />
        </button>
      </div>
      <span v-if="message.timestamp && !userHasBubbleContent" class="msg-user-image-time">
        {{ formatTime(message.timestamp) }}
      </span>
      <Teleport to="body">
        <div
          v-if="previewImageUrl"
          class="msg-image-preview"
          role="dialog"
          aria-modal="true"
          :aria-label="__t('ui.chat', '图片预览')"
          @click.self="previewImageUrl = null"
        >
          <button
            type="button"
            :aria-label="__t('ui.chat', '关闭图片预览')"
            @click="previewImageUrl = null"
          >
            <PixelIcon name="close" size="sm" />
          </button>
          <img :src="previewImageUrl" :alt="__t('ui.chat', '用户发送的图片原图')" />
        </div>
      </Teleport>

      <!-- 悬浮操作：hover 时浮在气泡右下，不占布局高度 -->
      <div class="msg-actions msg-user-actions">
        <button
          class="msg-action-btn"
          :title="__t('ui.chat', '复制')"
          @click="emit('copy', message.content)"
        >
          <PixelIcon name="copy" size="xs" />
        </button>
        <button
          v-if="allowMutations && mutationActions.includes('edit')"
          class="msg-action-btn"
          @click="emit('edit', message)"
        >
          <PixelIcon name="edit" size="xs" />
        </button>
        <button
          v-if="allowMutations && mutationActions.includes('delete')"
          class="msg-action-btn msg-action-btn-danger"
          :title="deleteActionLabel"
          @click="emit('deletePair', message.id)"
        >
          <PixelIcon name="trash" size="xs" />
        </button>
      </div>
    </div>
    <UserAvatar v-if="isOwnerMessage" :size="36" />
  </div>

  <!-- 助手消息 -->
  <div
    v-else
    class="msg-row msg-row-assistant"
    :class="{ 'msg-row-streaming': isStreaming }"
    :data-message-id="message.id"
    :data-surface-id="message.surface?.surfaceId"
  >
    <!-- 头像 -->
    <AgentStateHover
      class="msg-avatar agent-portrait"
      :agent-id="agentId || message.senderId || message.surface?.principalId"
      :agent-name="agentName"
    >
      <img v-if="agentAvatarUrl" :src="agentAvatarUrl" :alt="agentName" class="msg-avatar-image" />
      <span v-else class="msg-avatar-text">{{ agentName?.[0]?.toUpperCase() ?? 'P' }}</span>
      <div class="msg-avatar-status" />
    </AgentStateHover>

    <div class="msg-bubble-container msg-assistant-container">
      <!-- 名称与时间 -->
      <div class="msg-assistant-header">
        <span class="msg-assistant-name">{{ agentName }}</span>
        <span class="msg-time">{{ formatTime(message.timestamp) }}</span>
        <div class="msg-actions">
          <!-- TTS 播放按钮（ playMessage） -->
          <button
            v-if="message.role === 'assistant' && message.spokenReply && !isStreaming"
            class="msg-action-btn"
            :class="{ 'msg-action-btn-active': props.playingMsgId === message.id }"
            :title="
              props.playingMsgId === message.id
                ? __t('ui.chat', '停止播放')
                : __t('ui.chat', '播放口语答复')
            "
            @click="emit('ttsPlay', message)"
          >
            <PixelIcon
              :name="
                props.playingMsgId === message.id
                  ? 'square'
                  : props.isLoadingAudio && props.playingMsgId === message.id
                    ? 'loader'
                    : 'volume-2'
              "
              size="xs"
              :animation="
                props.isLoadingAudio && props.playingMsgId === message.id ? 'spin' : undefined
              "
            />
          </button>
          <button
            class="msg-action-btn"
            :title="__t('ui.chat', '复制')"
            @click="emit('copy', message.content)"
          >
            <PixelIcon name="copy" size="xs" />
          </button>
          <button
            v-if="allowMutations && mutationActions.includes('edit')"
            class="msg-action-btn"
            @click="emit('edit', message)"
          >
            <PixelIcon name="edit" size="xs" />
          </button>
          <button
            v-if="allowMutations && mutationActions.includes('delete')"
            class="msg-action-btn msg-action-btn-danger"
            :title="deleteActionLabel"
            @click="emit('deletePair', message.id)"
          >
            <PixelIcon name="trash" size="xs" />
          </button>
        </div>
      </div>

      <!-- Thinking 折叠入口：放在气泡侧边，不干扰正文阅读。 -->
      <button
        v-if="message.thinkingContent"
        class="msg-thinking-toggle"
        :class="{ 'msg-thinking-toggle--active': isThinkingExpanded }"
        :title="isThinkingExpanded ? __t('ui.chat', '收起碎碎念') : __t('ui.chat', '展开碎碎念')"
        @click="isThinkingExpanded = !isThinkingExpanded"
      >
        <PixelIcon name="brain" size="xs" />
        <span>{{ __t('ui.chat', '碎碎念') }}</span>
        <PixelIcon :name="isThinkingExpanded ? 'chevron-up' : 'chevron-down'" size="xs" />
      </button>

      <div v-if="message.thinkingContent && isThinkingExpanded" class="msg-thinking-panel">
        <div class="msg-thinking-panel-header">
          <div>
            <span class="msg-thinking-signal" />
            <span>THINK TRACE</span>
            <small>LOCAL ONLY</small>
          </div>
          <button type="button" :title="__t('ui.chat', '复制碎碎念')" @click="copyThinking">
            <PixelIcon name="copy" size="xs" />
            {{ __t('ui.chat', '复制') }}
          </button>
        </div>
        <div class="msg-thinking-timeline">
          <article
            v-for="(section, index) in thinkingSections"
            :key="index"
            class="msg-thinking-step"
          >
            <span class="msg-thinking-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <ChatRichText :content="section" compact :web-preview="false" />
          </article>
        </div>
      </div>

      <!-- 消息体 -->
      <ReplySelection
        :agent-id="agentId || message.senderId || message.surface?.principalId"
        class="msg-bubble msg-bubble-assistant"
        :streaming="isStreaming"
        :identity="message.id"
      >
        <RunPulse
          v-if="ragFailure"
          state="failed"
          :name="agentName"
          :label="ragFailure.message"
          :live="false"
          :show-time="false"
          compact
          class="msg-rag-failure"
        />
        <!-- Conversation Surface 是助手消息唯一的可见内容来源。 -->
        <ConversationSurface v-if="message.surface" :surface="message.surface" />
        <ThinkingIndicator v-else-if="isStreaming" :name="agentName" :label="progressLabel" />
        <div v-else class="msg-surface-missing">{{ __t('ui.chat', '消息 Surface 不可用') }}</div>
      </ReplySelection>
      <Transition name="generation-stats">
        <div
          v-if="!isStreaming && message.surface?.state === 'committed' && generationStats"
          class="msg-generation-stats"
          :title="generationHint"
          :aria-label="__t('ui.chat', '本次对话输出统计')"
        >
          <span class="msg-generation-stats__marker" aria-hidden="true" />
          <span>
            {{ generationStats.estimated ? __t('ui.chat', '约 ') : ''
            }}{{ generationStats.outputTokens.toLocaleString(getDisplayLocale()) }}
            <small>Token</small>
          </span>
          <span class="msg-generation-stats__divider" aria-hidden="true">·</span>
          <span>
            {{ generationRate === null ? '—' : generationRate }}
            <small>Token/s</small>
          </span>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.msg-row-streaming,
.msg-row-streaming :deep(*) {
  user-select: none !important;
  -webkit-user-select: none !important;
}
.msg-generation-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  width: fit-content;
  max-width: 100%;
  margin: 7px 0 0 5px;
  padding: 3px 7px;
  border-left: 2px solid color-mix(in srgb, var(--ui-accent-purple) 40%, transparent);
  background: color-mix(in srgb, var(--ui-accent-purple) 5%, transparent);
  color: var(--ui-text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}
.msg-generation-stats__marker {
  width: 4px;
  height: 4px;
  background: var(--ui-accent-purple);
  opacity: 0.65;
}
.msg-generation-stats small,
.msg-generation-stats__divider {
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.generation-stats-enter-active,
.generation-stats-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}
.generation-stats-enter-from,
.generation-stats-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}
@media (prefers-reduced-motion: reduce) {
  .generation-stats-enter-active,
  .generation-stats-leave-active {
    transition: none;
  }
}

.msg-row-narration {
  justify-content: center;
  margin: 12px 0 20px;
  padding: 0 4%;
}

.msg-narration-card {
  --narration-edge: color-mix(in srgb, var(--ui-accent-purple) 26%, transparent);
  --narration-glow: color-mix(in srgb, var(--ui-accent-sky) 14%, transparent);
  position: relative;
  width: min(92%, 720px);
  padding: 15px 20px 16px;
  overflow: hidden;
  color: var(--ui-text-secondary);
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.11), transparent 38%),
    color-mix(in srgb, var(--ui-bg-surface) 88%, transparent);
  border: 1px solid var(--narration-edge);
  border-radius: 12px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    inset 0 -1px 0 rgba(76, 54, 120, 0.08),
    0 12px 30px rgba(28, 20, 48, 0.11),
    0 3px 8px rgba(28, 20, 48, 0.08);
  backdrop-filter: blur(12px) saturate(112%);
  transform: translateZ(0);
  animation:
    narration-arrive 420ms cubic-bezier(0.22, 1, 0.36, 1),
    narration-float 5.6s ease-in-out 500ms infinite;
  transition:
    transform var(--ui-duration-normal) var(--ui-ease-standard),
    border-color var(--ui-duration-normal) var(--ui-ease-standard),
    box-shadow var(--ui-duration-normal) var(--ui-ease-standard);
}

.msg-narration-card::before,
.msg-narration-card::after {
  content: '';
  position: absolute;
  pointer-events: none;
}

.msg-narration-card::before {
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(105deg, transparent 20%, rgba(255, 255, 255, 0.12), transparent 64%);
  transform: translateX(-115%);
  animation: narration-sheen 7s ease-in-out 1.1s infinite;
}

.msg-narration-card::after {
  left: 22px;
  right: 22px;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--ui-accent-purple), transparent);
  opacity: 0.42;
}

.msg-narration-card:hover {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 42%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 16px 38px rgba(28, 20, 48, 0.15),
    0 4px 11px rgba(28, 20, 48, 0.1);
  transform: translateY(-2px) perspective(700px) rotateX(0.35deg);
}

.msg-narration-glow {
  position: absolute;
  top: -48px;
  left: 18%;
  width: 64%;
  height: 80px;
  border-radius: 50%;
  background: var(--narration-glow);
  filter: blur(24px);
  pointer-events: none;
}

.msg-narration-header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: color-mix(in srgb, var(--ui-accent-purple) 76%, var(--ui-text-secondary));
  font-family: ui-serif, Georgia, 'Times New Roman', 'Noto Serif SC', serif;
  font-size: 10px;
  font-style: italic;
  font-weight: 650;
  letter-spacing: 0.13em;
}

.msg-narration-header time {
  margin-left: auto;
  color: var(--ui-text-tertiary);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.06em;
}

.msg-narration-ornament {
  color: var(--ui-accent-purple);
  font-size: 13px;
  animation: narration-orbit 4.8s ease-in-out infinite;
}

.msg-narration-content {
  position: relative;
  z-index: 1;
  font-family: ui-serif, Georgia, 'Times New Roman', 'Noto Serif SC', serif;
  font-size: 13px;
  font-style: italic;
  font-weight: 480;
  line-height: 1.85;
  letter-spacing: 0.018em;
  text-wrap: pretty;
}

.msg-narration-content :deep(*) {
  font-style: italic;
}

.msg-narration-actions {
  position: absolute;
  z-index: 3;
  right: 10px;
  bottom: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transform: translateY(var(--ui-motion-distance-sm));
  transition:
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}

.msg-narration-card:hover .msg-narration-actions,
.msg-narration-card:focus-within .msg-narration-actions {
  opacity: 1;
  transform: translateY(0);
}

@keyframes narration-arrive {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
    filter: blur(2px);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
}

@keyframes narration-float {
  0%,
  100% {
    translate: 0 0;
  }
  50% {
    translate: 0 -2px;
  }
}

@keyframes narration-sheen {
  0%,
  76%,
  100% {
    transform: translateX(-115%);
    opacity: 0;
  }
  84% {
    opacity: 0.7;
  }
  94% {
    transform: translateX(115%);
    opacity: 0;
  }
}

@keyframes narration-orbit {
  0%,
  100% {
    transform: rotate(0deg) scale(1);
    opacity: 0.75;
  }
  50% {
    transform: rotate(45deg) scale(1.08);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .msg-narration-card,
  .msg-narration-card::before,
  .msg-narration-ornament {
    animation: none;
  }
}

[data-theme='dark'] .msg-narration-card {
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.055), transparent 42%), rgba(28, 24, 40, 0.84);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.09),
    inset 0 -1px 0 rgba(0, 0, 0, 0.22),
    0 15px 34px rgba(4, 3, 9, 0.3),
    0 0 24px rgba(139, 92, 246, 0.055);
}

.msg-row-system {
  justify-content: center;
  margin: 6px 0 14px;
}
.msg-system-pill {
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 88%;
  padding: 7px 12px;
  border: 1px dashed var(--ui-border-default);
  border-radius: var(--ui-radius-full);
  background: var(--ui-accent-purple-soft);
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.msg-system-pill strong {
  flex-shrink: 0;
  color: var(--ui-accent-purple);
  font-size: 10px;
}
.msg-row {
  position: relative;
  isolation: isolate;
  display: flex;
  flex: 0 0 auto;
  width: 100%;
  min-width: 0;
  margin-bottom: 10px;
  animation: fade-in-up 0.3s ease-out;
}
.msg-row-user {
  align-items: flex-start;
  min-height: 0;
  justify-content: flex-end;
}
.msg-row-user--owner {
  gap: 12px;
}
.msg-user-container {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  align-self: flex-start;
  height: fit-content;
}
.msg-user-images {
  display: flex;
  max-width: 520px;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 2px;
  margin-top: 5px;
  padding: 3px 4px 5px;
}
.msg-user-image-note {
  position: relative;
  width: 112px;
  height: 88px;
  flex: 0 0 112px;
  padding: 4px 4px 9px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 42%, var(--ui-border-default));
  border-radius: 7px 3px 7px 3px;
  background: var(--ui-bg-elevated);
  box-shadow: 3px 4px 0 color-mix(in srgb, var(--ui-accent-sky) 18%, transparent);
  cursor: zoom-in;
  transition:
    transform var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.msg-user-image-note img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 4px 2px 4px 2px;
}
.msg-user-image-note--0 {
  transform: rotate(-2.6deg) translateY(2px);
}
.msg-user-image-note--1 {
  transform: rotate(1.8deg) translateY(-1px);
}
.msg-user-image-note--2 {
  transform: rotate(-1.1deg) translateY(4px);
}
.msg-user-image-note--3 {
  transform: rotate(2.8deg) translateY(1px);
}
.msg-user-image-note:hover {
  z-index: 2;
  transform: translateY(-4px) rotate(0deg) scale(1.04);
  box-shadow: 4px 7px 14px color-mix(in srgb, var(--ui-accent-purple) 22%, transparent);
}
.msg-image-preview {
  position: fixed;
  z-index: 10000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 48px;
  background: color-mix(in srgb, #100c1c 82%, transparent);
  backdrop-filter: blur(10px);
}
.msg-image-preview > img {
  display: block;
  max-width: min(92vw, 1400px);
  max-height: 88vh;
  object-fit: contain;
  border: 5px solid var(--ui-bg-elevated);
  border-radius: 18px 7px 18px 7px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.48);
}
.msg-image-preview > button {
  position: fixed;
  top: 22px;
  right: 24px;
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  padding: 0;
  border: 1px solid var(--ui-border-default);
  border-radius: 10px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-primary);
  cursor: pointer;
}
@media (max-width: 720px) {
  .msg-user-image-note {
    width: 96px;
    height: 76px;
    flex-basis: 96px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .msg-user-image-note {
    transition: none;
  }
}
.msg-user-image-time {
  margin: -4px 8px 0 0;
  color: var(--user-bubble-time);
  font-size: 8px;
  font-weight: 600;
  white-space: nowrap;
}
.msg-row-assistant {
  justify-content: flex-start;
  gap: 12px;
}

.msg-bubble-container {
  min-width: 0;
  max-width: 85%;
  overflow: visible;
}

/* 用户气泡以中性表面为主体，仅保留右侧品牌色轨作为身份提示。 */
.msg-bubble-user {
  position: relative;
  padding: 8px 14px;
  color: var(--user-bubble-text);
  background: var(--user-bubble-bg);
  border: 1px solid var(--user-bubble-border);
  border-right: 3px solid var(--user-bubble-accent);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--user-bubble-shadow);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.65;
  word-break: break-word;
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}

/* 时间悬浮在气泡左下侧，不参与文档流，也不挤占正文空间。 */
.msg-user-time {
  position: absolute;
  right: calc(100% + 6px);
  bottom: 3px;
  color: var(--user-bubble-time);
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
}

/* 悬浮操作浮在气泡右下方，不参与消息行高度计算。 */
.msg-user-actions {
  position: absolute;
  right: 4px;
  bottom: -13px;
  z-index: 3;
  gap: 4px;
}

.msg-bubble-user:hover {
  border-color: var(--user-bubble-border-hover);
  border-right-color: var(--user-bubble-accent);
  box-shadow: var(--user-bubble-shadow-hover);
}

/* :global 保证主题根节点不会被 scoped 属性限制。 */
:global(:root),
:global([data-theme='light']) {
  --user-bubble-bg: #f8f7fb;
  --user-bubble-text: #302d3a;
  --user-bubble-border: #e3dfe9;
  --user-bubble-border-hover: #d6cfdf;
  --user-bubble-accent: #b888d1;
  --user-bubble-time: #8b8493;
  --user-bubble-shadow: 0 1px 2px rgba(46, 39, 58, 0.06);
  --user-bubble-shadow-hover: 0 3px 10px rgba(46, 39, 58, 0.09);
}

:global([data-theme='dark']) {
  --user-bubble-bg: #26232d;
  --user-bubble-text: #ebe7ef;
  --user-bubble-border: #3c3746;
  --user-bubble-border-hover: #4a4355;
  --user-bubble-accent: #a98bc4;
  --user-bubble-time: #aaa2b2;
  --user-bubble-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  --user-bubble-shadow-hover: 0 4px 12px rgba(0, 0, 0, 0.28);
}

.msg-rag-failure {
  align-self: flex-start;
  max-width: 100%;
}

/* 助手气泡: 角色化证据卡，左侧色轨体现当前伙伴 */
.msg-bubble-assistant {
  position: relative;
  padding: 14px 18px 14px 20px;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-sm);
  font-size: 14px;
  line-height: 1.9;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 200px;
  max-width: 100%;
  overflow: hidden;
}

.msg-bubble-assistant::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  background: linear-gradient(var(--ui-accent-primary), var(--ui-accent-purple));
  border-radius: 2px;
}

[data-theme='dark'] .msg-bubble-assistant {
  background: rgba(30, 27, 45, 0.8);
  border-color: rgba(139, 92, 246, 0.15);
}

.msg-bubble-assistant:hover {
  box-shadow: var(--ui-shadow-md);
}

/* 消息头像沿用共享相框，仅保留紧凑尺寸与状态标识。 */
.msg-avatar {
  width: 36px;
  height: 36px;
  padding: 1px;
}

.msg-avatar-status {
  position: absolute;
  z-index: 2;
  bottom: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  background: var(--ui-success);
  border: 2px solid var(--ui-bg-surface);
  border-radius: 0;
  pointer-events: none;
}

.msg-avatar-text {
  user-select: none;
}

/* Thinking 侧边折叠控件 */
.msg-thinking-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  margin: 0 0 2px 4px;
  background: var(--ui-bg-surface-soft);
  border: 1px dashed rgba(139, 92, 246, 0.3);
  border-radius: var(--ui-radius-xs);
  color: var(--ui-accent-purple);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  transition: all var(--ui-duration-fast);
}

.msg-thinking-toggle:hover,
.msg-thinking-toggle--active {
  background: var(--ui-accent-purple-soft);
  border-style: solid;
  box-shadow: 0 0 14px rgba(139, 92, 246, 0.11);
}

.msg-thinking-panel {
  margin: 0 0 4px 4px;
  overflow: hidden;
  background: var(--ui-bg-surface-soft);
  border: 1px solid rgba(139, 92, 246, 0.16);
  border-left: 3px solid var(--ui-accent-purple);
  border-radius: var(--ui-radius-sm);
  animation: thinking-reveal var(--ui-duration-normal) var(--ui-ease-standard);
}

.msg-thinking-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-tertiary);
  font-family: var(--font-pixel);
  font-size: 9px;
  letter-spacing: 0.1em;
  background: linear-gradient(90deg, var(--ui-accent-purple-soft), var(--ui-accent-sky-soft));
}

.msg-thinking-panel-header > div,
.msg-thinking-panel-header button {
  display: flex;
  align-items: center;
  gap: 6px;
}

.msg-thinking-panel-header small {
  opacity: 0.62;
  font-size: 8px;
}
.msg-thinking-panel-header button {
  padding: 3px 6px;
  color: var(--ui-accent-purple);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-subtle);
  font: 700 9px var(--font-pixel);
  cursor: pointer;
}
.msg-thinking-signal {
  width: 7px;
  height: 7px;
  background: var(--ui-accent-purple);
  box-shadow: 0 0 8px color-mix(in srgb, var(--ui-accent-purple) 50%, transparent);
  animation: think-signal 1.8s ease-in-out infinite;
}

.msg-thinking-timeline {
  position: relative;
  max-height: 360px;
  padding: 12px 13px 12px 42px;
  overflow: auto;
}
.msg-thinking-timeline::before {
  content: '';
  position: absolute;
  top: 14px;
  bottom: 14px;
  left: 24px;
  width: 1px;
  background: linear-gradient(var(--ui-accent-purple), var(--ui-accent-sky), transparent);
}
.msg-thinking-step {
  position: relative;
  padding: 0 0 13px 5px;
  color: var(--ui-text-secondary);
}
.msg-thinking-step:last-child {
  padding-bottom: 0;
}
.msg-thinking-index {
  position: absolute;
  left: -37px;
  top: 2px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 18px;
  color: var(--ui-accent-purple);
  background: var(--ui-bg-surface);
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 28%, transparent);
  font: 700 9px var(--font-mono);
}

.msg-internal-only {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 270px;
  padding: 11px 12px;
  overflow: hidden;
  color: var(--ui-text-secondary);
  background: linear-gradient(105deg, var(--ui-accent-purple-soft), var(--ui-accent-sky-soft));
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 26%, transparent);
  border-radius: var(--ui-radius-sm);
}
.msg-internal-only::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 35%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
  transform: translateX(-140%);
  animation: internal-scan 2.4s ease-out 1;
  pointer-events: none;
}
.msg-internal-orb {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  transform: rotate(45deg);
  background: linear-gradient(135deg, var(--ui-accent-purple), var(--ui-accent-sky));
  box-shadow: 0 0 11px color-mix(in srgb, var(--ui-accent-purple) 42%, transparent);
}
.msg-internal-only div {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.msg-internal-only strong {
  color: var(--ui-text-primary);
  font: 800 11px var(--font-pixel);
}
.msg-internal-only small {
  margin-top: 2px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.msg-internal-only button {
  padding: 5px 8px;
  color: var(--ui-accent-purple);
  background: var(--ui-bg-surface);
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 28%, transparent);
  font: 700 9px var(--font-pixel);
  cursor: pointer;
}

@keyframes think-signal {
  50% {
    opacity: 0.42;
    transform: scale(0.75);
  }
}
@keyframes internal-scan {
  to {
    transform: translateX(420%);
  }
}

@keyframes thinking-reveal {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .msg-thinking-panel,
  .msg-thinking-signal,
  .msg-internal-only::after {
    animation: none;
  }
}

/* 助手头部 */
.msg-assistant-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  margin-left: 4px;
  transition: opacity 0.3s;
}
.msg-row-assistant:hover .msg-assistant-header {
  opacity: 1;
}

.msg-assistant-name {
  font-size: 12px;
  font-weight: 800;
  color: var(--ui-accent-primary);
  font-family: var(--font-pixel);
  letter-spacing: 0.08em;
}

[data-theme='dark'] .msg-assistant-name {
  color: var(--ui-accent-purple);
}

/* 通用 */
.msg-token-usage {
  color: var(--ui-text-tertiary);
  font-family: var(--ui-font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  opacity: 0.72;
}

.msg-time {
  font-size: 10px;
  font-weight: 600;
  color: var(--ui-text-tertiary);
}

.msg-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--ui-duration-fast);
}
.msg-row:hover .msg-actions,
.msg-row:focus-within .msg-actions {
  opacity: 1;
}

.msg-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-xs);
  color: var(--ui-text-tertiary);
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.msg-action-btn:hover {
  color: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
  box-shadow: var(--ui-glow-pink);
}
.msg-action-btn-danger:hover {
  color: var(--ui-danger);
  border-color: var(--ui-danger);
  box-shadow: 0 0 0 2px var(--ui-danger-soft);
}
.msg-action-btn-danger {
  --ui-focus-color: var(--ui-danger);
}

.msg-attachments {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.msg-attachment {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 260px;
  padding: 7px 9px;
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-text-secondary);
}
.msg-attachment img {
  width: 72px;
  height: 56px;
  object-fit: cover;
  border-radius: 2px;
}
.msg-attachment div {
  min-width: 0;
}
.msg-attachment strong,
.msg-attachment span,
.msg-attachment small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-attachment strong {
  color: var(--ui-text-primary);
  font-size: 11px;
}
.msg-attachment span,
.msg-attachment small {
  color: var(--ui-text-tertiary);
  font-size: 9px;
}

/* 图片 */
.msg-images {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.msg-image {
  max-height: 128px;
  border: 2px solid var(--color-border);
  object-fit: cover;
  cursor: pointer;
  transition: transform var(--ui-duration-fast) var(--ui-ease-standard);
}
.msg-image:hover {
  transform: scale(1.05);
}

.msg-plain-text {
  font-weight: 700;
  color: var(--color-text-primary);
  white-space: pre-wrap;
}

/* Markdown 渲染容器 */
.msg-markdown {
  color: var(--ui-text-primary);
  line-height: 1.9;
  word-break: break-word;
}
.msg-markdown :deep(p) {
  margin: 4px 0;
}
.msg-markdown :deep(pre) {
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  padding: 12px;
  overflow-x: auto;
  font-size: 12px;
  margin: 8px 0;
}
.msg-markdown :deep(code) {
  font-size: 12px;
  background: var(--ui-accent-primary-soft);
  padding: 2px 6px;
  border-radius: var(--ui-radius-xs);
}
.msg-markdown :deep(pre code) {
  background: none;
  padding: 0;
}
.msg-markdown :deep(ul),
.msg-markdown :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}
.msg-markdown :deep(blockquote) {
  border-left: 3px solid var(--ui-accent-primary);
  padding-left: 12px;
  margin: 8px 0;
  color: var(--ui-text-secondary);
}

/* 流式光标 */
.msg-streaming-cursor {
  display: inline-block;
  width: 6px;
  height: 14px;
  background: var(--ui-accent-primary);
  margin-left: 2px;
  vertical-align: text-bottom;
  border-radius: 1px;
  animation: cursor-blink 0.8s steps(2) infinite;
}

/* 工具调用证据轨迹（内容由 ToolCallCard 渲染） */
.msg-tools {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--ui-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}
.msg-tools::before {
  content: '工具轨迹';
  position: absolute;
  top: -9px;
  left: 0;
  background: var(--ui-bg-surface);
  padding: 0 6px;
  font-family: var(--font-pixel);
  font-size: 9px;
  color: var(--ui-text-tertiary);
  letter-spacing: 0.12em;
  /* 纯装饰标签，禁止拦截工具卡片展开点击 */
  pointer-events: none;
}

@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes cursor-blink {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
</style>
