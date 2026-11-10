/**
 * @file 桥接请求的「迟到回音」与临时文件登记（从 windowsDesktop.ts 原样挪出，减少合并上游时的冲突）。
 *
 * - 超时被放弃的请求：编号 → 放弃时间，迟到的回音直接丢弃；
 * - 视觉工作线程：已回过错误但原生线程还未退出，不能被普通请求回音误清除；
 * - 请求附带的临时文件：请求结束（或线程退出）后删除；
 * - 看门狗：被放弃的请求长时间没有回音，说明执行线程卡死，回收桥接进程。
 *
 * @platform WINDOWS
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { bridgeTemporaryFile, removeBridgeTemporaryFile } from './desktopBridgeFiles'
import { HUNG_BRIDGE_MS } from './windowsDesktopProtocol'

export class BridgeLateReplies {
  /** 超时后被放弃、仍在等回音的请求：编号 → 放弃时间。迟到的回音直接丢弃。 */
  private readonly abandoned = new Map<string, number>()
  /** 已回过错误但原生工作线程还未退出，不能被普通请求回音误清除。 */
  private readonly visionWorkers = new Map<string, number>()
  private readonly temporaryFiles = new Map<string, string>()
  private watchdog?: ReturnType<typeof setInterval>

  /** @param current 当前的桥接进程（看门狗只回收仍是当前进程的那一个）。 */
  constructor(private readonly current: () => ChildProcessWithoutNullStreams | undefined) {}

  private cleanupTemporary(id: string): void {
    const file = this.temporaryFiles.get(id)
    if (file && removeBridgeTemporaryFile(file)) this.temporaryFiles.delete(id)
  }

  /** 发出请求前登记它附带的临时文件。 */
  track(id: string, operation: string, input: Record<string, unknown>): void {
    const temporary = bridgeTemporaryFile(operation, input)
    if (temporary) this.temporaryFiles.set(id, temporary)
  }

  /** 视觉工作线程的状态消息；是这类消息时返回 true（调用方不再往下处理）。 */
  visionMessage(
    message: { visionId?: string; visionWorker?: 'abandoned' | 'finished' },
    child: ChildProcessWithoutNullStreams,
  ): boolean {
    if (!(message.visionId && message.visionWorker)) return false
    if (message.visionWorker === 'abandoned') {
      this.visionWorkers.set(message.visionId, Date.now())
      this.watchHung(child)
    } else {
      this.visionWorkers.delete(message.visionId)
      this.cleanupTemporary(message.visionId)
    }
    return true
  }

  /** 已放弃请求的迟到回音：清理后返回 true，调用方直接丢弃。 */
  late(id: string): boolean {
    if (!this.abandoned.delete(id)) return false
    if (!this.visionWorkers.has(id)) this.cleanupTemporary(id)
    return true
  }

  /** 请求正常回音：普通请求不再保留临时文件登记。 */
  settled(id: string): void {
    if (!this.visionWorkers.has(id)) this.temporaryFiles.delete(id)
  }

  /** 请求超时被放弃：记下时间并启动看门狗。 */
  abandon(id: string, child: ChildProcessWithoutNullStreams): void {
    this.abandoned.set(id, Date.now())
    this.watchHung(child)
  }

  /** 桥接进程退出：清空登记、删除临时文件、停止看门狗。 */
  reset(): void {
    this.abandoned.clear()
    this.visionWorkers.clear()
    for (const id of this.temporaryFiles.keys()) this.cleanupTemporary(id)
    clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  /** 被放弃的请求长时间没有回音：执行线程卡死（例如 UIA 提供者无响应），回收桥接进程。 */
  private watchHung(child: ChildProcessWithoutNullStreams): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (this.current() !== child || (!this.abandoned.size && !this.visionWorkers.size)) {
        clearInterval(this.watchdog)
        this.watchdog = undefined
        return
      }
      const oldest = Math.min(...this.abandoned.values(), ...this.visionWorkers.values())
      if (Date.now() - oldest < HUNG_BRIDGE_MS) return
      clearInterval(this.watchdog)
      this.watchdog = undefined
      child.stdin.end()
      child.kill()
    }, 5_000)
    this.watchdog.unref?.()
  }
}
