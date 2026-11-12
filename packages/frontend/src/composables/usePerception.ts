import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  PERCEPTION_STATE_EVENT,
  type PerceptionAction,
  type PerceptionDisabledReason,
  type PerceptionSettings,
  type PerceptionSnapshot,
  type PerceptionState,
} from '@infos/shared'
import { t as __t } from '../i18n/index'
import { invoke, isElectron, listen } from '../utils/ipcAdapter'

export type PerceptionPhase = 'stopped' | 'blocked' | 'off' | 'paused' | 'running'

/** 这些字段存在 desktop-home.json 的 perception 分区；总开关和五个开关走 perception-action。 */
export type PerceptionStoredPatch = Partial<
  Pick<PerceptionSettings, 'proactiveLevel' | 'redactedApps' | 'unrecordedApps'>
>

/** 这些原因表示外部条件挡住了感知；disabled、hard-stopped、paused 由设置本身决定。 */
const BLOCKED_REASONS: PerceptionDisabledReason[] = [
  'desktop-disabled',
  'desktop-unavailable',
  'locked',
  'suspended',
  'sensitive-target',
]

// 底部状态栏、红条、设置页共用一份状态，主进程只推一次。
const state = ref<PerceptionState | null>(null)
const error = ref('')
let users = 0
let remove: (() => void) | undefined
let connection = 0
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let revealChannel: BroadcastChannel | undefined

function apply(next: PerceptionState | null): void {
  state.value = next
  clearTimeout(expiryTimer)
  const remaining = (next?.settings.pausedUntil ?? 0) - Date.now()
  // 软暂停到期时重读一次，界面不用等下一次推送。
  if (remaining > 0) expiryTimer = setTimeout(() => void read(connection), remaining + 50)
}

async function read(current: number): Promise<void> {
  try {
    const snapshot = (await invoke('desktop-home:perception-get')) as PerceptionState
    if (current === connection) apply(snapshot)
  } catch {
    // 主进程没有这组通道时不显示感知入口，旧设置照常可用。
    if (current === connection) apply(null)
  }
}

async function connect(): Promise<void> {
  const current = ++connection
  // 独立面板与主窗口各有前端实例，跳转请求同时送达当前承载设置页的窗口。
  if (typeof BroadcastChannel !== 'undefined') {
    revealChannel = new BroadcastChannel('infos:perception-settings')
    revealChannel.onmessage = ({ data }) => {
      if (data !== 'reveal') return
      revealPending = true
      perceptionRevealRequest.value++
    }
  }
  try {
    const off = await listen(PERCEPTION_STATE_EVENT, (payload) => {
      apply(payload as PerceptionState)
    })
    if (current !== connection) return off()
    remove = off
  } catch {
    if (current === connection) apply(null)
    return
  }
  await read(current)
}

function disconnect(): void {
  connection++
  revealChannel?.close()
  revealChannel = undefined
  remove?.()
  remove = undefined
  apply(null)
}

// 从底部状态栏跳到设置页的感知分组：设置页可能还没挂载，所以先记下请求，由设置页取走。
export const perceptionRevealRequest = ref(0)
let revealPending = false
export function revealPerceptionSettings(): void {
  revealPending = true
  perceptionRevealRequest.value++
  revealChannel?.postMessage('reveal')
}
export function takePerceptionReveal(): boolean {
  const pending = revealPending
  revealPending = false
  return pending
}

export function usePerception() {
  const blockedReason = computed(() => {
    const reasons = state.value?.disabledReasons ?? []
    return BLOCKED_REASONS.find((reason) => reasons.includes(reason)) ?? null
  })

  const phase = computed<PerceptionPhase | null>(() => {
    const value = state.value
    if (!value) return null
    if (value.settings.hardStopped) return 'stopped'
    // 没开的时候不说「被挡住了」，否则桌面操作关着的用户会一直看到一句无关的提示。
    if (!value.settings.enabled) return 'off'
    if (blockedReason.value) return 'blocked'
    // 到期后 pausedUntil 可能还留着旧值，以主进程算出的原因为准。
    return value.disabledReasons.includes('paused') ? 'paused' : 'running'
  })

  const label = computed(() => {
    switch (phase.value) {
      case 'stopped':
        return __t('ui.desktop', '感知已停止')
      case 'blocked':
        switch (blockedReason.value) {
          case 'desktop-disabled':
            return __t('ui.desktop', '感知暂停：桌面操作未启用')
          case 'locked':
            return __t('ui.desktop', '感知暂停：电脑已锁屏')
          case 'suspended':
            return __t('ui.desktop', '感知暂停：电脑休眠中')
          case 'sensitive-target':
            return __t('ui.desktop', '感知暂停：当前为敏感窗口')
          default:
            return __t('ui.desktop', '感知暂停：桌面暂不可用')
        }
      case 'off':
        return __t('ui.desktop', '感知未开启')
      case 'paused':
        return __t('ui.desktop', '感知暂停至 {0}', [
          new Date(state.value?.settings.pausedUntil ?? 0).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        ])
      case 'running':
        return __t('ui.desktop', '感知中')
      default:
        return ''
    }
  })

  /** 总览方块地方小，统一用简短规范状态词。 */
  const shortLabel = computed(() => {
    switch (phase.value) {
      case 'stopped':
        return __t('ui.desktop', '已停止')
      case 'blocked':
        return __t('ui.desktop', '已暂停')
      case 'off':
        return __t('ui.desktop', '未开启')
      case 'paused':
        return __t('ui.desktop', '已暂停')
      case 'running':
        return __t('ui.desktop', '感知中')
      default:
        return ''
    }
  })

  async function act(action: PerceptionAction): Promise<boolean> {
    try {
      apply((await invoke('desktop-home:perception-action', action)) as PerceptionState)
      error.value = ''
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : __t('ui.desktop', '桌面设置保存失败')
      return false
    }
  }

  async function updateSettings(patch: PerceptionStoredPatch): Promise<boolean> {
    try {
      await invoke('desktop-home:update', { section: 'perception', patch })
      error.value = ''
      await read(connection)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : __t('ui.desktop', '桌面设置保存失败')
      return false
    }
  }

  /** 她现在知道什么：过滤后的临时文字，只在点开时读，不留存。 */
  async function readSnapshot(): Promise<string> {
    try {
      const snapshot = (await invoke(
        'desktop-home:perception-snapshot',
      )) as PerceptionSnapshot | null
      return snapshot?.text ?? ''
    } catch {
      return ''
    }
  }

  onMounted(() => {
    if (!isElectron()) return
    if (users++ === 0) void connect()
  })
  onUnmounted(() => {
    if (!isElectron()) return
    if (--users === 0) disconnect()
  })

  return { state, phase, blockedReason, label, shortLabel, error, act, updateSettings, readSnapshot }
}
