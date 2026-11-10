/**
 * @file 收纳框页面发来的动作：按枚举与类型校验后交给 DesktopFences。
 *       页面只能引用项目 ID；只有 `drop`（用户真实拖入的文件）带路径，且只登记为引用、不启动。
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import {
  FENCE_GESTURE_MAX_DELTA,
  FENCE_ICON_SIZES,
  FENCE_LIMITS,
  FENCE_PAGE_ACTIONS,
  FENCE_SORTS,
  isFenceBackgroundOpacity,
  isFenceGesture,
  isFenceItemId,
  type FenceGesture,
  type FenceIconSize,
  type FencePageAction,
  type FenceSort,
} from '../../../../packages/shared/src/desktopFence'
import { fail } from '../../windows/desktopCardModel'
import type { DesktopFences } from './fenceService'

const invalid = (action: string): never =>
  fail('DESKTOP_FENCE_INVALID_ACTION', '收纳框动作无效：{0}', [action])

function readBoolean(action: string, value: unknown): boolean {
  if (typeof value !== 'boolean') invalid(action)
  return value as boolean
}

/** 页面传来的项目 ID 列表：只收登记项 ID（`i-`），路径一律拒绝。 */
function readItemIds(action: string, value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > FENCE_LIMITS.items ||
    !value.every((item) => isFenceItemId(item) && item.startsWith('i-'))
  )
    invalid(action)
  return value as string[]
}

/** 拖入的路径：数量受限，逐个由 DesktopFences 校验格式与是否存在。 */
function readDropped(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > FENCE_LIMITS.items ||
    !value.every((item) => typeof item === 'string')
  )
    invalid('drop')
  return value as string[]
}

/** 手势的累计增量：必须是有限数字且在合理范围内。 */
function readDelta(value: unknown): { dx: number; dy: number } {
  const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const valid = (delta: unknown) =>
    typeof delta === 'number' &&
    Number.isFinite(delta) &&
    Math.abs(delta) <= FENCE_GESTURE_MAX_DELTA
  if (!valid(item.dx) || !valid(item.dy)) invalid('gesture')
  return { dx: item.dx as number, dy: item.dy as number }
}

/** 收纳框页面的窗口手势：`begin`（手势种类）→ 若干 `update`（累计增量）→ `end`（最终增量）。 */
export function runFenceGesture(
  fences: DesktopFences,
  id: string,
  phase: unknown,
  payload: unknown,
): void {
  if (phase === 'begin') {
    if (!isFenceGesture(payload)) invalid('gesture')
    fences.beginGesture(id, payload as FenceGesture)
  } else if (phase === 'update') {
    const { dx, dy } = readDelta(payload)
    fences.updateGesture(id, dx, dy)
  } else if (phase === 'end') {
    const { dx, dy } = readDelta(payload)
    fences.endGesture(id, dx, dy)
  } else invalid('gesture')
}

export async function runFencePageAction(
  fences: DesktopFences,
  id: string,
  action: unknown,
  payload: unknown,
): Promise<unknown> {
  if (!FENCE_PAGE_ACTIONS.includes(action as FencePageAction)) return invalid(String(action))
  switch (action as FencePageAction) {
    case 'launch':
      return fences.launch(id, payload)
    case 'collapse':
      return fences.setCollapsed(id, readBoolean('collapse', payload))
    case 'pin':
      return fences.setPinned(id, readBoolean('pin', payload))
    case 'layer':
      return fences.setLayer(id, readBoolean('layer', payload))
    case 'iconSize':
      if (!FENCE_ICON_SIZES.includes(payload as FenceIconSize)) invalid('iconSize')
      return fences.setIconSize(id, payload as FenceIconSize)
    case 'sort':
      if (!FENCE_SORTS.includes(payload as FenceSort)) invalid('sort')
      return fences.setSort(id, payload as FenceSort)
    case 'backgroundOpacity':
      if (!isFenceBackgroundOpacity(payload)) invalid('backgroundOpacity')
      return fences.setBackgroundOpacity(id, payload as number)
    case 'rename':
      if (typeof payload !== 'string' || !payload.trim()) invalid('rename')
      return fences.rename(id, payload)
    case 'remove':
      return fences.remove(id, readItemIds('remove', payload))
    case 'reorder':
      return fences.reorder(id, readItemIds('reorder', payload))
    case 'drop':
      return fences.add(id, readDropped(payload))
    case 'close':
      return fences.close(id)
  }
}
