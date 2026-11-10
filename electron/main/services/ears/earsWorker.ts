/**
 * @file 耳朵的识别进程（Electron utilityProcess 入口，单独打包成 `earsWorker.js`）。
 *
 * 原生模块 sherpa-onnx-node 只在这个进程里加载：识别一段话要上百毫秒的 CPU，放在主进程会卡界面；
 * 原生模块崩溃也只会带走这个进程，主进程收到退出后报告「耳朵已停止」。
 *
 * 消息（主进程 → 这里）：init { paths, language } / audio { samples, at } / flush / stop
 * 消息（这里 → 主进程）：ready / line { text, start, end } / error { error }
 *
 * @platform ELECTRON
 */

import { EarsEngine, type EarsModelPaths, type SherpaModule } from './earsEngine'

export type EarsWorkerRequest =
  | { type: 'init'; paths: EarsModelPaths; language: string }
  | { type: 'audio'; samples: Float32Array; at: number }
  | { type: 'flush' }
  | { type: 'stop' }

export type EarsWorkerEvent =
  | { type: 'ready' }
  | { type: 'line'; text: string; start: number; end: number }
  | { type: 'error'; error: string }

const port = process.parentPort
let engine: EarsEngine | undefined

function send(event: EarsWorkerEvent): void {
  port.postMessage(event)
}

function deliver(lines: Array<{ text: string; start: number; end: number }>): void {
  for (const line of lines) send({ type: 'line', ...line })
}

port.on('message', (event: { data: EarsWorkerRequest }) => {
  const message = event.data
  try {
    if (message.type === 'init') {
      let sherpa: SherpaModule
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        sherpa = require('sherpa-onnx-node') as SherpaModule
      } catch (error) {
        throw new Error(
          `EARS_NATIVE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      engine = new EarsEngine(sherpa, message.paths, message.language)
      send({ type: 'ready' })
    } else if (message.type === 'audio') {
      if (engine) deliver(engine.accept(new Float32Array(message.samples), message.at))
    } else if (message.type === 'flush') {
      if (engine) deliver(engine.flush())
    } else if (message.type === 'stop') {
      if (engine) deliver(engine.flush())
      process.exit(0)
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    send({ type: 'error', error: text.startsWith('EARS_') ? text : `EARS_ENGINE_FAILED: ${text}` })
  }
})
