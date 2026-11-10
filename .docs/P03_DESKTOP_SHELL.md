# 桌面外壳与卡片

桌面外壳把功能页、角色生成的卡片和桌面收纳框组织为 Electron 窗口。前端负责页面内容，主进程负责窗口生命周期与本机布局，后端通过 `desktop.shell` 能力提供 Agent 工具入口。

## 数据归属

| 数据 | 权威位置 | 范围 |
| --- | --- | --- |
| 可打开与可摘出页面 | `packages/shared/src/desktopShell.ts` | 应用协议 |
| 面板位置、尺寸、置顶与透明度 | 客户端数据目录的 `desktop-shell.json` | 当前设备 |
| 卡片内容、收藏状态与窗口属性 | 客户端 `desktop-cards/<id>/` | 当前设备 |
| 主题资源 | 服务端 `themes/<id>/` | 当前实例 |
| 选中的主题 | `localStorage` 的 `infos.customTheme` | 当前设备与同源窗口 |
| 卡片消息与局部数据 | Home 服务 | 角色与会话 |

## 功能页窗口

导航菜单经 `useDetachedPanels` 调用 `desktop-shell:*` IPC。`DetachedPanels` 校验页面白名单、创建窗口、保存布局并广播变化，独立窗口使用 `DetachedPanelView.vue` 加载现有功能组件。聊天与危险区域使用主窗口。

关闭独立面板后，页面回到主窗口的可用列表。退出应用后保存的面板可在下次启动恢复。移动和缩放按工作区边界修正，多显示器变化通过 `displayWatch` 重新安排越界窗口。

Agent 通过以下内置工具操作外壳。工具白名单、执行模式与能力节点的可用性共同决定实际开放范围。

| 工具 | 职责 |
| --- | --- |
| `shell_layout` | 读取窗口、显示器、可摘出页面与当前主题 |
| `shell_window` | 摘出、合回、移动、缩放、置顶、透明度、聚焦、恢复与撤销 |
| `shell_theme` | 读取、编写、切换和删除主题 |
| `shell_card` | 创建、更新、收藏、打开、关闭和删除卡片 |
| `shell_fence` | 创建与整理桌面收纳框 |

后端的 `ShellCapabilityRuntime` 经能力目录找到 Electron 提供者。主进程的 `shellCapability` 与 `shellHost` 再把操作分派到真实窗口。窗口目标使用 `main`、`panel:<页面>` 和 `card:<ID>`。撤销保留本次运行内最近二十份窗口布局快照。

## 桌面卡片

普通卡片保存 `index.html` 和 `card.json`。临时卡片随关闭或退出清理，收藏卡片保留内容与打开状态。卡片页提供集中管理入口。

每张卡片使用独立内存 Session 和 `infos-card://<ID>/` 地址。主进程限定资源读取范围、导航、窗口创建和权限请求，页面使用专用 preload 的 `infosCard` 接口。主题与外观由宿主注入，卡片数据交互经 `HomeCardBridge` 核对卡片、角色及会话归属。

卡片消息先进入 Home 的持久记录，再通过会话队列投递。局部更新携带 revision，冲突时由调用方读取新状态后重试。主线发言继续使用独立消息与 Execution 合同。

## 预制件与桌面层

预制件由主进程注册受信任的处理器。当前收纳框支持文件和程序路径引用、文件夹映射、图标、拖放、折叠、排列及背景透明度。持久状态带版本号，加载时经对应处理器归一化。

Windows 的 `desktopLayer` 将窗口放入桌面层。全屏让位与显示器变化由主进程统一处理。预制件的实现与数据合同见 [桌面预制件](./P11_DESKTOP_PREFABS.md)。

## 失败与恢复

布局采用临时文件改名写入。窗口调整后读取实际边界，操作结果返回最终位置。卡片创建失败时清理半成品，收藏卡片从持久记录恢复。关闭通道由主进程持有。

主题文件由后端管理，选择与窗口布局属于客户端。分布式部署沿用这两类数据各自的归属。主题格式见 [自定义主题](./P02_CUSTOM_THEME.md)，文件交接和卡片消息见 [共同的家](./B31_COMMON_HOME.md)。

## 源码入口

- 共享协议位于 `desktopShell.ts`、`desktopCards.ts`、`desktopPrefabs.ts`。
- 主进程位于 `electron/main/windows/detachedPanels.ts`、`desktopCardManager.ts`、`desktopCardStore.ts`、`services/shellCapability.ts` 和 `prefabs/`。
- 后端位于 `capabilities/shellCapabilityRuntime.ts`、`desktopShellWiring.ts` 与 `tools/shell/`。
- 前端位于 `composables/shell/useDetachedPanels.ts`、`views/DetachedPanelView.vue` 与 `components/shell/`。
