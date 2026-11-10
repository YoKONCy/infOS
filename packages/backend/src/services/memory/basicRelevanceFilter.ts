import type { EventNote } from '@infos/shared'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import { passesBasicRelevance, type BasicRelevanceGate } from './automaticRagSelection'

/** 按独立相关证据过滤基础检索候选；一次遍历取出候选向量，保持原排序。 */
export function filterBasicRelevant(
  stores: MemoryStoreRegistry,
  agentId: string,
  query: string,
  ranked: EventNote[],
  gate: BasicRelevanceGate,
): EventNote[] {
  const wanted = new Set(ranked.map((note) => note.id))
  const vectors = new Map<string, ArrayLike<number>>()
  if (gate.queryVector) {
    const store = stores.getAgentStore(agentId, 'main')
    for (const id of store.allNodeIds()) {
      const node = store.get<{ kind?: string; id: string }>(id)
      if (node?.payload?.kind === 'event_note' && wanted.has(node.payload.id))
        vectors.set(node.payload.id, node.vector)
    }
  }
  return ranked.filter((note) => passesBasicRelevance(note, vectors.get(note.id), query, gate))
}
