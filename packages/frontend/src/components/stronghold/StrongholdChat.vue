<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { copyClientText } from '../../lib/clientPlatform'

/**
 * StrongholdChat — 据点群聊数据适配器
 *
 * 本组件不实现独立的气泡或输入框，只负责把据点 group 消息映射到
 * 普通对话共用的 MessageBubble，并复用 InputBar（CHAR OPS）。
 * 数据源仍是 group_chat_messages，不接触 desktop ThreadStore。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useMessageVisibility } from '../../composables/chat/useMessageVisibility'
import { useChatScroll } from '../../composables/chat/useChatScroll'
import MessageBubble from '../chat/MessageBubble.vue'
import { isLocalOwnerMessage } from '../../lib/userMessageIdentity'
import SurfaceTransition from '../motion/SurfaceTransition.vue'
import InputBar, { type MentionCandidate } from '../chat/InputBar.vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import AgentStateHover from '../agent/AgentStateHover.vue'
import type { ChatMessage } from '../chat/MessageBubble.vue'
import type { GroupMessage } from '../../api/modules/strongholdApi'
import type { AgentProfileMap, StrongholdRoundState } from '../../composables/useStronghold'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { useCompositorStore } from '../../stores/useCompositorStore'

interface Props {
  messages: GroupMessage[]
  profiles?: AgentProfileMap
  /** @ 弹窗的候选成员（当前房间在场的 Agent，用于 @ 选人）。 */
  mentionCandidates?: MentionCandidate[]
  isLoading?: boolean
  isSending?: boolean
  isAwaitingReply?: boolean
  roundState?: StrongholdRoundState | null
  replyStatus?: string
  roomName?: string
  roomId?: string
  participantCount?: number
}

const props = withDefaults(defineProps<Props>(), {
  profiles: () => new Map(),
  mentionCandidates: () => [],
  isLoading: false,
  isSending: false,
  isAwaitingReply: false,
  roundState: null,
  replyStatus: '',
  roomName: '',
  roomId: undefined,
  participantCount: 0,
})

const emit = defineEmits<{
  send: [content: string, mentions: string[], complete: (success: boolean) => void]
  /** 删除单条群聊消息（messageId 为 group_chat_messages 主键） */
  delete: [messageId: number]
}>()

const messageList = ref<HTMLElement | null>(null)
const notify = useNotificationStore()
const compositor = useCompositorStore()
const initialLoad = ref(props.isLoading && !props.messages.length)
watch(
  () => props.isLoading,
  (loading) => {
    if (!loading) initialLoad.value = false
  },
)
const { observeContent, unobserveContent, scrollToBottom } = useChatScroll(
  messageList,
  computed(() => props.messages.length),
)
const { observe, unobserve } = useMessageVisibility(messageList, (element, visible) => {
  if (element.dataset.surfaceId) compositor.setSuspended(element.dataset.surfaceId, !visible)
})
function bubbleElement(event: unknown): Element | null {
  const element = (event as { el?: unknown })?.el
  return element instanceof Element ? element : null
}
function observeBubble(event: unknown): void {
  const element = bubbleElement(event)
  observe(element)
  observeContent(element)
}
function unobserveBubble(event: unknown): void {
  const element = bubbleElement(event)
  unobserve(element)
  unobserveContent(element)
}
const bubbleCache = new WeakMap<
  GroupMessage,
  {
    surface: ReturnType<typeof compositor.get>
    name: string
    avatar: string
    bubble: ChatMessage & {
      agentName: string
      agentAvatarUrl: string
      systemVariant: 'default' | 'narration'
    }
  }
>()

/** 将 SQLite localtime 时间转换为毫秒时间戳。 */
function parseTimestamp(raw?: string): number | undefined {
  if (!raw) return undefined
  const value = new Date(raw.replace(' ', 'T')).getTime()
  return Number.isNaN(value) ? undefined : value
}

function isSystemMessage(message: GroupMessage): boolean {
  return message.role === 'system' || ['butler', 'system'].includes(message.senderId.toLowerCase())
}

function profileName(senderId: string): string {
  return props.profiles.get(senderId)?.name ?? senderId
}

/** 据点消息映射到普通对话共用的气泡数据结构。 */
const bubbleMessages = computed<
  Array<
    ChatMessage & {
      agentName: string
      agentAvatarUrl: string
      systemVariant: 'default' | 'narration'
    }
  >
>(() =>
  props.messages.map((message) => {
    const system = isSystemMessage(message)
    const butler = message.senderId.toLowerCase() === 'butler'
    const name = system ? (butler ? '管家旁白' : '系统') : profileName(message.senderId)
    const surface = compositor.get(`stronghold-message:${message.id}`)
    const avatar = props.profiles.get(message.senderId)?.avatarUrl ?? ''
    const cached = bubbleCache.get(message)
    if (cached?.surface === surface && cached?.name === name && cached?.avatar === avatar)
      return cached.bubble
    const bubble = {
      id: String(message.id),
      role: system ? 'system' : message.role,
      content: message.content,
      timestamp: parseTimestamp(message.timestamp),
      outputTokens: message.outputTokens,
      senderId: message.senderId,
      surface,
      agentName: name,
      agentAvatarUrl: avatar,
      systemVariant: butler ? ('narration' as const) : ('default' as const),
    }
    bubbleCache.set(message, { surface, name, avatar, bubble })
    return bubble
  }),
)

/** CHAR OPS 的发送适配：据点当前只接受文本，上传 desktop Thread 附件。
 * @param mentions 被 @ 的 Agent ID 列表（含 '@all'）。
 */
function handleSend(
  text: string,
  mentions: string[],
  attachmentIds: string[],
  _attachments: import('../../api/modules/attachmentsApi').AttachmentInfo[],
  _imageMode: 'auto' | 'native' | 'relay',
  complete: (success: boolean) => void,
): void {
  if (props.participantCount === 0) {
    notify.toast(__t('ui.stronghold', '当前房间没有角色，无法发言'), { type: 'warning' })
    complete(false)
    return
  }
  if (attachmentIds.length > 0) {
    notify.toast(__t('ui.stronghold', '据点群聊暂不支持附件，请使用文本消息'), { type: 'warning' })
    complete(false)
    return
  }
  emit('send', text, mentions, complete)
}

async function copyMessage(content: string): Promise<void> {
  try {
    await copyClientText(content)
    notify.toast(__t('ui.stronghold', '已复制到剪贴板'), { type: 'success' })
  } catch {
    notify.toast(__t('ui.stronghold', '复制失败'), { type: 'error' })
  }
}

/**
 * 复用 MessageBubble 的 deletePair 事件作为据点单条删除：
 * 群聊里删除“整对”没有意义，气泡 ID 直接映射为群聊消息主键。
 */
function handleDeletePair(id: string): void {
  const messageId = Number(id)
  if (Number.isInteger(messageId) && messageId > 0) {
    emit('delete', messageId)
  }
}

watch(
  () => props.roomName,
  async () => {
    await nextTick()
    scrollToBottom(false)
  },
)
</script>

<template>
  <section class="stronghold-chat-adapter">
    <SurfaceTransition
      class="stronghold-message-region"
      fill
      variant="conversation"
      :identity="roomId ?? roomName"
      :pending="initialLoad && isLoading"
      :label="__t('ui.stronghold', '正在切换房间')"
    >
      <div ref="messageList" class="stronghold-message-list">
        <div v-if="isLoading && messages.length === 0" class="stronghold-chat-state">
          <PixelIcon name="refresh" size="sm" animation="spin" />
          <span>
            {{ __t('ui.stronghold', '正在同步「') }}{{ roomName
            }}{{ __t('ui.stronghold', '」的群聊记录...') }}
          </span>
        </div>
        <div v-else-if="messages.length === 0" class="stronghold-chat-state">
          <PixelIcon name="message" size="lg" />
          <strong>{{ __t('ui.stronghold', '这个房间还很安静') }}</strong>
          <span>{{ __t('ui.stronghold', '发送消息后，房间里的角色会根据群聊上下文接话。') }}</span>
        </div>

        <MessageBubble
          v-for="message in bubbleMessages"
          :key="message.id"
          v-memo="[message, isSending]"
          :message="message"
          :is-owner-message="
            isLocalOwnerMessage({
              role: message.role,
              channel: 'group',
              platform: 'stronghold',
              senderId: message.senderId,
            })
          "
          :agent-id="message.senderId"
          :agent-name="message.agentName"
          :agent-avatar-url="message.agentAvatarUrl"
          :system-variant="message.systemVariant"
          :allow-mutations="true"
          :mutation-actions="['delete']"
          delete-action-label="删除消息"
          @copy="copyMessage"
          @delete-pair="handleDeletePair"
          @vue:mounted="observeBubble"
          @vue:before-unmount="unobserveBubble"
        />

        <div v-if="isAwaitingReply || roundState" class="stronghold-round-state">
          <div class="stronghold-round-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <header>
            <div>
              <strong>
                {{
                  roundState?.completed
                    ? __t('ui.stronghold', '本轮发言完成')
                    : __t('ui.stronghold', '房间对话进行中')
                }}
              </strong>
              <span>{{ replyStatus || __t('ui.stronghold', '角色正在依次接话…') }}</span>
            </div>
            <i v-if="roundState">
              {{ roundState.agents.filter((a) => a.status === 'completed').length }}/{{
                roundState.agents.length
              }}
            </i>
          </header>
          <div v-if="roundState" class="stronghold-round-agents">
            <article
              v-for="agent in roundState.agents"
              :key="agent.agentId"
              :class="`round-agent--${agent.status}`"
            >
              <AgentStateHover
                :agent-id="agent.agentId"
                :agent-name="profileName(agent.agentId)"
                :thread-id="roomId ? `stronghold_${roomId}_${agent.agentId}` : ''"
              >
                <img
                  v-if="profiles.get(agent.agentId)?.avatarUrl"
                  :src="profiles.get(agent.agentId)?.avatarUrl"
                  :alt="profileName(agent.agentId)"
                />
                <span v-else class="round-agent-fallback">
                  {{ profileName(agent.agentId).slice(0, 1) }}
                </span>
              </AgentStateHover>
              <div>
                <b>{{ profileName(agent.agentId) }}</b>
                <small v-if="agent.status === 'queued'">
                  {{ __t('ui.stronghold', '等待接话') }}
                </small>
                <small v-else-if="agent.status === 'streaming'">
                  {{ __t('ui.stronghold', '正在实时回复') }}
                </small>
                <small v-else-if="agent.status === 'tool'">
                  {{ __t('ui.stronghold', '正在调用') }} {{ agent.toolName }}
                </small>
                <small v-else-if="agent.status === 'completed'">
                  {{ __t('ui.stronghold', '已完成') }}
                </small>
                <small v-else>{{ agent.error || __t('ui.stronghold', '回复失败') }}</small>
              </div>
              <PixelIcon
                :name="
                  agent.status === 'completed'
                    ? 'check'
                    : agent.status === 'failed'
                      ? 'alert'
                      : 'sparkle'
                "
                size="xs"
                :animation="
                  agent.status === 'streaming' || agent.status === 'tool' ? 'pulse' : undefined
                "
              />
              <p v-if="agent.draft" class="round-agent-draft">{{ agent.draft }}</p>
            </article>
          </div>
        </div>
      </div>
    </SurfaceTransition>

    <div class="stronghold-input-area">
      <InputBar
        channel="group"
        :context-label="roomName || __t('ui.stronghold', '据点房间')"
        :participant-label="
          participantCount > 0
            ? __t('ui.stronghold', '{0} 位角色在场', [participantCount])
            : __t('ui.stronghold', '当前房间暂无角色')
        "
        :placeholder="
          !roomName
            ? __t('ui.stronghold', '向据点群聊发送消息...')
            : participantCount === 0
              ? __t('ui.stronghold', '当前房间没有角色，暂时无法发言')
              : __t('ui.stronghold', '在「{0}」的群聊中发言...', [roomName])
        "
        :mention-candidates="mentionCandidates"
        :is-sending="isSending || isAwaitingReply"
        :disabled="!roomName || participantCount === 0"
        @send="handleSend"
      />
    </div>
  </section>
</template>

<style scoped>
.stronghold-chat-adapter {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: transparent;
}

.stronghold-message-region {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.stronghold-message-list {
  position: relative;
  z-index: 1;
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px 8px;
}

.stronghold-chat-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}

.stronghold-chat-state strong {
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-pixel), 'Zpix', monospace;
  font-size: 14px;
}

.stronghold-round-state {
  position: relative;
  width: min(88%, 680px);
  margin: 8px 0 18px 46px;
  padding: 13px 14px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 28%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--ui-bg-surface) 88%, transparent);
  box-shadow: 0 10px 28px rgba(35, 24, 59, 0.1);
  backdrop-filter: blur(12px);
  animation: round-state-in 280ms var(--ui-ease-out);
}

.stronghold-round-state > header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.stronghold-round-state > header > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stronghold-round-state header strong {
  color: var(--ui-text-primary);
  font-size: 11px;
}

.stronghold-round-state header span {
  color: var(--ui-text-tertiary);
  font-size: 10px;
}

.stronghold-round-state header i {
  color: var(--ui-accent-purple);
  font-family: var(--ui-font-mono);
  font-size: 10px;
  font-style: normal;
}

.stronghold-round-orbit {
  position: absolute;
  right: -14px;
  top: -22px;
  width: 84px;
  height: 84px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 16%, transparent);
  border-radius: 50%;
  animation: round-orbit 8s linear infinite;
}

.stronghold-round-orbit span {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-accent-purple);
  box-shadow: 0 0 8px var(--ui-accent-purple);
}

.stronghold-round-orbit span:nth-child(1) {
  left: 8px;
  top: 18px;
}
.stronghold-round-orbit span:nth-child(2) {
  right: 5px;
  top: 36px;
}
.stronghold-round-orbit span:nth-child(3) {
  left: 32px;
  bottom: 2px;
}

.stronghold-round-agents {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 7px;
}

.stronghold-round-agents article {
  position: relative;
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 10px;
  background: var(--ui-bg-surface-soft);
  transition: all 220ms var(--ui-ease-out);
}

.stronghold-round-agents article.round-agent--streaming,
.stronghold-round-agents article.round-agent--tool {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 45%, transparent);
  background: linear-gradient(100deg, var(--ui-accent-purple-soft), var(--ui-bg-surface-soft));
  box-shadow: 0 5px 16px rgba(98, 66, 148, 0.1);
  transform: translateX(3px);
}

.stronghold-round-agents article.round-agent--completed {
  opacity: 0.62;
}
.stronghold-round-agents article.round-agent--failed {
  border-color: color-mix(in srgb, var(--ui-danger) 38%, transparent);
}

.stronghold-round-agents img,
.round-agent-fallback {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  object-fit: cover;
}

.round-agent-fallback {
  display: grid;
  place-items: center;
  color: white;
  background: linear-gradient(135deg, var(--ui-accent-sky), var(--ui-accent-purple));
  font-size: 11px;
  font-weight: 800;
}

.stronghold-round-agents article > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.stronghold-round-agents b {
  color: var(--ui-text-primary);
  font-size: 11px;
}
.stronghold-round-agents small {
  color: var(--ui-text-tertiary);
  font-size: 9px;
}

.round-agent-draft {
  grid-column: 2 / 4;
  max-height: 84px;
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.65;
  mask-image: linear-gradient(to bottom, black 72%, transparent);
}

@keyframes round-state-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes round-orbit {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .stronghold-round-state,
  .stronghold-round-orbit {
    animation: none;
  }
}

.stronghold-input-area {
  flex-shrink: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface-soft);
}
</style>
