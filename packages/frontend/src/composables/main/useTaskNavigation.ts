import { shallowRef } from 'vue'

/** 任务页异步挂载后仍能接续桌宠发来的详情跳转。 */
const pending = shallowRef<{ taskId: string; revision: number } | null>(null)
let revision = 0

/** 同一任务可重复打开，每次请求均拥有独立序号。 */
export function requestTaskNavigation(taskId: string): void {
  revision = Math.max(revision + 1, (pending.value?.revision ?? 0) + 1)
  pending.value = { taskId, revision }
}
export function useTaskNavigation() {
  return pending
}
