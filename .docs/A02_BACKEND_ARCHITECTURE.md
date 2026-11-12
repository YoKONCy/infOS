# 后端架构

> **适用范围**：`packages/backend/` 全部代码
> **技术栈**：Hono + Drizzle + better-sqlite3 + TriviumDB
> **最后更新**：2026-11-12

---

## 1. 三层架构

角色连续交互由唯一主 Thread 锚定，SideThread 承载局部交互。角色状态、长记忆、会话现场、据点事实与 Execution 分别持有权威，具体调用链、事务边界和恢复入口见 [主侧会话与角色持续状态](./B26_MAIN_SIDE_THREADS.md)。

```
┌─────────────────────────────────────────────────────────┐
│  Router 层 (routers/)                                    │
│  职责：接收请求 → Zod 校验 → 调用 Service → 包装响应      │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Service 层 (services/)                                  │
│  职责：业务逻辑编排 → 调用 Repository → 调用外部服务       │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Repository 层 (repositories/)                           │
│  职责：数据访问 (SQLite via Drizzle / TriviumDB)          │
└─────────────────────────────────────────────────────────┘
```

层间禁止事项见 `S05_CODE_STANDARDS.md` §2。

---

## 2. Router 层

Router 由 `app.ts` 挂载，使用 `AppContext` 获取所需服务。以 `routers/memory.router.ts` 为例，`GET /api/memories` 通过项目级 `validate` 包装器校验查询参数，构造档案筛选条件，再调用 `eventMemoryService.archiveQuery()`。请求字段和默认值以 Router Schema 为准。

---

## 3. Service 层

服务负责领域编排，并通过构造函数或明确的 Port 获得依赖。事件记忆由 `services/memory/eventMemoryService.ts`、`eventNoteDraftCommitter.ts` 等协作处理；来源覆盖、持久化与失败恢复见 [记忆引擎](./A05_MEMORY_ENGINE.md)。

---

## 4. Repository 层

SQLite 访问由 `repositories/` 下各领域 Repository 和 Drizzle Schema 承担；`EventNoteRepository` 管理事件记忆的 SQLite 备份与事务记录。TriviumDB 句柄及文件组由 `MemoryStoreRegistry` 管理，事件记忆和事实分别使用自己的领域实现。两种存储的权威关系、事务重放和重建边界见 [记忆引擎](./A05_MEMORY_ENGINE.md)。

主库在 `database/connection.ts` 默认使用 `journal_mode=WAL`、`synchronous=NORMAL`、`journal_size_limit=64MB` 与 `temp_store=MEMORY`，避免常规配置、状态与流式结算在每次提交时强制同步刷盘，同时保持应用进程崩溃安全性与容器挂载卷下的低延迟写入；用户显式队列受理与变更则通过 `conversationQueue.repo.ts` 的 `durableQueueWrite` 在事务前后临时提升至 `synchronous=FULL`，同步落盘后再向客户端确认。Steam 自动云存档建立在已提交数据及一致性快照之上，触发、缓存与恢复边界见 [Steam 集成](./M04_STEAM_INTEGRATION.md#5-steam-cloud-自动完整快照同步)。

### 4.1 结构迁移与执行记录

`database/schemaMigrations.ts` 统一承接启动和 CLI 的结构迁移。旧单基线库先登记基线执行记录，再由 Drizzle 执行后续 SQL。已有迁移记录的库先对齐重排记录，最后执行待追加的迁移。

对齐时先按 SQL 的 SHA-256 摘要认领全部已执行项，兼容 LF 与 CRLF。剩余项再按 journal 的 `when` 匹配尚未认领的执行记录，兼容旧 SQL 文件摘要变化。摘要匹配优先于时间匹配，确保重排项旧时间上的新增迁移仍能补执行。执行记录保留原始摘要，重排仅更新 `created_at`。

最后一个已执行项之前的真实缺口在同一事务内补执行并登记，失败时连同时间调整一起回滚。其后的新增迁移交由 Drizzle 的迁移事务执行。已发布的 SQL 以既有执行记录为准，后续结构或数据变更应追加迁移文件。

早期 `0025_main_side_threads` 曾在同名文件中扩展交流执行结构。兼容入口对已登记的该项按实际列、表和索引补齐 DDL，包括消息的 `publication_id / execution_id` 及交流执行、消息来源和追问记录。补齐在记录对齐事务中完成，先于表达学习等后续迁移。该入口限定此项历史 DDL，后续演进继续追加标准迁移。

---

## 5. DI 容器

`container.ts` 定义 `AppConfig`、`AppContext` 和异步 `createAppContext()`，按依赖组装数据库、Repository、领域服务、内核和应用集成；`initAppContext()` 执行后续初始化。`startup.ts` 管理服务启动和退出。实际依赖和生命周期以这两个入口为准。

---

## 6. LLM Provider 模式

`services/llm/types.ts` 定义 Provider 接口，`llmService.ts` 根据解析后的请求协议和接口类型选择 OpenAI 兼容 Chat Completions、OpenAI Responses、Gemini 或 Anthropic 实现。服务商品牌、连接认证和请求协议分别配置；连接继承规则见 [服务商连接](./B22_PROVIDER_CONNECTIONS.md)。

### 6.1 上游提示词缓存

缓存优化只稳定现有输入，不增加模型请求、不为命中缓存保留额外旧内容。实际是否自动缓存及如何收费由服务商决定；需要显式缓存标记的服务不会由本实现主动开启。维护约束：

- 系统段只放固定规则；时间、心情、RAG、环境放在靠近当前输入的 `turn_context`。工具与 Schema 键由 `canonicalTools` 稳定排序。
- 工作模式从首个请求起列出 `finish_task`，消除业务工具执行后追加该定义的菜单变化。是否允许调用仍由执行侧门控决定；提前拒绝也先确认参数草稿、保留失败内容块，再返回工具错误，不结束执行。聊天、极简模式维持原菜单。高级工具展开、Skill 加载和错误熔断仍可改变菜单，不能为保持前缀而绕过权限或错误恢复。
- Anthropic / OpenAI Chat Completions / Responses 均不发送 `cache_control`、`prompt_cache_key` 等缓存控制字段；官方端点和中转一致。没有缓存探测、预热或不支持字段后的自动重发，也没有模型卡片缓存开关。
- 稳定前缀不等于任意重排上下文：系统规则优先级、普通消息时间顺序、工具调用与结果配对、最新状态及裁剪边界必须保持。现有工作轨迹续接与历史窗口按原规则工作，不因缓存优化额外延长历史。
- 缓存读写用量按 [B16](./B16_TOKEN_USAGE.md) 口径入账，用量卡片显示命中率。每次请求另记 `prompt_hash`、`prefix_hash`、`tools_hash`，可用 B16 的自查 SQL 定位前缀变化。

---

### 6.1 模型调用与恢复

模型请求的临时 HTTP、网络和超时故障使用统一、可取消的有限退避；ReAct 每轮最多重试 5 次，所有尝试共用请求总预算。鉴权、参数、额度耗尽、主动停止及明确不可重试故障不会自动重发。流式 EOF 缺少完成标记按中断处理；已收到部分响应时，受控 ReAct 冻结旧展示片段、丢弃未执行的工具草稿，再重新请求当前轮，前面完成的工具不重放。后台普通调用默认只在未交付部分输出时重试。

每次重试产生独立 `model_retry` 时间线块和 `model-retry` Surface 节点，固定在中断位置；记录原始原因、重试序号、上限与退避时长。回连、失败或取消只更新内部活动状态并停止动画，不替换原始文案或覆盖前次计数。时间线随消息 metadata 保存，实时展示、会话刷新和失败持久化共用同一投影。

每轮 ReAct 在文件版本投影和容量裁剪后，通过 `context_budget` 报告实际待发送消息与工具定义的输入估算；上游上报有效输入用量后替换本轮统计。聊天和陪伴入口将其写入当前 Surface 的状态节点，后续阶段切换保留该值。该统计表示当前模型请求的上下文占用，不累计多轮 API 消费，也不进入模型消息或重试时间线。

草稿 Token 预算预览以 `disableMemoryRetrieval` 关闭远程记忆检索，仅编译本地提示词、历史及工作上下文，不调用 Embedding 或 Reranker。返回 `memoryRetrievalDeferred` 标识估算不含待检索记忆；真正发送时仍按通道和 Thread 配置执行自动 RAG，ReAct 实时统计使用实际请求内容。

Embedding Provider 区分配置启用状态与服务健康状态：验证页、鉴权和无效向量响应冷却 5 分钟；网络和其他服务故障默认冷却 30 秒，429 默认 60 秒，有效 `Retry-After` 优先（限制在 1 秒至 30 分钟）。冷却期间明确抛出错误，不返回占位零向量，也不把服务标记为关闭。到期后的下一次调用只放行一个恢复探测；成功解除冷却，失败重新计时。主动取消不触发冷却，配置变更会取消旧请求并重建 Provider，迟到响应不能覆盖较新请求的健康状态。

OpenAI 兼容模型列表请求仅在 `/models` 返回 404/405 且不是验证页时探测兼容列表端点；403、鉴权、限流、网络故障及损坏响应直接报告错误，不返回成功空列表。真正的空列表保持空数组。Embedding、Reranker 和 OpenAI 兼容接口统一识别 `cf-mitigated: challenge` 与 HTML 验证页，错误提示服务商放行 API 或检查基址，日志不输出验证页原文。上游安全规则仍由服务商调整。

## 7. Gateway 层

### 7.1 架构

- **端口**：与 HTTP 共用 `:9120`
- **协议**：WebSocket + 版本化 JSON Envelope；消息进入路由前必须通过 Shared Schema 校验与协议版本协商
- **鉴权**：WebSocket 升级时校验设备身份，随后完成版本化 Hello；能力节点使用独立能力通道及相应凭据。远程 TLS 与证书信任见 [部署架构](./A04_DEPLOYMENT.md)。

### 7.2 文件组织

```
services/gateway/
├── gatewayHub.ts           # WS Hub，管理连接、心跳和版本协商
├── durableGatewayStream.ts # 可持久化的 Gateway 事件流
├── index.ts                # Gateway公开入口
├── types.ts                # GatewayEnvelope与连接事件
└── wsUpgrade.ts            # Hono WebSocket升级与JSON消息入口
```

### 7.3 Service 集成

GatewayHub 管理连接、协议握手、订阅与消息路由，并通过注入的持久通知 Repository 提供通知相关能力。具体推送入口及不同模块依赖以 `gatewayHub.ts` 和 `container.ts` 为准；Application 通过受限 Host ABI 接入。

---

## 8. 错误处理

`app.ts` 注册 `middleware/errorHandler.ts`：`AppError` 按业务码映射状态并返回信封，未知异常记录日志并返回 `INTERNAL_ERROR`。消息依据请求语言通过诊断翻译入口处理，堆栈保留在服务端日志。业务码与特殊响应边界见 [API 响应规范](./S02_API_SPEC.md)。

## 9. AIOS 领域架构约束

后端以 [A09_AIOS_ARCHITECTURE](./A09_AIOS_ARCHITECTURE.md) 为资源边界基线。三层架构之上，所有领域模块必须遵守以下分工：

| 领域            | 后端权威对象                                 | 不承担的职责                     |
| --------------- | -------------------------------------------- | -------------------------------- |
| PrincipalAgent  | 身份、人格定义、长期资源关联                 | 不维护窗口级活跃 Agent           |
| Thread          | 对话边界、消息事实、channel 与 policy        | 不持有长期记忆或工具权限         |
| Context Runtime | 只读编译 LLM 输入与 Manifest                 | 不写消息、记忆、人格或文件       |
| Memory          | EventNote 事件记事、ConversationCoverage、Provenance | 不将原始 Thread 当作长期记忆     |
| Workspace       | Agent 私有文件根与 containment               | 不写安装/Workshop 只读资产       |
| Tool Capability | `(agentId, channel)` 权限与资源范围          | 不允许默认 Agent 或 channel 回退 |
| Application Integration | Application协议、Adapter、Endpoint与Capability Port | 不注入AppContext、Repository或目标应用内部实例 |

### 9.1 请求上下文

进入 Service/Tool 执行链的运行时上下文必须明确包含 `agentId`、`threadId` 和 `channel`。后端不允许根据“当前活跃角色”推断这些值；外部入站消息由 `InboundRoute` 决定归属，后台任务由任务本身的 `agentId` 决定。

### 9.2 Context Compiler

聊天入口只接收当前输入与 `threadId`。后端从 Thread 读取 active 消息、策略与 Agent，先完成 `CapabilityGate` 工具门控解析，再通过 `Promise.all` 并行执行自动 RAG、知识库召回、角色状态装配与心流状态读取，最后由 Compiler 按固定顺序只读组装原生 `user/assistant` 消息；禁止客户端上传完整历史，禁止 XML 形式的历史重复注入。

### 9.3 Daemon 与能力提供者

`packages/backend` 保持纯 Node 运行时，不 import Electron。平台能力通过 Capability Provider 委托给 Electron、移动端等节点；无 Provider 时返回可解释的不可用结果。Provider 调用也必须先经过 CapabilityGate。

### 9.4 第三方 Application

第三方 Application 不以内置 `AgentAppRuntime` 方式加载到 Backend。Backend 只承载通用 Application Integration Foundation 和贡献者的隔离 Backend Adapter；目标应用通过独立进程、Node Host、远程 Node 或应用内部 Plugin 连接。Adapter 使用公开 Port 和 Kernel Envelope，不得接触主数据库、Repository、DI Container、主 Agent Thread 或 Credential 明文。协议与 Arca 参考实现见 [A10_APPLICATION_INTEGRATION](./A10_APPLICATION_INTEGRATION.md)。

---

_本文档由 Carola 整理，适用于 infOS-TS 后端架构规范。_
