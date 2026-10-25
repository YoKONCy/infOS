import { computed, onActivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { userAvatarApi, type UserAvatarProfile } from '../../api/modules/userAvatarApi'
import { getApiBaseUrl } from '../../api/transport'
import { useGateway } from '../gateway/useGateway'
import { t } from '../../i18n'

const profile = ref<UserAvatarProfile>({ version: null, name: '' })
const busy = ref(false)
const loadedOrigin = ref('')
let pending: { origin: string; promise: Promise<void>; again: boolean } | null = null
let revision = 0

async function refresh(force = false): Promise<void> {
  const origin = getApiBaseUrl()
  if (pending?.origin === origin) {
    // 推送可能发生在旧请求尚未返回时，必须在它结束后再取一次最新资源。
    if (force) pending.again = true
    return pending.promise
  }
  if (!force && loadedOrigin.value === origin) return
  if (loadedOrigin.value !== origin) profile.value = { version: null, name: '' }
  const entry = { origin, promise: Promise.resolve(), again: false }
  pending = entry
  entry.promise = (async () => {
    do {
      entry.again = false
      const request = revision
      const response = await userAvatarApi.profile()
      if (request === revision && origin === getApiBaseUrl() && response.data) {
        profile.value = response.data
        loadedOrigin.value = origin
      }
    } while (entry.again && origin === getApiBaseUrl())
  })().finally(() => {
    if (pending === entry) pending = null
  })
  return entry.promise
}

async function mutate(operation: () => ReturnType<typeof userAvatarApi.upload>): Promise<void> {
  if (busy.value) return
  busy.value = true
  const origin = getApiBaseUrl()
  ++revision
  try {
    const response = await operation()
    if (origin === getApiBaseUrl() && response.data) {
      // 同时使保存期间发出的旧读取失效，避免成功后的头像回跳。
      ++revision
      profile.value = response.data
      loadedOrigin.value = origin
    }
  } finally {
    busy.value = false
  }
}

/** 同一服务端的头像由所有 UI 共享；重连与重新聚焦时补齐错过的资源更新。 */
export function useUserAvatar() {
  const quietlyRefresh = () => {
    void refresh(true).catch(() => undefined)
  }
  const gateway = useGateway({
    onStateUpdate: (payload) => {
      if (payload.ownerAvatarChanged === true) quietlyRefresh()
    },
  })
  const stop = watch(gateway.isConnected, (connected) => {
    if (connected) quietlyRefresh()
  })
  onMounted(() => {
    void refresh().catch(() => undefined)
    window.addEventListener('focus', quietlyRefresh)
  })
  onActivated(quietlyRefresh)
  onUnmounted(() => {
    stop()
    window.removeEventListener('focus', quietlyRefresh)
  })
  return {
    busy: computed(() => busy.value),
    version: computed(() =>
      loadedOrigin.value === getApiBaseUrl() ? profile.value.version : null,
    ),
    name: computed(
      () =>
        (loadedOrigin.value === getApiBaseUrl() && profile.value.name) ||
        t('ui.user-avatar', '主人'),
    ),
    imageUrl: computed(() =>
      loadedOrigin.value === getApiBaseUrl() && profile.value.version
        ? userAvatarApi.contentUrl(profile.value.version)
        : '',
    ),
    refresh,
    upload: (image: Blob) => mutate(() => userAvatarApi.upload(image)),
    reset: () => mutate(() => userAvatarApi.remove()),
  }
}
