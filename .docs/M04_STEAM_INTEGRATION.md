# Steam 集成与资产联邦化规范

> **版本**：0.9.13 · **更新时间**：2026-10-27
> **适用范围**：`electron/main/services/steam*`、`packages/backend/src/core/`
> **依赖规范**：[A04_DEPLOYMENT](./A04_DEPLOYMENT.md)、[A02_BACKEND_ARCHITECTURE](./A02_BACKEND_ARCHITECTURE.md)

---

## 1. 概述

Steam SDK、Workshop 发现、Steam Cloud 和 Overlay 由 Electron 客户端接入。服务端独立管理内部成就；Steam 可用时由客户端提交已达成记录。Docker 后端也能保存内部成就。

---

## 2. 模块职责划分

### 2.1 Electron 专属 — Steam 服务

```
electron/main/services/
  ├── steam.ts           ← steamworks.js 封装（初始化/用户/Overlay/Workshop 订阅与安装发现）
  ├── cloudAutoSave.ts   ← 自动保存触发、启动恢复与冲突决策
  ├── cloudSnapshotStore.ts ← 本机检查点、分块云文件与代次清单
  ├── cloudSnapshotTransport.ts ← 后端一致性快照的导出与校验暂存
  ├── cloudSync.ts       ← 既有云存档调用的兼容入口
  ├── assets.ts          ← 官方/本地/Workshop 模型联邦扫描
  └── portableDaemon.ts  ← 启动后端守护进程并注入 Workshop 目录
```

- 全部通过 IPC 暴露给渲染进程
- Docker 版中这些 Service **完全不存在**
- `steamworks.js` native addon 延迟加载，先检查 `steam_api64.dll` 存在性（防 segfault）

保存调度直接依赖 `cloudSnapshotTransport` 执行快照请求。兼容入口 `cloudSync` 在实际调用时动态加载，静态引用统一的保存队列与传输层，保存队列对兼容入口仅保留类型引用。上传、恢复和清理都交由同一个自动保存实例处理，超时、账户密钥及本机连接校验由原职责层执行。

### 2.2 后端共享 — 路径与资产核心

```
packages/backend/src/core/
  ├── pathResolver.ts         ← 虚拟路径管理（@app/@data/@workshop/@temp）
  └── assetRegistry.ts        ← 统一资产注册表
```

### 2.3 职责边界

| 职责                   | Electron                                  | Docker                      |
| ---------------------- | ----------------------------------------- | --------------------------- |
| Steam 初始化 / Overlay | ✅ steam.ts                               | ❌ 不存在                   |
| Workshop 发现/管理     | ✅ steam.ts（getWorkshopInstallations）   | ❌ 不存在                   |
| Cloud 同步             | ✅ cloudAutoSave / cloudSnapshotStore / cloudSync | ❌ 不存在             |
| Steam 成就提交         | ✅ 已达成记录由主进程提交，须配置 Steam 后台 | ❌ 无 Steam SDK；保留内部成就 |
| PathResolver           | ✅ 含 @workshop                           | ✅ 无 @workshop             |
| AssetRegistry          | ✅ 扫描 3 层                              | ✅ 扫描 2 层（无 workshop） |

---

## 3. 虚拟路径管理器 — PathResolver

成就规则、身份范围、持久化和 Steam 回执以 [B30 成就与 Steam 提交](./B30_ACHIEVEMENTS.md) 为准。服务端记录内部成就，Electron 仅将当前凭据对应的已达成项交给 Steam；远程后端无需加载 Steam SDK。

### 3.1 逻辑前缀定义

| 前缀         | 含义           | 可写              | Electron 映射                             | Docker 映射     |
| ------------ | -------------- | ----------------- | ----------------------------------------- | --------------- |
| `@app/`      | 程序安装根目录 | ❌ 只读           | `resources/` 或项目根                     | 容器内应用目录  |
| `@data/`     | 用户可写数据   | ✅                | 统一应用数据目录                          | `PERO_DATA_DIR` |
| `@workshop/` | Steam Workshop | ❌ 只读，多订阅根 | 由 `steamApi.workshop.installInfo()` 发现 | ❌ 不可用       |
| `@temp/`     | 运行时临时     | ✅                | 系统 temp                                 | 系统 temp       |
| `@principal/` | 角色工作区    | 由具体访问策略决定 | `@data/principals/<agentId>/workspace`   | 同左            |

`@principal` 使用 `resolvePrincipal(agentId, relativePath)`，需要角色上下文；工作区访问仍需经过领域权限与范围检查。

### 3.2 Workshop 路径传递

Electron 版启动后端进程时，通过环境变量注入：

```typescript
// electron/main/services/portableDaemon.ts
const workshopDirs = getWorkshopInstallations().map((item) => item.folder)
spawn(backendProcess, {
  env: {
    ...process.env,
    PERO_WORKSHOP_DIRS: JSON.stringify(workshopDirs),
  },
})
```

Docker 版不设此环境变量，`@workshop` 自然为空。

---

## 4. 资产联邦化注册表 — AssetRegistry

### 4.1 覆盖优先级

```
@data/custom/ (用户手动) > @workshop/ (用户订阅) > @app/ (官方内置)
```

行业惯例（Skyrim / Cities Skylines / Minecraft 等均采用此顺序）。

### 4.2 Asset ID 规范（继承自 v1）

反向域名格式：`<scope>.<type>.<name>`

| scope          | 来源       | 示例                        |
| -------------- | ---------- | --------------------------- |
| `com.infos`    | 官方内置   | `com.infos.persona.pero`    |
| `com.workshop` | 创意工坊   | `com.workshop.model.123456` |
| `com.user`     | 用户自定义 | `com.user.plugin.my_tool`   |

### 4.3 资源读取职责

| 资源类型            | 读取者               | 原因                    |
| ------------------- | -------------------- | ----------------------- |
| 提示词 (prompts)    | **后端**             | LLM 调用在后端          |
| 人设 (agents)       | **后端**             | 人设注入 system prompt  |
| 插件 schema         | **后端**             | Tool calling 在后端     |
| 3D 模型（标准资源） | **前端**             | Three.js 渲染在渲染进程 |
| UI 资产 (图片/音频) | **客户端**           | Electron 或浏览器展示   |
| 业务配置            | **后端管理**         | 前端通过接口读取与修改  |

### 4.4 提示词覆盖查找

`core/promptTemplateLoader.ts` 按用户自定义、Workshop、官方内置的顺序查找；多个 Workshop 根按订阅列表倒序查找。官方兜底路径为 `@app/backend/src/services/mdp/prompts/`，都不存在时记录警告并返回空字符串。

---

## 5. Steam Cloud 自动完整快照同步

### 5.1 产品语义

Steam 本地模式在后端就绪后自动监测业务文件变化，文件事件仅标记待保存。每两分钟统一检查修改、建立快照或重试失败操作，没有修改且没有待传快照时不重复导出。修改序号只确认本次捕获前的事件，捕获期间的新修改保留到下一轮，文件指纹轮询补偿遗漏事件。数据库 WAL 计入修改检测，日志、缓存、备份工作区及设备身份不触发业务保存。正常退出的快照交接与截止时间见下文「完整快照与覆写流程」。

窗口关闭或隐藏、渲染器退出、主进程异常、锁屏、休眠及 Windows 会话结束会提前尝试保存。Windows 系统关机、重启和注销不保证经过 `before-quit`，所以常规退出钩子不能代替运行中检查点。强杀、断电和磁盘故障不保证有机会运行回调，能保留的云数据上限是最近一次成功建立并交给 Steam 的快照。

远程模式不读取或同步本机业务快照；远程服务器自行备份。`steam-cloud-upload`、`steam-cloud-download` 和兼容名称 `steam-cloud-sync` 保留，但上传统一经过自动保存队列，下载先暂停写入并等待安全重启。前端“数据与备份”的 Steam 卡片显示本机检查点、待重试状态和最近交给 Steam 的时间，不把 SDK 接受写入显示成云端服务器已确认。

### 5.2 同步范围

快照包含受管数据目录内的业务数据及一致性数据库副本，包括角色、会话、记忆、工作区和配置。节点身份、设备凭据、部分运行状态、缓存、日志与临时数据按同步服务的排除规则处理；安装包和 Workshop 安装目录由各自的发行渠道管理。受管 NapCat 目录中的已知发行程序、日志和缓存也省略，账号配置、账号数据库、快速登录选择和第三方插件继续保存；恢复时复用目标端已安装的程序，新设备按需安装 NapCat。

快照由 Daemon 使用传输密钥加密。Steam 适配器根据 Steam 身份派生传输密钥，Steam Cloud 的账号权限是外层访问边界；导入后暂存内容由本机密钥重新加密。具体纳入和排除规则以 `backupStorage.ts`、`distributedSyncService.ts` 和共享的 `snapshotPaths.ts` 为准；Electron 的文件监测与指纹计算使用同一组客户端缓存与 NapCat 范围规则。

Daemon 的 v3 快照按原始文件字节分块压缩，避免大数据库整体 Base64/JSON 化触发 Node 字符串长度上限；传输格式、资源限额和旧版 v1/v2 兼容规则见 [完整快照说明](A04_DEPLOYMENT.md#95-单对象单-authority-一致性)。Steam SDK 使用的分块 Base64 属于压缩密文的上传封装，每块保持固定大小。新快照的接收客户端需要支持 v3 格式。

### 5.3 完整快照与覆写流程

1. Daemon 通过完整快照协调器固定 SQLite 读视图并复制受管 TDB 文件组，随后以分步在线备份和异步文件复制完成导出，再以 Steam 账户对应的传输密钥加密。SQLite 视图、普通文件版本核对和失败清理的实现见 [完整快照说明](A04_DEPLOYMENT.md#95-单对象单-authority-一致性)。Electron 先将密文原子写入 `data/cloud-cache/steam-<SteamID>/`，写入落盘完成后更新检查点回执；保留最近三份本机密文。
2. 云文件使用 `infos/auto-v1/<代次>/<分块>.chunk`，每块四 MiB 原始密文，以 base64 文本交给 SDK，避免单文件超过 Steam FileWrite 上限。所有分块成功后才切换 `infos/auto-v1/head.json`；清单保存当前与上一代的大小、摘要及分块信息，旧代在成功切换之前保持可读。
3. 启动时在本机后端打开之前读取云清单与本机回执。空数据目录或本机指纹未变而云端更新时自动恢复；两边有不同数据时询问方向，不按墙上时钟直接覆盖。指纹基于文件名、大小与修改时间，属于保守修改检测，后台写入及 SQLite 检查点也可能触发冲突确认。
4. 下载必须验证完整密文大小与 SHA256，再调用 `/api/distributed/snapshot/import`；后端负责解密、兼容校验及暂存。只重启本模块拥有的 Daemon，打开数据库前建立本机恢复点、安装暂存数据。核对 `/api/distributed/pending` 的 `lastSync.snapshotId` 后才更新云端基线、允许自动保存与显示主窗口。外部 Daemon 不强制终止；无法完成暂存恢复时暂停云端写入，已经暂存但尚未应用的恢复会阻止进入主界面。

本机状态记录待传检查点与恢复中的快照 ID；进程中断后可接续，不能把已暂存误报为已恢复。云端兼容读取旧路径 `infos/full-snapshot.bundle`，下一次自动保存迁移到分块格式；旧版单文件客户端不识别新的分块清单。

启动就绪后会立即检查是否需要保存，文件元数据变化时生成完整快照。分步导出用于缩短后端连续阻塞，保存内容覆盖完整业务范围。请求超时或主动取消时，后端会在当前备份步骤或文件复制结束后响应取消，释放读取视图并清理暂存区，HTTP 499 表示该取消流程已经结束。客户端请求结束与后端释放导出占用之间存在清理间隔，此时接口返回 `RESOURCE_BUSY`。传输层读取业务错误码，在调用者原有的取消与截止时间内每隔 250 毫秒重试，其他错误立即返回并保留业务错误码。修改检测范围调整后，旧指纹可能触发一次重新捕获或保守的冲突确认。

正常退出先停止自动保存触发器，等待在途保存结束，再以 60 秒时限强制捕获最终快照。最终保存结束后才停止 Daemon。退出清理期间的窗口销毁、隐藏与渲染进程结束事件由统一退出流程处理。平时关闭或隐藏窗口触发的后台保存使用常规 60 秒时限。

### 5.4 冲突与恢复

不逐文件混合两份业务数据库，也不依据客户端时间戳裁决。上传前及切换清单前核对已知云端代次，发现分叉便保留本机密文并暂停覆盖，启动时由用户选择“恢复云端”“保留本机”或“暂不同步”。恢复云端保留本机恢复点；保留本机发布新代时保留上一代云文件。

当前代分块缺失或摘要错误时，可明确选择恢复上一代；仍需经过相同校验、后端暂存和恢复回执。单份清单损坏、权限失败或无法读取时不能当作“云端为空”直接覆盖。

Steam SDK 的成功回执仅证明接受本机云文件写入，实际网络上传和启动前下载由 Steam 客户端负责。代次检查使用客户端已经取得的云清单，不提供实时跨设备合并或云端 compare-and-swap；多设备同时离线修改仍可能进入 Steam 自身的冲突处理。应用暂存包的回滚、版本及完整性检查以分布式同步和备份服务为准。

### 5.5 触发时机

| 事件 | 动作 |
| --- | --- |
| 应用启动 | 比较云清单与本机基线，安全恢复后启动自动保存 |
| 业务数据修改 | 标记待保存，等待两分钟周期统一处理 |
| 两分钟轮询 | 保存有修改的数据、补偿事件遗漏、重试待传快照 |
| 窗口关闭、隐藏、异常或休眠 | 有时间时提前尝试保存 |
| 正常退出与应用重启 | 最终一致性快照先于 Daemon 停止 |
| 强杀或断电 | 依赖已落盘业务数据、最近检查点及 Steam 已接受的云文件 |

---

## 6. 成就系统

服务端记录内部成就，Electron 主进程在 Steam 可用时提交已达成记录；远程服务端也可以保存内部成就。当前内置首个成就是 `fresh_start`，Steam API Name 为 `ACH_FRESH_START`。触发条件、身份范围、提交与 Steam 后台配置见 [成就与 Steam 提交](./B30_ACHIEVEMENTS.md)。Steam App ID 在 `electron/main/services/steam.ts` 中配置为 `4457100`。

---

## 7. 打包后目录结构

发行资源的实际布局以根目录 `electron-builder.base.yml` 和 `electron-builder.steam.yml` 为准：主进程、预加载及渲染代码进入应用包，Daemon、依赖、应用与资产作为发行资源携带，Steam 配置额外加入 SDK 文件。用户数据与安装资源分离；安装版使用系统 `userData/data`，便携版使用程序同级 `data`。数据路径见 `electron/main/utils/env.ts`，存储组织见 [项目结构](./A01_PROJECT_STRUCTURE.md)。

---

_本文档由 Carola 整理，适用于 infOS Steam 集成与资产管理规范。_
