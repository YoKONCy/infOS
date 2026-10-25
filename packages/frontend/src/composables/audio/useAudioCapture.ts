import { onUnmounted, ref } from 'vue'
import { t } from '../../i18n'

export type VoiceInputMode = 'vad' | 'ptt' | 'off'
export interface VoiceClip {
  audio: ArrayBuffer
  mimeType: string
  durationMs?: number
}

/** 麦克风预先就绪；录制、识别各有取消边界，松开不依赖异步网络检查。 */
export function useAudioCapture(
  onAudio: (clip: VoiceClip, signal: AbortSignal) => Promise<void>,
  isSpeaking?: { readonly value: boolean },
  options: { maxDurationMs?: number; discardSilence?: boolean; releaseAfterCapture?: boolean } = {},
) {
  const mode = ref<VoiceInputMode>('off')
  const ready = ref(false)
  const preparing = ref(false)
  const isRecording = ref(false)
  const recognizing = ref(false)
  const audioLevel = ref(0)
  const elapsedMs = ref(0)
  const error = ref('')
  let generation = 0
  let stream: MediaStream | undefined
  let context: AudioContext | undefined
  let analyser: AnalyserNode | undefined
  let raf = 0
  let pending: AbortController | undefined
  let capture:
    | {
        recorder: MediaRecorder
        cancelled: boolean
        peak: number
        started: number
        duration: number
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  let silenceAt = 0

  function stopRecording(cancelled = false) {
    const current = capture
    if (!current) return
    capture = undefined
    current.cancelled = cancelled
    current.duration = Date.now() - current.started
    clearTimeout(current.timer)
    isRecording.value = false
    if (current.recorder.state !== 'inactive') {
      recognizing.value = !cancelled
      current.recorder.stop()
    }
  }

  function cancel() {
    stopRecording(true)
    pending?.abort()
    pending = undefined
    recognizing.value = false
  }

  function releaseMicrophone() {
    ready.value = false
    cancelAnimationFrame(raf)
    stream?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    stream = undefined
    void context?.close()
    context = undefined
    analyser = undefined
    audioLevel.value = 0
  }
  function release() {
    cancel()
    releaseMicrophone()
  }

  function startRecording() {
    if (!ready.value || !stream || capture) return
    if (mode.value === 'vad' && (isSpeaking?.value || recognizing.value)) return
    pending?.abort()
    recognizing.value = false
    elapsedMs.value = 0
    try {
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      const controller = new AbortController()
      pending = controller
      const current = {
        recorder,
        cancelled: false,
        peak: 0,
        started: Date.now(),
        duration: 0,
        timer: setTimeout(() => stopRecording(), options.maxDurationMs ?? 60_000),
      }
      capture = current
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      recorder.onstop = async () => {
        if (options.releaseAfterCapture && pending === controller) releaseMicrophone()
        if (
          current.cancelled ||
          controller.signal.aborted ||
          current.duration < 180 ||
          (options.discardSilence !== false && current.peak < 0.008) ||
          !chunks.length
        ) {
          if (pending === controller) {
            recognizing.value = false
            pending = undefined
          }
          return
        }
        recognizing.value = true
        try {
          const audio = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()
          if (!controller.signal.aborted)
            await onAudio(
              { audio, mimeType: recorder.mimeType, durationMs: current.duration },
              controller.signal,
            )
        } catch (cause) {
          if (!controller.signal.aborted)
            error.value =
              cause instanceof Error ? cause.message : t('ui.audio-input', '音频处理失败')
        } finally {
          if (pending === controller) {
            recognizing.value = false
            pending = undefined
          }
        }
      }
      recorder.onerror = () => {
        error.value = t('ui.audio-input', '麦克风录制失败，请重新开启语音')
        release()
      }
      recorder.start(100)
      isRecording.value = true
      silenceAt = 0
    } catch {
      error.value = t('ui.audio-input', '当前设备无法录制语音')
      release()
    }
  }

  async function setMode(next: VoiceInputMode, microphoneId = ''): Promise<void> {
    const request = ++generation
    release()
    preparing.value = next !== 'off'
    mode.value = next
    error.value = ''
    if (next === 'off') return
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
        },
      })
      if (generation !== request) {
        acquired.getTracks().forEach((track) => track.stop())
        return
      }
      stream = acquired
      context = new AudioContext()
      await context.resume()
      if (generation !== request || !stream) return
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser)
      ready.value = true
      const data = new Uint8Array(analyser.fftSize)
      const monitor = () => {
        if (!analyser || generation !== request) return
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const value of data) sum += ((value - 128) / 128) ** 2
        const rms = Math.sqrt(sum / data.length)
        audioLevel.value = rms
        if (capture) {
          capture.peak = Math.max(capture.peak, rms)
          elapsedMs.value = Date.now() - capture.started
        }
        if (mode.value === 'vad') {
          if (isSpeaking?.value) stopRecording(true)
          else if (rms > 0.015) {
            silenceAt = 0
            startRecording()
          } else if (capture) {
            if (!silenceAt) silenceAt = Date.now()
            else if (Date.now() - silenceAt > 1000) stopRecording()
          }
        }
        raf = requestAnimationFrame(monitor)
      }
      raf = requestAnimationFrame(monitor)
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (generation === request) {
            error.value = t('ui.audio-input', '麦克风已断开，请重新开启语音')
            release()
          }
        }
      })
    } catch (cause) {
      if (generation === request) {
        error.value =
          cause instanceof Error
            ? t('ui.audio-input', '麦克风不可用：{0}', [cause.message])
            : t('ui.audio-input', '无法开启麦克风')
        release()
      }
    } finally {
      if (generation === request) preparing.value = false
    }
  }

  function pttDown() {
    if (mode.value === 'ptt') startRecording()
  }
  function pttUp(cancelled = false) {
    if (mode.value === 'ptt') stopRecording(cancelled)
  }
  onUnmounted(() => {
    generation++
    release()
  })
  return {
    mode,
    ready,
    preparing,
    isRecording,
    recognizing,
    audioLevel,
    elapsedMs,
    error,
    setMode,
    pttDown,
    pttUp,
    cancel,
    release,
  }
}
