import { shallowRef } from 'vue'
import type { CodeSearchNavigation } from '@infos/shared'

export interface WorkspaceSearchRequest extends CodeSearchNavigation {
  file: string
  line?: number
  column?: number
  revision: number
}

/** 工作区延迟挂载和缓存恢复时仍能消费文件跳转。 */
const pending = shallowRef<WorkspaceSearchRequest | null>(null)
export function requestWorkspaceSearchFile(input: Omit<WorkspaceSearchRequest, 'revision'>): void {
  pending.value = { ...input, revision: (pending.value?.revision ?? 0) + 1 }
}
export function useWorkspaceSearchNavigation() {
  return pending
}
