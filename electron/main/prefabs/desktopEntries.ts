/**
 * @file 读取桌面上有哪些图标（用户桌面与公共桌面），供 Agent 分组整理收纳框。
 *       只读列出名称与路径，不打开、不移动任何文件；与「看随便看」的只读观察一致。
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import path from 'node:path'
import {
  FENCE_LIMITS,
  fenceDisplayName,
  fenceItemKind,
  normalizeFencePath,
} from '../../../packages/shared/src/desktopFence'
import type { FenceFileSystem } from './fence/fenceEntries'

export interface DesktopEntry {
  path: string
  name: string
  kind: string
  location: 'user' | 'public'
}

const HIDDEN = new Set(['desktop.ini', 'thumbs.db'])

/** 列出桌面文件夹的直接子项；同名路径只保留一次，最多 FENCE_LIMITS.folderEntries 项。 */
export function listDesktopEntries(
  folders: readonly { dir: string; location: DesktopEntry['location'] }[],
  files: FenceFileSystem,
): DesktopEntry[] {
  const entries: DesktopEntry[] = []
  const seen = new Set<string>()
  for (const { dir, location } of folders) {
    const join = /^[A-Za-z]:\\/.test(dir) ? path.win32.join : path.posix.join
    for (const name of files.readDir(dir)) {
      if (HIDDEN.has(name.toLowerCase()) || name.startsWith('~$')) continue
      const target = normalizeFencePath(join(dir, name))
      if (!target || seen.has(target.toLowerCase())) continue
      const isDirectory = files.stat(target)?.isDirectory ?? false
      seen.add(target.toLowerCase())
      entries.push({
        path: target,
        name: fenceDisplayName(target, isDirectory),
        kind: fenceItemKind(target, isDirectory),
        location,
      })
      if (entries.length >= FENCE_LIMITS.folderEntries) return entries
    }
  }
  return entries
}
