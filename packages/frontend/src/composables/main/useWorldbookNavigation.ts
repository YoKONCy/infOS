import { shallowRef } from 'vue'

/** 角色档案跳转到「提示词 → 世界书」时携带的目标；页面异步挂载后仍能接续。 */
export interface WorldbookNavigationTarget {
  /** 要打开的世界书；为空时只打开世界书模块。 */
  bookId: string | null
  /** 发起跳转的角色，用于在世界书模块中提示绑定关系。 */
  agentId: string | null
  revision: number
}

const pending = shallowRef<WorldbookNavigationTarget | null>(null)
let revision = 0

/** 同一本书可重复打开，每次请求均拥有独立序号。 */
export function requestWorldbookNavigation(bookId: string | null, agentId: string | null): void {
  revision = Math.max(revision + 1, (pending.value?.revision ?? 0) + 1)
  pending.value = { bookId, agentId, revision }
}

export function useWorldbookNavigation() {
  return pending
}
