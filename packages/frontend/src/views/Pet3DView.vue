<script setup lang="ts">
import { t as __t } from '../i18n/index'

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import type { PetControlSettings, MessageResource } from '@infos/shared'
import '@infos/shared/i18n/catalogs/petActivity'
import BedrockAvatar from '../components/avatar/BedrockAvatar.vue'
import PetOverlayUI from '../components/pet/PetOverlayUI.vue'
import { usePetWindow } from '../composables/pet/usePetWindow'
import { useHomeCardReaction } from '../composables/pet/useHomeCardReaction'
import { useWindowVisibility } from '../composables/main/useWindowVisibility'
import { usePetGateway } from '../composables/pet/usePetGateway'
import { usePetVoice } from '../composables/pet/usePetVoice'
import { usePetAudio } from '../composables/pet/usePetAudio'
import { usePetTexts } from '../composables/pet/usePetTexts'
import { usePetControls } from '../composables/pet/usePetControls'
import { usePetAttention } from '../composables/pet/usePetAttention'
import { splitSpokenCaptions } from '../composables/pet/petPresentation'
import { voiceApi } from '../api/modules/voiceApi'
import { invoke, listen, send, isElectron } from '../utils/ipcAdapter'
import {
  AVATAR_MODEL_STORAGE_KEY,
  DEFAULT_AVATAR_MANIFEST_PATH,
} from '../components/avatar/lib/avatarDefaults'

defineOptions({ name: 'Pet3DView' })
const router = useRouter()
const avatarRef = ref<InstanceType<typeof BedrockAvatar> | null>(null)
const windowVisible = useWindowVisibility()
const avatarMounted = ref(windowVisible.value)
let suspendedAnimation = ''
let avatarReleaseTimer: ReturnType<typeof setTimeout> | undefined
watch(
  windowVisible,
  (visible) => {
    clearTimeout(avatarReleaseTimer)
    if (visible) avatarMounted.value = true
    else {
      // 只回收视觉资源，网关连接、语音播放和快捷键继续由桌宠宿主承载。
      avatarReleaseTimer = setTimeout(() => {
        suspendedAnimation = avatarRef.value?.getAnimation() ?? ''
        avatarMounted.value = false
      }, 60_000)
    }
  },
  { immediate: true },
)
const {
  globalMouse,
  isDragging,
  onInteractableEnter,
  onInteractableLeave,
  resizeMode,
  windowSize,
  toggleResizeMode,
} = usePetWindow()
const { settings, loaded, update } = usePetControls()
const {
  isPlaying: speaking,
  currentId: playbackId,
  mouthOpen,
  progress,
  playAsset,
  stopAll,
} = usePetAudio()
const {
  chatState,
  activeAgentId,
  activeSessionId,
  activeThread,
  switching,
  selectAgent,
  selectThread,
  createThread,
  conversationTarget,
  latestReply,
  activity,
  deliveries,
  deliveryKey,
  deliveryTarget,
  unread,
  hint,
  wsState,
  sendChat,
  stopSpeech: cancelServerSpeech,
  selectPrincipal,
} = usePetGateway()
const { attention, attentionKey, attentionKind, attentionTarget } = usePetAttention(activeAgentId)
useHomeCardReaction({
  agentId: activeAgentId,
  visible: windowVisible,
  busy: () => isDragging.value || speaking.value,
  element: () => (avatarRef.value?.$el instanceof HTMLElement ? avatarRef.value.$el : undefined),
})
const reaction = ref('')
const replyText = ref('')
const transientHint = ref('')
const replyNotice = ref(false)
const playbackCaption = ref('')
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
const bounds = ref({
  left: window.innerWidth * 0.35,
  right: window.innerWidth * 0.65,
  top: window.innerHeight * 0.25,
  bottom: window.innerHeight * 0.85,
})
let layoutBounds = { left: 0.35, right: 0.65, top: 0.25, bottom: 0.85 }
let reactionTimer: ReturnType<typeof setTimeout> | undefined
let hintTimer: ReturnType<typeof setTimeout> | undefined
let replyTimer: ReturnType<typeof setTimeout> | undefined
let configureGeneration = 0
let disposed = false
const cleanup: Array<() => void> = []

const voice = usePetVoice(async ({ audio, mimeType }, signal) => {
  const agentId = activeAgentId.value
  const threadId = activeSessionId.value
  const result = await voiceApi.recognize(audio, mimeType, signal)
  if (
    signal.aborted ||
    activeAgentId.value !== agentId ||
    activeSessionId.value !== threadId ||
    switching.value
  )
    return
  if (chatState.value.isThinking) {
    showHint('上一条消息仍在处理中，这次语音没有发送')
    return
  }
  if (result.text?.trim()) void sendChat(result.text.trim(), settings.value.speechEnabled)
  else showHint('没有听清，再说一次吧')
}, speaking)
const {
  isRecording: recording,
  recognizing,
  preparing,
  ready: voiceReady,
  error: voiceError,
  audioLevel,
} = voice

function showHint(text: string) {
  clearTimeout(hintTimer)
  transientHint.value = text
  if (text)
    hintTimer = setTimeout(() => {
      transientHint.value = ''
    }, 6000)
}
function showReaction(text: string, duration?: number) {
  if (document.activeElement?.matches('input,textarea,select,[contenteditable=true]')) return
  if (
    recording.value ||
    recognizing.value ||
    speaking.value ||
    chatState.value.isThinking ||
    attention.value
  )
    return
  clearTimeout(reactionTimer)
  reaction.value = text
  reactionTimer = setTimeout(
    () => {
      reaction.value = ''
    },
    duration ?? Math.min(30000, Math.max(5000, text.length * 120)),
  )
}
const { agentName, getClickText } = usePetTexts({
  agentId: activeAgentId,
  showBubble: showReaction,
  ambientMessages: false,
  isThinking: computed(() => chatState.value.isThinking),
  isSpeaking: speaking,
})
const petName = computed(() => agentName.value || activeAgentId.value)
const spokenSentences = computed(() => splitSpokenCaptions(playbackCaption.value))
const subtitle = computed(() => {
  // 自动播报的短口语答复整体显示，让气泡按实际内容伸缩。
  if (playbackCaption.value.length <= 240) return playbackCaption.value
  const sentences = spokenSentences.value
  if (!sentences.length) return ''
  const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0)
  const cursor = progress.value * total
  let end = 0
  return (
    sentences.find((sentence) => {
      end += sentence.length
      return cursor <= end
    }) ??
    sentences[sentences.length - 1] ??
    ''
  )
})

function stopSpeech(agentId?: string) {
  const id = playbackId.value
  stopAll()
  if (id) send('audio-output:receipt', { playbackId: id, state: 'cancelled' })
  cancelServerSpeech(agentId)
}
function pttDown() {
  if (
    !voiceReady.value ||
    settings.value.voiceMode !== 'ptt' ||
    switching.value ||
    !activeSessionId.value
  )
    return
  if (chatState.value.isThinking) {
    showHint('正在处理上一条消息，请稍等片刻')
    return
  }
  reaction.value = ''
  stopSpeech()
  voice.pttDown()
}
function cancelVoice() {
  voice.cancel()
}
function reloadPet(): void {
  stopSpeech()
  cancelVoice()
  router.go(0)
}
async function setVoiceMode(mode: PetControlSettings['voiceMode']) {
  await update({ voiceMode: mode })
}
async function configureVoice() {
  if (!loaded.value) return
  const request = ++configureGeneration
  await voice.setMode('off')
  if (isElectron()) await invoke('pet-controls:arm', false).catch(() => {})
  if (settings.value.voiceMode === 'off') return
  try {
    const status = await voiceApi.getStatus()
    if (request !== configureGeneration || disposed) return
    if (!status.data?.asr.available) {
      showHint('请先在主应用配置语音识别服务')
      return
    }
    await selectPrincipal(activeAgentId.value, true)
    if (request !== configureGeneration || disposed) return
    await voice.setMode(settings.value.voiceMode, settings.value.microphoneId)
  } catch {
    if (request === configureGeneration) showHint('语音服务暂不可用，请检查连接')
  }
}
watch([loaded, () => settings.value.voiceMode, () => settings.value.microphoneId], () => {
  void configureVoice()
})
watch(voiceReady, (ready) => {
  if (isElectron()) void invoke('pet-controls:arm', ready).catch(() => {})
})
watch(voiceError, showHint)
watch(hint, showHint)
watch(
  () => settings.value.speechEnabled,
  (enabled) => {
    if (!enabled) stopSpeech()
  },
)
watch(
  conversationTarget,
  (target) => {
    if (isElectron()) void invoke('pet-controls:conversation', target).catch(() => {})
  },
  { deep: true },
)
watch(activeAgentId, (_, previous) => {
  stopSpeech(previous)
  cancelVoice()
  reaction.value = ''
  replyText.value = ''
  replyNotice.value = false
  playbackCaption.value = ''
  transientHint.value = ''
  clearTimeout(replyTimer)
  void configureVoice()
})
watch(activeSessionId, () => {
  stopSpeech()
  cancelVoice()
  reaction.value = ''
  replyText.value = ''
  replyNotice.value = false
  playbackCaption.value = ''
  clearTimeout(replyTimer)
})
watch(latestReply, (reply, previous) => {
  if (!reply || reply.messageId === previous?.messageId || !unread.value) return
  clearTimeout(replyTimer)
  replyText.value = reply.spokenReply
  replyNotice.value = true
  replyTimer = setTimeout(
    () => {
      replyNotice.value = false
    },
    Math.min(30000, Math.max(8000, reply.spokenReply.length * 120)),
  )
})
watch(mouthOpen, (value) => avatarRef.value?.setLipSync(value))
watch(globalMouse, ({ x, y }) => avatarRef.value?.setGlobalMouse(x, y))

async function openConversation() {
  try {
    if (isElectron()) await invoke('pet-controls:open-conversation', conversationTarget.value)
    unread.value = false
    replyNotice.value = false
  } catch {
    showHint('主应用暂时无法打开')
  }
}
async function openDelivery(resource: MessageResource) {
  try {
    const opened = await invoke('pet-controls:open-resource', {
      resource,
      target: deliveryTarget.value || conversationTarget.value,
    })
    if (opened !== true) throw new Error('RESOURCE_OPEN_FAILED')
  } catch {
    showHint(__t('ui.pet-activity', '无法打开文件'))
  }
}
async function sendOverlayMessage(text: string, complete: (accepted: boolean) => void) {
  complete(await sendChat(text, settings.value.speechEnabled))
}
async function choosePetAgent(id: string, complete: (success: boolean) => void) {
  cancelVoice()
  stopSpeech()
  complete(await selectAgent(id))
}
async function choosePetThread(id: string, complete: (success: boolean) => void) {
  cancelVoice()
  stopSpeech()
  complete(await selectThread(id))
}
async function newPetThread(complete: (success: boolean) => void) {
  cancelVoice()
  stopSpeech()
  complete(await createThread())
}
async function openSection(section: string) {
  try {
    if (section === 'tasks' && attentionTarget.value) {
      await invoke('pet-controls:open-conversation', attentionTarget.value)
    } else await invoke('pet-controls:open-section', section)
  } catch {
    showHint('主应用暂时无法打开')
  }
}
function updateBounds() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  bounds.value = {
    left: layoutBounds.left * viewport.value.width,
    right: layoutBounds.right * viewport.value.width,
    top: layoutBounds.top * viewport.value.height,
    bottom: layoutBounds.bottom * viewport.value.height,
  }
}
/** 只在模型加载后采样布局，角色动画和视线追踪不能驱动 HUD 重定位。 */
function captureModelBounds() {
  const projected = avatarRef.value?.getScreenBounds()
  if (projected && Object.values(projected).every(Number.isFinite)) {
    layoutBounds = {
      left: projected.left / window.innerWidth,
      right: projected.right / window.innerWidth,
      top: projected.top / window.innerHeight,
      bottom: projected.bottom / window.innerHeight,
    }
  }
  updateBounds()
}

function handleModelReady(): void {
  if (suspendedAnimation) {
    avatarRef.value?.setAnimation(suspendedAnimation)
    suspendedAnimation = ''
  }
  avatarRef.value?.setLipSync(mouthOpen.value)
  avatarRef.value?.setGlobalMouse(globalMouse.value.x, globalMouse.value.y)
  captureModelBounds()
}
const currentManifestPath = ref(
  localStorage.getItem(AVATAR_MODEL_STORAGE_KEY) || DEFAULT_AVATAR_MANIFEST_PATH,
)
async function onModelChange(path: string, complete: (success: boolean, message?: string) => void) {
  try {
    const success = (await avatarRef.value?.loadManifestPath(path)) ?? false
    if (success) {
      currentManifestPath.value = path
    }
    complete(success, success ? undefined : '模型尚未就绪或加载失败')
  } catch (error) {
    complete(false, error instanceof Error ? error.message : '模型加载失败')
  }
}
function keydown(event: KeyboardEvent) {
  if (event.code !== 'Escape') return
  if (recording.value || recognizing.value) {
    event.preventDefault()
    cancelVoice()
  }
}
const petTheme = ref<'light' | 'dark'>('light')
function applyTheme(mode?: string | null) {
  const theme =
    mode === 'dark' || mode === 'light'
      ? mode
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  petTheme.value = theme
}
function setPetTheme(mode: 'light' | 'dark') {
  applyTheme(mode)
  try {
    localStorage.setItem('infos.theme', mode)
  } catch {
    // 存储不可用时，当前窗口仍然应用所选主题。
  }
  void invoke('set-native-theme', mode).catch(() => {})
}
function themeStorage(event: StorageEvent) {
  if (event.key === 'infos.theme') applyTheme(event.newValue)
}
applyTheme(localStorage.getItem('infos.theme'))
async function subscribe(channel: string, handler: (payload: unknown) => void) {
  const remove = await listen(channel, handler)
  if (disposed) remove()
  else cleanup.push(remove)
}
onMounted(() => {
  window.addEventListener('storage', themeStorage)
  window.addEventListener('resize', updateBounds)
  window.addEventListener('keydown', keydown, true)
  void subscribe('pet-controls:ptt', (data) => {
    const event = data as { pressed: boolean; cancelled?: boolean }
    if (event.pressed) pttDown()
    else voice.pttUp(event.cancelled)
  })
  void subscribe('pet-controls:action', (data) => {
    const action = (data as { action: string }).action
    if (action === 'toggle-voice')
      void setVoiceMode(settings.value.voiceMode === 'off' ? 'ptt' : 'off')
    if (action === 'stop-speech') stopSpeech()
    if (action === 'cancel-voice') cancelVoice()
    if (action === 'suspend-voice') {
      configureGeneration++
      void voice.setMode('off')
    }
    if (action === 'resume-voice') void configureVoice()
  })
  void subscribe('audio-output:play', (data) => {
    const payload = data as {
      playbackId?: string
      assetUrl?: string
      volume?: number
      caption?: string
      agentId?: string
      threadId?: string
    }
    if (!payload.playbackId || !payload.assetUrl?.startsWith('/api/assets/audio/')) return
    const id = payload.playbackId
    if (
      !settings.value.speechEnabled ||
      recording.value ||
      switching.value ||
      (payload.agentId && payload.agentId !== activeAgentId.value) ||
      (payload.threadId && payload.threadId !== activeSessionId.value)
    ) {
      send('audio-output:receipt', { playbackId: id, state: 'cancelled' })
      return
    }
    playbackCaption.value = payload.caption || ''
    void playAsset(id, payload.assetUrl, payload.volume).then(
      () => send('audio-output:receipt', { playbackId: id, state: 'completed' }),
      () => send('audio-output:receipt', { playbackId: id, state: 'cancelled' }),
    )
  })
  void subscribe('audio-output:stop', (data) => {
    const id = (data as { playbackId?: string }).playbackId
    if (!id) return
    stopAll(id)
    send('audio-output:receipt', { playbackId: id, state: 'cancelled' })
  })
})
onUnmounted(() => {
  disposed = true
  clearTimeout(avatarReleaseTimer)
  configureGeneration++
  window.removeEventListener('resize', updateBounds)
  clearTimeout(reactionTimer)
  clearTimeout(hintTimer)
  clearTimeout(replyTimer)
  window.removeEventListener('keydown', keydown, true)
  window.removeEventListener('storage', themeStorage)
  for (const remove of cleanup) remove()
  if (isElectron()) void invoke('pet-controls:arm', false).catch(() => {})
})
</script>

<template>
  <div class="pet-view" :class="{ 'pet-view--hidden': !windowVisible }">
    <BedrockAvatar
      v-if="avatarMounted"
      ref="avatarRef"
      :active="windowVisible"
      :speaking="speaking"
      :is-dragging="isDragging"
      :manifest-path="currentManifestPath"
      :agent-id="activeAgentId"
      :mood="chatState.mood"
      :vibe="chatState.vibe"
      @pet="(event) => showReaction(getClickText(event.type))"
      @hover-start="onInteractableEnter"
      @hover-end="onInteractableLeave"
      @model-load-success="handleModelReady"
    />
    <PetOverlayUI
      :pet-name="petName"
      :mood-text="chatState.mood"
      :vibe-text="chatState.vibe"
      :mind-text="chatState.mind"
      :thinking="chatState.isThinking"
      :activity="activity"
      :deliveries="deliveries"
      :delivery-key="deliveryKey"
      :stage="chatState.thinkingMessage"
      :connected="wsState === 'connected'"
      :unread="unread"
      :reply-notice="replyNotice"
      :reply-text="replyText"
      :resize-mode="resizeMode"
      :window-size="windowSize"
      :reaction="reaction"
      :hint="transientHint"
      :subtitle="subtitle"
      :speaking="speaking"
      :recording="recording"
      :recognizing="recognizing"
      :preparing="preparing"
      :voice-ready="voiceReady"
      :voice-error="voiceError"
      :audio-level="audioLevel"
      :agent-id="activeAgentId"
      :thread-id="activeSessionId"
      :thread-title="activeThread?.title"
      :thread-kind="activeThread?.threadKind"
      :switching="switching"
      :attention="attention"
      :attention-key="attentionKey"
      :attention-kind="attentionKind"
      :settings="settings"
      :avatar-ref="avatarRef"
      :bounds="bounds"
      :viewport="viewport"
      @send-message="sendOverlayMessage"
      @select-agent="choosePetAgent"
      @select-thread="choosePetThread"
      @new-thread="newPetThread"
      @ui-enter="onInteractableEnter"
      @ui-leave="onInteractableLeave"
      @voice-mode="setVoiceMode"
      @ptt-down="pttDown"
      @ptt-up="voice.pttUp"
      @cancel-voice="cancelVoice"
      @stop-speech="stopSpeech"
      @toggle-resize="toggleResizeMode"
      @open-conversation="openConversation"
      @open-resource="openDelivery"
      @open-section="openSection"
      @dismiss-hint="transientHint = ''"
      @model-change="onModelChange"
    >
      <template #window-settings>
        <div class="window-settings">
          <span>{{ __t('ui.navigation', '桌宠大小') }}</span>
          <button
            type="button"
            :class="{ active: resizeMode }"
            :disabled="!isElectron()"
            @click="toggleResizeMode"
          >
            {{ resizeMode ? __t('ui.navigation', '结束调节') : __t('ui.navigation', '滚轮调节') }}
          </button>
        </div>
        <p v-if="resizeMode" class="resize-hint">
          {{ windowSize }}{{ __t('ui.navigation', 'px · 滚轮调整大小，Esc 退出') }}
        </p>
        <div class="pet-theme-settings">
          <span>{{ __t('ui.navigation', '界面主题') }}</span>
          <div
            class="pet-theme-options"
            role="group"
            :aria-label="__t('ui.navigation', '界面主题')"
          >
            <button
              type="button"
              :class="{ active: petTheme === 'light' }"
              :aria-pressed="petTheme === 'light'"
              @click="setPetTheme('light')"
            >
              {{ __t('ui.navigation', '浅色') }}
            </button>
            <button
              type="button"
              :class="{ active: petTheme === 'dark' }"
              :aria-pressed="petTheme === 'dark'"
              @click="setPetTheme('dark')"
            >
              {{ __t('ui.navigation', '暗色') }}
            </button>
          </div>
        </div>
        <div class="window-actions">
          <button type="button" @click="invoke('hide-pet-window')">
            {{ __t('ui.navigation', '隐藏桌宠') }}
          </button>
          <button type="button" @click="reloadPet">{{ __t('ui.navigation', '重新加载') }}</button>
        </div>
      </template>
    </PetOverlayUI>
  </div>
</template>

<style scoped>
.pet-view--hidden :deep(*) {
  animation-play-state: paused !important;
}

.pet-view {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: transparent;
}
.window-settings {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  border-top: 1px solid var(--pet-divider);
  padding-top: 12px;
  margin-top: 10px;
  font-size: 12px;
}
.window-settings > span,
.window-settings > button {
  flex-shrink: 0;
}
.window-settings button,
.window-actions button,
.pet-theme-options button {
  border: 1px solid var(--pet-border);
  border-radius: 0;
  padding: 4px 9px;
  background: var(--pet-control-fill);
  color: inherit;
  cursor: pointer;
  font-family: var(--ui-font-pixel);
  font-size: 12px;
  box-shadow: var(--pet-control-shadow);
}
.window-settings button:hover:not(:disabled),
.window-actions button:hover:not(:disabled),
.pet-theme-options button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--pet-accent) 55%, var(--pet-border));
  background: color-mix(in srgb, var(--pet-accent) 8%, var(--pet-soft));
}
.window-settings button:active:not(:disabled),
.window-actions button:active:not(:disabled),
.pet-theme-options button:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow: var(--pet-pressed-shadow);
}
.window-settings button:focus-visible,
.window-actions button:focus-visible,
.pet-theme-options button:focus-visible {
  outline: 1px solid var(--pet-accent);
  outline-offset: 2px;
}
.window-settings div {
  display: flex;
  gap: 4px;
}
.window-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
}
.resize-hint {
  margin: 8px 0 0;
  color: var(--pet-muted);
  font-size: 12px;
}
.pet-theme-settings {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  font-size: 12px;
}
.pet-theme-options {
  display: flex;
  gap: 6px;
}
.window-settings button.active,
.pet-theme-options button.active {
  border-color: var(--pet-accent);
  color: var(--pet-accent);
}
</style>
