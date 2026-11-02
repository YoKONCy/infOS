# Steam 集成与资产联邦化规范

> **版本**：0.9.11 · **更新时间**：2026-10-27
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
  ├── cloudSync.ts       ← Steam Cloud 同步实现（cloudSyncService）
  ├── assets.ts          ← 官方/本地/Workshop 模型联邦扫描
  └── portableDaemon.ts  ← 启动后端守护进程并注入 Workshop 目录
```

- 全部通过 IPC 暴露给渲染进程
- Docker 版中这些 Service **完全不存在**
- `steamworks.js` native addon 延迟加载，先检查 `steam_api64.dll` 存在性（防 segfault）

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
| Cloud 同步             | ✅ cloudSync.ts（cloudSyncService）       | ❌ 不存在                   |
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

## 5. Steam Cloud 手动完整快照同步

### 5.1 产品语义

Steam 客户端可以选择本地或远程服务；Steam Cloud 的完整快照上传与下载只在本地模式可用。云适配器提供手动上传、下载和清除接口，启动和退出时不自动同步，也不做文件级合并。

当前主进程提供 `steam-cloud-upload`、`steam-cloud-download`、`steam-cloud-sync` 等 IPC，其中兼容接口 `steam-cloud-sync` 等同于下载；前端入口以实际页面为准。

### 5.2 同步范围

快照包含受管数据目录内的业务数据及一致性数据库副本，包括角色、会话、记忆、工作区和配置。节点身份、设备凭据、部分运行状态、缓存、日志与临时数据按同步服务的排除规则处理；安装包和 Workshop 安装目录由各自的发行渠道管理。

快照由 Daemon 使用传输密钥加密。Steam 适配器根据 Steam 身份派生传输密钥，Steam Cloud 的账号权限是外层访问边界；导入后暂存内容由本机密钥重新加密。具体纳入和排除规则以 `distributedSyncService.ts` 为准。

### 5.3 完整快照与覆写流程

1. 上传时，本机 Daemon 生成一致性快照并加密，Electron 将其写入 Steam Cloud。
2. 下载时，Electron 读取云端快照并提交本机 Daemon；Daemon 解密、校验并暂存导入。此时返回的 `restartRequired` 表示还需要重启。
3. 下次启动、打开数据库之前，服务端生成当前数据的回滚副本并应用暂存包，保留本机节点身份。完成状态和失败恢复以分布式同步实现为准。

上传和下载互斥。同步完成后需要显式上传才会更新云端快照。

### 5.4 冲突与恢复

不采用文件 `modifiedAt` 最新者胜出，也不逐文件合并。Steam Cloud 快照始终是用户明确选择的唯一来源：

```text
Cloud Snapshot → 完整覆写当前本机用户数据
```

应用暂存包时会保留本机数据的回滚副本；分布式服务提供暂存回滚操作，实际恢复同样在后续启动时进行。兼容性、完整性或存储检查失败时应查看服务端错误，具体检查以同步服务实现为准。

### 5.5 触发时机

| 事件 | 动作 |
| --- | --- |
| 应用启动 | 不自动下载或覆写 |
| 应用退出 | 不自动上传 |
| 用户手动上传 | 生成并上传当前完整快照 |
| 手动下载 | 校验并暂存完整快照，重启后应用 |

---

## 6. 成就系统

服务端记录内部成就，Electron 主进程在 Steam 可用时提交已达成记录；远程服务端也可以保存内部成就。当前内置首个成就是 `fresh_start`，Steam API Name 为 `ACH_FRESH_START`。触发条件、身份范围、提交与 Steam 后台配置见 [成就与 Steam 提交](./B30_ACHIEVEMENTS.md)。Steam App ID 在 `electron/main/services/steam.ts` 中配置为 `4457100`。

---

## 7. 打包后目录结构

发行资源的实际布局以根目录 `electron-builder.base.yml` 和 `electron-builder.steam.yml` 为准：主进程、预加载及渲染代码进入应用包，Daemon、依赖、应用与资产作为发行资源携带，Steam 配置额外加入 SDK 文件。用户数据与安装资源分离；安装版使用系统 `userData/data`，便携版使用程序同级 `data`。数据路径见 `electron/main/utils/env.ts`，存储组织见 [项目结构](./A01_PROJECT_STRUCTURE.md)。

---

_本文档由 Carola 整理，适用于 infOS Steam 集成与资产管理规范。_
