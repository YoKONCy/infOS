<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import type { PackageWebUiSession } from '@infos/shared'
import { packageWebUiApi } from '../../api/modules/packageWebUiApi'
import { ApiError } from '../../api/errors'
import { getApiBaseUrl, getClientToken } from '../../api/transport'
import { parsePackageWebUiMessage } from '../../lib/packageWebUiBridge'
import { getLocale } from '@infos/shared/i18n'
import { t } from '../../i18n'
import { PButton, PixelIcon } from '../pixel'

const props = defineProps<{ packageId: string; contributionId: string; name: string }>()
const emit = defineEmits<{ close: [] }>()
const frame = ref<HTMLIFrameElement>()
const session = ref<PackageWebUiSession>()
const loading = ref(false)
const error = ref('')
const calls = new Map<string, AbortController>()
let origin = ''
let credential = ''
let generation = 0
let boot: AbortController | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
let deadline: ReturnType<typeof setTimeout> | undefined
let observer: MutationObserver | undefined
const source = computed(() => (session.value ? `${origin}${session.value.documentPath}` : ''))
const current = () => origin === getApiBaseUrl() && credential === getClientToken()

function send(type: string, payload: Record<string, unknown> = {}) {
  if (!session.value) return
  frame.value?.contentWindow?.postMessage(
    { protocol: 'infos.package-ui.v1', channel: session.value.channel, type, ...payload },
    '*',
  )
}
function sendContext() {
  send('context', {
    context: {
      theme:
        document.documentElement.getAttribute('data-theme') === 'light' ||
        document.documentElement.classList.contains('light')
          ? 'light'
          : 'dark',
      locale: getLocale(),
    },
  })
}
function release() {
  generation++
  boot?.abort()
  clearInterval(heartbeat)
  clearTimeout(deadline)
  observer?.disconnect()
  send('closed', { message: t('ui.packages', '插件界面已关闭。') })
  for (const controller of calls.values()) controller.abort()
  calls.clear()
  const previous = session.value
  session.value = undefined
  loading.value = false
  if (previous && current()) void packageWebUiApi.close(previous.id).catch(() => undefined)
}
function unavailable() {
  release()
  error.value = t('ui.packages', '插件已停用、更新或连接已变化，请返回列表后重新打开。')
}
async function open() {
  release()
  error.value = ''
  loading.value = true
  origin = getApiBaseUrl()
  credential = getClientToken()
  const epoch = generation
  boot = new AbortController()
  try {
    const response = await packageWebUiApi.open(props.packageId, props.contributionId, boot.signal)
    if (epoch !== generation) return
    if (!current()) {
      unavailable()
      return
    }
    if (!response.data) throw new Error('PACKAGE_WEB_UI_UNAVAILABLE')
    session.value = response.data
    deadline = setTimeout(() => {
      if (epoch !== generation) return
      release()
      error.value = t('ui.packages', '界面加载未完成，可以重新加载。')
    }, 20_000)
    let checking = false
    let failures = 0
    heartbeat = setInterval(async () => {
      if (checking || epoch !== generation) return
      if (!current()) {
        unavailable()
        return
      }
      checking = true
      try {
        await packageWebUiApi.touch(response.data!.id)
        failures = 0
      } catch (cause) {
        const invalid =
          cause instanceof ApiError && ['UNAUTHORIZED', 'NOT_FOUND'].includes(cause.code)
        if (epoch === generation && (invalid || ++failures >= 3)) unavailable()
      } finally {
        checking = false
      }
    }, 15_000)
    observer = new MutationObserver(sendContext)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'lang'],
    })
  } catch {
    if (epoch !== generation) return
    loading.value = false
    error.value = t('ui.packages', '无法打开插件界面，请确认插件已启用。')
  }
}
async function receive(event: MessageEvent) {
  const page = session.value
  if (!page || event.source !== frame.value?.contentWindow || event.origin !== 'null') return
  if (!current()) {
    unavailable()
    return
  }
  const message = parsePackageWebUiMessage(event.data, page.channel)
  if (!message) return
  if (message.type === 'failed') {
    loadFailed()
    return
  }
  if (message.type === 'ready') {
    clearTimeout(deadline)
    loading.value = false
    sendContext()
    return
  }
  if (message.type === 'cancel') {
    calls.get(message.id)?.abort()
    return
  }
  if (calls.has(message.id)) return
  if (calls.size >= 8) {
    send('error', { id: message.id, message: t('ui.packages', '操作较多，请稍后重试。') })
    return
  }
  const controller = new AbortController()
  calls.set(message.id, controller)
  const epoch = generation
  try {
    const value = await packageWebUiApi.call(
      page.id,
      message.action,
      message.input,
      (progress) => {
        if (epoch === generation) send('progress', { id: message.id, value: progress })
      },
      controller.signal,
    )
    if (epoch === generation && !controller.signal.aborted)
      send('result', { id: message.id, value })
  } catch {
    if (epoch === generation)
      send('error', { id: message.id, message: t('ui.packages', '插件操作未完成，请重试。') })
  } finally {
    if (calls.get(message.id) === controller) calls.delete(message.id)
  }
}
function loadFailed() {
  release()
  error.value = t('ui.packages', '界面加载未完成，可以重新加载。')
}
onMounted(() => {
  window.addEventListener('message', receive)
  window.addEventListener('infos:unauthorized', unavailable)
  window.addEventListener('infos:authorized', unavailable)
  void open()
})
onActivated(() => {
  if (!session.value && !loading.value) void open()
})
onDeactivated(release)
onBeforeUnmount(() => {
  window.removeEventListener('message', receive)
  window.removeEventListener('infos:unauthorized', unavailable)
  window.removeEventListener('infos:authorized', unavailable)
  release()
})
</script>

<template>
  <section class="plugin-page" :aria-label="name" :aria-busy="loading">
    <header class="plugin-page__header">
      <PButton variant="ghost" size="sm" @click="emit('close')">
        <PixelIcon name="arrow-left" size="xs" />
        {{ t('ui.packages', '返回插件列表') }}
      </PButton>
      <div class="plugin-page__identity">
        <strong>{{ session?.title ?? name }}</strong>
        <code>{{ packageId }}</code>
      </div>
      <PButton variant="secondary" size="sm" :disabled="loading" @click="open">
        <PixelIcon name="refresh" size="xs" />
        {{ t('ui.packages', '重新加载') }}
      </PButton>
    </header>
    <div class="plugin-page__stage">
      <div v-if="loading" class="plugin-page__status" role="status">
        <PixelIcon name="puzzle" size="lg" animation="pulse" />
        {{ t('ui.packages', '正在准备插件界面…') }}
      </div>
      <div v-if="error" class="plugin-page__status plugin-page__status--error" role="alert">
        {{ error }}
      </div>
      <iframe
        v-if="session"
        ref="frame"
        :key="session.id"
        :src="source"
        :title="session.title"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        allow="
          camera 'none';
          microphone 'none';
          geolocation 'none';
          clipboard-read 'none';
          clipboard-write 'none';
        "
        :class="{ 'plugin-page__frame--loading': loading }"
        @error="loadFailed"
      />
    </div>
  </section>
</template>

<style scoped>
.plugin-page {
  min-width: 0;
  border: 1px solid var(--ui-border-default);
  background: var(--app-panel-fill, var(--ui-bg-surface));
}
.plugin-page__header {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px;
  border-bottom: 1px solid var(--ui-border-default);
  box-shadow: inset 0 2px 0 var(--ui-accent-purple);
}
.plugin-page__identity {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 120px;
}
.plugin-page__identity strong {
  font-family: var(--ui-font-pixel);
  color: var(--ui-text-primary);
}
.plugin-page__identity code {
  color: var(--ui-text-tertiary);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.plugin-page__stage {
  position: relative;
  height: clamp(360px, 72vh, 760px);
}
.plugin-page iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--ui-bg-surface);
}
.plugin-page__frame--loading {
  opacity: 0;
  pointer-events: none;
}
.plugin-page__status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-pixel);
}
.plugin-page__status--error {
  color: var(--ui-danger);
}
</style>
