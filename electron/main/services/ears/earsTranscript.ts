/**
 * @file 耳朵听到的台词：带时间戳的滚动列表（内存里，有上限），按调用方记游标。
 *
 * - takeNew(owner)：返回这个调用方上次取过之后的新台词，每句只给一次；
 * - range(from, to)：按时间段查询，只看不动游标；
 * - 上限：最多 MAX_LINES 句、最久 MAX_AGE_MS，超出的从最旧的开始丢。
 *
 * @platform ELECTRON
 */

import { filterPerceptionText } from '../home/perceptionFilter'
export const MAX_LINES = 400
export const MAX_AGE_MS = 2 * 60 * 60_000
/** 一次最多交付多少句（一次性堆太多会挤占上下文）；多出的下次再给。 */
export const MAX_TAKE = 60

export interface HeardLine {
  id: number
  /** 墙钟毫秒。 */
  start: number
  end: number
  text: string
  target?: { windowId: string; processGeneration: string }
}

export class Transcript {
  private lines: HeardLine[] = []
  private nextId = 1
  private readonly cursors = new Map<string, number>()
  private readonly retries = new Map<string, Set<number>>()

  constructor(private readonly now: () => number = Date.now) {}

  add(line: Omit<HeardLine, 'id'>): HeardLine {
    const item = { ...line, text: filterPerceptionText(line.text), id: this.nextId++ }
    this.lines.push(item)
    this.prune()
    return item
  }

  private prune(): void {
    const oldest = this.now() - MAX_AGE_MS
    let drop = Math.max(0, this.lines.length - MAX_LINES)
    while (drop < this.lines.length && this.lines[drop]!.end < oldest) drop++
    if (drop) this.lines.splice(0, drop)
    const retained = new Set(this.lines.map((line) => line.id))
    for (const ids of this.retries.values())
      for (const id of ids) if (!retained.has(id)) ids.delete(id)
  }

  /** 新调用方从「现在」开始，不把开始之前的旧台词塞给它。 */
  begin(owner: string): void {
    if (!this.cursors.has(owner)) this.cursors.set(owner, this.nextId - 1)
  }

  forget(owner: string): void {
    this.cursors.delete(owner)
    this.retries.delete(owner)
  }

  /** 上次到这次之间的新台词，每句只给一次；没登记过的调用方返回空。 */
  takeNew(owner: string): { lines: HeardLine[]; more: boolean } {
    const cursor = this.cursors.get(owner)
    if (cursor === undefined) return { lines: [], more: false }
    this.prune()
    const retry = this.retries.get(owner)
    const fresh = this.lines.filter((line) => line.id > cursor || retry?.has(line.id))
    const lines = fresh.slice(0, MAX_TAKE)
    for (const line of lines) retry?.delete(line.id)
    if (lines.length) this.cursors.set(owner, Math.max(cursor, lines.at(-1)!.id))
    return { lines, more: fresh.length > lines.length }
  }

  /** 当前游标（陪看插话没能执行时用它退回，台词留到下次）。 */
  cursor(owner: string): number | undefined {
    return this.cursors.get(owner)
  }

  rewind(owner: string, cursor: number, through = this.cursors.get(owner)): void {
    if (!this.cursors.has(owner) || through === undefined) return
    this.prune()
    const retry = this.retries.get(owner) ?? new Set<number>()
    for (const line of this.lines) if (line.id > cursor && line.id <= through) retry.add(line.id)
    this.retries.set(owner, retry)
  }

  /** 是否有这个调用方还没取过的新台词（不动游标）。 */
  pending(owner: string): number {
    this.prune()
    const cursor = this.cursors.get(owner)
    return cursor === undefined
      ? 0
      : this.lines.filter((line) => line.id > cursor || this.retries.get(owner)?.has(line.id))
          .length
  }

  /** 按时间段查询（与时间段有重叠的句子），只看不动游标；不会返回未来的内容。 */
  range(from: number, to: number): HeardLine[] {
    this.prune()
    const until = Math.min(to, this.now())
    return this.lines.filter((line) => line.end >= from && line.start <= until)
  }

  get size(): number {
    return this.lines.length
  }

  clear(): void {
    this.lines = []
    this.cursors.clear()
    this.retries.clear()
  }
}

/** 给模型看的紧凑格式：一行一句，`[时:分:秒] 台词`（本地时间）。 */
export function formatLines(lines: HeardLine[]): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return lines
    .map((line) => {
      const time = new Date(line.start)
      return `[${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}] ${line.text}`
    })
    .join('\n')
}
