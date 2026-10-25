---
description: infOS-TS 项目的完整工程规范与架构设计摘要，覆盖命名、API、架构、记忆系统、扩展系统等设计决策。在为 infOS-TS 编写任何代码之前必须阅读本技能。
---

# infOS-TS 工程规范 Skill

> **本文件是对 `.docs/` 下规范文档的高密度摘要。**
> 目标读者：AI 编码助手（包括你自己的后续会话）。
> 文档分四类：**S (Standards 规范) / A (Architecture 架构) / B (Business 功能规范) / M (Modules 模块说明)**。
> 如需查看完整细节，请阅读对应的 `.docs/Sxx_*.md` / `.docs/Axx_*.md` / `.docs/Bxx_*.md` / `.docs/Mxx_*.md` 源文件。

---

## 0. 项目概况

infOS-TS 是 infOS (Python) 的 TypeScript 全栈重写。核心卖点：**庞大的 AI 角色记忆系统**。

### 产品命名体系

| 名称 | 含义 | 使用场景 |
|---|---|---|
| **infOS** | 后端引擎内核 | 代码仓库名、`packages/backend`、技术文档、Docker 镜像名 |
| **萌动链接：PeroperoChat** | 完整 Electron 桌面应用 | Steam 商店页、用户可见的产品名、窗口标题 |
| **PeroperoChat** | 上述产品的简称 | 日常口语、非正式场合 |
| **infOS-TS** | 整个 TS 重构仓库 | 仅开发期使用，区分 Python 版 infOS |

> infOS 是引擎，PeroperoChat 是产品。关系类似 Unreal Engine 和用它做的游戏。

### 技术栈

- **Monorepo**: pnpm workspace
- **后端**: Hono + Drizzle + better-sqlite3 + TriviumDB (自研 Rust 向量引擎)
- **前端**: Vue 3 + Pinia + Vite + TailwindCSS 4
- **壳层**: Electron (桌面版) / Docker (服务器版)
- **通信**: REST (:9120) + 版本化 JSON WebSocket Gateway
- **第三方 Native 依赖**: `better-sqlite3`、`node-pty`、Steam版的`steamworks.js`

**包依赖关系** (节选，完整见 A01):

```
@infos/shared          ← 无内部依赖（协议/DTO/Port/纯工具）
@infos/document-engine ← 语义文档权威
@infos/avatar-assets   ← 3D 角色(YSM)资产与清单生成
@infos/node-sdk        ← shared
@infos/node-host       ← shared + node-sdk
@infos/backend         ← shared + node-sdk + node-host + arca + pictoria
@infos/social          ← shared + backend
@infos/arca            ← shared + document-engine + node-sdk + node-host
@infos/pictoria        ← shared + node-sdk + node-host
@infos/frontend        ← shared + arca + avatar-assets
@infos/daemon          ← backend + arca + shared（发行入口）
electron               ← frontend + 本机 Capability Provider
```

**严禁**: backend import frontend/electron; frontend import backend/electron (除 shared 外); shared 无任何内部依赖。

→ 详见 [A01_PROJECT_STRUCTURE.md](../.docs/A01_PROJECT_STRUCTURE.md)

---

## 1. 命名规范速查

- **TS 文件**: `camelCase.ts` (`memoryService.ts`, `vectorWriteHelper.ts`)
- **Vue 组件**: `PascalCase.vue` (`ChatInterface.vue`)
- **变量/函数**: camelCase; **类/接口/类型**: PascalCase; **常量**: UPPER_SNAKE_CASE
- **私有成员**: `private` 关键字, **不加下划线前缀**
- **布尔变量**: is/has/can/should 前缀
- **API 路由**: 复数名词 + kebab-case (`/api/memories`, `/api/model-configs`)
- **数据库**: snake_case, 复数表名
- **注释/日志**: **中文**（专业术语保留英文）
- **平台特有代码**: `@platform WINDOWS/LINUX/DARWIN/ELECTRON/DOCKER` 标注

→ 详见 [S01_NAMING_CONVENTIONS.md](../.docs/S01_NAMING_CONVENTIONS.md)

---

## 2. API 响应规范速查

**统一信封**:
```typescript
{ code: string, message: string, data?: T }
```

- `code`: UPPER_SNAKE_CASE，从 `@infos/shared/src/constants/responseCodes.ts` 的 `CODE_MESSAGES` 注册表选取；新增 code 须先更新文档
- `message`: 中文, 面向用户, 每个 code 有默认 message
- 分页: `page=1, pageSize=20, max=100`, 响应 `{ items, total, page, pageSize, hasMore }`
- **流式统一走 Surface Projection**（`ConversationSurfaceProjector`）；旧 `stream_delta` / `tool_status` 协议已删除
- 错误处理: `AppError` 类 + 全局 `errorHandler` 中间件

→ 详见 [S02_API_SPEC.md](../.docs/S02_API_SPEC.md)

---

## 3. 后端三层架构

```
Router 层 (routers/)
  ↓ 接收请求 → Zod 校验 → 调用 Service → 包装响应
Service 层 (services/)
  ↓ 业务逻辑编排 → 调用 Repository → 外部服务
Repository 层 (repositories/)
    数据访问 (SQLite via Drizzle / TriviumDB)
```

**禁令**:
- Router 禁止直接操作 DB, 包含业务逻辑
- Service 禁止 import Hono, 构造 HTTP 响应
- Repository 禁止包含业务逻辑

**DI 容器**: `container.ts` → `createAppContext()` 按依赖顺序初始化

**LLM Provider 模式**: `LlmProvider` 接口 → `OpenAiProvider` / `GeminiProvider` / `AnthropicProvider`

**Gateway**: `services/gateway/`（gatewayHub / wsUpgrade / durableGatewayStream），业务 Action 逐步迁移到显式 Audience

→ 详见 [A02_BACKEND_ARCHITECTURE.md](../.docs/A02_BACKEND_ARCHITECTURE.md)

---

## 4. 前端架构速查

- **Transport 层**: `ElectronTransport`(IPC) / `HttpTransport`(REST), 运行时自动切换
- **Pinia vs Composable**: Pinia 管跨页面全局状态, Composable 管组件 UI 逻辑
- **性能 P0**: keep-alive 白名单 / 稳定区-尾部区分段渲染 / IntersectionObserver 不可见消息暂停
- **性能 P1**: 分批加载历史消息 / defineAsyncComponent 异步加载 / manualChunks 分包

→ 详见 [A03_FRONTEND_ARCHITECTURE.md](../.docs/A03_FRONTEND_ARCHITECTURE.md)

---

## 5. 双形态部署

- **Electron 桌面版**: 业务 API 走 HTTP(localhost:9120), IPC 仅用于窗口/托盘等 Electron 专属能力
- **Docker 后端版**: Node 运行 + Nginx 前端静态服务, 无 IPC
- **PathResolver**: `@app / @data / @workshop / @temp` 四前缀，Docker 版无 `@workshop`
- **资源覆盖**: custom > workshop > official
- **CI/CD**: GitHub Actions, lint→test→build→打包; Tag 触发 Release
- **严格隔离**: packages/backend、frontend、shared 里 **0 个 Electron 依赖**

→ 详见 [A04_DEPLOYMENT.md](../.docs/A04_DEPLOYMENT.md)

---

## 6. 记忆系统架构 (核心!)

长记忆 = **Agent 对与用户真实互动的主观事件记事（EventNote）**，基于 PEDSA v2。

**权威与隔离**:
- 系统消息时间是事件时间的唯一权威；每个 Agent 拥有独立事件记忆库（`memory.tdb`），禁止跨 Agent 混用
- 时间轴是主干，其他关系（`caused_by` / `same_event` / `same_topic` / `involves_*`）是从时间轴外扩的路网

**写入**:
- Agent 在 ReAct 中主动调用 `write_event_note` / `revise_event_note`：只创建本回合 `EventNoteDraft`，**回合成功持久化后才提交**
- 后台兜底炼化只处理"未覆盖消息区间"，允许产出 0~N 条；覆盖结论记入 `ConversationCoverage`

**检索**:
- 对话前自动 RAG：100% 注入物理时间链末尾事件 + 混合 Top-K + 不占名额的直接前驱
- Agent 用 `query_event_notes` 主动查询（recent/time_range/semantic/entity/logical/affective/mixed），返回确定性图路径

**维护与共享**:
- Reflection 统一操作 EventNote（建边/修订/归档），不得旁路写 TDB
- 每日人格日记写入 Workspace `dailynotes/*.md`（不进事件记忆库）
- 全 Agent 共享 **Facts Store**（`facts.tdb`，仅工具访问）；Knowledge Store 仅预留合同

**存储**:
- TriviumDB 0.8.2 为运行/检索权威；SQLite 保存完整备份 + 事务日志（`operationId` 幂等提交，可全量重建 TDB）
- 确定性多跳查询在 Service 层用受预算约束的 BFS 实现

> 旧摘要模式（`CanonicalMemory` / `memory_nodes` / `memoryService` / `scorer`）已删除，升级时清空旧记忆数据。

**目录**: `services/memory/`（eventMemoryService、eventReflectionService、dailyNotesService…）、`repositories/eventNote.repo.ts`、`repositories/facts.repo.ts`

→ 详见 [A05_MEMORY_ENGINE.md](../.docs/A05_MEMORY_ENGINE.md)

---

## 7. Package 与用户空间贡献系统

**Package** 是 infOS 的安装、签名、版本、升级与分发单元——不是运行时对象，也不是权限主体。

- **Manifest V2**（`@infos/shared/src/types/package.types.ts`）: `manifestVersion: 2`、`trust: official|signed|user|generated`、`contributions`、`requires`、`permissions`
- **铁律**: **安装 ≠ 激活 ≠ 授权**；任何 Contribution 不得因被发现、安装或加载而隐式扩权
- 用户 Package 物理安装根: `@data/packages`
- 统一调试入口 `runtime_debug` 仅由普通桌面工作会话按钮开启，默认关闭，按 Thread/Agent 门控；实际路径在 tools 文档动态注入。临时贡献复用宿主扩展点，关闭撤销，记录写入 `@data/debug`；任意 Node 代码仍走执行审批，不能称为 OS 沙箱。详见 [B28_RUNTIME_DEBUG.md](../.docs/B28_RUNTIME_DEBUG.md)。
- 用户插件由 `PackageManagementService` 管理 ZIP 上传、内容授权、独立依赖、启停、版本回退与代际重载；写入 `@data/packages/.managed`，运行数据写入 `@data/package-data`，不得修改发行 ASAR/镜像源码。
- `runtime:execute` 是显式的本机代码信任授权，不能自称 OS 沙箱；用户清单不能自称 `official` 获得信任。Context、Agent Flow、Presenter 与 Asset 贡献复用现有内核边界，停用须撤销注册。
- 旧 Extension Loader / ExtensionManager / ServiceRunner / HookRegistry 已**完全删除**

→ 详见 [A06_EXTENSION_SYSTEM.md](../.docs/A06_EXTENSION_SYSTEM.md)

---

## 8. Channel、Thread 与角色路由

- **Channel**（不可变，Thread 创建时写入）仅 `desktop` / `group`
- `companion` 已退役为请求级 `ambient` Capability Scope；`social`/`arca`/`coding` 是 Application Realm 身份，不是 Channel；`task` 是 Execution Class 或 Thread Purpose
- **ThreadPurpose**: `conversation | background_task | app_internal`
- **Active 不是后端全局状态**：执行主体由 `Thread.agentId` / `InboundRoute` / `Task.agentId` 决定，禁止从"当前窗口"推导
- Stronghold（`group`）永久属主应用；Social 由 `infos.social` Realm 运行，不创建 `social` Channel

→ 详见 [M01_MODE_SYSTEM.md](../.docs/M01_MODE_SYSTEM.md)

---

## 9. 能力门控 (CapabilityGate)

每个 Agent 目录下的 `capabilities.yaml` 声明式能力矩阵：
- `(Agent, Channel)` → 工具白名单
- 未在 `capabilities.yaml` 中声明的 channel **fail-closed**（无工具可用）
- 新增 channel 必须显式声明其工具白名单

→ 详见 [M02_CAPABILITY_GATE.md](../.docs/M02_CAPABILITY_GATE.md)

---

## 10. NIT 引擎

NIT 解释器封装为标准 FC 工具 `run_script`，LLM 通过 Function Calling 调用。
- 支持条件、循环、并行、try-catch
- 禁止函数定义、import、递归
- 脚本内工具调用递归走 ToolRegistry

→ 详见 [M03_NIT_ENGINE.md](../.docs/M03_NIT_ENGINE.md)

---

## 11. 其他规范

- **日志**: consola, 中文消息, 14 天保留 → [S03_LOGGING_SPEC.md](../.docs/S03_LOGGING_SPEC.md)
- **测试**: Vitest；**不设覆盖率百分比门禁**；`tests/unit` 镜像 `src` 路径，描述用中文 → [S04_TESTING_STANDARDS.md](../.docs/S04_TESTING_STANDARDS.md)
- **代码标准**: 文件大小参考上限（单文件 ≤ 500 行 / Vue ≤ 400）、三层约束、路径规范 → [S05_CODE_STANDARDS.md](../.docs/S05_CODE_STANDARDS.md)
- **UI/UX**: 设计基线，像素品牌资产 + 现代工作站空间结构 → [S06_UI_UX_DESIGN_SPEC.md](../.docs/S06_UI_UX_DESIGN_SPEC.md)
- **Steam**: Electron 专属, Workshop/Cloud → [M04_STEAM_INTEGRATION.md](../.docs/M04_STEAM_INTEGRATION.md)
- **B 系列（B01–B28）**: 具体功能的实现规范（后台任务、社交、桌面自动化、提示词、Pictoria、任务计划等）；新增文档前确认编号未被占用。

---

## 快速 Checklist

在为 infOS-TS 编写代码时, 对照以下检查项:

1. [ ] 文件名用 camelCase? Vue 组件用 PascalCase?
2. [ ] 注释和日志是中文?
3. [ ] API 返回 `{ code, message, data }` 信封? code 在规范表中?
4. [ ] Service 没 import Hono? Router 没包含业务逻辑?
5. [ ] 数据库操作通过 Repository 而非直接 Drizzle/TriviumDB?
6. [ ] 新 Service 接受构造函数注入?
7. [ ] 单个文件 ≤ 500 行 (Vue ≤ 400)?
8. [ ] LLM JSON 解析使用统一解析器?
9. [ ] 没有 Electron 依赖渗透到 backend/frontend/shared?
10. [ ] 路径没有硬编码? 使用 `path.join()` 拼接?
11. [ ] 平台特有代码用 `@platform` 标注了?
12. [ ] 平台特化功能用策略模式拆分了独立文件?
13. [ ] 事件监听用 `useEventListener`? 定时器用 `useInterval`?
14. [ ] 大型数组用 `shallowRef` 而非 `ref`?
15. [ ] 新模块有对应的 `*.test.ts` 文件?
16. [ ] 测试用例覆盖了正常路径 + 边界条件 + 错误处理?
17. [ ] 测试描述是中文，说清行为和预期?
18. [ ] 新增 Channel 已在 `capabilities.yaml` 显式声明工具白名单?
