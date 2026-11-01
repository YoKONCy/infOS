import type { CanvasItem, CanvasEdge } from '../types'
export interface CandidateSet {
  parent: CanvasItem
  items: CanvasItem[]
  primary?: CanvasItem
}

/** 新项目使用显式归属；旧项目可从任务输出与历史来源边恢复候选关系。 */
export function canvasCandidates(
  items: CanvasItem[],
  edges: CanvasEdge[] = [],
): Map<string, CandidateSet> {
  const runs = new Map(
    items.filter((item) => item.content.kind === 'run').map((item) => [item.id, item]),
  )
  const assets = new Map(
    items
      .filter(
        (item) => item.content.kind === 'asset' && item.content.mimeType?.startsWith('image/'),
      )
      .map((item) => [item.id, item]),
  )
  const owners = new Map<string, string>()
  const outputOwners = new Map<string, string>()
  for (const run of runs.values())
    for (const id of run.content.outputIds ?? [])
      outputOwners.set(id, run.content.candidateParentId || run.id)
  for (const edge of edges)
    if (edge.historical && runs.has(edge.source))
      owners.set(edge.target, runs.get(edge.source)!.content.candidateParentId || edge.source)
  const groups = new Map<string, CandidateSet>(),
    index = new Map<string, CandidateSet>()
  const linked = new Set(
    [...assets.values()]
      .filter((item) => item.content.candidateGroupId || owners.has(item.id))
      .map((item) => item.content.assetId),
  )
  const recovered = new Set<string>()
  for (const item of assets.values()) {
    const root =
      item.content.candidateGroupId ||
      owners.get(item.id) ||
      (!linked.has(item.content.assetId) && !recovered.has(item.content.assetId ?? '')
        ? outputOwners.get(item.content.assetId ?? '')
        : undefined)
    const parent = root ? runs.get(root) : undefined
    if (!parent) continue
    if (item.content.assetId) recovered.add(item.content.assetId)
    let group = groups.get(parent.id)
    if (!group) {
      group = { parent, items: [] }
      groups.set(parent.id, group)
    }
    group.items.push(item)
    index.set(item.id, group)
  }
  for (const group of groups.values()) {
    group.primary =
      group.items.find((item) => item.content.assetId === group.parent.content.primaryAssetId) ||
      group.items[0]
    index.set(group.parent.id, group)
  }
  for (const run of runs.values())
    if (run.content.candidateParentId && groups.has(run.content.candidateParentId))
      index.set(run.id, groups.get(run.content.candidateParentId)!)
  return index
}
