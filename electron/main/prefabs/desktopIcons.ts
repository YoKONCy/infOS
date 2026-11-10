/**
 * @file 隐藏桌面原图标（可选，默认关闭，可一键恢复）。
 *
 *       做法与资源管理器桌面右键「查看 → 显示桌面图标」相同：向桌面的 SHELLDLL_DefView 发送
 *       WM_COMMAND 0x7402，由资源管理器自己切换并写入 HideIcons 设置；再次发送即恢复，完全可还原。
 *       不直接改注册表，也不移动任何图标或文件。
 *
 *       另记下「是否由 infOS 隐藏」，卡片页据此提示；用户点「恢复」时无论是谁隐藏的都显示回来。
 *       这是改系统设置，只能由用户在卡片页操作，不开放给 Agent 工具。
 *
 * @platform ELECTRON (Windows)
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { DesktopIconsState } from '../../../packages/shared/src/desktopPrefabs'
import { isZeroHandle, type Handle, type PrefabNative } from './prefabNative'

const WM_COMMAND = 0x0111
/** 资源管理器桌面菜单「显示桌面图标」的命令 ID。 */
export const TOGGLE_DESKTOP_ICONS = 0x7402

/** 「是否由 infOS 隐藏」的持久化（Electron 用户数据目录下的小文件）。 */
export interface DesktopIconsMemory {
  read(): boolean
  write(hiddenByInfos: boolean): void
}

export class DesktopIcons {
  constructor(
    private readonly native: () => PrefabNative | null,
    private readonly memory: DesktopIconsMemory,
  ) {}

  /** 桌面图标所在的 SHELLDLL_DefView：通常在 Progman 下，切换过壁纸后可能在某个 WorkerW 下。 */
  private defView(api: PrefabNative): Handle {
    const progman = api.findWindow('Progman', null)
    if (!isZeroHandle(progman)) {
      const view = api.findWindowEx(progman, 0, 'SHELLDLL_DefView', null)
      if (!isZeroHandle(view)) return view
    }
    let worker: Handle = 0
    for (let index = 0; index < 64; index += 1) {
      worker = api.findWindowEx(0, worker, 'WorkerW', null)
      if (isZeroHandle(worker)) break
      const view = api.findWindowEx(worker, 0, 'SHELLDLL_DefView', null)
      if (!isZeroHandle(view)) return view
    }
    return 0
  }

  private locate(): { api: PrefabNative; view: Handle; list: Handle } | null {
    const api = this.native()
    if (!api) return null
    const view = this.defView(api)
    if (isZeroHandle(view)) return null
    const list = api.findWindowEx(view, 0, 'SysListView32', 'FolderView')
    return isZeroHandle(list) ? null : { api, view, list }
  }

  state(): DesktopIconsState {
    const found = this.locate()
    if (!found) return { supported: false, hidden: false, hiddenByInfos: false }
    const hidden = !found.api.isWindowVisible(found.list)
    // 用户在别处把图标显示回来了：infOS 的隐藏已不再生效。
    const hiddenByInfos = hidden && this.memory.read()
    if (!hidden && this.memory.read()) this.memory.write(false)
    return { supported: true, hidden, hiddenByInfos }
  }

  /** 隐藏或恢复；已是目标状态时只更新记录。不支持时抛 `DESKTOP_ICONS_UNAVAILABLE`。 */
  set(hidden: boolean): DesktopIconsState {
    const found = this.locate()
    if (!found) throw new Error('DESKTOP_ICONS_UNAVAILABLE')
    const current = !found.api.isWindowVisible(found.list)
    if (current !== hidden) {
      if (!found.api.sendMessageTimeout(found.view, WM_COMMAND, TOGGLE_DESKTOP_ICONS, 0))
        throw new Error('DESKTOP_ICONS_UNAVAILABLE')
    }
    // 只有这次确实由 infOS 隐藏（原本是显示的）才记为 infOS 隐藏。
    this.memory.write(hidden && (current !== hidden || this.memory.read()))
    return this.state()
  }
}
