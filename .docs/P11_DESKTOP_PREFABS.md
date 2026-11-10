# P11 桌面预制件与收纳框

预制件是 infOS 自己写好的「受信任的内置卡片」。它属于卡片系统里的一种：窗口生命周期、置顶、贴到桌面底层、Ctrl+W 关闭、卡片页管理与开机恢复都沿用 [P03 阶段 4、5](./P03_DESKTOP_SHELL.md) 的卡片实现。区别在于页面与能力，窗口也不同（全透明、不用毛玻璃，移动和缩放由页面内的手势实现，见「窗口」一节）：

|                  | 普通卡片（角色写的 HTML）  | 预制件                                                |
| ---------------- | -------------------------- | ----------------------------------------------------- |
| 页面             | `index.html`，角色提供     | 宿主内置的空白文档，CSP 为 `script-src 'none'`        |
| 界面             | 页面脚本                   | 预制件 preload（`preload/prefab.js`）在隔离环境中绘制 |
| 对页面暴露的接口 | `window.infosCard`         | 无（不调用 `contextBridge`）                          |
| 主进程能力       | 白名单数据、通知、绑定会话 | 注册表声明的受控能力（见下）                          |
| 计入 30 张上限   | 是                         | 由定义的 `countsTowardCardLimit` 决定（收纳框不计）   |
| 收藏             | 新建时临时                 | 新建即收藏，不进「最近关闭」                          |

两类卡片都在同一套沙箱里：独立内存 session、不可达代理、禁止导航 / 新窗口 / 下载 / 权限。普通卡片窗口调用预制件通道一律返回 `DESKTOP_PREFAB_FORBIDDEN`。

## 注册表

`packages/shared/src/desktopPrefabs.ts`：

- `DESKTOP_PREFAB_KINDS`：种类枚举，当前只有 `fence`。
- `DESKTOP_PREFABS[kind]`：`version`（状态结构版本）、`capabilities`、`defaultSize`、`minSize`、`countsTowardCardLimit`、`normalizeState(value, fromVersion)`（读取与迁移）。
- `card.json` 的 `prefab` 字段为 `{ kind, version, state }`。读取时按种类归一化并迁移到当前版本；未知种类不当作预制件，因为它没有 `index.html`，存储层会跳过它。

能力（`DESKTOP_PREFAB_CAPABILITIES`）由主进程按声明放行，未声明即拒绝：

| 能力                | 含义                                        |
| ------------------- | ------------------------------------------- |
| `launch-registered` | 启动本预制件登记过的项目，页面只能传项目 ID |
| `file-icons`        | 主进程读取并缓存系统图标                    |
| `folder-watch`      | 映射文件夹，内容变化时刷新                  |
| `drop-reference`    | 用户拖进来的文件登记为引用                  |
| `collapse`          | 折叠为只剩标题栏                            |
| `fullscreen-yield`  | 前台全屏时暂时隐藏                          |
| `window-gesture`    | 页面内拖动来移动、缩放自己的窗口            |
| `drag-out`          | 把项目作为系统文件拖出去（只按项目 ID）     |

### 新增一种预制件

1. 共享注册表：在 `DESKTOP_PREFAB_KINDS` 加种类，在 `DESKTOP_PREFABS` 写定义；状态结构与纯函数放在独立模块（参考 `desktopFence.ts`）。
2. 主进程：实现 `PrefabKindHandler`（`electron/main/prefabs/desktopPrefabs.ts`）并在构造函数的 `handlers` 中登记；需要系统能力时注入接口，便于测试替换。
3. preload：在 `electron/preload/prefab.ts` 的 `VIEWS` 中登记视图；视图只依赖注入的接口，可以在浏览器里用替身渲染。预制件 preload 不能与 `card.ts` 导入同一个运行时模块（例如 `desktopCards.ts`）：多个 preload 入口共用模块时打包会拆出公共 chunk，而沙箱 preload 不能 `require` 相对路径的文件。只导入 `desktopPrefabs.ts` 的常量与类型。
4. Agent 工具：在后端 `tools/shell/` 增加工具，经外壳能力的 `prefab` 操作（`input.kind` 区分种类）。身份统一由 `shellHomeInput` 注入。
5. 改了状态结构时提高 `version`，并在 `normalizeState` 中迁移旧版本。

## 收纳框（fence）

把桌面上的程序、文件、文件夹以**路径引用**收在半透明框里，外观为深色半透明、细边框、小号大写标题。

### 状态（`desktopFence.ts`）

| 字段                           | 说明                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| 标题                           | 即卡片名称（`card.name`），60 字以内                                                       |
| `collapsed`                    | 折叠后窗口只剩 30px 标题栏，只能改宽度；`card.bounds` 仍保存展开时的高度                   |
| `alwaysOnTop` / `desktopLayer` | 沿用卡片字段；两者互斥，开一个时自动关另一个                                               |
| `iconSize`                     | `small` / `medium` / `large`                                                               |
| `sort`                         | `manual`（登记顺序，可拖动）/ `name` / `type`（文件夹、程序、快捷方式、文件，再按名称）    |
| `backgroundOpacity`            | 背景透明度，0–100 的整数（0 全透明、100 不透明），默认 42；状态版本 2 新增，旧数据按默认值 |
| `items`                        | 登记项 `{ id: 'i-…', path, addedAt }`，最多 200 项，路径不区分大小写去重                   |
| `folder`                       | 映射的文件夹，显示其直接子项（最多 300 项），子项 ID 为 `f-` 加名称的 SHA-1 前缀           |
| `createdBy`                    | `{ kind: 'user' }` 或 `{ kind: 'agent', agentId, sessionId }`，后者只来自宿主注入          |

路径只接受本机绝对路径：拒绝 `\\server\share` 网络路径、`\\?\` 设备路径、相对路径、`..` 段与控制字符，避免读取图标时访问外部主机。

### 内容、图标与启动

- 登记与移出只改 `card.json`；删除框只删 `desktop-cards/<ID>/`。任何操作都不移动、复制、删除引用的文件。
- 图标：`app.getFileIcon(path, { size: 'large' })`。`.lnk` 先用 `shell.readShortcutLink` 取图标文件或目标，二者都不可用时用 `.lnk` 本身。按「路径 + 修改时间 + 大小」缓存，最多 512 个。
- 缩略图：png、jpg、jpeg、webp、gif、bmp 用 `nativeImage.createThumbnailFromPath` 生成，尺寸是图标档位的 2 倍，保持比例，由 `object-fit: contain` 居中显示。系统图标先显示，缩略图好了再替换；生成失败或文件超过 64MB 时用系统图标。按「像素 + 路径 + 修改时间 + 大小」缓存，最多 600 个（失败也缓存，文件变了才重试）。这个接口在 Windows 上实际在主线程同步执行，工具进程里也没有 `nativeImage`，所以主进程排队：每轮事件循环只启动一个，间隔 16ms，同时最多 3 个；页面同时最多要 4 张，视图变了就丢掉排队中的旧请求。页面仍只传项目 ID，路径由主进程反查；读图标时 2 秒内共用同一份条目列表，避免每个图标都重新列文件夹。
- 映射文件夹不列出点开头的文件和带 Windows 隐藏属性的文件（`GetFileAttributesW`，koffi 加载失败时只按名称过滤）；手动登记的项目不受影响。
- 项目多时滚动：列表项用 `content-visibility: auto` 跳过视口外的布局和绘制，图标 `decoding="async"`。没有用 `loading="lazy"`，它对 data URL 不起作用。
- 启动：页面发 `launch` 和项目 ID，主进程在本框当前条目（登记项与映射文件夹子项）中反查路径，存在时调用 `shell.openPath`。页面传路径、其他框的 ID 或已移出的 ID 都返回 `DESKTOP_FENCE_ITEM_NOT_FOUND`。每个框每分钟最多启动 20 次。
- 页面视图（`FenceView`）只含 ID、显示名、类型、是否缺失、是否来自文件夹、文件版本（修改时间与大小）、是否图片及能否拖出，不含路径。
- 拖入：preload 在真实的 `drop` 事件中用 `webUtils.getPathForFile` 取路径，主进程校验格式与是否存在后登记为引用；拖入不会触发启动。`reorder` 只收 `i-` 项目 ID。
- 拖出：和从资源管理器拖一样，能拖进 infOS 聊天窗口和别的程序。`dragstart` 里取消页面拖拽，经 `desktop-prefab:drag-out` 只传项目 ID，主进程在本框当前条目里反查路径，确认存在、不是隐藏或受保护文件后调用 `webContents.startDrag`。不允许的文件：隐藏属性、系统属性、点开头的文件和 infOS 的凭据文件（清单与后端 `protectedFiles.ts` 共用保护目标）。文件夹可以拖，但不检查里面的内容。每个框每分钟最多 60 次，同时只允许一个。系统拖拽只允许复制和引用，不会移动文件。
- 排序和拖出共用一次系统拖拽，不用切换模式：放在别的程序上是拖出，放回本框由 `fenceDropOutcome` 判定为排序（登记项）或不做任何事（映射项目、放回原位）。本框发起的拖拽一律不登记。HTML5 拖拽中途不能换成系统拖拽，所以没有用「出框再切换」的做法。Windows 上 `startDrag` 要等拖拽结束才返回，放下事件和这个返回到达页面的先后不确定，页面在返回后再等 800ms 才清掉「本框发起」的标记。缺失、隐藏或受保护的登记项发不了系统拖拽，仍用页面拖拽在框内排序（视图字段 `dragOut` 为假）。
- 文件夹监视：`fs.watch`（不递归），合并 400ms 内的变化后推送新视图；窗口关闭或框删除时停止。

### 窗口

- 透明：预制件窗口 `transparent: true`、底色 `#00000000`，不用 `backgroundMaterial`（acrylic 在窗口失焦时会退成不透明的灰色，透明度也就调不出来）。普通卡片仍按原来的方式。框的背景和标题栏由页面绘制，透明度用 CSS 变量 `--fence-bg-alpha`，图标和文字不受影响。没有做毛玻璃选项：`transparent` 与 `backgroundMaterial` 不能同时生效，要切换就得重建窗口。
- 透明度为 0 时不穿透：逐像素全透明的地方，系统可能把点击和拖放交给后面的窗口，所以实际绘制的不透明度不低于 `FENCE_MIN_HIT_ALPHA`（约 3/255，肉眼看不出），圆角外的像素由缩放手柄覆盖。
- 窗口的整体透明度 `card.opacity` 仍然存在（`shell_window` 可改），但它连图标一起变淡；为 1 时打开窗口不调用 `setOpacity`，避免影响逐像素透明。
- 移动：页面内的指针手势，标题栏（含标题文字，不含按钮）按下后捕获指针，移动超过 4px 才算拖动。标题栏不用 `-webkit-app-region`，否则系统会吞掉指针事件。捕获指针后点击事件的目标会变，双击改名由纯函数 `FencePress`（`preload/prefabs/fencePointer.ts`）判定，不用 `dblclick`。
- 缩放：窗口 `resizable: false`（透明窗口的原生边缘不可靠，还会抢走指针事件），四边四角是隐形手柄：左右下边 10px、上边 8px、四角 16px。标题栏按钮的层级高于手柄；内容区左右下留出 10px，图标和滚动条不被挡。折叠时只保留左右两边；贴在桌面上时不显示。
- 手势通道：页面按动画帧发送相对按下位置的**累计增量**（`screenX/screenY`），主进程在 `begin` 时记下窗口位置，每次用「起始值 + 累计增量」计算（`fenceGestureBounds`），不在当前值上累加，混合 DPI 下不会越拖越偏。最小尺寸由主进程钳制，拖动的边跟手、对边不动。`end` 时立即写盘（`commitWindowBounds`），平时的 `move` / `resize` 事件仍会延迟保存。
- 窗口没有原生最小尺寸，`windowBounds` 钳到 140×80（折叠 140×30），`shell_window` 与重启恢复都经过它。
- 位置换算钩子：`windowBounds` 把保存的展开位置换算成折叠后的窗口位置，`persistBounds` 反向换算，因此移动折叠的框、显示器变化后的拉回与重启恢复都保留展开高度。
- 关闭：标题栏最右边的关闭按钮平时隐藏（占位不变），鼠标移到框上时出现，自带深色底，背景透明度为 0 时在浅色壁纸上也看得清；页面动作 `close` 与 Ctrl/Cmd+W 走同一个 `DesktopCards.close`，框保留，可从卡片页重新打开。折叠时同样可用。
- 贴在桌面上时不能移动和缩放：挂到 WorkerW 后窗口坐标相对桌面图标层，`begin` 返回 `DESKTOP_CARD_PINNED`，手柄隐藏，标题栏提示要先在菜单里取消。折叠只改高度（`setSize`）。

### 全屏让开（`fullscreenYield.ts`）

声明 `fullscreen-yield` 的预制件在前台窗口铺满某块显示器时隐藏该显示器上的窗口，退出全屏后 `showInactive`。判定方式：前台窗口的矩形（经 `screen.screenToDipRect` 换算为逻辑像素）在 2px 容差内覆盖整块显示器（含任务栏区域）；`Progman`、`WorkerW` 与任务栏不算。贴在桌面上的窗口不让开。只在有需要让开的窗口时每 1.5 秒查询一次。

这一思路参考了 [Lively Wallpaper](https://github.com/rocksdanister/lively) 的「前台全屏时暂停」。Lively 使用 GPL-3.0，本实现自行编写，没有复制其代码。

### 隐藏桌面原图标（`desktopIcons.ts`）

可选，默认关闭，卡片页一键切换与恢复。向桌面的 `SHELLDLL_DefView` 发送 `WM_COMMAND 0x7402`，与桌面右键「查看 → 显示桌面图标」相同，由资源管理器自己切换并写入 `HideIcons`；再发一次即恢复，不直接写注册表，也不移动图标。`desktop-prefabs.json` 记录是否由 infOS 隐藏。这是系统设置，只开放给卡片页（主窗口与桌面面板），不开放给 Agent 工具。找不到桌面图标窗口时报告不支持。

## 通道

| 通道                                                       | 发送方             | 说明                                                                                                                 |
| ---------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `desktop-prefab:state`                                     | 预制件窗口主 frame | 读取视图                                                                                                             |
| `desktop-prefab:icon`                                      | 同上               | `(itemId, variant?)` 按项目 ID 读图标，`variant` 为 `thumbnail` 时读图片缩略图（需 `file-icons`）                    |
| `desktop-prefab:action`                                    | 同上               | `(action, payload)`，按种类的动作枚举校验                                                                            |
| `desktop-prefab:gesture`                                   | 同上               | `(phase, payload)`：`begin`（手势种类）、`update` / `end`（累计增量）；只作用于发送者自己的窗口，需 `window-gesture` |
| `desktop-prefab:drag-out`                                  | 同上               | `(itemId)` 把项目作为系统文件拖出去（需 `drag-out`）；Windows 上拖拽结束才返回                                       |
| `desktop-prefab:changed`                                   | 主进程推送         | 新视图                                                                                                               |
| `desktop-prefab-admin:create-fence`                        | 主窗口 / 桌面面板  | `{ folder?: boolean }`，为真时先弹出选文件夹对话框                                                                   |
| `desktop-prefab-admin:desktop-icons` / `set-desktop-icons` | 同上               | 读取 / 切换「隐藏桌面原图标」                                                                                        |

收纳框动作：`launch`（项目 ID）、`collapse` / `pin` / `layer`（布尔）、`iconSize`、`sort`、`backgroundOpacity`（0–100 的整数）、`rename`、`remove` / `reorder`（`i-` 项目 ID 数组）、`drop`（路径数组）。

## Agent 工具 `shell_fence`

经 `desktop.shell` 的 `prefab` 操作。后端 `shellHomeInput` 对全部 `prefab` 操作丢弃模型参数里的 `__homeScope`、`homeBinding`、`createdBy`，再写入运行上下文的 `agentId` / `threadId`；Electron 端没有可信身份时拒绝（`DESKTOP_PREFAB_SCOPE_REQUIRED`），新建的框把它记为 `createdBy`。

动作包括 `list`、`desktop`（只读列出用户桌面与公共桌面的直接子项）、`create`、`update`（两者均可带 `backgroundOpacity`）、`add`、`remove`、`reorder`、`arrange`（`column` / `row` / `grid`，贴在桌面上的框跳过）和 `delete`。启动项目走桌面操作授权，隐藏原图标由用户操作。模型参数与动作约束由 `shell_fence` 工具定义提供。

## 源码入口

- 共享：`packages/shared/src/desktopPrefabs.ts`、`desktopFence.ts`
- 卡片系统钩子：`electron/main/windows/desktopCardModel.ts`（`DesktopCardPrefabHooks`）、`desktopCardManager.ts`、`desktopCardWindow.ts`
- 主进程：`electron/main/prefabs/`（`desktopPrefabs.ts` 注册与分派、`prefabRuntime.ts` 接线与通道、`fence/` 收纳框、`fullscreenYield.ts`、`desktopIcons.ts`、`desktopEntries.ts`）
- preload：`electron/preload/prefab.ts`、`electron/preload/prefabs/`（动效使用 [S07 公共动效层](./S07_MOTION_LAYER.md) 的 `motion.css`，构建时以 `?raw` 内联）
- 后端：`packages/backend/src/tools/shell/fence.ts`、`homeScope.ts`
- 卡片页入口：`packages/frontend/src/components/shell/cards/FenceToolbar.vue`

