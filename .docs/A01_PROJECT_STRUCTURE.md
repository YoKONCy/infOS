# 项目结构与 Monorepo 规范

> **适用范围**：infOS-TS 项目整体
> **最后更新**：2026-10-26

---

## 1. Monorepo 配置

使用 **pnpm workspace** 管理。

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'packages/apps/*'
  - 'electron'
```

---

## 2. 目录结构

```
infOS-TS/
├── packages/
│   ├── shared/                    # @infos/shared — 共享类型/常量/工具
│   │   └── src/
│   │       ├── types/             # 共享类型 (api.types.ts, memory.types.ts ...)
│   │       ├── constants/         # 共享常量 (responseCodes.ts ...)
│   │       ├── utils/             # 共享工具函数
│   │       └── index.ts           # 桶导出
│   │
│   ├── backend/                   # @infos/backend — Hono + Drizzle + TriviumDB
│   │   └── src/
│   │       ├── app.ts             # Hono 应用入口
│   │       ├── container.ts       # DI 容器
│   │       ├── database/          # Drizzle schema + 连接 + 迁移
│   │       ├── repositories/      # 数据访问层 (SQLite / TriviumDB)
│   │       ├── services/          # 业务逻辑层 (按功能域分目录)
│   │       ├── routers/           # 路由层
│   │       ├── middleware/        # 中间件 (errorHandler / auth / requestLogger)
│   │       ├── services/gateway/  # 版本化JSON WebSocket Gateway
│   │       ├── packages/          # Package Manifest V2与运行时
│   │       ├── tools/             # 内置Tool（按能力域分目录）
│   │       ├── applications/       # Application Realm、Host ABI与应用协作基础设施
│   │       ├── capabilities/       # CapabilityGate、Provider 注册与调用桥接
│   │       ├── lifecycle/          # 启动、关闭、Scheduler
│   │       ├── core/               # PathResolver、资产注册表与领域基础设施
│   │       ├── lib/                # 底层工具库 (logger, env, paths)
│   │       └── shared/             # 后端共享工具 (llmJsonParser, vectorWriteHelper)
│   │
│   ├── frontend/                  # @infos/frontend — Vue 3 + Pinia
│   │   └── src/
│   │       ├── api/               # API 客户端 + Transport 层
│   │       ├── stores/            # Pinia Stores
│   │       ├── composables/       # Vue Composables (按域分目录)
│   │       ├── components/        # 组件 (ui/chat/avatar/dashboard/settings...)
│   │       ├── views/             # 页面级视图
│   │       ├── router/            # Vue Router
│   │       └── config/            # 运行时配置
│   │
│   ├── document-engine/            # @infos/document-engine — 语义文档权威与投影
│   ├── avatar-assets/              # @infos/avatar-assets — 3D角色（YSM）资产与清单生成
│   ├── node-sdk/                   # @infos/node-sdk — Node协议客户端
│   ├── node-host/                  # @infos/node-host — 独立Capability Provider宿主
│   ├── daemon/                     # @infos/daemon — Daemon发行入口
│   ├── wiki/                       # @infos/wiki — 文档站
│   ├── apps/
│   │   ├── social/                 # infos.social Application Realm
│   │   ├── arca/                   # Arca自治Host与独立Client双入口
│   │   └── pictoria/               # Pictoria绘图子应用自治Host与独立Client双入口
│
├── electron/                      # Electron 壳层
│   ├── main/                      # 主进程 (index.ts, ipcBridge.ts, services/...)
│   └── preload/                   # 预加载脚本
│
├── .docs/                         # 规范文档
├── .github/workflows/             # CI/CD
├── .changeset/                    # Changeset 配置
├── pnpm-workspace.yaml
├── package.json                   # 根 package.json
└── tsconfig.base.json             # 共享 TS 配置
```

---

## 3. 包依赖关系

```
@infos/shared              ← 无内部依赖，只承载跨包稳定协议、DTO、Port、协议校验器与无领域归属的纯工具
@infos/document-engine     ← 独立Document Authority核心
@infos/avatar-assets       ← 3D角色（YSM）资产与清单生成
@infos/node-sdk            ← 依赖shared
@infos/node-host           ← 依赖shared + node-sdk
@infos/backend             ← 依赖shared + node-sdk + node-host + arca + pictoria
@infos/social              ← 依赖shared + backend
@infos/arca                ← 依赖shared + document-engine + node-sdk + node-host
@infos/arca/client         ← Arca包内独立Vue Client入口，通过Node协议连接Arca Host
@infos/pictoria            ← 依赖shared + node-sdk + node-host
@infos/pictoria/client     ← Pictoria包内独立Vue Client入口，通过Node协议连接Pictoria Host
@infos/frontend            ← 依赖shared + arca + avatar-assets
@infos/daemon              ← 依赖backend + arca + shared（Backend发行入口）
@infos/wiki                ← 文档站
Electron                   ← 主Frontend与本机Capability Provider壳层
```

**严格规则**：见 `S05_CODE_STANDARDS.md` §7（依赖管理）。

---

## 4. 后端 Service 目录

Service 按功能域分目录，超 500 行必须拆分子模块。

```
services/
├── memory/            # 记忆核心域（eventMemory*、eventReflection*、dailyNotesService、
│                      #   graph/、maintenance/ 等；SocialScorer 归社交应用）
├── gateway/           # 版本化JSON WebSocket Gateway（gatewayHub/wsUpgrade/durableGatewayStream）
├── agent/             # Agent 服务 + ReAct 循环
├── conversation/      # 会话与对话日志
├── context/           # 上下文编译（Context Compiler）
├── retrieval/         # 检索（含记忆高级检索管线）
├── embedding/         # 向量编码
├── llm/ model/        # LLM 门面、模型注册与选择
├── prompt/            # 提示词系统
├── voice/ tokenizer/  # 语音 TTS/VAD 与分词
├── scheduler/         # 调度
├── stronghold/        # 多角色房间
├── social/            # 宿主侧社交桥接；应用运行时位于 packages/apps/social/runtime/
├── mcp/ mdp/          # MCP 与 MDP 集成
└── …                  # 其余功能域：attachment、companion、distributed、execution、flow、
                       #   integrations、knowledge、maintenance、pipeline、runtime、session、
                       #   system、task、thread、weather、workspace
```

---

## 5. 规范文档与归档

活动架构文档按职责维护，禁止重新建立跨领域巨型“演进计划”作为第二权威源：

| 主题                                                           | 权威文档                              |
| -------------------------------------------------------------- | ------------------------------------- |
| AIOS宪法、Kernel Object、Execution、Capability、Event、Context | [A09](./A09_AIOS_ARCHITECTURE.md)     |
| Backend分层、DI、Gateway与错误                                 | [A02](./A02_BACKEND_ARCHITECTURE.md)  |
| Surface Protocol与Compositor                                   | [A03](./A03_FRONTEND_ARCHITECTURE.md) |
| Memory Resource与Provenance                                    | [A05](./A05_MEMORY_ENGINE.md)         |
| Package、Application与跨包Port                                 | [A06](./A06_EXTENSION_SYSTEM.md)      |
| Runtime Adapter、资源Handle与跨平台隔离                        | [A07](./A07_CROSS_PLATFORM.md)        |
| 第三方Application三层Adapter、协议与Arca参考实现               | [A10](./A10_APPLICATION_INTEGRATION.md) |
| 性能预算、安全、故障注入与发布验证                             | [A08](./A08_DEVOPS.md)                |

长期技术文档按当前职责持续维护，完成实现不意味着应归档其技术说明。被替代的方案、一次性调查与历史计划可留在本地 `archived/`，不作为当前实现的权威规范。文档分类和阅读路线见 [开发者入口](./README.md)。第三方 Application 接入的权威规范见活动文档 [A10_APPLICATION_INTEGRATION](./A10_APPLICATION_INTEGRATION.md)。

---

原生能力通过上游 npm 依赖接入；本仓库没有自有 Rust/Cargo 工程。ABI 适配和发行资源维护见 [B27](./B27_RUNTIME_SECURITY.md)。
