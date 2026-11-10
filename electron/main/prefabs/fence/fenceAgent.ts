/**
 * @file Agent 整理收纳框（外壳能力 `prefab` 操作，kind 为 fence）。
 *
 *       - 身份只认后端从工具运行上下文注入的 `__homeScope`（模型参数里的同名字段已被后端丢弃并覆盖）；
 *         没有可信身份的调用一律拒绝。
 *       - 能做：列出框、读桌面快捷方式、新建、改名 / 折叠 / 置顶 / 图标大小 / 排序 / 背景透明度 / 映射文件夹、
 *         加入或移出项目（路径引用）、重新排列、把多个框排成一组、删除框（不碰文件）。
 *       - 不能做：启动框里的程序（走现有的桌面动作授权）、隐藏桌面原图标（只能由用户在界面上操作）。
 *
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import {
  FENCE_ICON_SIZES,
  FENCE_LAYOUTS,
  FENCE_LIMITS,
  FENCE_SORTS,
  isFenceBackgroundOpacity,
  type FenceCreator,
  type FenceIconSize,
  type FenceLayout,
  type FenceSort,
} from '../../../../packages/shared/src/desktopFence'
import { isDesktopCardId } from '../../../../packages/shared/src/desktopCards'
import { fail } from '../../windows/desktopCardModel'
import type { DesktopFences } from './fenceService'

export const FENCE_AGENT_ACTIONS = [
  'list',
  'desktop',
  'create',
  'update',
  'add',
  'remove',
  'reorder',
  'arrange',
  'delete',
] as const
type FenceAgentAction = (typeof FENCE_AGENT_ACTIONS)[number]

/** 桌面上的条目（只读列出，供 Agent 分组）。 */
export type DesktopEntriesReader = () => {
  path: string
  name: string
  kind: string
  location: 'user' | 'public'
}[]

const invalid = (field: string): never =>
  fail('DESKTOP_FENCE_INVALID_ARGUMENT', '收纳框参数无效：{0}', [field])

/** 宿主注入的身份：必须是非空的 agentId 与 sessionId。 */
export function readFenceCreator(value: unknown): FenceCreator {
  const scope = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  if (
    typeof scope.agentId !== 'string' ||
    !scope.agentId ||
    typeof scope.sessionId !== 'string' ||
    !scope.sessionId
  )
    fail('DESKTOP_PREFAB_SCOPE_REQUIRED', '缺少可信的调用身份，不能整理收纳框')
  return { kind: 'agent', agentId: scope.agentId as string, sessionId: scope.sessionId as string }
}

function readId(value: unknown, field = 'fenceId'): string {
  if (!isDesktopCardId(value)) invalid(field)
  return value as string
}

function readPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > FENCE_LIMITS.items ||
    !value.every((item) => typeof item === 'string')
  )
    invalid('paths')
  return value as string[]
}

function optional<T>(args: Record<string, unknown>, key: string, check: (v: unknown) => boolean) {
  const value = args[key]
  if (value === undefined) return undefined
  if (!check(value)) invalid(key)
  return value as T
}

const isBoolean = (value: unknown) => typeof value === 'boolean'
const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

function readBounds(args: Record<string, unknown>): Record<string, number> | undefined {
  const bounds: Record<string, number> = {}
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = optional<number>(args, key, isNumber)
    if (value !== undefined) bounds[key] = value
  }
  if ((bounds.x === undefined) !== (bounds.y === undefined)) invalid('x/y')
  return Object.keys(bounds).length ? bounds : undefined
}

export async function runFenceAgent(
  fences: DesktopFences,
  args: Record<string, unknown>,
  desktop: DesktopEntriesReader,
): Promise<Record<string, unknown>> {
  const action = args.action as FenceAgentAction
  if (!FENCE_AGENT_ACTIONS.includes(action)) invalid('action')
  // 所有操作都要可信身份：即使只读，也只接受后端代表某个会话发起的调用。
  const creator = readFenceCreator(args.__homeScope)
  if (action === 'list') return { fences: fences.list() }
  if (action === 'desktop') return { entries: desktop() }
  const iconSize = optional<FenceIconSize>(args, 'iconSize', (v) =>
    FENCE_ICON_SIZES.includes(v as FenceIconSize),
  )
  const sort = optional<FenceSort>(args, 'sort', (v) => FENCE_SORTS.includes(v as FenceSort))
  const backgroundOpacity = optional<number>(args, 'backgroundOpacity', isFenceBackgroundOpacity)
  if (action === 'create') {
    if (typeof args.title !== 'string' || !args.title.trim()) invalid('title')
    const bounds = readBounds(args)
    const folder = optional<string>(args, 'folder', (v) => typeof v === 'string')
    const alwaysOnTop = optional<boolean>(args, 'alwaysOnTop', isBoolean)
    const collapsed = optional<boolean>(args, 'collapsed', isBoolean)
    const { card, skipped } = fences.create({
      title: args.title as string,
      ...(bounds ? { bounds } : {}),
      items: args.paths === undefined ? [] : readPaths(args.paths),
      ...(folder !== undefined ? { folder } : {}),
      ...(alwaysOnTop !== undefined ? { alwaysOnTop } : {}),
      ...(collapsed !== undefined ? { collapsed } : {}),
      ...(iconSize ? { iconSize } : {}),
      ...(sort ? { sort } : {}),
      ...(backgroundOpacity !== undefined ? { backgroundOpacity } : {}),
      createdBy: creator,
    })
    return { changed: true, fence: fences.summary(card.id), skipped }
  }
  if (action === 'arrange') {
    const ids = args.fenceIds
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) invalid('fenceIds')
    const layout = (args.layout ?? 'column') as FenceLayout
    if (!FENCE_LAYOUTS.includes(layout)) invalid('layout')
    const x = optional<number>(args, 'x', isNumber)
    const y = optional<number>(args, 'y', isNumber)
    if ((x === undefined) !== (y === undefined)) invalid('x/y')
    const gap = optional<number>(args, 'gap', (v) => isNumber(v) && (v as number) >= 0)
    const columns = optional<number>(args, 'columns', (v) => isNumber(v) && (v as number) >= 1)
    const result = fences.arrange(
      (ids as unknown[]).map((id) => readId(id, 'fenceIds')),
      layout,
      x === undefined ? undefined : { x, y: y! },
      gap,
      columns,
    )
    return { changed: result.placed.length > 0, ...result }
  }
  const id = readId(args.fenceId)
  const before = fences.summary(id)
  switch (action) {
    case 'update': {
      const title = optional<string>(args, 'title', (v) => typeof v === 'string' && !!v.trim())
      const collapsed = optional<boolean>(args, 'collapsed', isBoolean)
      const alwaysOnTop = optional<boolean>(args, 'alwaysOnTop', isBoolean)
      const folder = optional<string | null>(
        args,
        'folder',
        (v) => v === null || typeof v === 'string',
      )
      if (
        [title, collapsed, alwaysOnTop, folder, iconSize, sort, backgroundOpacity].every(
          (v) => v === undefined,
        )
      )
        invalid('update')
      if (title !== undefined) fences.rename(id, title)
      if (collapsed !== undefined) fences.setCollapsed(id, collapsed)
      if (alwaysOnTop !== undefined) fences.setPinned(id, alwaysOnTop)
      if (folder !== undefined) fences.setFolder(id, folder)
      if (iconSize) fences.setIconSize(id, iconSize)
      if (sort) fences.setSort(id, sort)
      if (backgroundOpacity !== undefined) fences.setBackgroundOpacity(id, backgroundOpacity)
      break
    }
    case 'add':
      return { changed: true, ...fences.add(id, readPaths(args.paths)), fence: fences.summary(id) }
    case 'remove':
      return {
        changed: true,
        removed: fences.remove(id, readPaths(args.paths)),
        fence: fences.summary(id),
      }
    case 'reorder':
      fences.reorder(id, readPaths(args.paths))
      break
    case 'delete':
      fences.delete(id)
      return { changed: true, deleted: true, previous: before }
  }
  return { changed: true, fence: fences.summary(id), previous: before }
}
