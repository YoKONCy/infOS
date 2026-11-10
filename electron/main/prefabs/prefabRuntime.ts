/**
 * @file 预制件的生产环境接线：Electron 文件系统 / 图标 / 打开方式、全屏让开、隐藏桌面图标，
 *       以及预制件页面与卡片页的 IPC 通道。由 windows/desktopCards.ts 创建单例并注册通道。
 *
 *       页面通道：发送者必须是某张预制件卡片自己的窗口（主 frame），请求只作用于该卡片；
 *       普通卡片窗口调用一律拒绝。卡片页通道：只接受主窗口与桌面面板。
 *
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import { app, dialog, ipcMain, nativeImage, screen, shell, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { t as __t } from '../utils/i18n'
import {
  DESKTOP_PREFAB_ADMIN_CHANNELS,
  DESKTOP_PREFAB_CHANNELS,
  DEFAULT_FENCE_STATE,
  type DesktopCardListItem,
} from '../../../packages/shared/src/desktopCards'
import type { DesktopCards } from '../windows/desktopCardManager'
import { DesktopPrefabs } from './desktopPrefabs'
import { DesktopIcons } from './desktopIcons'
import { listDesktopEntries } from './desktopEntries'
import { DesktopFences, type FenceSystem } from './fence/fenceService'
import { FullscreenYield } from './fullscreenYield'
import { loadPrefabNative } from './prefabNative'

/** 收纳框界面文案（由主进程翻译，页面无需 i18n）。 */
export function fenceLabels(): Record<string, string> {
  const label = (text: string) => __t('electron.ui.desktopShell', text)
  return {
    collapse: label('折叠收纳框'),
    expand: label('展开收纳框'),
    menu: label('收纳框选项'),
    close: label('关闭卡片'),
    pin: label('始终置顶'),
    layer: label('贴在桌面上'),
    layerHint: label('贴在桌面时不能移动，先在菜单里取消'),
    iconSize: label('图标大小'),
    small: label('小'),
    medium: label('中'),
    large: label('大'),
    sort: label('排序'),
    manual: label('手动'),
    name: label('名称'),
    type: label('类型'),
    backgroundOpacity: label('背景透明度'),
    backgroundOpacityHint: label('0% 全透明，100% 不透明'),
    remove: label('从框中移出（不删除文件）'),
    empty: label('把桌面上的图标拖到这里'),
    missing: label('找不到原文件'),
    rename: label('双击改名'),
    drag: label('拖动收纳框'),
    count: label('{0} 项'),
    folder: label('映射：{0}'),
    failed: label('操作失败：{0}'),
  }
}

const FILE_ATTRIBUTE_HIDDEN = 0x2
const FILE_ATTRIBUTE_SYSTEM = 0x4

/** 拖拽时跟着鼠标的图标不超过这个边长，大缩略图会挡住放下的位置。 */
const DRAG_ICON_MAX_PIXELS = 64
/** 取不到图标时用的内置图标（32×32 的文档图案）：Electron 遇到空图标会直接不发起拖拽。 */
export const FENCE_FALLBACK_DRAG_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAARklEQVR42mNgGAWDFUSlVPynJibLAV+//6IKHnXAqANGHUAVB5Ca70ejYDQNjEbBaBoYjYLRNDAaBaMOoIoDBrRjMgroBQB2lwQSo/965QAAAABJRU5ErkJggg=='

/** data URL → 拖拽图标：保证非空，并按比例缩到合适大小。 */
function dragImage(icon: string | null): Electron.NativeImage {
  const image = icon ? nativeImage.createFromDataURL(icon) : null
  if (!image || image.isEmpty()) return nativeImage.createFromDataURL(FENCE_FALLBACK_DRAG_ICON)
  const { width, height } = image.getSize()
  if (Math.max(width, height) <= DRAG_ICON_MAX_PIXELS) return image
  return image.resize(
    width >= height ? { width: DRAG_ICON_MAX_PIXELS } : { height: DRAG_ICON_MAX_PIXELS },
  )
}

const hasAttribute = (target: string, attribute: number) => {
  const attributes = loadPrefabNative()?.fileAttributes(target)
  return attributes !== undefined && attributes !== null && (attributes & attribute) !== 0
}

/** Electron 提供的文件系统、图标与打开方式；只读取，不写、不删用户文件。 */
export const electronFenceSystem: FenceSystem = {
  stat: (target) => {
    try {
      const stat = fs.statSync(target)
      return { isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return null
    }
  },
  readDir: (folder) => {
    try {
      return fs.readdirSync(folder)
    } catch {
      return []
    }
  },
  getFileIcon: async (target) => {
    const image = await app.getFileIcon(target, { size: 'large' })
    return image.isEmpty() ? null : image.toDataURL()
  },
  createThumbnail: async (target, pixels) => {
    // Windows 只看宽度，并按比例缩放，长边不超过 pixels（已用真实图片确认）。
    const image = await nativeImage.createThumbnailFromPath(target, {
      width: pixels,
      height: pixels,
    })
    return image.isEmpty() ? null : image.toDataURL()
  },
  isHidden: (target) => hasAttribute(target, FILE_ATTRIBUTE_HIDDEN),
  isSystem: (target) => hasAttribute(target, FILE_ATTRIBUTE_SYSTEM),
  readShortcutLink: (target) => {
    if (process.platform !== 'win32') return null
    try {
      const link = shell.readShortcutLink(target)
      return { target: link.target, icon: link.icon }
    } catch {
      return null
    }
  },
  openPath: (target) => shell.openPath(target),
  startDrag: (contents, file, icon) => contents.startDrag({ file, icon: dragImage(icon) }),
  watch: (folder, listener) => {
    const watcher = fs.watch(folder, { persistent: false }, () => listener())
    watcher.on('error', () => watcher.close())
    return () => watcher.close()
  },
}

/** 用户桌面与公共桌面（Windows 的 %PUBLIC%\Desktop）。 */
function desktopFolders() {
  const folders: { dir: string; location: 'user' | 'public' }[] = [
    { dir: app.getPath('desktop'), location: 'user' },
  ]
  if (process.platform === 'win32' && process.env.PUBLIC)
    folders.push({ dir: path.join(process.env.PUBLIC, 'Desktop'), location: 'public' })
  return folders
}

/** 「是否由 infOS 隐藏桌面图标」记在用户数据目录的小文件里。 */
function desktopIconsMemory() {
  const file = () => path.join(app.getPath('userData'), 'desktop-prefabs.json')
  return {
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(file(), 'utf8')).desktopIconsHiddenByInfos === true
      } catch {
        return false
      }
    },
    write: (hiddenByInfos: boolean) =>
      fs.writeFileSync(file(), `${JSON.stringify({ desktopIconsHiddenByInfos: hiddenByInfos })}\n`),
  }
}

export function createDesktopPrefabs(cards: DesktopCards): {
  prefabs: DesktopPrefabs
  icons: DesktopIcons
} {
  const fences = new DesktopFences(cards, electronFenceSystem, fenceLabels)
  const fullscreen = new FullscreenYield(loadPrefabNative, {
    toDip: (rect) => screen.screenToDipRect(null, rect),
    displays: () => screen.getAllDisplays().map((display) => ({ ...display.bounds })),
  })
  const prefabs = new DesktopPrefabs(cards, fences, fullscreen, () =>
    listDesktopEntries(desktopFolders(), electronFenceSystem),
  )
  cards.usePrefabs(prefabs)
  return { prefabs, icons: new DesktopIcons(loadPrefabNative, desktopIconsMemory()) }
}

/** 预制件页面的通道：只接受预制件卡片自己窗口的主 frame。 */
export function registerDesktopPrefabHandlers(cards: DesktopCards, prefabs: DesktopPrefabs): void {
  const owner = (event: Electron.IpcMainInvokeEvent): string => {
    const id = cards.idOf(event.sender)
    if (!id || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
      throw new Error('DESKTOP_PREFAB_FORBIDDEN')
    // 普通卡片（角色写的 HTML）拿不到预制件能力。
    if (!cards.get(id).prefab) throw new Error('DESKTOP_PREFAB_FORBIDDEN')
    return id
  }
  ipcMain.handle(DESKTOP_PREFAB_CHANNELS.state, (event) => prefabs.view(owner(event)))
  ipcMain.handle(DESKTOP_PREFAB_CHANNELS.icon, (event, itemId: unknown, variant?: unknown) =>
    prefabs.icon(owner(event), itemId, variant),
  )
  ipcMain.handle(DESKTOP_PREFAB_CHANNELS.action, (event, action: unknown, payload?: unknown) =>
    prefabs.action(owner(event), action, payload),
  )
  // 手势只作用于 owner 查出的发送者自己的窗口，页面没有办法指定别的卡片。
  ipcMain.handle(DESKTOP_PREFAB_CHANNELS.gesture, (event, phase: unknown, payload?: unknown) =>
    prefabs.gesture(owner(event), phase, payload),
  )
  // 只收项目 ID，路径由主进程在发送者自己的框里反查；页面多传的参数一律不看。
  ipcMain.handle(DESKTOP_PREFAB_CHANNELS.dragOut, (event, itemId: unknown) =>
    prefabs.dragOut(owner(event), itemId),
  )
}

/** 卡片页里与预制件相关的入口：新建收纳框、隐藏 / 恢复桌面原图标。只接受主窗口与桌面面板。 */
export function registerDesktopPrefabAdminHandlers(
  isTrusted: (sender: WebContents) => boolean,
  cards: DesktopCards,
  prefabs: DesktopPrefabs,
  icons: DesktopIcons,
): void {
  const assert = (sender: WebContents) => {
    if (!isTrusted(sender)) throw new Error('DESKTOP_CARD_FORBIDDEN')
  }
  ipcMain.handle(
    DESKTOP_PREFAB_ADMIN_CHANNELS.createFence,
    async (event, input: unknown): Promise<DesktopCardListItem[]> => {
      assert(event.sender)
      const wantsFolder =
        !!input && typeof input === 'object' && (input as { folder?: unknown }).folder === true
      let folder: string | undefined
      if (wantsFolder) {
        const picked = await dialog.showOpenDialog({
          title: __t('electron.ui.desktopShell', '选择要映射到收纳框的文件夹'),
          properties: ['openDirectory'],
        })
        if (picked.canceled || !picked.filePaths[0]) return cards.adminList()
        folder = picked.filePaths[0]
      }
      prefabs.fences.create({
        title: folder
          ? path.basename(folder) || folder
          : __t('electron.ui.desktopShell', '新收纳框'),
        ...(folder ? { folder } : {}),
        iconSize: DEFAULT_FENCE_STATE.iconSize,
        createdBy: { kind: 'user' },
      })
      return cards.adminList()
    },
  )
  ipcMain.handle(DESKTOP_PREFAB_ADMIN_CHANNELS.desktopIcons, (event) => {
    assert(event.sender)
    return icons.state()
  })
  ipcMain.handle(DESKTOP_PREFAB_ADMIN_CHANNELS.setDesktopIcons, (event, input: unknown) => {
    assert(event.sender)
    const hidden =
      !!input && typeof input === 'object' && (input as { hidden?: unknown }).hidden === true
    return icons.set(hidden)
  })
}
