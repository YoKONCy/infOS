// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { Blob as NodeBlob } from 'node:buffer'
import { usePetVoice } from '@infos/frontend/composables/pet/usePetVoice'

class Recorder {
  static isTypeSupported = () => true
  mimeType = 'audio/ogg;codecs=opus'
  state = 'inactive'
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  onerror?: () => void
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new NodeBlob(['音频']) as unknown as Blob })
    this.onstop?.()
  }
}
const track = { stop: vi.fn(), onended: null }
const stream = { getTracks: () => [track] }
let monitor: FrameRequestCallback
let getUserMedia: ReturnType<typeof vi.fn>
let wrapper: ReturnType<typeof mount> | undefined
function setup(
  onAudio = vi.fn().mockResolvedValue(undefined),
  options: Parameters<typeof usePetVoice>[2] = {},
) {
  let voice!: ReturnType<typeof usePetVoice>
  wrapper = mount(
    defineComponent({
      setup() {
        voice = usePetVoice(onAudio, undefined, options)
        return () => null
      },
    }),
  )
  return { voice, onAudio }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
  track.stop.mockClear()
  getUserMedia = vi.fn().mockResolvedValue(stream)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    monitor = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal(
    'AudioContext',
    class {
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
      createMediaStreamSource = () => ({ connect: vi.fn() })
      createAnalyser = () => ({
        fftSize: 512,
        getByteTimeDomainData: (data: Uint8Array) => data.fill(136),
      })
    },
  )
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('桌宠按住说话生命周期', () => {
  it('输入栏停止后释放麦克风，处理仍可独立取消', async () => {
    let resolve!: () => void
    const onAudio = vi.fn().mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    const { voice } = setup(onAudio, { releaseAfterCapture: true, discardSilence: false })
    await voice.setMode('ptt')
    voice.pttDown()
    vi.advanceTimersByTime(250)
    voice.pttUp()
    await flushPromises()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(voice.ready.value).toBe(false)
    expect(voice.recognizing.value).toBe(true)
    const signal = onAudio.mock.calls[0]![1] as AbortSignal
    expect(signal.aborted).toBe(false)
    await voice.setMode('off')
    expect(signal.aborted).toBe(true)
    resolve()
    await flushPromises()
    expect(voice.recognizing.value).toBe(false)
  })
  it('输入栏最长两分钟自动停止，静音也允许保留为原音', async () => {
    const { voice, onAudio } = setup(undefined, {
      releaseAfterCapture: true,
      discardSilence: false,
      maxDurationMs: 120000,
    })
    await voice.setMode('ptt')
    voice.pttDown()
    vi.advanceTimersByTime(120000)
    await flushPromises()
    expect(voice.isRecording.value).toBe(false)
    expect(onAudio).toHaveBeenCalledOnce()
    expect(onAudio.mock.calls[0]![0].durationMs).toBe(120000)
    expect(track.stop).toHaveBeenCalledOnce()
  })
  it('麦克风预先准备，松开只提交一次并保留 Recorder 实际格式', async () => {
    const { voice, onAudio } = setup()
    await voice.setMode('ptt')
    expect(voice.ready.value).toBe(true)
    voice.pttDown()
    monitor(0)
    vi.advanceTimersByTime(250)
    voice.pttUp()
    voice.pttUp()
    await flushPromises()
    expect(onAudio).toHaveBeenCalledTimes(1)
    expect(onAudio.mock.calls[0]![0].mimeType).toBe('audio/ogg;codecs=opus')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
  it('短按和明确取消不会发送；模式关闭释放麦克风', async () => {
    const { voice, onAudio } = setup()
    await voice.setMode('ptt')
    voice.pttDown()
    monitor(0)
    vi.advanceTimersByTime(50)
    voice.pttUp()
    voice.pttDown()
    monitor(0)
    vi.advanceTimersByTime(300)
    voice.pttUp(true)
    await voice.setMode('off')
    await flushPromises()
    expect(onAudio).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
    expect(voice.ready.value).toBe(false)
  })
  it('等待权限时关闭语音，迟到的设备流不能重启录音', async () => {
    let resolve!: (value: typeof stream) => void
    getUserMedia.mockImplementation(
      () =>
        new Promise((value) => {
          resolve = value
        }),
    )
    const { voice } = setup()
    const preparing = voice.setMode('ptt')
    await voice.setMode('off')
    resolve(stream)
    await preparing
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(voice.ready.value).toBe(false)
    expect(voice.mode.value).toBe('off')
  })
})
