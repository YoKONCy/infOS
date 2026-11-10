/**
 * @file 桌面预制件 preload（受信任的内置卡片，如桌面收纳框）
 * @description 预制件页面不运行任何脚本（CSP 禁止），界面全部由这里在隔离环境中绘制；
 *              不向页面暴露任何接口（没有 contextBridge），页面也就无从伪造请求。
 *              与主进程只走 `DESKTOP_PREFAB_CHANNELS`：读取视图、按项目 ID 读图标、发起动作、拖出文件；
 *              主进程再核对发送者是不是预制件卡片自己的窗口。
 *              拖入的文件经 `webUtils.getPathForFile` 取本机路径，只登记为引用。
 *              动效使用前端公共动效层（motion.css），系统「减少动态效果」时自动关闭。
 *
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 * @module electron/preload/prefab
 */

import { ipcRenderer, webUtils } from 'electron'
import motionCss from '../../packages/frontend/src/assets/motion.css?raw'
// 只从 desktopPrefabs 导入运行时常量：与 card preload 共用模块会被打包成公共 chunk，沙箱 preload 加载不了。
import { DESKTOP_PREFAB_CHANNELS } from '../../packages/shared/src/desktopPrefabs'
import type { FenceView } from '../../packages/shared/src/desktopFence'
import { mountFence, type FenceApi } from './prefabs/fenceView'
import { FENCE_STYLE } from './prefabs/fenceStyle'

/** 预制件种类 → 视图；新增预制件时在这里登记。 */
const VIEWS = {
  fence: (doc: Document, api: FenceApi) => mountFence(doc, api, `${motionCss}\n${FENCE_STYLE}`),
} as const

const fenceApi: FenceApi = {
  state: () => ipcRenderer.invoke(DESKTOP_PREFAB_CHANNELS.state) as Promise<FenceView>,
  icon: (itemId, variant) => ipcRenderer.invoke(DESKTOP_PREFAB_CHANNELS.icon, itemId, variant),
  action: (action, payload) => ipcRenderer.invoke(DESKTOP_PREFAB_CHANNELS.action, action, payload),
  gesture: (phase, payload) => ipcRenderer.invoke(DESKTOP_PREFAB_CHANNELS.gesture, phase, payload),
  dragOut: (itemId) => ipcRenderer.invoke(DESKTOP_PREFAB_CHANNELS.dragOut, itemId),
  onChange: (listener) => {
    ipcRenderer.on(DESKTOP_PREFAB_CHANNELS.changed, (_event, view: FenceView) => listener(view))
    // 卡片管理改了名称或置顶时只发卡片信息，这里重新读取视图。
    ipcRenderer.on(DESKTOP_PREFAB_CHANNELS.cardChanged, () => listener())
  },
  droppedPaths: (files) =>
    [...files].map((file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
}

function install(): void {
  const kind = document.body?.dataset.prefab
  if (kind === 'fence') VIEWS.fence(document, fenceApi)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
else install()
