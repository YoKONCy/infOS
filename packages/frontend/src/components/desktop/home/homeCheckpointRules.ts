import type { HomeCheckpoint } from '@infos/shared'

/**
 * 会话改动清单里每条检查点能做什么：
 * - applied 可以单条撤回；
 * - pending 必须先核对（reconcile），核对前不能撤回，也挡住「一键全撤」；
 * - expired（备份已清理）、undone、failed 都不画撤回按钮。
 */
export function checkpointAbilities(checkpoint: Pick<HomeCheckpoint, 'state'>): {
  undo: boolean
  reconcile: boolean
} {
  return { undo: checkpoint.state === 'applied', reconcile: checkpoint.state === 'pending' }
}

export function undoAllState(checkpoints: Array<Pick<HomeCheckpoint, 'state'>>): {
  enabled: boolean
  blockedByPending: boolean
} {
  const blockedByPending = checkpoints.some((row) => row.state === 'pending')
  return {
    enabled: !blockedByPending && checkpoints.some((row) => row.state === 'applied'),
    blockedByPending,
  }
}

/** 一条检查点涉及的路径（移动时含源和目标），去重并保持顺序。 */
export function checkpointPaths(checkpoint: Pick<HomeCheckpoint, 'before' | 'after'>): string[] {
  return [...new Set([...checkpoint.before, ...checkpoint.after].map((snapshot) => snapshot.path))]
}
