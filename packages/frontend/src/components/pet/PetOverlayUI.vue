<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { PetControlSettings, MessageResource } from '@infos/shared'
import '@infos/shared/i18n/catalogs/petActivity'
import type { PetActivity, PetUiRect } from '../../composables/pet/usePetActivity'
import type BedrockAvatar from '../avatar/BedrockAvatar.vue'
import PetHudIcon from './PetHudIcon.vue'
import PetToolbelt, { type PetPanel } from './PetToolbelt.vue'
import PetSpeechBubble from './PetSpeechBubble.vue'
import PetActivityTrace from './PetActivityTrace.vue'
import PetDeliveries from './PetDeliveries.vue'
import { useDesktopControl } from '../../composables/useDesktopControl'
import { invoke } from '../../utils/ipcAdapter'

interface Props {
  agentId?: string
  threadId?: string | null
  threadTitle?: string
  switching?: boolean
  petName: string
  moodText?: string
  vibeText?: string
  mindText?: string
  stage?: string
  thinking?: boolean
  activity?: PetActivity
  deliveries?: MessageResource[]
  deliveryKey?: string
  connected?: boolean
  unread?: boolean
  replyNotice?: boolean
  replyText?: string
  resizeMode?: boolean
  windowSize?: number
  reaction?: string
  hint?: string
  subtitle?: string
  speaking?: boolean
  recording?: boolean
  recognizing?: boolean
  preparing?: boolean
  voiceReady?: boolean
  voiceError?: string
  audioLevel?: number
  attention?: string
  attentionKey?: string
  attentionKind?: 'approval' | 'question' | 'task'
  settings: PetControlSettings
  avatarRef?: InstanceType<typeof BedrockAvatar> | null
  bounds: { left: number; right: number; top: number; bottom: number }
  viewport: { width: number; height: number }
}
const props = defineProps<Props>()
const desktop = useDesktopControl()
const desktopVisible = computed(
  () =>
    desktop.supported &&
    desktop.state.value.phase !== 'idle' &&
    (!desktop.state.value.agentId || desktop.state.value.agentId === props.agentId),
)
function openDesktopTask() {
  const state = desktop.state.value
  void invoke('pet-controls:open-conversation', {
    agentId: state.agentId || props.agentId,
    threadId: state.threadId,
    taskId: state.taskId,
  }).catch(() => {})
}
const emit = defineEmits<{
  (e: 'send-message', text: string, complete: (accepted: boolean) => void): void
  (e: 'select-agent', id: string, complete: (success: boolean) => void): void
  (e: 'select-thread', id: string, complete: (success: boolean) => void): void
  (e: 'new-thread', complete: (success: boolean) => void): void
  (e: 'ui-enter'): void
  (e: 'ui-leave'): void
  (e: 'open-conversation'): void
  (e: 'open-resource', resource: MessageResource): void
  (e: 'open-section', section: string): void
  (e: 'voice-mode', mode: PetControlSettings['voiceMode']): void
  (e: 'ptt-down'): void
  (e: 'ptt-up', cancelled?: boolean): void
  (e: 'cancel-voice'): void
  (e: 'stop-speech'): void
  (e: 'toggle-resize'): void
  (e: 'dismiss-hint'): void
  (e: 'model-change', path: string, complete: (success: boolean, message?: string) => void): void
}>()
const panel = ref<PetPanel>('chat')
const expanded = ref(false)
const deliveriesOpen = ref(true)
const bubbleRect = ref<PetUiRect | null>(null)
watch(
  () => props.deliveryKey,
  () => {
    deliveriesOpen.value = true
  },
)
const input = ref('')
const drafts = new Map<string, string>()
const inputTarget = computed(() => `${props.agentId || ''}:${props.threadId || ''}`)
watch(inputTarget, (target, previous) => {
  if (previous && input.value) drafts.set(previous, input.value)
  else if (previous) drafts.delete(previous)
  input.value = drafts.get(target) || ''
})
const root = ref<HTMLElement | null>(null)
const dismissedAttention = ref(new Set<string>())
let hideTimer: ReturnType<typeof setTimeout> | undefined
const scale = computed(() => Math.min(1, Math.max(0.78, props.viewport.width / 650)))
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

// 光点只按自身范围定位，内容高度和过渡动画均不能改变入口或模型位置。
const anchor = computed(() => {
  const size = 44 * scale.value
  return {
    left: clamp(props.bounds.right + 8, 12, props.viewport.width - size - 12),
    top: clamp(
      props.bounds.top + (props.bounds.bottom - props.bounds.top) * 0.55 - size / 2,
      12,
      props.viewport.height - size - 12,
    ),
  }
})
const placement = computed(() => ({
  left: anchor.value.left + 'px',
  top: anchor.value.top + 'px',
  transform: 'scale(' + scale.value + ')',
}))
// 操作面的底部固定在角色脚边；窗口空间不足时限制内容高度，内部滚动。
const beltPlacement = computed(() => {
  const s = scale.value
  const width = Math.min(440, Math.max(0, (props.viewport.width - 24) / s))
  const bottom = Math.max(12, props.viewport.height - props.bounds.bottom - 176 * s)
  const maxHeight = Math.min(420, Math.max(0, (props.viewport.height - bottom - 12) / s))
  const left = clamp(
    (props.bounds.left + props.bounds.right - width * s) / 2,
    12,
    props.viewport.width - width * s - 12,
  )
  return {
    left: left + 'px',
    bottom: bottom + 'px',
    width: width + 'px',
    transform: 'scale(' + s + ')',
    '--belt-content-max': Math.max(0, maxHeight - 90) + 'px',
  }
})
const identityPlacement = computed(() => ({
  left: clamp(props.bounds.right + 16, 12, props.viewport.width - 140 * scale.value - 12) + 'px',
  top:
    clamp(
      props.bounds.top + (props.bounds.bottom - props.bounds.top) * 0.2,
      12,
      props.viewport.height - 82 * scale.value - 12,
    ) + 'px',
  transform: 'scale(' + scale.value + ')',
}))
// 必要状态独立放在角色上方，不随操作面切换，也不被收起菜单隐藏。
const noticePlacement = computed(() => {
  const s = scale.value
  const width = Math.min(264, Math.max(0, (props.viewport.width - 24) / s))
  const above = props.bounds.top - 20
  return {
    left:
      clamp(
        (props.bounds.left + props.bounds.right - width * s) / 2,
        12,
        props.viewport.width - width * s - 12,
      ) + 'px',
    width: width + 'px',
    top: above < 48 * s ? '12px' : undefined,
    bottom: above >= 48 * s ? props.viewport.height - props.bounds.top + 8 + 'px' : undefined,
    transform: 'scale(' + s + ')',
    transformOrigin: above >= 48 * s ? 'bottom left' : 'top left',
    maxHeight:
      Math.max(0, Math.min(320, (above >= 48 * s ? above : props.viewport.height - 24) / s)) + 'px',
  }
})
const occupied = computed(() => props.recording || props.recognizing || props.preparing)
const showActivity = computed(
  () => props.thinking && !expanded.value && !occupied.value && !props.speaking,
)
const currentActivity = computed<PetActivity>(() =>
  props.activity && props.activity.phase !== 'idle'
    ? props.activity
    : { phase: 'thinking', steps: [], nit: false },
)
const showDeliveries = computed(() => !expanded.value && !occupied.value && deliveriesOpen.value)
const bubbleText = computed(() => {
  if (expanded.value || occupied.value) return ''
  if (props.speaking && props.settings.subtitlesEnabled) return props.subtitle || ''
  if (props.speaking || props.thinking) return ''
  if (props.replyNotice && props.unread) return props.replyText || __t('ui.pet', '回复好了')
  if (props.attention) return ''
  return props.reaction || ''
})
const showAttention = computed(
  () =>
    !!props.attention &&
    !!props.attentionKey &&
    !dismissedAttention.value.has(props.attentionKey) &&
    !occupied.value &&
    !expanded.value,
)
function dismissAttention() {
  if (!props.attentionKey) return
  dismissedAttention.value.add(props.attentionKey)
  if (dismissedAttention.value.size > 100)
    dismissedAttention.value.delete(dismissedAttention.value.values().next().value!)
}
const voiceLabel = computed(() =>
  props.preparing
    ? __t('ui.pet', '正在准备麦克风')
    : props.recording
      ? __t('ui.pet', '正在听，松开发送')
      : props.recognizing
        ? __t('ui.pet', '正在识别')
        : props.voiceError || '',
)
const markTitle = computed(
  () =>
    props.attention ||
    (props.unread
      ? __t('ui.pet', '有新消息')
      : props.thinking
        ? props.stage || __t('ui.pet', '正在处理')
        : props.connected
          ? props.petName
          : __t('ui.pet', '连接已断开')),
)
function enter() {
  clearTimeout(hideTimer)
  emit('ui-enter')
}
function toggleMenu() {
  if (expanded.value) close()
  else {
    panel.value = 'chat'
    expanded.value = true
    enter()
  }
}
function leave() {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (
      root.value?.contains(document.activeElement) &&
      document.activeElement?.matches('textarea,input,select,[contenteditable=true],:focus-visible')
    )
      return
    close()
  }, 650)
}
function close() {
  if (root.value?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur()
  clearTimeout(hideTimer)
  expanded.value = false
  void nextTick(() => emit('ui-leave'))
}
function selectPanel(id: PetPanel) {
  panel.value = id
  enter()
}
function sendMessage() {
  const text = input.value.trim()
  const target = inputTarget.value
  if (!text || props.thinking || props.switching) return
  emit('send-message', text, (accepted) => {
    if (!accepted) return
    if (drafts.get(target)?.trim() === text) drafts.delete(target)
    if (inputTarget.value === target && input.value.trim() === text) input.value = ''
  })
  close()
}
watch(
  () => props.recording,
  (recording) => {
    if (recording && (!expanded.value || panel.value !== 'voice')) close()
  },
)
onUnmounted(() => clearTimeout(hideTimer))
</script>

<template>
  <div ref="root" class="pet-hud" @focusin="enter" @focusout="leave" @keydown.esc.stop="close">
    <Transition name="pet-speech" :css="!expanded">
      <PetSpeechBubble
        v-if="bubbleText || showActivity || (!expanded && !occupied && deliveries?.length)"
        :text="bubbleText"
        :pet-name="petName"
        :bounds="bounds"
        :viewport="viewport"
        :speaking="speaking"
        :conversation="speaking || thinking || (replyNotice && unread)"
        @ui-enter="enter"
        @ui-leave="leave"
        @open-conversation="emit('open-conversation')"
        @stop-speech="emit('stop-speech')"
        @placement="bubbleRect = $event"
      >
        <PetActivityTrace v-if="showActivity" :activity="currentActivity" />
        <button
          v-if="deliveries?.length"
          type="button"
          class="bubble-deliveries-toggle"
          :title="__t('ui.pet-activity', deliveriesOpen ? '收起交付' : '展开交付')"
          :aria-expanded="deliveriesOpen"
          @click="deliveriesOpen = !deliveriesOpen"
        >
          <PetHudIcon name="sparkle" size="xs" />
          {{ __t('ui.pet-activity', '交付 {0}', [deliveries.length]) }}
          <PetHudIcon :name="deliveriesOpen ? 'chevron-down' : 'chevron-right'" size="xs" />
        </button>
      </PetSpeechBubble>
    </Transition>
    <PetDeliveries
      v-if="deliveries?.length"
      :items="deliveries"
      :delivery-key="deliveryKey || ''"
      :active="showDeliveries"
      :bounds="bounds"
      :bubble="bubbleRect"
      :viewport="viewport"
      @open="emit('open-resource', $event)"
      @collapse="deliveriesOpen = false"
      @ui-enter="enter"
      @ui-leave="leave"
      @play-media="emit('stop-speech')"
    />
    <!-- 展开后由操作面提供收起入口，光点让位于会话选择和输入区域。 -->
    <div
      v-if="!expanded"
      data-pet-ui
      class="hud-anchor"
      :style="placement"
      @pointerenter="enter"
      @pointerleave="leave"
    >
      <button
        type="button"
        class="floating-trigger"
        :title="markTitle"
        :aria-label="markTitle + __t('ui.pet', '，展开桌宠菜单')"
        :aria-expanded="expanded"
        @click="toggleMenu"
      >
        <span class="trigger-core" aria-hidden="true">
          <span class="pulse-ring" />
          <span class="core-dot" />
        </span>
      </button>
    </div>
    <Transition name="pet-identity">
      <div v-if="expanded" class="pet-identity" :style="identityPlacement">
        <div>
          {{ petName }}
          <PetHudIcon name="heart" size="xs" />
        </div>
        <small v-if="moodText || vibeText">
          {{ [moodText, vibeText].filter(Boolean).join(' · ') }}
        </small>
      </div>
    </Transition>
    <Transition name="pet-belt">
      <div
        v-if="expanded"
        data-pet-ui
        class="hud-belt"
        :style="beltPlacement"
        @pointerenter="enter"
        @pointerleave="leave"
      >
        <PetToolbelt
          v-model:message="input"
          :panel="panel"
          :pet-name="petName"
          :agent-id="agentId"
          :thread-id="threadId"
          :thread-title="threadTitle"
          :switching="switching"
          :thinking="thinking"
          :speaking="speaking"
          :voice-ready="voiceReady"
          :recording="recording"
          :attention="attention"
          :mind-text="mindText"
          :settings="settings"
          :avatar-ref="avatarRef"
          @select-panel="selectPanel"
          @close="close"
          @send-message="sendMessage"
          @select-agent="(id, complete) => emit('select-agent', id, complete)"
          @select-thread="(id, complete) => emit('select-thread', id, complete)"
          @new-thread="(complete) => emit('new-thread', complete)"
          @voice-mode="emit('voice-mode', $event)"
          @ptt-down="emit('ptt-down')"
          @ptt-up="emit('ptt-up', $event)"
          @open-conversation="emit('open-conversation')"
          @open-section="emit('open-section', $event)"
          @stop-speech="emit('stop-speech')"
          @model-change="(path, complete) => emit('model-change', path, complete)"
        >
          <template #window-settings><slot name="window-settings" /></template>
        </PetToolbelt>
      </div>
    </Transition>
    <div
      data-pet-ui
      class="hud-notices"
      :style="noticePlacement"
      @pointerenter="enter"
      @pointerleave="leave"
    >
      <Transition name="pet-status">
        <div v-if="desktopVisible && !occupied" class="stage" role="status" aria-live="polite">
          <PetHudIcon name="thought" size="sm" />
          <button type="button" class="text-button" @click="openDesktopTask">
            {{
              desktop.state.value.phase === 'running'
                ? __t('ui.pet', '正在操作桌面')
                : __t('ui.pet', '桌面操作已暂停')
            }}
          </button>
          <button
            v-if="desktop.state.value.phase === 'running'"
            type="button"
            class="icon-button"
            :title="__t('ui.pet', '暂停桌面操作')"
            @click="desktop.control('pause')"
          >
            <PetHudIcon name="close" size="xs" />
          </button>
        </div>
      </Transition>
      <div v-if="resizeMode && (!expanded || panel !== 'more')" class="resize-strip" role="status">
        <span>{{ windowSize }}{{ __t('ui.pet', 'px · 滚轮调整大小，Esc 退出') }}</span>
        <button
          type="button"
          class="icon-button"
          :title="__t('ui.pet', '结束调节')"
          :aria-label="__t('ui.pet', '结束调节')"
          @click="emit('toggle-resize')"
        >
          <PetHudIcon name="close" size="xs" />
        </button>
      </div>
      <Transition name="pet-status">
        <div
          v-if="voiceLabel"
          class="voice-strip"
          :class="{ recording, failed: !!voiceError }"
          role="status"
        >
          <PetHudIcon
            :name="recording ? 'mic' : recognizing || preparing ? 'thought' : 'alert'"
            size="sm"
          />
          <span>{{ voiceLabel }}</span>
          <div v-if="recording" class="meter">
            <i :style="{ width: Math.min(100, (audioLevel || 0) * 700) + '%' }" />
          </div>
          <button
            v-if="recording || recognizing"
            type="button"
            class="icon-button"
            :title="__t('ui.pet', '丢弃这次语音')"
            @click="emit('cancel-voice')"
          >
            <PetHudIcon name="close" size="xs" />
          </button>
        </div>
      </Transition>
      <Transition name="pet-status">
        <div v-if="showAttention" class="attention-card" role="status" aria-live="polite">
          <div class="attention-card__heading">
            <PetHudIcon :name="attentionKind === 'approval' ? 'check' : 'thought'" size="sm" />
            <strong>
              {{
                attentionKind === 'approval'
                  ? __t('ui.pet', '需要你确认')
                  : attentionKind === 'question'
                    ? __t('ui.pet', '有事想问你')
                    : __t('ui.pet', '有待处理事项')
              }}
            </strong>
            <button
              class="icon-button"
              type="button"
              :aria-label="__t('ui.pet', '暂时收起，相同事项不再弹出')"
              @click="dismissAttention"
            >
              <PetHudIcon name="close" size="xs" />
            </button>
          </div>
          <p class="attention-card__summary">{{ attention }}</p>
          <button type="button" class="text-button" @click="emit('open-section', 'tasks')">
            {{ __t('ui.pet', '在主应用中处理') }}
            <PetHudIcon name="chevron-right" size="xs" />
          </button>
        </div>
      </Transition>
      <div v-if="hint && !occupied && !expanded && !showAttention" class="hint-strip" role="status">
        <span>{{ hint }}</span>
        <button
          type="button"
          class="icon-button"
          :aria-label="__t('ui.pet', '收起提示')"
          @click="emit('dismiss-hint')"
        >
          <PetHudIcon name="close" size="xs" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./pet-hud.css" />
