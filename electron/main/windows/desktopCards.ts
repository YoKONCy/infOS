/**
 * @file 桌面卡片窗口
 * @description 阶段 4：角色设计的卡片（类似安卓桌面小组件）。
 *
 *              - 存放在 Electron 用户数据目录 `desktop-cards/<卡片 ID>/`：card.json（名称、位置、置顶、
 *                透明度、是否收藏、是否打开、时间）与 index.html；写入用临时文件再改名。
 *              - 新卡片是临时的：关闭窗口或退出应用时删除；收藏后保留，关闭只隐藏，下次启动恢复打开的卡片。
 *              - 卡片 HTML 不可信：每张卡片独立的内存 session，经 `infos-card://<ID>/` 只能读取本卡片的
 *                index.html，响应带 CSP（不能联网、不能嵌套页面）；窗口开启 sandbox 与 contextIsolation，
 *                禁止 Node、导航、新窗口、下载与全部权限请求。卡片唯一的对外接口是卡片 preload 的 `window.infosCard`。
 *              - 总能关闭：Ctrl/Cmd+W 由主进程拦截（卡片脚本无法阻止），设置页另有卡片列表（管理通道）。
 *              - 阶段 5：`desktopLayer` 为真的卡片打开后贴到桌面底层（宿主提供，仅 Windows）。
 *              - 预制件（受信任的内置卡片，如桌面收纳框）见 `../prefabs`：本文件创建其单例并注册通道。
 *              - 窗口创建（Electron 部分）由宿主注入，便于单元测试。
 *              - 按职责拆分：`desktopCardModel`（宿主接口与位置计算）、`desktopCardStore`（磁盘存储）、
 *                `desktopCardManager`（卡片与窗口管理）；本文件提供全局单例与 IPC 通道并统一再导出。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 * @module electron/main/windows/desktopCards
 */

import { app, ipcMain, type WebContents } from 'electron'
import path from 'node:path'
import {
  DESKTOP_CARD_ACTIONS,
  DESKTOP_CARD_CHANNELS,
  type DesktopCardAction,
  DESKTOP_CARD_FOLDER,
  DESKTOP_CARD_ADMIN_CHANNELS,
  type DesktopCardAdminPatch,
  desktopCardUrl,
} from '../../../packages/shared/src/desktopCards'
import { DesktopCards } from './desktopCardManager'
import { DesktopCardRequests } from './desktopCardRequests'
import { watchDisplayChanges } from './displayWatch'
import { DesktopCardToasts, desktopCardToasts } from './desktopCardToast'
import { HomeCardBridge } from '../home/homeCardBridge'
import { homeRequest } from '../home/homeRequest'
import { getBackendOrigin } from '../services/clientConnection'
import { onHomeEvent } from '../home/homeEvents'
import { onLocaleChange } from '../../../packages/shared/src/i18n'
import type { DesktopPrefabs } from '../prefabs/desktopPrefabs'
import type { DesktopIcons } from '../prefabs/desktopIcons'
import {
  createDesktopPrefabs,
  registerDesktopPrefabAdminHandlers,
  registerDesktopPrefabHandlers,
} from '../prefabs/prefabRuntime'

export * from './desktopCardManager'
export type { DesktopCardDisplays, DesktopCardInput, DesktopCardsHost } from './desktopCardModel'

/** 全局单例 */
export const desktopCards = new DesktopCards(() =>
  path.join(app.getPath('userData'), DESKTOP_CARD_FOLDER),
)

/** 预制件单例（收纳框等），接在全局卡片单例上。 */
export const { prefabs: desktopPrefabs, icons: desktopIcons } = createDesktopPrefabs(desktopCards)

/**
 * 注册卡片 preload 的通道。发送者必须是某张卡片自己的窗口，请求只作用于该卡片；
 * 卡片消息只进入宿主绑定的会话。`toast` 只能以卡片自己的名称为标题发出 infOS 桌面通知。
 */
export function registerDesktopCardHandlers(
  cards: DesktopCards = desktopCards,
  toasts: DesktopCardToasts = desktopCardToasts,
  bridge = new HomeCardBridge(cards, homeRequest, getBackendOrigin),
  prefabs: DesktopPrefabs | null = cards === desktopCards ? desktopPrefabs : null,
): void {
  if (prefabs) registerDesktopPrefabHandlers(cards, prefabs)
  // 显示器拔掉或分辨率变化后，把跑到屏幕外的卡片拉回来；退出时自动解绑监听。
  watchDisplayChanges(() => cards.correctOffscreen())
  const owner = (sender: WebContents): string => {
    const id = cards.idOf(sender)
    if (!id) throw new Error('DESKTOP_CARD_FORBIDDEN')
    return id
  }
  const mainFrame = (event: Electron.IpcMainInvokeEvent) => {
    owner(event.sender)
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
      throw new Error('DESKTOP_CARD_FORBIDDEN')
  }
  ipcMain.handle(DESKTOP_CARD_CHANNELS.interaction, (event) => {
    mainFrame(event)
    bridge.interaction(event.sender)
  })
  ipcMain.handle(DESKTOP_CARD_CHANNELS.homeGet, (event) => {
    mainFrame(event)
    return bridge.get(event.sender)
  })
  ipcMain.handle(DESKTOP_CARD_CHANNELS.homeSend, (event, text: unknown) => {
    mainFrame(event)
    return bridge.send(event.sender, text)
  })
  const cancel = [
    onHomeEvent('card-data', (value) => bridge.data(value)),
    onHomeEvent('card-message', (value) => bridge.message(value)),
    onHomeEvent('reconnected', () => bridge.refresh()),
    onLocaleChange(() => {
      for (const win of cards.openWindows()) {
        const id = cards.idOf(win.webContents)
        if (id)
          win.webContents.send(
            DESKTOP_CARD_CHANNELS.changed,
            DesktopCardRequests.info(cards.get(id)),
          )
      }
    }),
  ]
  app.once('will-quit', () => cancel.forEach((stop) => stop()))
  ipcMain.handle(DESKTOP_CARD_CHANNELS.info, (event) =>
    DesktopCardRequests.info(cards.get(owner(event.sender))),
  )
  ipcMain.handle(DESKTOP_CARD_CHANNELS.data, (event, name: unknown) =>
    cards.pageRequests.data(owner(event.sender), name),
  )
  ipcMain.handle(DESKTOP_CARD_CHANNELS.openPage, (event, pageId: unknown) => {
    cards.pageRequests.openPage(owner(event.sender), pageId)
    return true
  })
  // 统一动作通道：先按枚举校验，再分派；只作用于发送者自己的卡片。
  ipcMain.handle(DESKTOP_CARD_CHANNELS.control, (event, action: unknown, payload?: unknown) => {
    const id = owner(event.sender)
    if (!DESKTOP_CARD_ACTIONS.includes(action as DesktopCardAction))
      throw new Error('DESKTOP_CARD_INVALID_PATCH')
    const card = cards.get(id)
    if (action === 'save') cards.save(id, !card.saved)
    else if (action === 'pin') cards.set(id, { alwaysOnTop: !card.alwaysOnTop })
    else if (action === 'toast') toasts.show(id, card.name, payload)
    else if (action === 'reload') return cards.windowOf(id)?.loadURL(desktopCardUrl(id))
    else cards.close(id)
    return true
  })
}

/**
 * 注册「卡片」页管理卡片的通道（卡片之外的查看、关闭与整理入口）。只接受主窗口与桌面面板；
 * 角色工具不经过这些通道。改动后统一返回最新列表（含缩略图与最近关闭的过期时间）。
 */
export function registerDesktopCardAdminHandlers(
  isTrusted: (sender: WebContents) => boolean,
  cards: DesktopCards = desktopCards,
  prefabs: { prefabs: DesktopPrefabs; icons: DesktopIcons } | null = cards === desktopCards
    ? { prefabs: desktopPrefabs, icons: desktopIcons }
    : null,
): void {
  if (prefabs) registerDesktopPrefabAdminHandlers(isTrusted, cards, prefabs.prefabs, prefabs.icons)
  const assert = (sender: WebContents) => {
    if (!isTrusted(sender)) throw new Error('DESKTOP_CARD_FORBIDDEN')
  }
  const handle = (channel: string, run: (input: unknown) => unknown) =>
    ipcMain.handle(channel, (event, input: unknown) => {
      assert(event.sender)
      run(input)
      return cards.adminList()
    })
  handle(DESKTOP_CARD_ADMIN_CHANNELS.list, () => undefined)
  handle(DESKTOP_CARD_ADMIN_CHANNELS.show, (id) => cards.show(id))
  handle(DESKTOP_CARD_ADMIN_CHANNELS.close, (id) => cards.close(id))
  handle(DESKTOP_CARD_ADMIN_CHANNELS.remove, (id) => cards.remove(id))
  // 渲染进程的 invoke 只带一个参数：`{ id, patch }`。
  handle(DESKTOP_CARD_ADMIN_CHANNELS.patch, (input) => {
    const item = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    cards.patch(item.id, readAdminPatch(item.patch))
  })
  ipcMain.handle(DESKTOP_CARD_ADMIN_CHANNELS.source, (event, id: unknown) => {
    assert(event.sender)
    return cards.read(id).html
  })
}

/** 卡片页的修改只收已知字段与正确类型，其余忽略。 */
function readAdminPatch(value: unknown): DesktopCardAdminPatch {
  const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const patch: DesktopCardAdminPatch = {}
  if (typeof item.name === 'string') patch.name = item.name
  for (const key of ['saved', 'alwaysOnTop', 'autoOpen'] as const)
    if (typeof item[key] === 'boolean') patch[key] = item[key]
  return patch
}
