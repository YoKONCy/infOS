import { AsyncLocalStorage } from 'node:async_hooks'
import type { PerceptionSnapshot } from '@infos/shared'
import type { ChatMessage } from '../llm/types'
import { formatPerceptionContext, PERCEPTION_PROACTIVE_RULES } from '../perception/perceptionPrompts'

const context = new AsyncLocalStorage<{ snapshot: PerceptionSnapshot; proactive: boolean }>()

/** 来源由宿主入口确定，不从模型内容或工具参数读取。 */
export function withPerception<T>(snapshot: PerceptionSnapshot | undefined, proactive: boolean, run: () => T): T {
  return snapshot ? context.run({ snapshot, proactive }, run) : run()
}

/** 主动回合失败的原因：去掉感知原文、压短，才能传给界面和日志。 */
export function perceptionFailure(error: unknown, source?: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`PERCEPTION_TURN_FAILED: ${redactPerceptionText(message, source).replace(/\s+/g, ' ').slice(0, 160)}`)
}

export function perceptionActive(): boolean { return !!context.getStore() }
export function perceptionReadOnly(): boolean { return context.getStore()?.proactive === true }

/** 按 Unicode 字符比较连续片段；命中后一次替换整个最长相同片段。 */
export function redactPerceptionText(value: string, source = context.getStore()?.snapshot.text): string {
  if (!source) return value
  const original = Array.from(source)
  const input = Array.from(value)
  const starts = new Map<string, number[]>()
  for (let i = 0; i + 20 <= original.length; i++) {
    const key = original.slice(i, i + 20).join('')
    const positions = starts.get(key) ?? []
    positions.push(i)
    starts.set(key, positions)
  }
  let result = ''
  for (let i = 0; i < input.length;) {
    const candidates = starts.get(input.slice(i, i + 20).join('')) ?? []
    let length = 0
    for (const start of candidates) {
      let n = 20
      while (start + n < original.length && i + n < input.length && original[start + n] === input[i + n]) n++
      length = Math.max(length, n)
    }
    if (length) { result += '（当时看到的内容）'; i += length }
    else result += input[i++]
  }
  return result
}

/** 工具参数、草稿与调试数据只留下脱敏副本，不修改可见正式回复。 */
export function redactPerception<T>(value: T): T {
  if (!perceptionActive()) return value
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(redactPerception(JSON.parse(value))) as T } catch { /* 非 JSON 正文按连续字符处理。 */ }
    }
    return redactPerceptionText(value) as T
  }
  if (Array.isArray(value)) return value.map((item) => redactPerception(item)) as T
  if (value instanceof Error) {
    // 保留原型和自带字段：AppError 的 code、instanceof 判断都要继续有效。
    const error = Object.assign(Object.create(Object.getPrototypeOf(value)), redactPlain({ ...value })) as Error
    for (const key of ['message', 'stack'] as const)
      if (typeof value[key] === 'string')
        Object.defineProperty(error, key, { value: redactPerceptionText(value[key]), writable: true, configurable: true, enumerable: false })
    return error as T
  }
  return redactPlain(value) as T
}

/** 只递归普通对象：AbortSignal、Buffer、class 实例原样保留，循环引用不重复走。 */
function redactPlain(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const items: unknown[] = []
    seen.set(value, items)
    for (const item of value) items.push(typeof item === 'object' && !(item instanceof Error) ? redactPlain(item, seen) : redactPerception(item))
    return items
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const [key, item] of Object.entries(value)) copy[key] = typeof item === 'object' && !(item instanceof Error) ? redactPlain(item, seen) : redactPerception(item)
  return copy
}

/** 写记忆的工具：只有这些在执行时也替换，其余工具用真实参数执行。 */
export const PERCEPTION_MEMORY_TOOLS = new Set(['write_event_note', 'revise_event_note'])

/** 整条临时输入从审计、重放中删除，包括不足 20 字的标题及媒体。 */
export function omitPerceptionMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.transientSource !== 'perception')
}

/** 扩展只接收持久化视图；临时消息始终由宿主放回，扩展不能修改或复制其正文。 */
export function perceptionHooks<T extends { emitHook<D>(event: string, data: D): Promise<D> }>(hooks: T | undefined): T | undefined {
  if (!hooks || !perceptionActive()) return hooks
  if (perceptionReadOnly()) return undefined
  return new Proxy(hooks, {
    get(target, key) {
      if (key !== 'emitHook') return Reflect.get(target, key)
      return async (event: string, data: Record<string, unknown>) => {
        const messages = Array.isArray(data.messages) ? data.messages as ChatMessage[] : undefined
        const projected = redactPerception({ ...data, ...(messages ? { messages: omitPerceptionMessages(messages) } : {}) })
        const result = await target.emitHook(event, projected)
        if (!result || typeof result !== 'object') return result
        // 钩子没改动的字段还原真实值，否则工具参数会被占位符换掉。
        const restored: Record<string, unknown> = { ...result }
        for (const key of Object.keys(data)) {
          if (key === 'messages') continue
          try { if (JSON.stringify(restored[key]) === JSON.stringify((projected as Record<string, unknown>)[key])) restored[key] = data[key] } catch { /* 无法比较的字段留给钩子的结果。 */ }
        }
        if (!messages) return restored
        const visible = Array.isArray(result.messages) ? result.messages : projected.messages as ChatMessage[]
        let index = 0
        return { ...restored, messages: messages.map(message => message.transientSource === 'perception' ? message : visible[index++] ?? message) }
      }
    },
  })

}

export function perceptionMessage(snapshot: PerceptionSnapshot): ChatMessage {
  if (snapshot.source !== 'perception' || snapshot.text.length > 20_000 || (snapshot.images?.length ?? 0) > 2)
    throw new Error('PERCEPTION_PAYLOAD_INVALID')
  const text = (perceptionReadOnly() && !snapshot.omitProactiveRules ? PERCEPTION_PROACTIVE_RULES + '\n' : '') + formatPerceptionContext([snapshot.text])
  return {
    role: 'user', transientSource: 'perception',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(snapshot.images ?? []).map((image) => {
        if (!['image/png', 'image/jpeg'].includes(image.mimeType) || image.data.length > 4_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image.data))
          throw new Error('PERCEPTION_MEDIA_INVALID')
        return { type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.data}` } }
      }),
    ],
  }
}
