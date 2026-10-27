# Steam 集成与资产联邦化规范

> **版本**：0.9.7 · **更新时间**：2026-10-27
> **适用范围**：`electron/main/services/steam*`、`packages/backend/src/core/`
> **依赖规范**：[A04_DEPLOYMENT](./A04_DEPLOYMENT.md)、[A02_BACKEND_ARCHITECTURE](./A02_BACKEND_ARCHITECTURE.md)

---

## 1. 概述

infOS 同时支持 **Electron 桌面版（Steam 上架）** 和 **Docker 后端版**。Steam 相关功能（Workshop、Cloud Sync、成就、Overlay）仅存在于 Electron 版，Docker 版完全不涉及 Steam。

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
| UI 资产 (图片/音频) | **Electron**         | 前端展示                |
| config.json         | **后端写，前端只读** | 后端为权威源            |

### 4.4 提示词覆盖查找

```typescript
class PromptTemplateLoader {
  async load(templatePath: string): Promise<string> {
    // 1. 用户自定义优先
    const customPath = pathResolver.resolve(`@data/custom/prompts/${templatePath}`)
    if (await pathExists(customPath)) return readFile(customPath, 'utf-8')

    // 2. 回退到官方
    return readFile(pathResolver.resolve(`@app/prompts/${templatePath}`), 'utf-8')
  }
}
```

---

## 5. Steam Cloud 手动完整快照同步

### 5.1 产品语义

Steam 版客户端始终与同设备内置 Daemon 死绑定，不允许切换远程 Server。Steam Cloud 不承担实时同步、文件级自动合并、分布式锁或 Authority Fence；它只是手动完整同步包的存储适配器。

面向用户只提供：

```text
“从 Steam Cloud 同步最新数据”
```

用户点击后，以 Steam Cloud 中最新的完整同步包为唯一来源，完整覆写当前本机 Server 的全部用户数据。应用启动和退出不自动下载、上传或合并。

### 5.2 同步范围

默认同步全部用户数据：

- SQLite、TriviumDB 及各应用 Store 的一致性 Snapshot；
- Agent、Thread、Message、Memory、Task、Approval、AgentInput、Notification；
- config、API Key、MCP Credential、TTS/ASR 配置等用户凭据；
- Applications、插件、Skills、自定义 Prompt、用户模型和头像资源；
- Workspace、附件、Asset、Social、Arca 及其他用户可写目录；
- Workshop 订阅和用户配置状态。

只自动排除：

- Server/Client/Capability Node ID、私钥、证书、Gateway Token 和 Trust Session；
- Session、Lease、Input Seat、临时 Handle、PID、锁文件、Socket、WAL/SHM、缓存、临时文件和日志；
- 随安装包分发的只读官方资源；
- Steam Workshop 实际安装文件，由 Steam 根据同步后的订阅状态重新获取。

API Key 等凭据不能以裸明文写入 Steam Cloud。生成同步包时使用同步包密钥加密，目标本机 Daemon 导入后使用本机主密钥重新封装。

### 5.3 完整快照与覆写流程

```text
1. 本机 Daemon 通过 SQLite Backup/Checkpoint 和各 Store Snapshot 生成一致性视图
2. 收集全部用户可写目录
3. 生成 Manifest、App/Schema Version、文件清单和 Checksum
4. 加密并上传完整同步包
5. 用户在目标设备点击“从 Steam Cloud 同步最新数据”
6. 下载到隔离区并完成版本、路径、大小、签名和摘要预检
7. 自动生成当前本机数据的 pre-sync 回滚快照
8. 暂停业务写入与 Runtime
9. 原子切换全部数据库和用户目录
10. 重封装凭据、执行迁移、重建索引并重启 Runtime
```

同步失败必须恢复原状态，不能留下部分新数据。同步完成后不会自动反向上传；用户需要时显式生成并上传新的完整快照。

### 5.4 冲突与恢复

不采用文件 `modifiedAt` 最新者胜出，也不逐文件合并。Steam Cloud 快照始终是用户明确选择的唯一来源：

```text
Cloud Snapshot → 完整覆写当前本机用户数据
```

当前本机数据在覆写前自动备份，用户可以撤销上次同步。若 App/Schema Version 不兼容、同步包损坏、凭据无法重封装或空间不足，则在切换前 fail-closed。

### 5.5 触发时机

| 事件 | 动作 |
| --- | --- |
| 应用启动 | 仅检查云端快照元数据并提示，不自动下载或覆写 |
| 应用退出 | 不自动上传 |
| 用户手动上传 | 生成并上传当前完整快照 |
| 用户手动同步 | 下载最新完整快照并原子覆写当前本机数据 |

---

## 6. 成就系统（预留）

仅定义接口，不实现具体触发逻辑：

```typescript
interface AchievementProvider {
  unlock(id: string): boolean
  isUnlocked(id: string): boolean
}

const ACHIEVEMENTS = {
  FIRST_ENCOUNTER: 'FIRST_ENCOUNTER',
  WEEKLY_COMPANION: 'WEEKLY_COMPANION',
  MONTHLY_BESTIE: 'MONTHLY_BESTIE',
  INTERACTION_MASTER: 'INTERACTION_MASTER',
} as const

// Electron: SteamAchievementProvider (基于 steamworks.js)
// Docker: NoOpAchievementProvider (空实现)
```

App ID 硬编码 `4457100`，无需提取为配置。

---

## 7. 打包后目录结构

```
infOS/                          (安装根目录 = @app/)
├── infOS.exe
├── steam_api64.dll
├── resources/
│   ├── app.asar                   ← 前端 + 主进程代码（只读）
│   ├── app.asar.unpacked/         ← native addon
│   ├── backend/
│   │   ├── dist/                  ← 后端 JS 编译产物（只读）
│   │   ├── prompts/               ← 官方提示词模板（只读）
│   │   └── agents/                ← 官方人设定义（只读）
│   └── assets/
│       └── 3d/                    ← 官方 3D 模型（只读）

%APPDATA%/infOS/                 (@data/ = 用户可写)
├── db/
│   ├── infos.db
│   └── social_storage.db
├── memory/
│   ├── memory.tdb
│   └── agents/
├── workspace/
│   ├── diary/
│   └── reports/
├── custom/                        ← 用户覆盖层
│   ├── prompts/
│   ├── agents/
│   ├── models/
│   └── plugins/
├── config.json
└── sync_manifest.json
```

---

_本文档由 Carola 整理，适用于 infOS Steam 集成与资产管理规范。_
