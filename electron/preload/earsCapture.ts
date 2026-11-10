/**
 * @file 耳朵的录音页 preload（隐藏窗口，不显示任何界面）。
 *
 * 用 getDisplayMedia 取系统回环声音（主进程的 setDisplayMediaRequestHandler 给 `audio: 'loopback'`），
 * 不开麦克风。画面轨道拿到后立刻停止；声音降到 16 kHz 单声道，每约 0.5 秒交给主进程一块。
 * 页面是 `infos-ears://capture/` 空白页，不加载任何脚本；这里不向页面暴露任何接口。
 *
 * @platform ELECTRON
 * @module electron/preload/earsCapture
 */

import { ipcRenderer } from 'electron'

const SAMPLE_RATE = 16_000
/** 每块的采样数（0.5 秒）。 */
const CHUNK = 8_000

let stream: MediaStream | undefined
let context: AudioContext | undefined

function stop(): void {
  stream?.getTracks().forEach((track) => track.stop())
  void context?.close().catch(() => undefined)
  stream = undefined
  context = undefined
}

async function start(): Promise<void> {
  stop()
  try {
    const media = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    // 只要声音：画面轨道立刻停止，不占用屏幕采集。
    media.getVideoTracks().forEach((track) => track.stop())
    const audio = media.getAudioTracks()
    if (!audio.length) {
      media.getTracks().forEach((track) => track.stop())
      throw new Error('EARS_CAPTURE_NO_AUDIO')
    }
    stream = media
    context = new AudioContext({ sampleRate: SAMPLE_RATE })
    const source = context.createMediaStreamSource(new MediaStream(audio))
    // ScriptProcessor 已不推荐但足够简单；输出不写入，所以接到扬声器也没有声音。
    const node = context.createScriptProcessor(4096, 1, 1)
    let buffer = new Float32Array(CHUNK)
    let filled = 0
    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      let offset = 0
      while (offset < input.length) {
        const count = Math.min(CHUNK - filled, input.length - offset)
        buffer.set(input.subarray(offset, offset + count), filled)
        filled += count
        offset += count
        if (filled === CHUNK) {
          ipcRenderer.send('ears-capture:chunk', { samples: buffer, at: Date.now() })
          buffer = new Float32Array(CHUNK)
          filled = 0
        }
      }
    }
    source.connect(node)
    node.connect(context.destination)
    audio[0]!.addEventListener('ended', () => {
      ipcRenderer.send('ears-capture:state', { state: 'ended' })
    })
    ipcRenderer.send('ears-capture:state', { state: 'started' })
  } catch (error) {
    stop()
    const message = error instanceof Error ? error.message : String(error)
    ipcRenderer.send('ears-capture:state', {
      state: 'failed',
      error: message.startsWith('EARS_') ? message : `EARS_CAPTURE_FAILED: ${message}`,
    })
  }
}

ipcRenderer.on('ears-capture:start', () => void start())
ipcRenderer.on('ears-capture:stop', () => stop())
ipcRenderer.send('ears-capture:state', { state: 'loaded' })
