import { ipcRenderer } from 'electron'
import { DESKTOP_CARD_CHANNELS } from '../../packages/shared/src/desktopCards'
import { isNewHomeCardData, type HomeCardData } from '../../packages/shared/src/homeCardChannel'

type Callback = (value: HomeCardData) => void
const callbacks = new Set<Callback>()
let current: HomeCardData | undefined
let loading: Promise<void> | undefined
let reportError: (error: unknown) => void = () => {}

function receive(value: unknown): void {
  const id = current?.cardId ?? (value as HomeCardData | undefined)?.cardId
  if (typeof id !== 'string' || !isNewHomeCardData(value, id, current?.revision ?? -1)) return
  current = value
  window.dispatchEvent(new Event('infos-card-updated'))
  for (const callback of [...callbacks]) {
    try {
      callback(value)
    } catch (error) {
      reportError(error)
    }
  }
}

ipcRenderer.on(DESKTOP_CARD_CHANNELS.homeData, (_event, value: unknown) => receive(value))
ipcRenderer.on(DESKTOP_CARD_CHANNELS.homeMessage, () => {
  window.dispatchEvent(new Event('infos-card-message-received'))
})

/** 真实鼠标点击或键盘确认产生一次主进程交互凭据；合成事件不生效。 */
for (const name of ['click', 'keydown'] as const) {
  window.addEventListener(
    name,
    (event) => {
      if (
        !event.isTrusted ||
        (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key))
      )
        return
      if (navigator.userActivation?.isActive)
        void ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.interaction).catch(() => undefined)
    },
    true,
  )
}

function get(): Promise<void> {
  loading ??= ipcRenderer
    .invoke(DESKTOP_CARD_CHANNELS.homeGet)
    .then(receive)
    .catch((error: unknown) => {
      reportError(error)
    })
    .finally(() => {
      loading = undefined
    })
  return loading
}

export const cardHome = {
  onData(callback: Callback): () => void {
    if (typeof callback !== 'function') throw new Error('DESKTOP_CARD_INVALID_DATA')
    callbacks.add(callback)
    if (current) callback(current)
    void get()
    return () => {
      callbacks.delete(callback)
    }
  },
  unsubscribe(callback?: Callback): void {
    if (callback) callbacks.delete(callback)
    else callbacks.clear()
  },
  async send(text: unknown): Promise<{ messageId: string }> {
    if (!navigator.userActivation?.isActive)
      throw new Error('DESKTOP_CARD_USER_ACTIVATION_REQUIRED')
    if (typeof text !== 'string' || !text.trim() || text.length > 8000)
      throw new Error('HOME_CARD_INVALID_MESSAGE')
    return ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.homeSend, text)
  },
  start(onError: (error: unknown) => void): void {
    reportError = onError
    void get()
  },
}

window.addEventListener('pagehide', () => {
  callbacks.clear()
})
