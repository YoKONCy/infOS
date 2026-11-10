import type { PerceptionSnapshot } from '@infos/shared'
import { randomUUID } from 'node:crypto'

const IMAGE_WAIT_MS = 6000
type PerceptionImage = NonNullable<PerceptionSnapshot['images']>[number]

/** 仅受信任原生端可写；不接入数据库、附件、队列消息或日志。 */
export class PerceptionSnapshotStore {
  private snapshot?: PerceptionSnapshot
  private sequence = 0
  private generation = 0
  private until = 0
  private cursors=new Map<string,number>()
  private demands = new Map<string, {generation: number; expiresAt: number; finish: (image?: PerceptionImage) => void}>()
  pendingImages(): Array<{id: string; generation: number}> {
    return [...this.demands].filter(([, item]) => item.expiresAt > Date.now()).map(([id, item]) => ({id, generation: item.generation}))
  }
  resolveImage(id: string, generation: number, image?: PerceptionImage): void {
    const item = this.demands.get(id)
    if (item) item.finish(item.generation === generation && this.generation === generation && item.expiresAt > Date.now() ? image : undefined)
  }
  requestImage(generation: number, signal?: AbortSignal): Promise<PerceptionImage | undefined> {
    if (signal?.aborted || this.demands.size >= 4 || generation !== this.generation || !this.take()) return Promise.resolve(undefined)
    return new Promise(resolve => {
      const id = randomUUID()
      const finish = (image?: PerceptionImage) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.demands.delete(id); resolve(image)
      }
      const abort = () => finish()
      // 等久了用户就要干等，来不及就先不带图。
      const timer = setTimeout(abort, IMAGE_WAIT_MS)
      this.demands.set(id, {generation, expiresAt: Date.now() + IMAGE_WAIT_MS, finish})
      signal?.addEventListener('abort', abort, {once: true})
    })
  }
  update(sequence: number, generation: number, expiresAt: number, snapshot: PerceptionSnapshot | null): void {
    if (sequence <= this.sequence) return
    if(generation!==this.generation)this.cursors.clear()
    this.sequence = sequence; this.generation = generation
    this.until = Math.min(expiresAt, Date.now() + 12_000)
    this.snapshot = snapshot && snapshot.generation === generation ? structuredClone(snapshot) : undefined
  }
  take(owner?: string): PerceptionSnapshot | undefined {
    if (Date.now() >= this.until || this.snapshot?.generation !== this.generation) { this.snapshot = undefined; return undefined }
    if(!this.snapshot)return undefined
    const snapshot=structuredClone(this.snapshot)
    if(owner&&snapshot.current) {
      const cursor=this.cursors.get(owner)??0
      const events=(snapshot.events??[]).filter(item=>item.id>cursor&&item.at>Date.now()-30*60_000).slice(-4)
      snapshot.text=Array.from([snapshot.current,events.length?`最近：${events.map(item=>item.text).join(' → ')}`:'',snapshot.tail??''].filter(Boolean).join('\n')).slice(0,300).join('')
      this.cursors.delete(owner);this.cursors.set(owner,Math.max(cursor,...(snapshot.events??[]).map(item=>item.id)))
      if(this.cursors.size>128)this.cursors.delete(this.cursors.keys().next().value!)
    }
    return snapshot
  }
  clear(): void { this.snapshot = undefined; this.until = 0; for (const item of this.demands.values()) item.finish() }
}
export const perceptionSnapshots = new PerceptionSnapshotStore()
