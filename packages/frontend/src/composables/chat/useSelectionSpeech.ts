import { onDeactivated, onScopeDispose, ref } from 'vue'
import { voiceApi } from '../../api/modules/voiceApi'

let active:
  | {
      owner: symbol
      context: AudioContext
      source?: AudioBufferSourceNode
      abort: AbortController
      busy: ReturnType<typeof ref<boolean>>
    }
  | undefined

function stopActive(): void {
  const current = active
  active = undefined
  if (!current) return
  current.abort.abort()
  try {
    current.source?.stop()
  } catch {
    /* 音源可能尚未启动或已经结束。 */
  }
  void current.context.close().catch(() => {})
  current.busy.value = false
}
if (typeof window !== 'undefined') window.addEventListener('infos:stop-message-audio', stopActive)
import.meta.hot?.dispose(() => window.removeEventListener('infos:stop-message-audio', stopActive))

/** 选区朗读复用已配置的 TTS；跨气泡只保留一次播放，离开页面立即取消。 */
export function useSelectionSpeech(agentId?: () => string | undefined) {
  const owner = Symbol('selection-speech')
  const busy = ref(false)
  const stop = () => {
    if (active?.owner === owner) stopActive()
  }
  async function speak(text: string): Promise<void> {
    stopActive()
    if (!text.trim()) return
    window.dispatchEvent(new Event('infos:stop-message-audio'))
    const context = new AudioContext()
    const current = {
      owner,
      context,
      abort: new AbortController(),
      busy,
      source: undefined as AudioBufferSourceNode | undefined,
    }
    active = current
    busy.value = true
    try {
      // 在点击手势中恢复音频设备，网络合成完成后不再依赖自动播放许可。
      await context.resume()
      const chunks: string[] = []
      for (let start = 0; start < text.length; ) {
        let end = Math.min(text.length, start + 500)
        // 不从 UTF-16 代理对中间切开，避免分段朗读破坏表情或生僻字。
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
        chunks.push(text.slice(start, end))
        start = end
      }
      for (const chunk of chunks) {
        if (active !== current) return
        const bytes = await voiceApi.synthesize(
          { text: chunk, ...(agentId?.() ? { agentId: agentId() } : {}) },
          current.abort.signal,
        )
        if (active !== current) return
        const buffer = await context.decodeAudioData(bytes)
        if (active !== current) return
        await new Promise<void>((resolve, reject) => {
          const source = context.createBufferSource()
          current.source = source
          source.buffer = buffer
          source.connect(context.destination)
          const cancelled = () => {
            try {
              source.stop()
            } catch {
              /* 取消期间音源可能已经结束。 */
            }
            resolve()
          }
          current.abort.signal.addEventListener('abort', cancelled, { once: true })
          source.onended = () => {
            current.abort.signal.removeEventListener('abort', cancelled)
            resolve()
          }
          try {
            source.start()
          } catch (error) {
            current.abort.signal.removeEventListener('abort', cancelled)
            reject(error)
          }
        })
      }
    } catch (error) {
      if (active !== current || current.abort.signal.aborted) return
      throw error
    } finally {
      if (active === current) stopActive()
    }
  }
  onScopeDispose(stop)
  onDeactivated(stop)
  return { busy, speak, stop }
}
