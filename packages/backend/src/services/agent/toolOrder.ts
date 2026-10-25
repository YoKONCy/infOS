/**
 * toolOrder — 发给模型的工具排序
 *
 * 常驻工具在前、动态工具（子应用工具等）在后，各层内部仍按函数名确定性排序。
 * 动态工具随子应用上下线时只改动工具列表尾部，常驻工具前缀不变，减少提示词缓存失效。
 *
 * @module packages/backend/src/services/agent/toolOrder
 */

let isDynamicTool: (name: string) => boolean = () => false

/** 装配根注入动态工具判定；未注入时（如独立子应用进程）全部按常驻工具排序。 */
export function setDynamicToolPredicate(predicate: (name: string) => boolean): () => void {
  isDynamicTool = predicate
  return () => {
    if (isDynamicTool === predicate) isDynamicTool = () => false
  }
}

export function compareToolNames(a: string, b: string): number {
  const tier = Number(isDynamicTool(a)) - Number(isDynamicTool(b))
  if (tier) return tier
  return a < b ? -1 : a > b ? 1 : 0
}
