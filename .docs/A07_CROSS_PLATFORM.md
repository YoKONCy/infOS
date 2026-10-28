# 跨平台与路径规范

> **版本**：0.9.8 · **更新时间**：2026-10-26
> **适用范围**：infOS 全项目（后端 / 前端 / Electron / 上游原生依赖的集成）
> **依赖规范**：[A04_DEPLOYMENT](./A04_DEPLOYMENT.md)

上游原生依赖的源码和工具链由依赖项目维护。本仓库负责 Node/Electron ABI、目标平台资源、加载路径与降级行为；不得把依赖集成称为自有 Rust 模块。依赖维护见 [B27](./B27_RUNTIME_SECURITY.md)。

---

## 1. 路径禁止硬编码

### 1.1 核心规则

**路径永远不能硬编码。** 必须通过 配置 / 环境变量 / 运行时计算 获取。

```typescript
// ❌ 禁止！硬编码路径
const dbPath = 'C:\\Users\\pero\\data\\infos.db'
const dataDir = '/opt/infos/data'

// ✅ 从环境变量/配置获取
const dbPath = env.PERO_DATABASE_PATH ?? path.join(getDataDir(), 'infos.db')

// ✅ 运行时计算
const dataDir = app.getPath('userData') // Electron
const dataDir = env.PERO_DATA_DIR ?? path.join(os.homedir(), '.infos') // Docker/CLI
```

### 1.2 路径操作必须使用 `node:path`

```typescript
// ❌ 禁止！手动拼接路径分隔符
const filePath = dataDir + '/' + 'config.json'
const filePath = `${dataDir}\\agents\\${agentId}`

// ✅ 必须使用 path.join / path.resolve
import path from 'node:path'
const filePath = path.join(dataDir, 'config.json')
const filePath = path.join(dataDir, 'agents', agentId)
```

### 1.3 路径分隔符

```typescript
// ❌ 禁止！假设分隔符
const parts = filePath.split('/')
const parts = filePath.split('\\')

// ✅ 使用 path.sep 或跨平台方法
const parts = filePath.split(path.sep)
// 或兼容两种分隔符
const parts = filePath.split(/[/\\]/)
```

### 1.4 统一路径工厂

所有运行时路径应从统一的工厂函数获取：

```typescript
// lib/paths.ts
import path from 'node:path'
import os from 'node:os'

/** 应用数据根目录 */
export function getDataDir(): string {
  return process.env.PERO_DATA_DIR ?? path.join(os.homedir(), '.infos')
}

/** 数据库文件路径 */
export function getDatabasePath(): string {
  return process.env.PERO_DATABASE_PATH ?? path.join(getDataDir(), 'infos.db')
}

/** Agent 工作区目录 */
export function getAgentWorkspace(agentId: string): string {
  return path.join(getDataDir(), 'principals', agentId, 'workspace')
}

/** TriviumDB 存储目录 */
export function getTriviumDir(): string {
  return path.join(getDataDir(), 'trivium')
}

/** Package目录 */
export function getPackagesDir(): string {
  return process.env.PERO_PACKAGES_DIR ?? path.join(getDataDir(), 'packages')
}
```

---

## 2. 平台特有代码标注

### 2.1 标注格式

所有平台特有的代码必须使用醒目的 **块注释 + `@platform` 标签** 标注：

```typescript
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// @platform WINDOWS — 使用 Win32 API 获取活动窗口标题
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function getActiveWindowTitle_win32(): string { ... }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// @platform LINUX — 使用 xdotool 获取活动窗口标题
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function getActiveWindowTitle_linux(): string { ... }
```

### 2.2 平台标签枚举

| 标签                 | 含义                                              |
| -------------------- | ------------------------------------------------- |
| `@platform WINDOWS`  | Windows 专有 (Win32 API, PowerShell, Registry 等) |
| `@platform LINUX`    | Linux 专有 (xdotool, systemd, /proc 等)           |
| `@platform DARWIN`   | macOS 专有 (AppleScript, launchd, Cocoa 等)       |
| `@platform ELECTRON` | Electron 专有 (BrowserWindow, Tray, IPC 等)       |
| `@platform DOCKER`   | Docker/容器专有                                   |

### 2.3 复合情况

当代码适用于多个（但非全部）平台时：

```typescript
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// @platform LINUX | DARWIN — Unix 信号处理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
process.on('SIGUSR2', () => {
  /* graceful restart */
})
```

---

## 3. 平台检测与分支模式

### 3.1 平台常量

```typescript
// lib/platform.ts
import os from 'node:os'

export const IS_WINDOWS = os.platform() === 'win32'
export const IS_LINUX = os.platform() === 'linux'
export const IS_DARWIN = os.platform() === 'darwin'
export const IS_ELECTRON = typeof process !== 'undefined' && !!process.versions?.electron
export const IS_DOCKER = !!process.env.PERO_DOCKER

export type Platform = 'windows' | 'linux' | 'darwin'

export function getPlatform(): Platform {
  if (IS_WINDOWS) return 'windows'
  if (IS_DARWIN) return 'darwin'
  return 'linux'
}
```

### 3.2 平台分支函数

对于需要平台特化的功能，使用 **策略模式** 而非 `if/else`：

```typescript
// ❌ 禁止！大段 if/else 散落在业务代码中
if (process.platform === 'win32') { ... }
else if (process.platform === 'linux') { ... }

// ✅ 策略模式，各平台实现独立文件
const impls = {
  windows: () => import('./activeWindow.win32'),
  linux:   () => import('./activeWindow.linux'),
  darwin:  () => import('./activeWindow.darwin'),
}

export async function getActiveWindowTitle(): Promise<string> {
  const impl = await impls[getPlatform()]()
  return impl.getActiveWindowTitle()
}
```

### 3.3 平台特有文件命名

| 文件                     | 说明                   |
| ------------------------ | ---------------------- |
| `activeWindow.ts`        | 跨平台门面（对外 API） |
| `activeWindow.win32.ts`  | Windows 实现           |
| `activeWindow.linux.ts`  | Linux 实现             |
| `activeWindow.darwin.ts` | macOS 实现             |

---

## 4. 常见跨平台陷阱

### 4.1 文件系统

| 陷阱         | 说明                          | 解决                                                       |
| ------------ | ----------------------------- | ---------------------------------------------------------- |
| 路径分隔符   | Windows `\` vs Unix `/`       | 用 `path.join()`                                           |
| 大小写敏感   | Windows 不敏感, Linux 敏感    | 统一 lowercase 或明确约定                                  |
| 最大路径长度 | Windows 默认 260 字符         | 避免深层嵌套, 考虑 `\\?\` 前缀                             |
| 文件锁       | Windows 独占锁更严格          | SQLite WAL 模式 + 重试                                     |
| 换行符       | Windows CRLF, Unix LF         | `.gitattributes` 统一 LF; 读取时 `.replace(/\r\n/g, '\n')` |
| 临时目录     | Windows `%TEMP%`, Unix `/tmp` | 用 `os.tmpdir()`                                           |

### 4.2 进程与信号

| 场景       | Windows                  | Linux/macOS             | 解决                      |
| ---------- | ------------------------ | ----------------------- | ------------------------- |
| 优雅关闭   | `SIGINT` 有限支持        | `SIGTERM` / `SIGINT`    | 同时监听两者              |
| 子进程终止 | `taskkill /f /pid`       | `process.kill(pid)`     | 封装 `killProcess()`      |
| Shell      | `cmd.exe` / `PowerShell` | `/bin/bash` / `/bin/sh` | 用 `cross-env` 或 `execa` |

### 4.3 网络

| 场景         | 注意事项                                              |
| ------------ | ----------------------------------------------------- |
| 端口占用检测 | 统一用 `net.createServer().listen()` 测试             |
| localhost    | Windows 可能解析为 IPv6 `::1`, 建议显式用 `127.0.0.1` |

---

## 5. Electron 特有隔离 (重申)

- `packages/backend/` — **0 个 Electron 依赖**
- `packages/frontend/` — **0 个 Electron 依赖**
- `packages/shared/` — **0 个 Electron 依赖**
- `electron/` — 唯一允许 import Electron API 的位置

Electron 专有代码 **全部** 在 `electron/` 目录中，后端/前端通过 Transport 层访问。

---

## 6. Linux / Mac 待实现适配清单（预留）

| 适配项         | Linux x64                  | Mac ARM64              |
| -------------- | -------------------------- | ---------------------- |
| 系统托盘       | Electron Tray API 通用     | ✅ 原生支持            |
| 自动启动       | `.desktop` 文件            | Login Items            |
| 原生通知       | libnotify                  | Notification API       |
| 第三方Native依赖 | 按Node/Electron ABI重建     | 按Node/Electron ABI重建 |
| 字体渲染       | 需验证中文字体             | ✅ 原生良好            |
| GPU (Three.js) | 需测试 Mesa/Vulkan         | ✅ Metal               |

## 7. AIOS 运行时路径与只读资产边界

除跨平台规则外，所有路径还必须遵守 [A09_AIOS_ARCHITECTURE](./A09_AIOS_ARCHITECTURE.md#6-workspace-与-tool-capability) 的资源边界：

| 逻辑空间                               | 读写规则       | 典型用途                    |
| -------------------------------------- | -------------- | --------------------------- |
| `@app`                                 | 只读           | 官方程序与内置资产          |
| `@workshop`                            | 只读，可多根   | Steam 订阅资源              |
| `@data`                                | 用户持久可写   | DB、Agent runtime、用户资产 |
| `@data/principals/{agentId}/workspace` | Agent 私有可写 | Principal Workspace         |
| `@temp`                                | 临时可写       | 可再生成中间文件            |

路径解析与云同步均必须执行 containment 检查，拒绝绝对路径和 `..` 逃逸。官方/Workshop 模型需要运行时 manifest 时，只能在内存或受限虚拟协议中提供，绝不可回写只读资源目录。

---

## 8. Runtime Adapter与Driver协议

Web、Electron、移动端、终端、文档和原生设备必须通过可协商Runtime Adapter暴露，禁止为每个平台增加绕过Kernel的特殊工具分支。

```typescript
interface RuntimeAdapter {
  getIdentity(): Promise<RuntimeIdentity>
  getCapabilities(): Promise<RuntimeCapability[]>
  inspect(target: KernelObjectRef): Promise<RuntimeSnapshot>
  execute(request: AdapterRequest): Promise<AdapterResult>
  cancel(callId: string): Promise<void>
}
```

### 8.1 固定协议语义

- Adapter提供统一命令目录、Capability Negotiation和结构化结果；
- 风险等级统一为`READ / INTERACT / ELEVATED / ROOT`；
- Runtime Instance、Document Generation、Snapshot ID与Stable Handle必须显式携带；
- 页面导航、Application重启、Document Revision或Provider重连后，旧Handle必须返回stale-object，不能静默作用于新目标；
- fallback必须显式、可审计且不能扩权；执行后必须验证Observed Effect；
- 跨Node调用必须携带协议版本、Principal/Process/Execution、Capability Handle、Target Generation、Deadline、Cancellation、Idempotency Key和审计链。

这些规则统一适用于`WebAdapter`、`DesktopAdapter`、`DocumentAdapter`、`MobileAdapter`、`TerminalAdapter`和`DeviceAdapter`。Browser和桌面能力的生产Provider位于Electron Node；Backend不得再加载平行Server Chromium或桌面自动化Provider。

### 8.2 Application Adapter 与 Runtime Adapter 的区别

Runtime Adapter 把设备或运行环境投影为 Capability；Application Adapter 把自治第三方应用投影为 Endpoint、Task、Session、Resource 和 Surface。两者共用 Node Identity、Envelope、Capability Handle、Generation、Deadline 和审计，但 Application Adapter 额外承担版本兼容、任务所有权移交和应用生命周期。

第三方 Application 使用三层结构：infOS 通用 Integration Foundation、infOS 侧专属 Adapter、目标应用内部 Adapter。主 Agent 通过 Tool/Task/Session 投影通信，不能持有目标应用实例。详细规范见 [A10_APPLICATION_INTEGRATION](./A10_APPLICATION_INTEGRATION.md)。

### 8.3 跨运行时资源原语

跨平台文件、上传下载、同步、模型资源和设备输出统一使用以下Kernel Object，不以绝对路径或二进制正文穿过Envelope：

- **AssetObject**：记录`assetId/objectRef/generation`、MIME、大小、SHA-256、Owner、来源与Retention；物理`storageRef`不进入Prompt。
- **FileHandle**：绑定Subject、Asset、`read/upload/export`操作、期限、使用次数、路径/MIME/大小Scope；用户选择文件产生Handle而不是泄露路径。
- **TransferObject**：统一`upload/download/copy/import/export`，状态为`pending/running/paused/completed/failed/cancelled`，进度通过Event投影到Surface；完成返回Asset Ref。
- **RuntimeEvent**：同一对象的`generation/revision/sequence`单调递增，高频事件支持合并、节流与背压，订阅绑定LifecycleScope。
- **ScopedCredential**：秘密正文只存在于Credential Vault；Handle绑定Origin/Audience、操作、Principal、期限与次数，日志、Event、Surface和Tool Result只显示脱敏元数据。

Credential不能替代Capability，调用必须同时满足能力授权和凭据授权。大文件不得进入Kernel Envelope、SSE或数据库正文；跨Node恢复只能恢复Provider可证明的合法前缀。

### 8.4 Agent Interaction World

Browser等交互Runtime必须把DOM、Accessibility、Layout、Network与Vision视为证据，编译成`InteractionScene → Semantic Object → Affordance/Precondition/Risk → Action Receipt`。Selector只是Driver内部定位提示，不是Agent任务语言。

强Interaction Handle应包含Runtime、Page、Frame、BackendNode、Document Generation、Snapshot和语义/AX/几何指纹。Rebind按BackendNode、语义+AX、几何辅助和置信度门槛依次执行；禁止跨Generation重绑，歧义时fail-closed。

每个高层动作必须产生Action Receipt，记录Intent、目标、前后Snapshot、Observed/Expected Effects、验证状态、证据和回滚提示。Site Model只能从`verified`或`partially_verified`结果学习。网页内容默认是外部数据，不是Agent指令；检测到指令覆盖、秘密请求或不安全动作时，必须阻断Planner和临时Capability编译。

### 8.5 隔离升级原则

逻辑Port边界稳定后，按风险与故障收益选择Worker Thread、Child Process、WASM、Electron Sandbox、远程Node或独立Daemon Service。不得以进程数量作为成功指标，也不得把没有机制隔离的软边界命名为Sandbox。

---

_本文档由 Carola 整理，适用于 infOS 跨平台开发规范。_
