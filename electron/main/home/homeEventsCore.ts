import type { HomeEvent } from '../../../packages/shared/src/home'

export type HomeEventType = HomeEvent['type'] | 'reconnected'
export type HomeEventData<T extends HomeEventType> = T extends 'reconnected'
  ? undefined
  : Extract<HomeEvent, { type: T }>['data']

/** SSE 按行解析，允许 CRLF、分块 UTF-8、多行 data 与注释；限制未完成事件的大小。 */
export class HomeEventParser {
  private buffer = ''
  private event = ''
  private data: string[] = []
  private size = 0
  constructor(private readonly receive: (event: string, data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.search(/[\r\n]/)
      if (end < 0) break
      if (this.buffer[end] === '\r' && end === this.buffer.length - 1) break
      const line = this.buffer.slice(0, end)
      const skip = this.buffer.slice(end, end + 2) === '\r\n' ? 2 : 1
      this.buffer = this.buffer.slice(end + skip)
      this.line(line)
    }
    if (this.buffer.length + this.size > 2 * 1024 * 1024) throw new Error('HOME_EVENT_TOO_LARGE')
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) this.receive(this.event || 'message', this.data.join('\n'))
      this.event = ''
      this.data = []
      this.size = 0
      return
    }
    this.size += line.length
    if (this.size > 2 * 1024 * 1024) throw new Error('HOME_EVENT_TOO_LARGE')
    const colon = line.indexOf(':')
    const key = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (key === 'event') this.event = value
    if (key === 'data') this.data.push(value)
  }
}

export interface HomeEventsDependencies {
  origin(): string
  credential(): string
  request: typeof fetch
}

/** 连接生命周期独立于 Electron，便于验证断流、取消与切换后端。 */
export class HomeEventsClient {
  private handlers = new Map<HomeEventType, Set<(data: never) => void>>()
  private controller?: AbortController
  private retry?: ReturnType<typeof setTimeout>
  private watch?: ReturnType<typeof setInterval>
  private running = false
  private connected = false
  private failures = 0
  private selected = ''

  constructor(private readonly dependencies: HomeEventsDependencies) {}

  on<T extends HomeEventType>(type: T, handler: (data: HomeEventData<T>) => void): () => void {
    const entries = this.handlers.get(type) ?? new Set()
    entries.add(handler as (data: never) => void)
    this.handlers.set(type, entries)
    return () => {
      entries.delete(handler as (data: never) => void)
      if (!entries.size) this.handlers.delete(type)
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.connect()
    this.watch = setInterval(() => {
      if (this.selected === this.identity()) return
      clearTimeout(this.retry)
      this.failures = 0
      this.controller?.abort()
      void this.connect()
    }, 1000)
    this.watch.unref?.()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.retry)
    clearInterval(this.watch)
    this.controller?.abort()
    this.controller = undefined
    this.connected = false
    this.failures = 0
  }

  private identity(): string {
    return `${this.dependencies.origin()}\n${this.dependencies.credential()}`
  }

  private emit(type: HomeEventType, data: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      try {
        handler(data as never)
      } catch {
        // 一个订阅者出错不能中断连接或阻止其他订阅者。
      }
    }
  }

  private receive(event: string, raw: string): void {
    if (event === 'ready') {
      this.failures = 0
      if (this.connected) this.emit('reconnected', undefined)
      this.connected = true
      return
    }
    if (event !== 'home') return
    try {
      const item = JSON.parse(raw) as HomeEvent
      if (!item || !['activity', 'confirmation', 'card-data', 'card-message'].includes(item.type))
        return
      if (!item.data || typeof item.data !== 'object') return
      this.emit(item.type, item.data)
    } catch {
      // 丢弃单条坏事件，后续事件仍正常消费。
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return
    const controller = new AbortController()
    this.controller = controller
    this.selected = this.identity()
    const token = this.dependencies.credential()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await this.dependencies.request(
        `${this.dependencies.origin()}/api/home/events`,
        {
          headers: {
            Accept: 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          redirect: 'error',
          signal: controller.signal,
        },
      )
      clearTimeout(timeout)
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      )
        throw new Error('HOME_EVENTS_UNAVAILABLE')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new HomeEventParser((event, data) => {
        if (!controller.signal.aborted && this.controller === controller) this.receive(event, data)
      })
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }
    } catch {
      // 网络、凭据或后端尚未就绪时统一退避，下一次连接重新读取当前配置。
    } finally {
      clearTimeout(timeout)
      await reader?.cancel().catch(() => undefined)
      reader?.releaseLock()
      if (this.running && this.controller === controller) {
        const delay = Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6))
        this.retry = setTimeout(() => void this.connect(), delay)
        this.retry.unref?.()
      }
    }
  }
}
