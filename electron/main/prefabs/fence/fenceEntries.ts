/**
 * @file 收纳框的项目解析：登记项与映射文件夹的子项 → 带 ID 的条目。
 *       页面只拿到 ID、显示名与类型；路径只留在主进程，启动时按 ID 反查。
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  FENCE_LIMITS,
  fenceDisplayName,
  fenceItemKind,
  fencePathKey,
  normalizeFencePath,
  sortFenceView,
  type FenceState,
  type FenceViewItem,
} from '../../../../packages/shared/src/desktopFence'
import { isFenceDragBlocked, isFenceHiddenName } from './fenceDrag'
import { isThumbnailTarget } from './fenceIcons'

/** 主进程读取文件系统的最小接口；测试中替换。只读，不写、不删用户文件。 */
export interface FenceFileSystem {
  stat(target: string): { isDirectory: boolean; mtimeMs: number; size: number } | null
  /** 文件夹的直接子项名称；读不到时返回空数组。 */
  readDir(folder: string): string[]
  /** 文件是否带隐藏属性（Windows）；不支持时可以不提供。 */
  isHidden?(target: string): boolean
  /** 文件是否带系统属性（Windows）；不支持时可以不提供。 */
  isSystem?(target: string): boolean
}

export interface FenceEntry extends FenceViewItem {
  path: string
}

/** 映射文件夹子项的 ID：按名称（不区分大小写）计算，文件夹内容变化后仍稳定。 */
export function folderItemId(name: string): string {
  return `f-${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 12)}`
}

function entryOf(
  target: string,
  id: string,
  fromFolder: boolean,
  files: FenceFileSystem,
): FenceEntry {
  const stat = files.stat(target)
  const isDirectory = stat?.isDirectory ?? false
  return {
    id,
    path: target,
    name: fenceDisplayName(target, isDirectory),
    kind: fenceItemKind(target, isDirectory),
    missing: stat === null,
    fromFolder,
    iconVersion: stat ? `${stat.mtimeMs}-${stat.size}` : 'missing',
    thumbnail: !!stat && !isDirectory && isThumbnailTarget(target),
    dragOut: !!stat && !isFenceDragBlocked(target, files),
  }
}

/**
 * 映射文件夹的子项，最多 FENCE_LIMITS.folderEntries 项。不显示：系统文件、Office 临时文件、
 * 点开头的文件（比如 `.trashed-...` 残留），以及带 Windows 隐藏属性的文件。
 * 先过滤再计数，隐藏文件不占名额。
 */
export function folderEntries(folder: string, files: FenceFileSystem): FenceEntry[] {
  // 盘符路径按 Windows 规则拼接，其余按 POSIX（非 Windows 开发环境）。
  const join = /^[A-Za-z]:\\/.test(folder) ? path.win32.join : path.posix.join
  const entries: FenceEntry[] = []
  for (const name of files.readDir(folder)) {
    if (isFenceHiddenName(name)) continue
    const target = normalizeFencePath(join(folder, name))
    if (!target || files.isHidden?.(target)) continue
    entries.push(entryOf(target, folderItemId(name), true, files))
    if (entries.length >= FENCE_LIMITS.folderEntries) break
  }
  return entries
}

/**
 * 框里当前的全部条目：先登记项（按登记顺序），再映射文件夹的子项；同一路径只出现一次。
 * 按框的排序方式排列（手动时登记项保持顺序，文件夹子项按名称排在后面）。
 */
export function resolveFenceEntries(state: FenceState, files: FenceFileSystem): FenceEntry[] {
  const registered = state.items.map((item) => entryOf(item.path, item.id, false, files))
  const seen = new Set(registered.map((entry) => fencePathKey(entry.path)))
  const mapped = state.folder
    ? sortFenceView(
        folderEntries(state.folder, files).filter((entry) => !seen.has(fencePathKey(entry.path))),
        'name',
      )
    : []
  return state.sort === 'manual'
    ? [...registered, ...mapped]
    : sortFenceView([...registered, ...mapped], state.sort)
}

/** 页面视图的条目：去掉路径。 */
export function viewItems(entries: readonly FenceEntry[]): FenceViewItem[] {
  return entries.map(({ path: _path, ...item }) => item)
}
