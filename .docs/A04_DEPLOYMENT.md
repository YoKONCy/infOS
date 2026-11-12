# 多目标部署架构

> **版本**：0.9.13 · **更新时间**：2026-10-26
> **适用范围**：infOS 全项目部署策略
> **依赖规范**：[A07_CROSS_PLATFORM](./A07_CROSS_PLATFORM.md)、[A08_DEVOPS](./A08_DEVOPS.md)
>
> **当前阶段**：生产基线是单个 Control Authority Server 对接多个 Client/Capability Node。Electron/Steam/便携版在启动后台之前选择本地或远程模式；远程模式只启动客户端与本机能力，不拉起本地 Daemon。多 Server 只规划手动完整快照同步，不实施实时 Federation、跨 Server Replica 或自动 Command Route。

---

## 1. 部署形态与 AIOS 运行时边界

各部署形态共用主侧会话迁移。数据库升级保留旧会话为 SideThread，并为登记角色确保空主线。完整同步快照写出 `schemaVersion=2`，可读取版本 1 后迁移。逻辑导入遇到主线冲突时将导入会话保留为侧线，据点待回复意图标记为已结束。数据权威和恢复边界见 [主侧会话](./B26_MAIN_SIDE_THREADS.md)。

infOS 的核心后端是纯 Node Daemon；Electron 是业务客户端和桌面能力提供者。详细职责见 [A09_AIOS_ARCHITECTURE](./A09_AIOS_ARCHITECTURE.md#7-nodefacet控制面与能力提供者)。

| 形态                              | Daemon 生命周期                                                 | Electron / 客户端职责              | 适用场景             |
| --------------------------------- | --------------------------------------------------------------- | ---------------------------------- | -------------------- |
| Electron 标准版、Steam 版、便携版 | 本地模式启动内置 Daemon；远程模式跳过本机后台并连接所选服务器 | GUI、3D、Steam、平台注册能力       | 普通桌面用户         |
| 开发环境                          | 可由开发脚本独立启动或统一编排                                  | 连接 HTTP/SSE/WS 服务              | 本地开发             |
| Docker / 服务器                   | 独立运行                                                        | Web/CLI/Electron 等客户端连接      | 长时间运行与远程访问 |
| 远程纯客户端                      | 连接指定 Control Authority Daemon                               | GUI、Input Seat、可选能力 Provider | 多节点接入           |

**强制边界**：`packages/backend`、`packages/frontend`、`packages/shared` 均不得 import Electron；业务数据一律走 HTTP/SSE/WS，IPC 仅用于 Electron 专属能力与能力 Provider 通道。

### Electron 壳层开屏

Electron 首次启动先显示本地透明开屏，并在同一窗口内选择本地或远程模式；连接验证通过或本地配置保存后，再准备资源与所选后端。已有有效配置时直接进入启动进度，远程验证失败则原地展开连接设置。后端健康检查和 Launcher 主框架首帧握手全部通过后才解除显窗门控；失败时保留开屏上的重试、日志与退出入口。二次启动与激活不会绕过门控，退出会取消未完成的启动链。托盘与分布式设置复用此开屏编辑下次配置，取消时返回客户端，保存后重启。

加载阶段使用佩诺菈的完整背景插画，由内联 SVG 叠加折纸轮廓、官方品牌和晶体滑道进度；人物与背景保持静态。百分比按启动阶段离散显示：准备为 0%、进入后端连接为 33%、进入 Launcher 首帧等待为 67%，健康检查及首帧握手通过后为 100%；这是阶段完成比例，不是耗时或文件加载量，失败时保留当前值，重试时复位。连接配置阶段仍使用 Pero 插画及原表单，切换时调整同一窗口比例；主应用内的首次配置页面不受影响。

安装包携带 `electron/splash/` 中的两套本地 PNG、HTML 内联 SVG、CSS、JS 和百分比字体，以及独立编译的开屏预加载脚本。渲染器等待两套插画解码、字体和初始状态就绪后才请求显窗；资源仅从本地读取，CSP 不允许内联脚本、外部网络和对象嵌入。设计实验保存在被 Git 忽略的 `TEMP/`，发行运行时不依赖该目录。标准版、Steam 版与便携版共用基础资源清单，浏览器与 Docker 入口不使用此过渡。

---

### Electron 系统图标

`public/system-icons/pero.png` 与 `pero.ico` 是 Electron 窗口、开屏、任务栏、托盘和 Windows 可执行文件共用的图标，采用 Pero 与 P 字母对话气泡组合，配无描边的米白至淡紫圆角底板以保持小尺寸下的视觉体量。PNG 为 512×512，圆角外部透明；ICO 包含 16、20、24、32、40、48、64、96、128、256 像素帧，小帧使用 32 位 DIB 与透明掩码，256 像素帧使用 PNG。`public/Logo.png`、`public/icon.png`、`public/icon.ico` 及 `resources` 中的同类兼容资源保持同步。

导出时按有效透明轮廓裁切，再等比居中放入画布，最长边占约 98%，减少托盘小尺寸下的多余留白；像素尺寸取整后保留完整主体。运行时入口为 `electron/main/utils/appIcon.ts`、`appIdentity.ts` 与 `windowsTaskbarIcon.ts`；各 electron-builder 配置使用同一 ICO。开发启动器 `scripts/dev-electron.mjs` 将 ICO 摘要纳入独立运行时缓存标识，完整退出后重新启动即可使用更新资源；已打包 EXE 与快捷方式需通过新的发行产物更新。Steam 商店字标图独立维护，不替代桌面系统图标；应用内 SVG 品牌标志及角色头像仍由各自入口维护。

### 开发客户端切换连接后的重启

`pnpm dev:electron` 的父启动器管理 electron-vite CLI；CLI 会在 Electron 退出时关闭 Vite 并退出。开发版不能直接调用 `app.relaunch()` 重开 EXE，否则新进程继承的 `ELECTRON_RENDERER_URL` 仍指向已关闭的本机 7359 页面服务，即使远程后端身份和健康验证通过，也会在 Launcher 阶段收到 `ERR_CONNECTION_REFUSED`。

托盘和分布式连接设置共用 `clientRestart.ts`：退出被应用标签取消时撤销重启意图，所有退出清理完成后才交接；受管开发会话以 `developmentRestart.mjs` 的专用退出码通知父启动器，父启动器等待旧 CLI 完整关闭后重新启动 Vite 与 Electron，顶层 `pnpm start` 不会将这次切换视为 Electron 退出而连带清理其余开发服务。普通退出、异常退出和 Ctrl+C 不自动重启。直接使用 electron-vite 等非受管入口时，连接保存后提示在终端手动重启；正式版仍由 Electron 的重启机制处理。启动器页面首帧门控继续保留，开发页面拒绝连接时显示对应的终端恢复指引。

### Docker Web 静态资源缓存

前端镜像构建阶段复制 Vite 配置依赖的 `frontendCatalogSplit.ts`、`i18n.mjs`、`pdfAssetsPlugin.ts` 与 `vite-browser-compat.ts`。词库拆分插件及其脚本翻译入口随镜像源码一起提供，语言 JSON 来自已复制的共享包。

前端 Nginx 对 `assets/` 下带内容哈希的 JS、CSS、字体、图片和 WASM 返回一年不可变缓存；HTML 入口和固定文件名资源使用 `no-cache` 与 ETag，刷新时协商更新，避免旧入口引用已经被替换的模块。TTF、MJS、WASM、PDF CMap 等资源纳入静态规则，不再依赖通用页面回退路径的默认缓存行为。业务 API、预览与附件继续遵循各自鉴权和缓存边界，不启用共享业务响应缓存。

Docker 前端镜像在前端构建后运行 `scripts/precompress-web-assets.mjs`，为压缩后确有收益的公开文本、字体及解码资源生成 gzip 副本；Nginx 通过 `gzip_static` 按请求协商发送，并设置 `Vary: Accept-Encoding`。未预压缩的响应仍可动态 gzip。原文件保留，未声明 gzip 的客户端继续使用原格式；不重复压缩 PNG、WOFF2 等已压缩资源。

主应用的后端静态入口及 `/applications/arca/`、`/applications/pictoria/` 共用 `StaticAssetService.response`，提供 ETag、Last-Modified、HEAD 和条件命中的 304，条件命中时不读取或传输文件正文。固定文件名不标记 immutable，内容哈希资源允许长期复用。开发代理继续保留 `no-store`，便于 HMR 与源码更新；不将生产缓存规则套到开发接口。

Web 主面板不在首屏后自动预热工作区编辑器与据点模块，改由用户导航时按需加载；Electron 保留本地资源的空闲预热。镜像验收入口 `scripts/docker-runtime-smoke.mjs` 实际比较 gzip 与未压缩资源内容，并验证主模块及像素字体的缓存响应与 304；该验收依赖真实构建镜像，不能由配置文件存在性代替。

## 2. 核心设计原则

```
┌───────────────────────────────────────────────────────┐
│                    严格隔离原则                         │
│                                                       │
│  packages/backend/   →  0 个 Electron 依赖            │
│  packages/frontend/  →  0 个 Electron 依赖            │
│  packages/shared/    →  0 个 Electron 依赖            │
│  electron/           →  仅做壳层                       │
│                                                       │
│  业务 API 连接所选 Daemon（本地或远程）                │
│  IPC 仅用于 Electron 专属的系统能力                    │
└───────────────────────────────────────────────────────┘
```

---

## 3. 通信架构

### 3.1 Electron 桌面版

```text
Electron Main
  ├─ 本地模式启动打包内置 Daemon；远程模式连接所选服务
  ├─ 注入 PERO_DATA_DIR、PERO_APP_ROOT、PERO_WORKSHOP_DIRS
  ├─ 注册 asset:// 只读资产协议
  ├─ 提供窗口、托盘、Steam 与桌面能力
  └─ Renderer 通过 HTTP/SSE/WS 访问 Daemon

Daemon
  ├─ 初始化 SQLite、TriviumDB、Agent、Scheduler
  ├─ 维护后端持久资源权威
  └─ 通过 Capability Provider 向 Electron 请求平台能力
```

Electron 本地模式启动 Daemon 是桌面全包发行的进程编排方式；远程模式连接已有 Daemon。Daemon 也能在 Docker/服务器形态独立运行。

**客户端连接规则**：Electron 标准版、Steam 版和便携版在本地开屏后、任何 Daemon 拉起之前读取用户根目录的 `client-connection.json`。首次启动或远程验证失败时显示本地 HTML 连接页；本地模式按原有链路启动，远程模式校验服务器身份后统一切换业务 HTTP/SSE/WS 和能力通道，失败不能自动回退本地。凭据经系统密钥服务加密。托盘与“分布式”Tab 均可打开连接页，运行中修改只写下次启动配置并重启，旧窗口和退出清理继续使用原连接。远程退出不停止服务器上的共享子应用。远程模式禁用本机 Steam 业务快照上传和恢复，服务器数据由服务器备份；设备身份、连接配置和凭据不进入业务快照。

**自部署 HTTPS 与证书信任**：允许使用 IP 和自签证书。保存远程连接时，主进程先建立不发送应用数据的 TLS 握手，读取公开叶证书；未受系统信任或与已保存指纹不同的证书需要用户在原生确认框核对 SHA-256 指纹、签发者和有效期。未确认前不发送访问令牌；默认按钮为取消，取消、鉴权失败或保存失败都保留原配置。过期或尚未生效的证书需在服务端修复或校准设备时间，不能通过确认绕过。

信任记录作为公开证书及指纹保存在本机 `client-connection.json` 的 `trustedCertificates` 字段，按 HTTPS 入口保存，切换本地模式仍保留历史信任。主进程业务请求通过 `fetchBackend` 使用专用 CA、叶证书指纹和禁用会话复用的 Agent；能力 WSS 使用同样的 TLS 选项，Chromium 页面在 Session 验证回调中仅接受当前业务主机已确认的叶证书。系统其他服务与站点继续使用各自正常验证规则；不会写入系统证书库，也不会设置全局跳过 TLS 校验。

默认能力地址仍为同主机的 9121 端口，可复用相同叶证书。能力入口使用不同证书或不同主机时，在高级选项中显式填写地址并单独核验；其 HTTPS／WSS 反向代理和端口映射仍由服务端部署负责，客户端信任证书不会自动公开 Docker 默认绑定回环地址的能力端口。Chromium 页面按当前业务主机使用业务证书，独立 Node 能力通道按其入口选择证书。证书变化后的后台重连不自动更换信任，需要重新打开连接设置确认；服务器业务身份仍独立校验，不因接受新证书而自动接受不同 `serverId`。

实现入口：`electron/main/services/remoteCertificates.ts` 负责证书探测及 Node TLS 请求，`remoteCertificateUi.ts` 负责确认、Chromium 验证及错误分类，`clientConnection.ts` 负责与连接配置一起落盘。连接页区分证书、鉴权、身份变化、超时、拒绝连接及服务器响应错误；回环 HTTPS／WSS 回归入口为 `remoteCertificates.test.ts`。

**大备份导入**：以下路径均以 `/api/backups` 为前缀：`POST /imports` 预约一项导入，`PUT /imports/:id/content` 流式接收原包后返回 202；解包与预览继续由 `BackupImports` 持有，`GET /imports/:id` 查询阶段与接收／解包计数，`DELETE /imports/:id` 取消。服务端已有备份通过 `POST /:id/import` 使用同一进度链路，取消不会删除原备份。完整库 `integrity_check` 在受控 Worker 中运行，局部记录冲突检查分批让出事件循环。分行器按字节限制并保持背压，格式仍为 `infos.backup` v1，文件、行与解压总量限制继续有效。旧 `/previews` 入口保留兼容。

选择本机文件时，前端 `backupFile.ts` 最多读取 4118 字节，识别格式及加密状态，再展示文件名、大小和独立的导入口令输入。未加密包不要求口令；加密包缺口令时不预约上传。`POST /imports` 可携带该头部的 base64 `prefix`（上限 5492 字符）；服务端在预约前检查头部，并用解密后的 gzip 固定前缀排除明显错误的口令。预检失败保留浏览器中的文件选择，可修正口令重试，不发送整包。该前缀检查不提供完整性或密码正确性的密码学证明，完整 GCM 认证、解压、文件摘要和数据库检查仍须在收齐原包后通过；不会将未认证的解密内容安装到业务目录。旧调用方可省略 `prefix`，继续沿用整包校验。服务端已有备份也先执行同一有界预检，再启动解包。

预约响应的 `uploadChunkBytes` 表示服务端支持分片，当前每片最多 1 MiB。Web 使用同一内容端点和 `Content-Range: bytes 起点-终点/总字节数` 顺序上传；每片完整写入并关闭后才推进 `receivedBytes`，最终片确认后再进入解包。片内断线会截回上一确认位置；重复的已确认片只返回状态，不追加数据。客户端发生断线、408、409 或 429 时先查询位置并有限重试，不重新上传已确认部分。取消或超时会清理片间暂存文件并释放导入名额。此进度仅保存在当前服务进程中，不支持服务重启后的跨进程续传。

分片文件使用可截断的读写句柄，按确认偏移显式定位并处理底层短写；中断时恢复文件长度，不依赖 Windows 追加句柄的截断行为。

未返回 `uploadChunkBytes` 的旧服务端继续使用整包上传，更新后的服务端也保留不带 `Content-Range` 的旧请求。分片不改变整包格式、总大小上限或最终校验，不直接写入业务数据库。Docker 的备份代理路径使用独立的 `^~` 前缀，关闭请求缓冲并保留长请求超时；外层反向代理仍须允许至少 1 MiB 的二进制请求和 `Content-Range` 请求头。磁盘不足会明确报告，不能作为口令或文件校验错误隐藏。

导入同时只允许一项，与备份创建和导入确认互斥；口令仅留在本次操作内存，不进入操作响应或浏览器存储。处理结束后的编号与未确认预览保留约一小时，操作记录最多八项；客户端用按服务器区分的 `sessionStorage` 找回编号。切页或预览阶段断网不会自动取消服务端处理，断网后继续查询；可恢复的分片断流保留已确认部分，取消、不可恢复的上传失败和校验失败清理私有暂存文件，不修改业务目录。服务重启后操作编号失效，需要重新选择文件或服务端备份，不支持跨进程续传。后端各 HTTP 监听的请求接收上限与 Nginx 对齐为一小时，导入另有两分钟上传无进展时限及三十分钟 SQLite 校验上限。确认后的离线恢复、快照一致性边界与数据卷安装机制不变。

**确认与重启**：上传、预览就绪和恢复完成是不同状态。确认方案仅写入待恢复计划，当前业务数据仍在使用；前端立即显示下一步弹窗和持续可见的指引，不以附加刷新请求成功作为暂存成功的条件。`GET /api/backups` 根据服务端 `INFOS_DOCKER=1` 返回 `runtime: docker`，否则为 `server`。Docker 指引提供在部署目录执行的 `docker compose restart backend` 与复制按钮；桌面本机连接提示完全退出再打开应用，其他远程连接提示由管理员重启后端。浏览器刷新与重启 frontend 容器不能执行恢复。

有待恢复计划时，页面可见且处于当前 Tab 才每三秒查询服务端列表；短暂断线继续等待，切页暂停，返回恢复。重启后以服务端持久化的 `lastImport` 显示完成或失败；完成时提供重新载入界面的入口，提醒检查角色、模型连接及恢复数据，失败时提示检查服务端日志。Docker 长时间不可达时展示 `docker compose logs --tail=100 backend`。Web 页面不直接操纵 Docker，也不自动触发服务重启。

恢复后的 TDB 运行期锁补建规则见 [TriviumDB 接入规范](./A05_MEMORY_ENGINE.md#5-triviumdb-接入规范)。缺少被备份排除的锁文件不能误判为主库丢失，也不能通过清空索引掩盖启动错误。

### 3.2 Docker 后端版

```text
┌─────────────────────────┐     ┌──────────────────────┐
│ 前端容器 (Nginx)         │     │ 后端容器 (Node.js)    │
│                         │     │                      │
│ 静态文件                │     │ @infos/backend       │
│ Vue SPA                 │────→│ HTTP :9120           │
│                         │     │ WS   :9120           │
│ Transport: HttpTransport│     │                      │
│ (无 IPC，走 HTTP 替代)   │     │ SQLite + TriviumDB   │
└─────────────────────────┘     └──────────────────────┘
```

---

## 4. IPC vs HTTP 能力划分

### 4.1 仅 IPC 的能力（Electron 专属）

窗口、桌宠、托盘、Steam 和本地客户端连接等能力由 Electron 主进程提供。预加载层通过 `window.electron` 暴露 IPC；例如 `window-minimize`、`window-close` 和 `open-pet-window`。主进程的通道及访问限制以 `electron/main/ipcBridge.ts` 和 `electron/preload/index.ts` 为准。浏览器端按功能使用浏览器能力或提供对应的不可用状态，具体处理见 `packages/frontend/src/utils/ipcAdapter.ts`。

主进程启动图中的托盘、内置 Daemon 管理、资源恢复与耳朵运行时统一使用静态导入。服务的创建、启动、停止和退出保存由生命周期调用控制，模块求值与实际服务启动分别管理。资源扫描、更新、NapCat、浏览器运行时等独立功能继续按调用路径动态加载。云存档的保存队列、快照传输及兼容入口加载关系见 [Steam 集成](./M04_STEAM_INTEGRATION.md)。

### 4.2 走 HTTP 的能力（两种模式通用）

| 能力             | 接口                                    |
| ---------------- | --------------------------------------- |
| 所有业务 API     | `GET/POST/PUT/DELETE /api/*`            |
| 聊天流式         | `SSE /api/chat/stream`                  |
| 配置管理         | `/api/configs`                          |
| 记忆 CRUD        | `/api/memories`                         |
| Agent 管理       | `/api/agents`                           |
| Gateway 实时通信 | `WS /ws/gateway`（版本化JSON Envelope） |

---

## 5. 前端运行时检测

`packages/frontend/src/utils/ipcAdapter.ts` 的 `isElectron()` 检查预加载桥接；`api/transport.ts` 的 `isElectronRuntime()` 与 `isLocalBackendRuntime()` 分别判断桌面运行环境和本地连接。Electron 的服务器地址来自主进程选择的连接，浏览器使用当前来源或所选服务器。浏览器访问可能连接 Docker、开发环境或其他部署，运行环境判断与服务端部署形态应分别处理。

---

## 6. 多目标构建矩阵

### 6.1 构建变体总览

| 变体 | 平台 | 产物 | 更新方式 |
| --- | --- | --- | --- |
| Steam 版 | Windows x64 | NSIS 及目录产物 | Steam |
| 标准版 | Windows x64 | NSIS 安装包 | 自有 Release 更新服务 |
| 便携版 | Windows x64 | ZIP | 自有 Release 更新服务 |
| Docker 版 | Linux 容器 | 前后端镜像及 Compose 文件 | 拉取所选版本镜像 |

发行范围和实际产物以 `.github/workflows/release.yml`、根目录的 Electron Builder 配置为准。Linux 和 macOS 桌面包属于后续平台方向。

### 6.2 版本与平台

发行脚本使用 `INFOS_EDITION` 区分 `standard`、`steam` 和 `portable`。Steam 功能在运行时受 Steam 环境检查约束；其原生依赖和 SDK 文件只由 Steam 构建配置打入。具体构建和运行时检查分别见根目录 `package.json`、`electron-builder.*.yml` 与 `electron/main/services/steam.ts`。

### 6.4 Electron Builder 配置矩阵

```
项目根目录/
  ├── electron-builder.base.yml       ← 共享配置
  ├── electron-builder.steam.yml      ← extends base + Steam 文件
  ├── electron-builder.standard.yml   ← extends base
  └── electron-builder.portable.yml   ← extends base，输出 ZIP
```

### 6.5 构建脚本

根目录 `package.json` 提供 `electron:build:standard`、`electron:build:steam`、`electron:build:portable` 和 `docker:build` 等脚本。桌面构建还包含安全检查、主应用与官方子应用构建、Daemon 依赖收集和原生依赖适配；CI 使用的完整步骤以 Release workflow 为准。

### 6.6 便携模式 (Portable)

打包运行时，`.exe` 同级的 `.portable` 标记启用便携模式；用户根目录是可执行文件所在目录，业务数据写入其 `data/` 子目录。标准安装版与 Steam 版使用系统 `userData/data`，开发模式使用 `~/.infos`。路径由 `electron/main/utils/env.ts` 管理。

### 6.7 自动更新策略

| 变体            | 更新机制           | 说明                    |
| --------------- | ------------------ | ----------------------- |
| Steam 版        | Steam 自带         | Depot 更新，零代码      |
| 标准版 / 便携版 | 自有 Release 更新服务 | 从 GitHub Releases 下载 |
| Docker 版       | `docker pull`      | 用户手动或 CI/CD        |
| Linux / Mac     | 待定               | 随平台实现一起确定      |

更新入口为 `electron/main/services/updater.ts` 与前端 `UpdateCenterDialog.vue`，不是 `electron-updater` 的元数据协议，不依赖 `latest.yml`。按当前部署形态选择 NSIS 安装包或 Portable ZIP。版本列表和下载都使用 Electron `net.fetch`，共享系统代理配置；下载逐跳限制 HTTPS GitHub 来源，校验 Release 声明的大小，存在 SHA-256 摘要时必须按流验证，安装交接前再次验证磁盘原包。每次下载使用独立暂存目录和固定文件名，不使用远程版本串拼接可删除的目录。在线列表成功但缓存写入失败时仍返回在线结果；离线仅允许回退到重新筛选后非空的版本列表，并明确标注缓存，不把旧空列表当作当前已是最新。后台检查、下载和安装互斥，重新检查不会丢弃已下载的有效包。

`updateInstaller.ts` 生成带 BOM 的 UTF-16LE PowerShell 助手，路径和日志文案以 UTF-8 JSON/base64 数据传递，不插入可执行的命令正文。助手位于系统临时目录的独立子目录，先取得原进程句柄并写入本次唯一编号的就绪凭据；宿主只在确认该编号后发起正常退出，启动失败或十五秒未接手时保留应用和下载。助手最多等待原进程退出三分钟；未保存内容导致取消退出时，主进程写入取消标记，失败则终止仍处于等待中的助手。新尝试更新所有者编号，迟到的旧助手不能覆盖新尝试的结果。

标准版助手按原 EXE 的目录固定 `/D` 目标，通过匹配卸载注册表的 `InstallLocation` 识别安装范围，传入 `/S --updated --force-run`，保留 NSIS 自身的权限提升流程。`/D` 位于参数末尾，路径不经过 cmd 的代码页、变量展开或元字符解析。便携版先检查源、目标不相同且互不嵌套，并确认双方 `.portable` 标记；复制排除业务 `data` 与目录联接，只接受 robocopy 的非失败退出码。两种形态都检查安装后 EXE 的 ProductVersion，随后记录文件安装结果；标准版由 NSIS 重新打开应用，便携版由助手重新打开。

安装回执位于 `data/cache/client-update-install.json`，保存目标版本、阶段、退出码或内部错误及日志路径；助手日志与启动诊断保留在业务日志目录的 `client-update-*.log`。下次启动以实际 `app.getVersion()` 判断是否已达到目标版本，不能只凭助手退出码宣告升级完成。未完成的回执在更新中心持续显示，后续后台检查不会掩盖；准备失败保留可重试的已验证下载，窗口提供日志目录与 Release 手动下载入口。宿主退出后发生安装错误时，助手在 Windows 桌面显示包含日志路径的本地化失败提示。Steam、开发环境仍不使用该更新器。旧客户端的更新器无法由新 Release 反向修复，已受影响的旧安装必要时需手动覆盖安装包含修复的新版本一次，再使用后续自动更新；用户数据目录不属于程序覆盖范围。

关键回归入口为 `updaterLifecycle.test.ts`、`updateInstaller.test.ts`、`updateInstaller.windows.test.ts` 与前端 `updateCenterDialog.test.ts`，分别覆盖下载/回执、交接协议、真实 Windows 助手生命周期与窗口状态。隐藏的独立 `cmd` 仅承载系统 PowerShell 路径与 base64 引导，用户路径不会进入 cmd 命令文本；它脱离 Node 作业后等待 PowerShell，启动确认后宿主 `unref`。PowerShell 本身不使用 `DETACHED_PROCESS`，避免未执行脚本便以成功码退出；也不直接作为受 Node 作业约束的子进程，以免随宿主结束被回收。取消标记写入失败时结束整个自有助手树。更新助手的边界替身和真实生命周期验证均不等同于完整安装验收；实际发布验收还需覆盖旧版本安装、中文路径、按用户/全用户范围、UAC 取消与重开新版的完整流程。

### 6.8 第三方 Native Addon

| Addon            | win-x64        | linux-x64   | mac-arm64   | Docker      |
| ---------------- | -------------- | ----------- | ----------- | ----------- |
| `steamworks.js`  | ✅ 仅 steam 版 | ❌          | ❌          | ❌          |
| `better-sqlite3` | ✅ prebuild    | ✅ prebuild | ✅ prebuild | ✅ prebuild |
| `node-pty`       | ✅ rebuild     | ✅ rebuild  | ✅ rebuild  | ✅ rebuild  |

---

### 6.9 NapCat 安装与启动

Windows x64 标准版、Steam 版、便携版及开发环境共用 NapCat 安装器。安装位置统一为 `paths.data/tools/NapCat`，不写入只读应用目录或 asar。官方 Node 发行包的版本与 SHA256 固定在 `electron/main/services/napcat.ts`，启动使用安装包内的 `node.exe`，不要求用户安装 Node 或修改 PATH。

更新保留账号连接配置、WebUI 设置、登录数据和第三方插件；`napcat/plugins/builtin` 属于官方内置程序，随发行包同步更新，其设置仍保存在受保护的 `config/plugins` 下。旧内置插件与当前事件接口不匹配时，即使 NapCat 核心版本相同也会显示更新修复入口。根目录 `config.json` 是 QQ 版本元数据，必须和 `package.json`、原生程序文件同步更新；已有安装在启动前校验程序文件，并按同包 QQ 清单校正旧版本元数据。程序文件缺失或 QQ 清单不一致时阻止启动并提示重新安装，不清空账号数据。

安装器先验证归档完整性与版本，再覆盖程序文件；覆盖期间保留 `.infos-installing` 标记，全部校验成功后才移除。中断安装会显示更新入口，并阻止继续加载混合版本。退出时结束本次启动的 Windows 进程树，避免 Worker 残留占用原生文件。

4.18.38 的已知运行问题在安装预检和启动预检中按版本及接口布局修复：未指定游标的空历史返回空数组，明确游标查询失败仍保留错误；引用消息缺少元数据而使用序号查询属于调试诊断，真正的解析失败仍保留错误日志。群历史接口按 `GoCQHTTP_GetGroupMsgHistory` 识别，枚举命名空间及局部变量从代码中定位。修复原子写入并可重复执行，未知版本不修改，接口布局不匹配时保留原文件并记录诊断，不阻止有效程序启动；程序文件和 QQ 元数据的完整性检查仍然有效。开发环境和 release 使用相同逻辑。

WebUI 的 SPA 回退固定发送 `index.html`，并将静态目录设为 `sendFile` 的根目录，避免 `.infos` 等隐藏安装目录触发 Express 的隐藏文件过滤；不放开任意隐藏文件访问。内嵌管理页使用 `/webui/` 入口，首次加载按来源清理独立管理分区的 Service Worker、CacheStorage 和 HTTP 缓存，保留 Cookie 与 localStorage 登录凭据。就绪探测要求 HTML 文档，200 状态的 JSON 错误不能被当作界面就绪。

## 7. Docker 部署规范

### 7.1 Docker Compose

以仓库根目录 `docker-compose.yml` 为源码构建的权威配置；`docker-compose.release.yml` 是 Release 附件模板，由发布流程填入固定镜像版本。两者均包含 Node 后端和 Nginx 前端，前端等待后端健康检查通过后启动。

`frontend` 默认将宿主机 `3000` 映射到容器 `8080`；`backend` 的 `9120` 业务端口和 `9121` 能力端口默认只绑定宿主机 `127.0.0.1`。`infos-data`、`infos-workspaces` 分别挂载到 `/app/data`、`/app/workspaces`；角色工作区默认位于数据目录的 `principals/<agentId>/workspace`。Compose 变量、登录与设备配对见[用户文档](../packages/wiki/deployment/docker.md)及本文件第 11 节。

### 7.2 运行时选择

| 场景            | 推荐运行时  | 说明                                                         |
| --------------- | ----------- | ------------------------------------------------------------ |
| Electron 桌面版 | **Node.js** | Electron 内嵌 Node.js，无法更换                              |
| Docker 后端版   | **Node.js** | 与 Electron Daemon 保持同一运行时语义，Native Addon 统一验证 |
| Docker 前端版   | **Nginx**   | 静态文件服务                                                 |
| 开发环境        | **Node.js** | `pnpm start` 一键启动                                        |
| CI/CD           | **Node.js** | 兼容性最好                                                   |

---

## 8. 鉴权系统

### 8.1 身份与入口

`ClientAccessService` 是当前设备身份的权威来源，Electron 本地客户端和 Web 客户端的业务请求都经过身份校验。`INFOS_API_TOKEN` 存在时作为管理员凭据，否则使用安装实例的本地管理员凭据。设备可通过一次性配对码或管理员凭据取得自己的设备会话；普通设备与管理员的权限分别检查。

### 8.2 配对与登录

`/api/client-access/pair` 使用短期配对码，`/api/client-access/login` 验证管理员凭据；两者都接收设备名及保持登录选项。服务端颁发设备令牌并写入 HttpOnly、SameSite Cookie；设备令牌摘要和有效期保存在服务端。需要 Bearer 凭据的客户端可显式使用相应的凭据模式。

首次启动时，未配置 `INFOS_API_TOKEN` 且没有已配对设备，服务端日志会提供五分钟有效的首次管理员配对码。管理员在分布式页面生成的新设备配对码同样五分钟有效、仅可兑换一次。保持登录对应 30 天设备会话；未勾选时使用浏览器会话 Cookie，服务端有效期为一天。

### 8.3 持续连接与权限

`app.ts` 校验业务请求，`services/gateway/wsUpgrade.ts` 在 WebSocket 升级时验证设备身份；设备撤销或过期后关闭关联的 Gateway/SSE 连接。管理员操作由各路由继续检查管理员身份；能力通道有独立的节点配对与设备凭据。完整边界和部署入口见第 11 节。

---

## 9. INF Node、Facet 与多节点拓扑

### 9.1 INF Node 定义

INF Node 是具有稳定身份、独立故障边界、能力目录、资源权威和安全凭据的运行单元。Node 不等同于设备、客户端、服务端或安装包；一个 Node 可以启用多个 Facet：

```text
INF Node
├─ Node Kernel
│  ├─ Identity / Trust / Protocol Version
│  ├─ Capability Directory
│  ├─ Resource Authority Directory
│  ├─ Transport / Router
│  └─ Lease / Health / Lifecycle
├─ Server Facet
├─ Client Facet
├─ Capability Facet
├─ Storage Facet
├─ Compute Facet
└─ Gateway Facet
```

标准部署映射：

| 部署形态          | Node Facet                               | 典型权威                                          |
| ----------------- | ---------------------------------------- | ------------------------------------------------- |
| Electron 桌面     | `server + client + capability + storage` | 本地 Workspace、桌面能力、隔离 Browser Capability |
| Tauri 移动端      | `server + client + capability + device`  | 移动端 UI、相册、相机、麦克风、可选本地数据       |
| Docker 云服务器   | `server + storage + scheduler + gateway` | Agent、Memory、Workspace、Durable Event           |
| ComfyUI/GPU 主机  | `capability + compute`                   | 工作流 Runtime、GPU 任务与临时产物                |
| 纯 Web 客户端     | `client`                                 | Surface、Web Input Seat、浏览器文件选择           |
| 远程 Browser Farm | `capability + compute`                   | Browser Profile、Chromium Runtime、下载临时资产   |

物理共机不改变逻辑边界。Electron 内置 Daemon 与 Electron Client 可以属于同一个 INF Node，但仍是独立 Facet，业务调用不得退化为跨层直接 import。

### 9.2 控制面、执行面与资源权威

```text
Control Plane
  Agent / Planner / Policy / Approval / Scheduler / Capability Binding

Execution Plane
  Browser / TTS / ComfyUI / Device Input / OCR / GPU Runtime

Resource Authority
  Workspace / Asset / Credential / Browser Profile / Transfer / Surface
```

一个功能必须分别声明：谁决策、在哪里执行、谁持有资源权威、结果如何传输。调用者所在 Node 不决定执行位置。

### 9.3 Placement Contract

所有 Capability Offer 必须逐步声明：

```text
providerNodeId
providerFacet
executionLocation
resourceAuthorityNodeId
requiresClientPresence
requiresInputSeat
supportsHeadless
dataResidency
networkZone
platforms
latencyClass
costClass
leaseExpiresAt
```

Placement 取值：

```text
server-local
client-local
node-local
remote-capability-node
any-trusted-node
```

Requirement 可以声明硬约束，例如“必须使用当前 Input Seat 所在客户端”“数据不得离开设备”“必须使用服务器网络出口”或“需要 GPU”。Placement Resolver 只能在满足 Requirement、Policy、Trust、Lease 与资源可达性的 Offer 中选择。

### 9.4 资源归属规则

客户端权威资源：

```text
原生文件选择器 / 窗口 / 桌面截图 / 屏幕录制 / 输入设备
剪贴板 / 通知 / Pet3DView / 相册 / 相机 / 麦克风 / 扬声器
```

服务端权威资源：

```text
Agent / Memory / Thread / Task / Workspace / Policy / Scheduler
Package Registry / Durable Outbox / 长期 Asset 元数据 / 长期 Credential Vault
```

可放置在 Capability Node 的执行资源：

```text
Browser / ComfyUI / LLM / Embedding / Reranker / TTS 生成
STT / OCR / 转码 / GPU Vision / Device Automation
```

TTS 必须拆分为“服务端或能力节点生成 Audio Asset”和“客户端 Audio Output 播放”，不能把生成与播放混成一个模糊工具。

### 9.5 单对象单 Authority 一致性

infOS 不采用所有 Node 双向同步同一 SQLite/TriviumDB 的多主模型。每个权威对象在任一时刻只有一个 Authority Node：

```text
Object Ref → Authority Node
写入 → 路由到 Authority
Generation → Authority 提升
Event Sequence → Authority 签发
Handle → Authority 或受委托签发者签发
Replica → 只读 Snapshot/Cache
Authority 不可达 → 写入 fail-closed
```

跨节点一致性依靠：

```text
Node-scoped Object Ref
Capability Handle
Generation / Revision / Sequence
Durable Event / Outbox
Asset / Transfer Object
Lease / Revocation Epoch
Idempotency Key / Deadline
```

禁止通过共享路径、绝对路径、共享数据库连接或未版本化内存对象跨 Node 协作。

多 Server 之间不建立实时副本或自动路由。用户在“分布式”Tab执行“从此服务器上同步最新数据”时，所选 Server 的完整用户数据快照是唯一来源，整体覆写当前 Server 并保留当前机器身份；此后各 Server 继续独立运行，不做自动追平。

完整快照包含聊天记录、请求副本、记忆、配置与其他业务文件；传输密钥只负责加密，不代表访问授权。`createApp` 先用 `ClientAccessService.authenticate` 验证身份，`distributed.router.ts` 再在请求体校验、快照读取和同步服务调用之前检查 `admin`，普通设备返回 HTTP 403 / `FORBIDDEN`，未认证请求返回 HTTP 401 / `UNAUTHORIZED`。未提供认证服务的嵌入式应用也不能绕过管理权限。

生产端通过 `BackupService.captureForSync` 调用 `backup/liveSnapshot.ts` 捕获来源：`MemoryStoreRegistry.captureSnapshot` 在同一个同步边界内 flush 并复制 TDB 文件组，回调为主库和子应用 SQLite 建立独立只读连接，以 `BEGIN` 和实际读取固定视图。随后使用 SQLite Online Backup 分步导出，每步 100 页，步骤之间由驱动让出事件循环；WAL 模式下业务连接可继续提交新事务，导出保留边界前的视图。使用回滚日志的外部子库在读事务结束前仍可能等待写锁，因此优先导出子库、及时关闭读连接。TDB 的 flush 和文件组复制仍在同步边界内完成。

普通文件在边界内登记路径与版本，后续通过异步文件复制导出；支持的文件系统可使用写时复制。复制前后核对源文件大小、修改时间、变更时间和文件身份，捕获期间发生改写或删除即中止本次快照，交由调用方重试。边界后的新文件留到下一次捕获。HTTP 断开会将取消信号传入捕获、摘要读取和压缩；导出失败或取消后释放固定读事务，再清理专用暂存目录。同一同步服务一次只导出一份快照，重叠请求返回 `RESOURCE_BUSY`；服务关闭时也先取消正在捕获的数据库视图。

`packages/shared/src/snapshotPaths.ts` 统一界定 NapCat 安装范围内可重新安装的程序、运行日志和缓存，后端快照与 Electron 修改检测使用相同规则；兼容旧的 `data/tools/NapCat` 路径和 `data/logs`。账号配置、账号数据库、快速登录选择、第三方插件与其他未知业务文件继续保存，工作区中的同名路径按用户资料处理。恢复时 `installBackupTree` 将目标端已有的发行程序补入影子目录，再按恢复事务安装来源配置与业务资料；新设备按发行渠道安装 NapCat 程序。

根目录 `client-language.txt` 和 `client-default-agent.txt` 分别保存本机客户端的启动语言与默认角色。导出、在线捕获和 Electron 云存档修改检测共用客户端缓存排除规则。正式语言配置及角色资料随主库保存，客户端偏好由各设备维护。恢复时沿用目标端缓存的存在状态与内容，旧完整备份和同步快照中的这些文件在正文校验后跳过安装。工作区内的同名文件仍作为用户资料保存。

`DistributedSyncService` 导出 `bundleVersion: 3` 的压缩二进制快照：AES-256-GCM 封装保持 `12 字节 IV + 16 字节认证标签 + 密文`；解密后的 `INFOSS3\n` 标识后是 gzip 数据，内容依次为 4 字节大端清单长度、JSON 清单和按清单顺序排列的原始文件字节。`syncArchive.ts` 按 256 KiB 读取文件，导入按解压流逐块核对长度与 SHA256；正文不转成整文件 Base64，也不拼接整包 JSON。导出期间再次校验文件摘要，来源改变时停止生成该包。清单上限 32 MiB、文件数上限十万、单文件上限 2 GiB、原始正文合计上限 20 GiB；HTTP 适配器仍在内存中收集完整压缩密文，实际传输规模还受可用内存和请求时限约束。

接收与重启应用共用格式、来源、路径和摘要校验，暂存时只换成本机密钥重新加密原有压缩载荷，校验失败不会登记待恢复快照；重启时先写入隔离目录，完整验证后再建立恢复点并安装。旧版 `bundleVersion: 1/2` 的 JSON/Base64 快照及旧暂存目录继续可读。旧客户端无法读取 v3 压缩载荷，多 Server 互传或跨设备恢复新快照时，接收端须同步升级。

| `/api/distributed` 接口                                                             | 权限与调用方                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /identity`                                                                     | 已认证设备；远程客户端启动校验和 Server 探测使用                                     |
| `GET /servers`、`POST /servers/probe`、`POST /servers`、`DELETE /servers/:serverId` | 管理员；管理远程来源与探测目标                                                       |
| `POST /snapshot`、`POST /snapshot/import`                                           | 管理员；Server 全量传输与本机 Steam Cloud 快照使用                                   |
| `POST /sync/:serverId`、`GET /pending`、`POST /rollback`                            | 管理员；发起覆盖、读取同步状态与暂存撤销                                             |
| `POST /capability-invites`、`GET /capability-nodes`                                 | 沿用已认证设备权限；远程 Electron 申请能力通道邀请和查看连接状态使用，不授予全库权限 |

`DistributedSyncService.stageFromServer` 将保存的目标端凭据作为 Bearer 请求远端 `/snapshot`。当前没有专用的 HTTP 同步节点令牌；合法同步节点使用目标端 `INFOS_API_TOKEN`、安装实例管理员凭据或有效的管理员设备会话。能力通道的配对码和 `kernel/capability-device-tokens.json` 中的设备令牌只由 `CapabilityBridge` 验证，不能用于 HTTP 快照接口，也不能凭 Node ID 或注册信息获得管理员权限。使用普通设备令牌保存的旧同步来源须由管理员更新为目标端管理员凭据；管理员凭据的同步协议、快照格式和机器身份保留规则不变。手机和普通远程客户端继续复用服务端业务数据，无需取得全库导入导出权限。前端 `DistributedTab.vue` 在服务器列表或同步状态返回 `FORBIDDEN` 时只隐藏服务器管理与同步卡片并提示需要管理员凭据，当前服务器身份与能力节点仍照常显示。

### 9.6 跨节点文件与资产

```text
Client File Picker
→ Client File Handle（authorityNodeId=client）
→ Placement 判断
├─ Client Browser：本地消费，不上传 Server
└─ Server Browser：Transfer → Server Asset → Server File Handle
```

Windows 路径不能发送给 Docker/移动端作为资源标识。跨 Node 只传 Asset Ref、File Handle、Transfer Ref 或有界二进制流。

### 9.7 Electron Browser Capability

首期 Browser 功能不是 Application，而是 Electron Client 发布的可选 `web.page` Capability。主 Agent 只看到 `browser_*` Tool；Tool 通过 Capability Handle 调用 Electron Provider。没有 `web.page` Offer 时，CapabilityGate 不暴露 Browser Tool，或调用明确返回 `CAPABILITY_UNAVAILABLE`。

```text
Principal Agent
→ browser_* Tool
→ web.page Capability Handle
→ electron.browser.web-page
→隔离 BrowserWindow / WebContents
```

Electron 自带 Chromium 内核，可直接创建专用 Browser Runtime，不要求用户安装 Chrome。该 Runtime 必须与 infOS 主 Renderer 隔离：

```text
独立 persistent session partition
nodeIntegration = false
contextIsolation = true
sandbox = true
主窗口与 Browser页面不共享 preload/API
Navigation与 window.open受 Policy限制
Permission Request显式审批
Upload经 Client File Handle
Download进入 Electron Client Asset/Transfer Authority
Cookie / Cache / Profile归 Electron Client Node
```

Browser Runtime 可隐藏运行，也可在需要用户观察、登录或审批时展示同一个隔离 WebContents。不得用 infOS 主窗口 Renderer 直接加载不可信网页，也不得默认控制用户日常 Chrome Profile。

非 Electron 客户端默认不提供 Browser Capability：

```text
纯 Web Client      无本地 web.page Offer
移动/Tauri首期     无本地 web.page Offer
Docker Daemon      不自动启动服务器 Chromium
Electron Client    发布 electron.browser.web-page
```

首期禁止在缺少本地 Provider 时自动回退服务器浏览器，因为这会改变 Cookie、登录态、下载 Authority、数据驻留和隐私语义。未来远程 Browser Farm 必须由用户显式安装或绑定，并作为独立 `web.page` Offer 出现。

生产装配已经迁移为：

```text
Backend / Kernel
├─ Browser Tool定义
├─ CapabilityGate / Binding / Policy
└─ Electron能力上下线管理

Electron Capability Provider
├─ BrowserWindow / WebContents生命周期
├─ web.page Provider
├─ Browser Session / Profile
├─ Cookie / Download / Upload边界
└─ Electron WebContents控制适配
```

Backend Container 不再安装 `infos.browser`、不发布 `server.browser.chromium`、不启动 Chromium 子进程，也不拥有 Browser Profile。非 Electron 部署因此自然不带 Browser 功能。旧 `ChromiumWebRuntimeDriver` 与 `BrowserAgentApplication` 仅作为未装配的研究代码保留。

#### 只读旁观画面

Electron 的 `web.page/observeFrame` 提供独立的只读 JPEG 采集，不进入 Agent 操作队列，不调用导航、输入、视口模拟或标签激活，也不续期临时页面的空闲生命周期。画面来自实际目标的当前视口；压缩后的输出最大宽度为 960 像素、单帧 JPEG 上限为 384,000 字节。采集超时三秒返回暂停状态，尚未结束的采集不会叠加新请求；Agent 正式截图正在采集时，旁观返回等待状态。旁观帧没有 `screenshotId`，不能用于 Agent 的坐标操作，也不会作废已有操作截图。

`browser_open_url`、`browser_search` 和 `browser_status` 的可选 `preview` 参数只表达展示意图：`true` 请求展开，`false` 请求后台，不传则沿用。后台工具绑定按可信执行上下文登记旁观会话，观看端不能传入浏览器目标或账号作用域。普通对话使用角色隔离的 `desktop` Profile，并按 Thread 与后台任务分别维护活动页面；社交渠道继续沿用其账号 Profile。旧的未限定共享 Profile 不自动迁移 Cookie，升级后普通对话可能需要重新登录网站。

`/api/browser-observer/sessions` 与 `/api/browser-observer/sessions/:id/frame` 沿用主应用设备鉴权，并在每次请求中复查 Agent/Thread 归属。会话 ID 绑定提供节点、对象代际与浏览器作用域：同一提供者重连后重新绑定端口并恢复观看，不要求 Agent 再次调用工具；换绑其他节点时，旧会话不能读取新节点的页面。帧按需经现有能力传输返回，不进入数据库、对话历史或模型上下文；HTTP 禁止缓存，服务端短期复用采集并在一秒后释放帧缓存。

会话发现包含当前 Thread 以及向该对话交付结果的后台任务；子任务按真实父任务链核对归属（最多八层，遇到环停止），不混入其他对话或渠道的任务。小窗默认跟随最近使用的浏览器会话，用户手动选择后保持所选；任务详情通过任务专属 Thread 复用同一旁观组件，保留抽屉内的键盘焦点边界。

前端 `BrowserObserver.vue` 在当前对话中发现会话，展开时按约 750 毫秒间隔串行请求最新画面，采集与传输耗时会降低帧率。拖动、八方向调整大小及放大缩小只改变观看端矩形，图片等比缩放并留边。收起、页面隐藏、切换对话或组件停用会取消观看请求并停止后续取帧；手动选择按服务器、角色、Thread 和任务写入当前窗口的 `sessionStorage`（最多 128 项），组件重挂载及节点重连后仍优先于 Agent 的重复展开意图。存储被禁用时退回组件内状态。节点离线或传输失败显示暂停并重试，页面关闭显示关闭状态。纯 Web 客户端可观看已连接 Electron 节点的画面，Docker 本身仍不提供独立浏览器执行端。

源码入口：`electron/main/services/browserRuntime.ts`、`packages/backend/src/capabilities/browserToolRuntime.ts`、`packages/backend/src/routers/browserObserver.router.ts`、`packages/frontend/src/components/chat/BrowserObserver.vue`。

### 9.8 远程连接与多 Server

客户端可以连接一个 Control Authority Server，同时向该 Server 注册自身 Client/Capability Facet。多个 Server 同时在线时，必须按对象 Authority 路由，不能使用“当前连接的任意 Server 都可写”规则。

```text
Client Node
├─ Control Session → Principal Authority Server
├─ Capability Session → 发布客户端能力
└─ Surface Session → 接收目标客户端 Surface

Capability Node
└─ Provider Session → 发布 Offer / Health / Lease
```

GatewayHub 只是 WebSocket Carrier Adapter，不是 Node Registry。Node Identity、Trust、Facet、Offer、Authority 与 Lease 由独立 Node Foundation 管理。

### 9.9 故障与重连

- 连接 ID 不等于 Node ID；重连产生新 Session，但保留 Node Identity
- Offer 与 Authority Lease 到期后立即停止新绑定
- 运行中调用受 Deadline、Cancellation 与 Idempotency Key 约束
- Node 断线使临时 Handle 和 Input Seat Lease 失效
- 远程执行结果必须具有合法前缀，不能在超时后静默提交不可逆副作用
- Authority 迁移必须显式提升 Epoch/Generation，旧 Handle 全部失效

### 9.10 Node Host 可部署单元

Node Host 以当前 monorepo 中可独立构建、打包和发布的 Package 实现：

```text
packages/node-sdk
  Provider ABI / NodeTransport / Invocation / Cancellation / Receipt

packages/node-host
  Identity / Pairing / Session / Lease / Provider Runtime / Diagnostics
  Echo Provider / Asset Probe / Loopback WebSocket Probe
```

`node-host` 可以部署到 AutoDL、VPS、GPU 工作站或 Browser Farm，但它不是缩小版 Backend。它不得包含 Agent Loop、Memory、Thread、Workspace Authority、Policy Authority、Scheduler Authority 或完整业务 API。

生产 Node Host 的职责限定为：

```text
持久 Node Identity
配对与证书
主动出站连接唯一 Home Server
建立 Node Session
发布受验证 Offer
加载 Provider
接收 Invocation
校验 Deadline / Cancellation / Idempotency
执行 Provider
返回 Receipt / Asset Ref
上报 Health / Lease / Diagnostics
```

首个生产 Provider 为 `system.shell`。它让 Server Agent 通过与现有多终端工具一致的会话式工具操作能力节点本机的 Bash、Python、进程和文件，而不是让 Server 再通过 SSH 登录节点。远程终端作为与浏览器、Computer Use 并列的独立高级工具包，默认隐藏在二级工具抽屉中，只有当前 ReAct 调用 `expand_advanced_tools` 后才向模型展开：

```text
remote_terminal_create / list / get / read / wait / write / interrupt / kill / close
→ system.shell Capability Handle
→ Capability Node 出站 WSS Session
→ 节点本机 Shell Runtime
```

远程终端工具必须显式携带目标 `node_id`，不得隐式选择任意在线算力节点。跨节点文件结果必须转换为 Asset/Transfer，不能把 Linux 绝对路径当作 Server 可访问路径。

远程终端采用独立且更简单的审批规则：

```text
Char Ops 自动执行关闭 → 每一次 remote_terminal_* 调用 100% 强制审批
Char Ops 自动执行开启 → 每一次 remote_terminal_* 调用 100% 不审批
```

该规则不读取命令风险等级、不继承本机终端的逐项例外，也不允许 `allow_session` 或历史永久授权绕过“非自动执行模式逐次审批”。CapabilityGate、节点在线状态、Handle、Deadline、Cancellation 与审计仍然始终生效。

第一版以通用 Shell 为主，Agent 可以自行使用 Bash/Python/curl 操作 ComfyUI、CUDA 和训练脚本；高频 ComfyUI Workflow 后续可作为结构化 Provider 增补，不阻塞通用远程节点操作。

当前已实现 Provider ABI、本机 `system.shell`、一次性 Pairing Code 换取持久设备 Token，以及 Capability Node 主动出站连接 Home Server 的 WS/WSS 客户端。Node Host 可通过以下环境变量运行：

```text
INFOS_HOME_SERVER=wss://home.example.com:9121
INFOS_PAIRING_CODE=<分布式 Tab 生成的一次性配对码>
INFOS_NODE_IDENTITY_PATH=/var/lib/infos-node/identity.json
infos-node-host
```

首次配对成功后，设备 Token 写入 Identity 同目录的 `home-server-credential.json`，后续重启不再需要 Pairing Code。生产部署仍必须由反向代理或 Server 端提供可信 WSS/TLS 终止；公网证书链、Linux 服务安装包、自动升级、NAT 特殊环境和真实 AutoDL/ComfyUI 黑盒验收属于发布环境工作，不得用本地 Loopback 测试冒充完成。

身份模型采用：

```text
Server 创建一次性 Pairing Code
→ Node Host 生成 Ed25519 密钥对
→ 提交 Code + Public Key + Descriptor
→ Server 签发短期 Node Certificate
→ 后续 Session 使用证书身份
→ 证书撤销或 Trust Epoch 提升使旧 Session 失效
```

开发探针可以使用本地自签名证书记录验证身份与过期语义，但不得将 Loopback WS 的明文 Carrier 描述为生产安全连接。

### 9.11 Node Host Provider ABI

Provider 必须声明 Definition、Offer Template、资源种类、Placement、配置 Schema 和生命周期，并实现：

```text
start(scope)
health()
invoke(envelope, context)
cancel(invocationId)
stop()
```

Provider 不能直接注册到 Server CapabilityDirectory；Node Host 先验证 Provider Manifest，再通过 Node Session 发布 Offer。Server 仍负责 Trust、Placement、Handle、Policy 与 Authority 裁决。

Echo/Asset 是首个标准探针：

```text
Echo Invocation
→ Node-bound Envelope
→ Provider Receipt
→ 合法状态前缀

Asset Invocation
→ 输入 Asset Payload + Digest
→ 节点校验 Digest/Size
→ 生成结果 Payload + Digest
→ Transfer Receipt
```

探针只证明 Provider ABI、Transport、Cancellation、Deadline、Idempotency、Receipt 和 Asset 完整性，不替代后续流式 Cross-node Transfer。

---

## 10. 跨平台路径管理

**路径严禁硬编码**。所有运行时路径应从统一工厂函数获取。

详见 [A07_CROSS_PLATFORM.md](./A07_CROSS_PLATFORM.md)。

### 10.1 逻辑前缀映射 (PathResolver)

| 前缀         | 含义                | Electron 映射            | Docker 映射      |
| ------------ | ------------------- | ------------------------ | ---------------- |
| `@app/`      | 安装程序目录 (只读) | `resources/`             | `/app`           |
| `@data/`     | 用户可写数据        | `%APPDATA%/infOS/`       | `$PERO_DATA_DIR` |
| `@workshop/` | Steam 创意工坊      | `steamapps/workshop/...` | ❌ 不支持        |
| `@temp/`     | 运行时临时文件      | 系统 TEMP                | 系统 TEMP        |

### 10.2 覆盖优先级 (AssetRegistry)

```
@data/custom/ (手动覆盖) > @workshop/ (创意工坊) > @app/ (内置资源)
```

---

## 11. 局域网主应用与手机浏览器

手机浏览器和 Electron 主应用访问同一个 Daemon。会话、工作上下文、模型调用、文件与终端任务始终属于服务端；移动浏览器只负责显示、输入、文件上传和下载。关闭网页不会启动另一个服务端，也不会将工具执行移到手机。

### 11.1 桌面版入口

在桌面端「分布式 → 局域网与设备」开启局域网访问，选择空闲端口并应用。默认独立端口为 `9122`，默认关闭；本机业务端口 `9120` 与能力通道 `9121` 保持原有职责。关闭此入口会断开局域网连接，电脑端继续使用本机入口。Web/Docker 端同一区域显示为「服务访问与设备」，使用设备可达的服务端 IP 或域名配对；Docker 入口由端口映射或反向代理管理。

此开关控制独立网页入口；已有 `PERO_HOST` 显式监听、Docker 端口映射或外部反向代理仍由各自部署配置管理。

开启后选择手机可访问的网卡地址，生成二维码或配对码。手机使用系统相机扫码后在浏览器打开，也可手动输入地址和配对码。首次启用如遇系统防火墙提示，需要允许所用运行时在专用网络接收入站连接；程序不自动改写防火墙规则。

配对码五分钟有效、仅能兑换一次，重新生成会使上一枚失效。二维码使用 URL fragment 携带短期代码，兑换成功后移除；二维码不包含长期管理凭据。勾选保持登录时设备会话有效期为 30 天，否则使用浏览器会话 Cookie，服务端最多保留 24 小时。管理员可以撤销单个设备。

### 11.2 统一鉴权与持久化

- 安装实例身份、监听设置与设备令牌摘要存于服务端数据目录的 `client-access.json`，不混入角色配置，不进入完整同步快照。设备原始令牌只通过 HttpOnly、SameSite Cookie 交给浏览器。
- Electron 从主进程受限 IPC 获取当前 Daemon 地址与本机凭据；原生资源请求只向可信主应用帧附加认证头。凭据读取器由统一路径工厂初始化，子应用页面不取得该管理凭据。
- 普通业务 API、SSE、Gateway WebSocket、附件、媒体和下载统一验证身份；撤销授权会关闭对应 Gateway 与 SSE，过期授权还由定时检查回收。日志接口也需要认证。公共入口仅保留静态网页、基础健康检查、配对和登录；HTML 预览继续使用自身签名校验。
- `INFOS_API_TOKEN` 仍可作为管理员凭据，用于管理登录、自动化客户端、远程完整同步或指标采集。浏览器配对后不需要保存该主凭据。
- 手机配对不会注册本机桌面能力；平台工具仍由服务端选择已有能力 Provider 执行。NapCat 反向连接不在独立局域网网页端口开放。

### 11.3 开发模式与发行包

源码开发可沿用 `pnpm start`（Daemon 与 Electron 开发入口），或分别启动 `pnpm dev:daemon` 与 `pnpm dev:frontend`。局域网入口代理回环 Vite `7359`，并代理已鉴权的 HMR WebSocket；Vite 不直接监听局域网，不读取残留的旧 `dist` 页面。

未配对时仅允许启动登录页所需的前端、共享模块和依赖源码；Vite 的绝对路径代理不会向未配对设备公开 backend 源码或 TEMP 文件。

发行包把主应用 renderer 同时作为独立网页资源放入 `resources/frontend`，Daemon 通过 `INFOS_FRONTEND_ROOT` 使用此目录，无需读取 `app.asar`。内置 Daemon 明确设置 `NODE_ENV=production`，不会在发行版中连接开发服务器。裸机生产部署可将该变量指定到已构建的 `packages/frontend/dist`。

| 变量 | 用途 |
| --- | --- |
| `INFOS_FRONTEND_ROOT` | 生产主应用静态文件根目录 |
| `INFOS_DEV_FRONTEND_URL` | 源码模式的本机 Vite 来源，默认 `http://127.0.0.1:7359` |
| `INFOS_PUBLIC_URL` | 二维码使用的公开入口 origin，适用于 HTTPS 反向代理 |
| `INFOS_WEB_PORT` | Docker Web 发布端口，默认 `3000` |
| `INFOS_BACKEND_BIND` | Compose 业务与能力端口的宿主绑定地址，默认 `127.0.0.1` |

### 11.4 Docker 与 HTTPS

Docker 保留现有 Nginx 同源 Web 入口，默认通过 `http://宿主机IP:3000` 访问，不再额外开 `9122`。Compose 默认仅将 Web 端口发布到外部网络，业务与能力端口绑定宿主回环地址；需要外部节点接入时再显式调整绑定与相应通道认证。

没有配置管理凭据且没有任何已配对设备时，Daemon 控制台会输出一次五分钟有效的首个管理员配对码，可使用 `docker compose logs backend` 查看；过期后可重启 backend 重新获取。已存在设备时不会继续输出管理配对码。管理员会话丢失时，可在服务端设置 `INFOS_API_TOKEN` 后重新登录，不需要删除业务数据。

HTTPS 可由已有反向代理终止 TLS，转发原始 Host、Cookie、WebSocket Upgrade，SSE 关闭缓冲，并将 `INFOS_PUBLIC_URL` 设为 HTTPS 入口。普通局域网 HTTP 可用于文字、附件与任务操作；安全随机 ID、复制操作和资产 SHA-256 校验提供兼容回退，校验不会被跳过。手机麦克风需要 HTTPS，界面会明确提示，不自动安装证书。

### 11.5 移动端范围

主应用提供抽屉导航、角色与会话列表、工作区文件/终端/协作面板切换、据点房间/成员面板、软键盘视口、触控输入与弹窗布局。工作区及工具图片支持双指缩放和平移。Windows 窗口栏、桌宠、内置浏览器窗口和独立子应用保持各自客户端形态，不属于主应用移动 Web 布局适配范围。

---

_本文档由 Carola 整理，适用于 infOS 多目标部署方案。_
