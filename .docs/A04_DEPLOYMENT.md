# 多目标部署架构

> **版本**：0.9.6 · **更新时间**：2026-10-17
> **适用范围**：infOS 全项目部署策略
> **依赖规范**：[A07_CROSS_PLATFORM](./A07_CROSS_PLATFORM.md)、[A08_DEVOPS](./A08_DEVOPS.md)
>
> **当前阶段**：生产基线是单个 Control Authority Server 对接多个 Client/Capability Node。Electron/Steam/便携版在启动后台之前选择本地或远程模式；远程模式只启动客户端与本机能力，不拉起本地 Daemon。多 Server 只规划手动完整快照同步，不实施实时 Federation、跨 Server Replica 或自动 Command Route。

---

## 1. 部署形态与 AIOS 运行时边界

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

设计母稿与预览临时保存在 `TEMP/design/`，该目录被 Git 忽略，不随仓库分发。安装包只携带 `electron/splash/` 中的透明 PNG、HTML、CSS 和 JS，以及独立编译的开屏预加载脚本；SVG 母稿不参与运行时。进度条以整个窗口居中，使用独立 CSS 与 SVG 动效。标准版、Steam 版与便携版共用基础资源清单，浏览器与 Docker 入口不使用此过渡。

---

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
│  所有业务 API 走 HTTP（即使在 Electron 也走 localhost） │
│  IPC 仅用于 Electron 专属的系统能力                    │
└───────────────────────────────────────────────────────┘
```

---

## 3. 通信架构

### 3.1 Electron 桌面版

```text
Electron Main
  ├─ 启动打包内置 Daemon（开发环境可由开发脚本编排）
  ├─ 注入 PERO_DATA_DIR、PERO_APP_ROOT、PERO_WORKSHOP_DIRS
  ├─ 注册 asset:// 只读资产协议
  ├─ 提供窗口、托盘、Steam 与桌面能力
  └─ Renderer 通过 HTTP/SSE/WS 访问 Daemon

Daemon
  ├─ 初始化 SQLite、TriviumDB、Agent、Scheduler
  ├─ 维护后端持久资源权威
  └─ 通过 Capability Provider 向 Electron 请求平台能力
```

Electron 启动 Daemon 是桌面全包发行的进程编排方式，不改变 Daemon 的纯 Node 边界；Daemon 必须能在 Docker/服务器形态独立运行。

**客户端连接规则**：Electron 标准版、Steam 版和便携版在本地开屏后、任何 Daemon 拉起之前读取用户根目录的 `client-connection.json`。首次启动或远程验证失败时显示本地 HTML 连接页；本地模式按原有链路启动，远程模式校验服务器身份后统一切换业务 HTTP/SSE/WS 和能力通道，失败不能自动回退本地。凭据经系统密钥服务加密。托盘与“分布式”Tab 均可打开连接页，运行中修改只写下次启动配置并重启，旧窗口和退出清理继续使用原连接。远程退出不停止服务器上的共享子应用。远程模式禁用本机 Steam 业务快照上传和恢复，服务器数据由服务器备份；设备身份、连接配置和凭据不进入业务快照。

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

| 能力       | IPC 通道                          | Docker 替代                  |
| ---------- | --------------------------------- | ---------------------------- |
| 窗口管理   | `window-minimize`, `window-close` | N/A（浏览器行为）            |
| 托盘操作   | `tray-set-tooltip`, `tray-flash`  | N/A                          |
| 文件对话框 | `dialog-open-file`, `dialog-save` | 浏览器 `<input type="file">` |
| 系统通知   | `notification-show`               | Web Notification API         |
| 剪贴板     | `clipboard-write`                 | `navigator.clipboard`        |
| 全局快捷键 | `shortcut-register`               | N/A                          |
| Steam 集成 | `steam-*`                         | N/A                          |
| 进程管理   | `backend-restart`, `get-app-path` | Docker restart               |

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

```typescript
// config/runtime.ts
export const isElectron = typeof window !== 'undefined' && !!(window as any).electron
export const isDocker = !isElectron

// 功能特性检测
export const features = {
  /** 是否支持原生文件对话框 */
  nativeFileDialog: isElectron,
  /** 是否支持托盘 */
  systemTray: isElectron,
  /** 是否支持全局快捷键 */
  globalShortcuts: isElectron,
  /** 是否支持 Steam */
  steam: isElectron,
}
```

---

## 6. 多目标构建矩阵

### 6.1 构建变体总览

| #   | 变体             | 平台        | Electron | Steam SDK | 打包格式       | 自动更新         | 状态       |
| --- | ---------------- | ----------- | -------- | --------- | -------------- | ---------------- | ---------- |
| 1   | **Steam 版**     | Windows x64 | ✅       | ✅        | NSIS 安装包    | Steam 自带       | 当前主力   |
| 2   | **标准版**       | Windows x64 | ✅       | ❌        | NSIS 安装包    | electron-updater | 当前主力   |
| 3   | **便携版**       | Windows x64 | ✅       | ❌        | ZIP 解压即用   | electron-updater | 当前主力   |
| 4   | **Docker 版**    | Linux x64   | ❌       | ❌        | Docker Image   | docker pull      | 接线校准中 |
| 5   | **Linux 桌面版** | Linux x64   | ✅       | ❌        | AppImage / deb | 待定             | 待实现     |
| 6   | **Mac 版**       | macOS ARM64 | ✅       | ❌        | DMG            | 待定             | 待实现     |

### 6.2 双轴解耦模型

差异只有三个维度，代码层面只需处理前两个：

```
维度 1: Edition（版本）   → steam | standard     ← 代码分支
维度 2: Platform（平台）  → win-x64 | linux-x64 | mac-arm64 | docker  ← 代码分支
维度 3: Packaging（打包） → nsis | portable | appimage | dmg | docker  ← 纯构建配置
```

### 6.3 Edition 编译标记

```typescript
// edition.ts
export const EDITION = (process.env.INFOS_EDITION ?? 'standard') as 'steam' | 'standard'
export const IS_STEAM = EDITION === 'steam'
```

Steam 相关代码**全部用 dynamic import + IS_STEAM 门控**，standard 版构建时 tree-shaking 完全去除。

### 6.4 Electron Builder 配置矩阵

```
electron/
  ├── electron-builder.base.yml       ← 共享配置
  ├── electron-builder.steam.yml      ← extends base + Steam 文件
  ├── electron-builder.standard.yml   ← extends base, 无 Steam
  └── electron-builder.portable.yml   ← extends standard, target=portable
```

### 6.5 构建脚本

```jsonc
// package.json (root)
{
  "scripts": {
    // ── 当前主力 ──
    "electron:build": "electron-builder --config electron-builder.standard.yml",
    "electron:build:steam": "cross-env INFOS_EDITION=steam electron-builder --config electron-builder.steam.yml",
    "electron:build:portable": "electron-builder --config electron-builder.portable.yml",
    "build:docker": "docker build -t infos-backend .",

    // ── 待实现 ──
    "electron:build:linux": "electron-builder --linux --config electron-builder.standard.yml",
    "electron:build:mac": "electron-builder --mac --arm64 --config electron-builder.standard.yml",
  },
}
```

### 6.6 便携模式 (Portable)

在 `.exe` 同级目录下新建 `.portable` 空白文件，应用将读写本地 `userData/` 目录而非系统 `%APPDATA%`。

```typescript
// electron/main/utils/portable.ts
const portableMarker = path.join(path.dirname(process.execPath), '.portable')
export const IS_PORTABLE = fs.existsSync(portableMarker)

export function getDataDir(): string {
  if (IS_PORTABLE) return path.join(path.dirname(process.execPath), 'userData')
  return app.getPath('userData')
}
```

### 6.7 自动更新策略

| 变体            | 更新机制           | 说明                    |
| --------------- | ------------------ | ----------------------- |
| Steam 版        | Steam 自带         | Depot 更新，零代码      |
| 标准版 / 便携版 | `electron-updater` | 从 GitHub Releases 下载 |
| Docker 版       | `docker pull`      | 用户手动或 CI/CD        |
| Linux / Mac     | 待定               | 随平台实现一起确定      |

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

```yaml
# docker-compose.yml
version: '3.8'
services:
  backend:
    build:
      context: .
      dockerfile: docker/Dockerfile.backend
    ports:
      - '9120:9120'
    volumes:
      - pero-data:/app/data
    environment:
      - PERO_PORT=9120
      - PERO_DATA_DIR=/app/data
      - PERO_DATABASE_PATH=/app/data/infos.db
      # 鉴权（可选，不设则首次启动自动生成）
      - INFOS_AUTH_TOKEN=your_custom_password
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:9120/api/health']
      interval: 30s
      timeout: 5s
      retries: 3

  frontend:
    build:
      context: .
      dockerfile: docker/Dockerfile.frontend
    ports:
      - '3000:80'
    depends_on:
      - backend

volumes:
  pero-data:
```

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

### 8.1 设计原则

| 原则                      | 说明                          |
| ------------------------- | ----------------------------- |
| **Electron 版不需要鉴权** | localhost 本机访问，天然安全  |
| **Docker 版必须鉴权**     | 端口暴露到公网/内网，需要保护 |
| **单用户模型**            | 不存在多用户、不需要角色权限  |
| **轻量实现**              | Token → JWT，不引入 OAuth/SSO |

### 8.2 Token 来源

```
优先级：
1. 环境变量 INFOS_AUTH_TOKEN（用户预设）
2. data/auth.json 中保存的 bcrypt 哈希（用户在控制面板修改的密码）
3. 首次启动自动生成随机 Token → 打印到日志 + 写入 data/auth.json
```

### 8.3 登录流程

```
前端                              后端
  │                                │
  │  POST /api/auth/login          │
  │  { token: "a7k9x3m2p5" }      │
  │ ──────────────────────────────→│
  │                                │ bcrypt.compare(token, hash)
  │  200 { jwt: "eyJ..." }        │
  │ ←──────────────────────────────│
  │                                │
  │  存入 localStorage             │
  │                                │
  │  GET /api/memories             │
  │  Authorization: Bearer eyJ...  │
  │ ──────────────────────────────→│
  │                                │ JWT 验证
  │  200 { code: "OK", data: [...]}│
  │ ←──────────────────────────────│
```

### 8.4 JWT 配置

| 配置项  | 值                                       | 说明                   |
| ------- | ---------------------------------------- | ---------------------- |
| 算法    | HS256                                    | 对称加密，单服务器足够 |
| 有效期  | **7 天**                                 | 平衡安全性与便利性     |
| Secret  | 首次启动随机生成 → `data/jwt_secret.key` | 重启后 JWT 仍有效      |
| Payload | `{ sub: 'owner', iat, exp }`             | 单用户模型             |

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

主应用提供抽屉导航、角色与会话列表、工作区文件/终端/协作面板切换、据点房间/成员面板、软键盘视口、触控输入与弹窗布局。工作区及工具图片支持双指缩放和平移。Windows 窗口栏、桌宠、内置浏览器窗口和独立子应用保持各自客户端形态，本轮不做移动端布局改造。

---

_本文档由 Carola 整理，适用于 infOS 多目标部署方案。_
