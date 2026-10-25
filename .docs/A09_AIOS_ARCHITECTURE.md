# AIOS 核心架构与演进边界

> **适用范围**：infOS-TS 全项目（后端 Daemon、前端客户端、Electron 壳、资产与扩展）
> **状态**：当前架构基线 + 后续演进约束
> **最后更新**：2026-10-17
> **来源**：融合历史 AIOS 设计草案（原 `.aios/00` 至 `.aios/12`）的设计原则、已完成重构结论与后续设计草案。

---

## 1. 架构使命与不可变原则

infOS 是以 **PrincipalAgent（主 Agent）内核** 为中心、可由自治 Application 扩展的 AI 工作站。系统必须从“单个后端进程围绕一次聊天请求集中编排状态”的模型，演进为资源边界明确、可多客户端接入、可跨发行形态运行的 Agent Runtime。

infOS 只有一种通用自治 Application 形态：稳定身份、独立领域边界和独立生命周期的 Application Node/Realm，Arca 是标准参考实现。第三方开源应用保持自己的进程、UI、后端、Agent、会话和数据，通过三层 Adapter 与 Application Integration Protocol 接入；不要求改写为进程内 `AgentAppRuntime`。是否有 UI、是否常驻、是否使用 LLM、是否包含内部 Agent，都是应用内部策略，不构成应用分类。Social是系统兼容特例，不定义通用生态 ABI。

**Stronghold是且永久只能是主应用内部模块。** 它拥有主应用内的房间权威消息流、`group` Thread、管家和多Agent交互，但不拥有Application Identity、Application Realm、独立Host、应用安装生命周期或应用工具命名空间。任何将Stronghold迁移为子应用、自治Application或Application Realm的设计均违反本规范。

### 1.1 六个一等资源

每个 PrincipalAgent（例如 Pero、Nana）拥有六个平级资源；它们通过 `agentId` 关联，不能用其中任意一个替代另一个。

| 资源                | 职责                                    | 生命周期             | 权威存储                                |
| ------------------- | --------------------------------------- | -------------------- | --------------------------------------- |
| Identity            | 人格、表达风格、行为边界与 channel 补丁 | Agent 长期存在       | Agent 定义文件与数据库元数据            |
| Long-term Memory    | 跨 Thread 的提炼记忆、候选和来源追溯    | Agent 长期存在       | SQLite + TriviumDB                      |
| Principal Workspace | Agent 的个人文件空间                    | Agent 长期存在       | `@data/principals/{agentId}/workspace/` |
| Context Runtime     | 只读编译 LLM 输入                       | 单次调用临时存在     | 内存                                    |
| Thread              | 对话边界与消息事实记录                  | 用户创建、归档或删除 | SQLite                                  |
| Tool Capability     | 工具、资源范围、参数约束和审批策略      | 随 Agent 配置存在    | Agent/扩展配置                          |

### 1.2 状态所有权

**持久状态**必须由后端权威维护，包含 Agent 配置、Thread 与消息、记忆、Workspace 文件、Capability 配置、入站路由及用户安装资产。

**运行时状态**重启后可重建，包含 LLM 调用、Context Bundle/Manifest、连接、Scheduler 执行态与取消控制器。

关键规则：

1. 后端不维护“全局活跃 Agent”或“全局活跃 Thread”。它们是**前端窗口级 UI 路由状态**。
2. 后端可同时服务多个 Agent、多个 Thread，所有请求必须显式携带或由 Thread 推导 `agentId`、`threadId`、`channel`。
3. 前端只拥有显示缓存和窗口偏好；不组装权威上下文，也不保存业务真相。
4. 切换 Agent 时必须原子地切换或创建匹配的 Thread，禁止出现不同 Agent 与 Thread 混配。
5. 消息存储、上下文编译与前端展示彼此独立；“模型看到什么”由 Context Compiler 决定，不应反向改变事实存储。

---

## 2. PrincipalAgent 与 Identity

### 2.1 Agent 身份边界

PrincipalAgent 是有长期人格、记忆和工作区的逻辑身份，不是会话、上下文包、工具清单或未来 SubAgent。

```text
PrincipalAgent
├─ Identity
├─ Long-term Memory
├─ Principal Workspace
├─ Context Runtime
├─ Threads
└─ Tool Capability
```

Agent 逻辑身份应与未来可能存在的运行实例区分：`pero@desktop`、`pero@mobile` 和 `pero@cloud` 可代表同一 PrincipalAgent 的不同接入点；长期记忆始终归属逻辑身份，而不是某台设备。

### 2.2 Identity 组成与补丁规则

```text
Identity
├─ basePersona            核心人格，始终存在
├─ channelPatches         仅叠加场景差异
└─ behaviorBoundary       安全、隐私与内容边界
```

- `basePersona` 不因 channel 或客户端切换而替换。
- `channelPatches` 仅叠加差异，不可覆盖核心人格。
- 补丁由 Context Compiler 在编译时只读加载；Identity 本身不维护“当前模式”。
- 客户端输入或 `extraVars` 不得覆盖 `agent_name`、人格、记忆、所有者信息等核心变量。

官方、Workshop 与用户 Agent 定义可以参与资产联邦，但官方/Workshop 定义只读；运行时 Workspace 必须始终位于 `@data`，不得写入安装目录或订阅目录。

---

## 3. Thread、Channel 与消息事实流

### 3.1 Thread 的职责

Thread 是一次交互的持久边界，负责消息存储、软删除、修订版本与策略归属；不负责人格、长期记忆、工具权限或上下文编译。

```text
Thread
├─ id / agentId / channel
├─ platform / platformIdentifier
├─ title / status / 时间字段
├─ contextPolicy
├─ messageCount / pairCount
└─ ThreadMessage[]
```

`ThreadMessage` 必须保留 `role`、内容、`pairId`、状态、`revision`、真实 `agentId`（适用于 assistant 消息）、元数据与时间戳。删除默认是软删除，Compiler 只读取 active 消息；敏感数据擦除应使用保留 tombstone 的物理清除流程。

### 3.2 Channel 是 Thread 的持久属性

```text
ThreadChannel = 'desktop' | 'group'
```

- Channel只描述主应用内部交互入口，不得编码Arca、Social、Coding等子应用身份；子应用身份由`appId/realmId`表达。
- `group`专属于主应用Stronghold内部交互；不得被Social或其他Application Realm复用。
- Application Realm内部会话使用Realm私有Surface/Session标识，不扩大全局`ThreadChannel`联合。
- Channel 不属于 Agent 的“当前模式”，也不是临时调用参数。
- 同一 Agent 可并发拥有不同 channel 的 Thread。
- `ambient` 是请求级 Capability Scope，不是 Channel；它只能在当前 Channel 权限基础上做减法。
- App 聊天与 Pet3DView 都使用同一 Agent 最新的 `desktop/conversation` Thread，确保历史与短期上下文连续。
- 主动陪伴开关只控制 Agent 主动行为调度，不切换 Thread、Channel 或人格。

| Channel | 主要处理路径                    | 记忆边界   | 说明                                        |
| ------- | ------------------------------- | ---------- | ------------------------------------------- |
| desktop | PrincipalAgent Context Compiler | 主记忆     | App、Pet3DView 与本地快捷入口共享的连续交互 |
| group   | 主应用Stronghold运行时          | 房间事件流 | 主应用内部多人房间交互，不属于Application   |

### 3.3 据点群聊的双层模型

据点群聊同时存在两种不同用途的数据：

1. **房间权威消息流**：按 `roomId` 存储和展示，代表用户实际看到的房间会话。
2. **按 Agent 隔离的 group Thread**：例如 `stronghold_{roomId}_{agentId}`，仅用于每个 Agent 的独立上下文编译、人格与工具边界。

两者不可混淆。对话日志必须按房间聚合并读取权威消息流，不能因内部隔离 Thread 而将同一房间拆成多个角色会话；内部 Thread 也不应被房间日志的改名、删除操作误伤。

### 3.4 主动行为与临时输入

主动陪伴、定时事件和系统触发属于通用主动行为，不创建专用 Channel。调度器复用目标 Agent 最新的 `desktop/conversation` Thread，并以 `capabilityScope='ambient'` 执行。内部触发指令使用 `inputPersistence='ephemeral'`，只参与本轮上下文；最终 assistant 回复正常写入 Thread 并推送到客户端。这样既保留完整用户历史，也避免内部系统指令污染聊天记录。

旧 `companion` Thread 在迁移启动时统一软删除，不合并到 Desktop 历史。

---

## 4. Context Runtime：只读编译而非状态容器

### 4.1 职责与边界

Context Runtime 在每次 LLM 调用时从 Identity、Memory、Thread、Workspace 和 Tool Capability **只读消费**，编译出 LLM Messages 与可审计 Manifest。

它不得：写入记忆、修改人格、持久化消息、执行工具或创建文件。

```text
ContextRuntime
├─ ContextCompiler
├─ ContextBundle       单次调用临时产物
├─ ContextManifest     资源使用与裁剪记录
├─ TokenBudget
└─ ContextPolicy       由 Thread 持有
```

### 4.2 三层上下文机制

| 层级     | 内容                     | LLM 介入   | 触发方式          |
| -------- | ------------------------ | ---------- | ----------------- |
| 短上下文 | 最近窗口内的原生消息     | 否         | Compiler 直接读取 |
| 长记忆   | Agent 的事件记事（EventNote） | 提炼阶段有 | RAG / 策略检索    |
| 即时检索 | Agent 主动调用的记忆工具 | 是         | ReAct 决策        |

滚动摘要不是事实真相层。它会造成双重压缩、维护复杂和额外 LLM 调用；超出窗口的历史应由可追溯的长期记忆兜底，而不是把历史反复摘要后注入 Prompt。

### 4.3 编译顺序与原生消息要求

高层编译顺序为：权限过滤 → 相关记忆检索 → active/latest revision 消息选择 → 去重 → Token 预算 → 槽位排序 → 输出 Messages/Manifest。

最近消息必须保留原生 `user` / `assistant` 角色，禁止序列化为 XML 后再塞进 system prompt，以避免历史重复注入。

典型槽位顺序：

| 位置    | 内容                             |
| ------- | -------------------------------- |
| 100–200 | 核心人格、行为边界、channel 补丁 |
| 300     | 经策略筛选的长期记忆             |
| 500     | 工具和技能描述                   |
| 600     | Workspace 引用（可选）           |
| 700     | 最近 Thread 原生消息             |
| 800     | 当前用户输入                     |
| 900     | 时间与一致性提醒                 |

### 4.4 Token 预算与 Manifest

不可压缩内容包括人格、硬规则和当前输入；近期消息、channel 补丁和必要工具为高优先级；工作区描述与旧消息可裁剪；记忆和系统知识按需检索。

`ContextManifest` 至少应记录人格/补丁版本、记忆检索项、消息范围、工具筛选、Token 明细和裁剪原因，用于回答“这条信息为何进入本轮 Prompt”。

---

## 5. Long-term Memory：事件记事与来源

长期记忆归属 PrincipalAgent，不归属 Thread；Thread 是记忆的来源，不是记忆容器。

```text
Thread 消息 / Scheduler / 主动记事
  → EventNoteDraft（本回合）
  → 回合成功持久化后提交 EventNote（系统时间轴）
  → 后台未覆盖区间补记 + Reflection 建边/归档
  → MemoryRetrieval
  → Context Compiler
```

### 5.1 EventNote 与 Provenance

每条事件记事应记录：`agentId`、`narrative`、`eventAt`（系统权威时间）、`createdAt`、`importance`、情感与结构化标签，以及完整 provenance：来源 Thread、Pair/消息 ID、channel、创建方式（主动/后台）。

来源追溯支持：

- 审计记忆为何存在；
- 判断可信度；
- 按来源处理隐私请求；
- 删除或归档 Thread 时定位受影响的记忆；
- 避免不同 Thread、不同场景的消息混批提炼。

### 5.2 提交与覆盖决策

写入只创建本回合 Draft，回合成功后才提交；后台仅处理未覆盖的连续消息区间，可产出 0~N 条事件。是否值得长期保留由模型判断，代码只负责工程幂等与覆盖边界；零事件区间以 `reviewed_no_event` 记录。

### 5.3 存储隔离与 TriviumDB 文件组

每个 Agent 的事件记忆按 `agent_{agentId}` 物理隔离（`memory.tdb`，社交侧为 `social.tdb`）；全 Agent 共享 `knowledge/facts.tdb` 与 `knowledge/knowledge.tdb`。每日人格日记写入 Workspace `dailynotes/*.md`，不进入记忆库。Mmap 存储模式下，一个 TDB 的持久化一致性组包括：

- `*.tdb`：元数据、图和 payload；
- `*.tdb.vec`：向量本体；
- `*.tdb.flush_ok`：跨文件提交标记；
- `*.tdb.wal`：崩溃恢复日志；
- `*.tdb.quiver`：可重建的 ANN 索引。

云同步必须同步持久化一致性组，排除 `*.tmp` 与 `*.lock` 等运行中间态；加载端以 `flush_ok` 校验并在必要时由 WAL 恢复。

---

## 6. Workspace 与 Tool Capability

### 6.1 Workspace 分类

| 空间                  | 所属           | 用途                             |
| --------------------- | -------------- | -------------------------------- |
| Principal Workspace   | PrincipalAgent | 日记、笔记、草稿、计划和个人文件 |
| Application Workspace | Application    | 应用项目、产物与任务资源         |
| Runtime Data Space    | 系统           | DB、配置、缓存、向量索引         |

Principal Workspace 的唯一可写根为：

```text
@data/principals/{agentId}/workspace/
├─ inbox/ notes/ diary/ drafts/ plans/
├─ documents/ attachments/ exports/
└─ archive/
```

所有 Workspace 文件操作必须做规范化 containment 检查，拒绝绝对路径、`..` 逃逸、软链接/junction 越界和未授权扩展名。`@principal` / Agent Workspace 逻辑前缀只能解析到 `@data` 下的 Agent 私有根。

### 6.2 Capability 的多层约束

权限不只是工具名白名单，而是：

```text
(agentId, channel)
  ∩ capabilityScope（default / ambient，只减不增）
  → ToolPermission
     ├─ toolName
     ├─ resourceScope（允许根、拒绝路径、scope）
     ├─ paramPolicy（可选）
     └─ requiresApproval
```

原则：

1. 工具定义注入和实际执行必须经过同一个 CapabilityGate。
2. 未配置 channel 必须 fail-closed，不能回退 desktop 全开放。
3. 平台能力（截图、剪贴板等）也必须先通过 CapabilityGate，再路由给 Provider。
4. 工具执行上下文必须显式传递 `agentId + threadId + channel + capabilityScope`，禁止默认回退到某个 Agent。
5. `ambient` 只能对 Channel 的工具、Skill 与 Prompt Fragment 取交集，禁止动态 `load_skill` 扩权。
6. 文件和终端操作默认受 Workspace scope 限制；高风险动作进入审批层。
7. `run_script` 等快捷路径不得绕过统一执行器。

---

## 7. Node、Facet、控制面与能力提供者

### 7.1 Node 与 Facet

Daemon、Electron、Tauri、Web、CLI、Docker 与 Capability Host 不再被建模为互斥产品类型，而是 INF Node 上可组合的 Facet：

```text
server      Agent、Policy、Scheduler、业务权威
client      Surface、Input Seat、用户在场
capability  Browser、ComfyUI、TTS、设备能力
storage     Workspace、Asset、Credential 权威
compute     GPU/CPU 执行资源
gateway     Node Session 与 Carrier 入口
device      相机、麦克风、相册、定位、震动
```

Node Identity 是稳定安全身份，Node Session 是一次 Transport 连接。连接断开或重建不能改变对象 Authority，也不能让旧 Session Handle 继续有效。

客户端入口在任何后台启动之前决定：Electron 标准版、Steam 版和便携版可选择本地 Server Facet 或远程 Control Authority。远程模式不启动本机 Server，仅保留 Client/Capability Facet；业务连接与能力会话绑定选定服务器身份，断线不自动回退本地。模式配置与加密凭据位于客户端用户根目录，不依赖业务数据库，不参与 Steam 业务快照。切换模式通过重启生效，退出远程客户端不关闭共享服务器或其子应用。

### 7.2 Control Plane 与 Execution Plane

```text
Control Plane（通常在 Server Facet）
  Principal Agent / Planner / Policy / Approval / Placement / Binding

Execution Plane（可在任意合规 Provider Node）
  Runtime Adapter / Browser / ComfyUI / TTS / OCR / Device Input

Data Plane
  Kernel Envelope / Runtime Event / Asset Stream / Transfer
```

Agent Application 不能直接持有本地 Driver。它只能消费 Bound Port；Placement Resolver 根据 Requirement、Offer、Node Lease、Trust、Input Seat、数据驻留和资源 Authority 选择 Provider。

### 7.3 单 Server 内单对象单 Authority

每个持久或有副作用的 Kernel Object 在当前 Server 运行时内只有一个 Authority Node。其他 Client/Capability Node 可以缓存 Snapshot，但写入必须回到该 Server Authority。Authority 负责 Generation、Revision、Sequence、Handle Revocation Epoch 与 Durable Fact。

多 Server 之间不建立实时 Replica、自动 Command Route 或隐式多主。用户主动执行“从此服务器上同步最新数据”时，所选 Server 的完整用户数据快照是唯一来源，并整体覆写当前 Server；同步完成后各 Server 继续独立运行，后续数据不会自动互相追平。

禁止：

- 多 Node 直接写同一 SQLite/TriviumDB；
- 多 Server 自动同步、对象级选择同步或按时间戳合并完整用户数据；
- 把共享文件路径当作分布式资源协议；
- 让 Electron/Steam/便携版 Renderer 切换到远程 Server；
- Provider 断线后继续使用旧 Lease/Handle。

### 7.4 Node-scoped Capability

Provider Offer 必须携带 Node 与 Placement：

```text
Capability Definition
→ Node-scoped Offer
→ Placement Resolver
→ Policy Binding
→ Node-bound Handle
→ Bound Port
→ Kernel Envelope(sourceNodeId → targetNodeId)
→ Node Transport
→ Provider
```

有效权限继续是交集，并加入 Node 约束：

```text
Consumer Handle
∩ Provider Offer
∩ Node Trust / Lease
∩ Placement Requirement
∩ Resource Authority
∩ Policy / Approval
∩ Deadline / Generation / Revocation Epoch
```

### 7.5 客户端与 Input Seat

Client Facet 代表用户界面，不天然拥有服务端权限。文件选择器、桌面截图、窗口、剪贴板、通知、摄像头、麦克风、扬声器与 Pet3DView 等能力必须由 Client/Device Provider 发布。

`InputSeat` 表示当前可接收用户输入和审批的客户端会话。需要用户在场的操作必须绑定 Input Seat Lease；无活动 Seat 时返回等待状态，不能任意选择另一个在线客户端。

### 7.6 Gateway 与 Node Plane

GatewayHub 只负责 WebSocket Carrier、连接心跳与消息收发，不承担 Node Identity、Trust、Facet、Authority、Placement 或 Capability Binding。正式 Node Plane 由以下对象组成：

```text
NodeRegistry
NodeSessionRegistry
NodeCapabilityDirectory
ResourceAuthorityDirectory
PlacementResolver
NodeRouter
NodeTransport
```

Gateway WebSocket、Electron IPC、HTTP、MCP 或未来 QUIC 都只是 NodeTransport Adapter。

### 7.7 Capability Node 接入规则

独立 Capability Node 不依赖 Server 主动连接其 IP。Server 在“分布式”Tab生成包含 Endpoint、Server ID、证书指纹和一次性 Pairing Code 的邀请；Capability Node 使用邀请主动建立出站 WSS，完成证书和 Trust 校验后发布 Offer。该方式通常不要求能力节点拥有公网入站地址或配置 NAT 端口映射。

首版一个 Capability Node 只绑定一个 Home Server。它的 Session、Offer Lease、Invocation、Cancellation、Receipt 和 Asset Transfer 都由 Home Server 管理；其他 Server 不实时发现或跨 Server 调用该节点。用户若要在另一 Server 使用同类能力，应将能力节点重新配对到目标 Server，或部署另一个能力节点。

### 7.8 Browser Capability 的正式边界

Browser 不定义为 Application。首期它是 Electron Client 按需发布的 `web.page` Capability，由 Agent 通过 `browser_*` Tool ABI 使用。页面 Scene、Action Receipt、Form Plan 和 Site Model 可以由 Tool 编排层维护，但不因此建立 Browser Application Identity、Application Store 或第二套生命周期。

```text
Principal Agent
→ browser_* Tool ABI
→ web.page Capability Handle
→ Electron Browser Provider
→隔离 BrowserWindow / WebContents
→ Electron内置 Chromium
```

Electron Browser Provider 拥有隔离的 Browser Session、Profile、Cookie、Download 和页面对象 Authority。它不得直接复用 infOS 主 Renderer，也不得默认接管用户日常 Chrome。需要可见交互或审批时，可把同一个隔离 WebContents 按需展示；后台任务可隐藏运行。

非 Electron Client 默认不声明 `web.page`，相应 Browser Tools 由 CapabilityGate 隐藏或返回 Capability Unavailable。首期不自动回退服务器 Chromium，也不因为客户端缺少浏览器能力而隐式上传 URL、Cookie、下载或登录流程。未来若确有需要，可显式安装远程 Browser Provider，但它只是另一个 `web.page` Offer，不改变 Tool ABI。

生产装配已完成迁移：Backend Container 不再安装 `infos.browser`、不发布 `server.browser.chromium`，也不启动 Chromium Driver 或持有 Browser Profile。Backend 只保留 Browser Tool 定义、Electron能力上下线绑定与结果编排；旧 Chromium Runtime 和 Browser Application 类仅作为未装配的研究代码保留，不构成运行时能力。

### 7.9 Application Integration 与主 Agent 边界

第三方 Application 采用三层 Adapter：infOS 通用 Integration Foundation、infOS 侧应用专属 Adapter、目标应用内部 Plugin/Extension/Sidecar。详细协议和 Arca 参考实现见 [A10_APPLICATION_INTEGRATION](./A10_APPLICATION_INTEGRATION.md)。

主 Agent 与 Application 主要通过 Tool Projection、Application Task 和 Application Session 通信。Application 接收长任务并返回 `taskId` 后，任务必须拥有独立 Principal、Kernel Execution、取消域和持久状态；主 Agent 的单次 ReAct、Thread 或 Execution 失败不得级联取消该任务。因果关系使用 `correlationId/causationId`，不能滥用 `parentExecutionId` 建立隐式生死绑定。

Application 使用 Persona、Knowledge、Workspace、Model 或 Asset 时必须通过 Capability Handle 和 Bound Port。禁止向社区 Adapter 注入 `AppContext`、Repository、数据库连接、裸路径、Credential 或 Kernel Service 实例。Persona 必须是版本化投影，不是包含系统协议和隐藏规则的最终 System Prompt。

进程内 Application Realm 仅用于官方受信任兼容实现。第三方 Application 默认运行在独立 Service Process、Node Host 或远程 Node；Backend 内存 Runtime Map 不得成为通用 Application 生命周期的权威载体。

### 7.10 入站路由替代全局活跃 Agent

外部消息仍由 `InboundRoute` 决定 Principal/Thread 归属；Node Placement 只决定执行位置，不能替代 Principal 路由：

```text
(source, identifier) → { agentId, channel, threadId?, config? }
```

桌面聊天由 Thread 的 `agentId` 决定，后台任务由 SchedulerTask 的 `agentId` 决定，外部消息由 InboundRoute 的 `agentId` 决定。Node、Principal、Thread 和 Input Seat 是四个独立维度。

---

## 8. Context Compiler 与 Region 收敛

ContextCompiler 是 infOS 唯一的模型上下文编译权威。跨端连续性统一实现为 Continuity Region，而不是平行的预处理器、消息库或 Prompt 触发系统。

```text
Identity / Rules / State / Capability / Memory / Flow
Thread Message Authority
Cross-thread Continuity Query
        ↓
ContextRegionProvider
        ↓
Context Region Registry
        ↓
Trust / Priority / Required / Budget / Deduplication
        ↓
ContextCompiler
        ↓
MDP Slot Render + Native Conversation Messages
        ↓
LLM Messages + Context Manifest
```

### 8.1 ContextRegion

Region 是一次编译使用的只读材料，不是新的持久领域真源：

```text
regionId
kind
sourceObjectRefs
trust
priority
required
tokenEstimate
contentHash
content
provenance
validUntil
deduplicationKey
```

Region Provider 只能读取其领域 Authority 并返回 Region；不能修改 Thread、Memory、Agent State 或 Prompt 模板。ContextCompiler 负责统一选择、预算和渲染。

### 8.2 Region 信任与预算

信任级别至少区分：

```text
system       内核规则与受信模板
principal    用户/Agent 显式身份资源
authority    Server 权威领域数据
derived      摘要、检索、投影等派生数据
external     外部平台或不可信来源
```

选择顺序不是简单字符串拼接：

```text
required Region 必须保留，否则编译失败
→按 priority、trust 和稳定 regionId 排序
→按 deduplicationKey/contentHash 去重
→在 tokenBudget 内选择 optional Region
→ Manifest 记录 selected/dropped/truncated 与原因
```

本阶段只允许 Region 整体选择，不对任意文本静默截断；后续可由 Provider 提供多分辨率 Region 或显式压缩版本。

### 8.3 Continuity Region

Continuity Region 只读查询同一 Agent 的其他活跃 conversation Thread：

```text
agentId = 当前 Agent
threadId !=当前 Thread
purpose = conversation
status = active
role ∈ user/assistant
message status = active
按 Authority timestamp/messageId 稳定排序
限制 Thread 数、消息数、时间范围与 Token 预算
```

Continuity 消息引用来自 Server Authority，但消息正文仍属于 `principal/external` 数据，不能因为由服务器持久化就提升为系统指令。Region 必须以低信任数据边界渲染，禁止覆盖当前目标、Policy、Capability 或系统规则。

输出保留结构化来源：

```text
messageId / threadId / channel / platform
senderId / agentId / role / revision / timestamp
```

Context 渲染时可以显示来源，但禁止把来源尾标写回消息正文。

Continuity 不建立私有消息数据库，不使用 Fuzzy 作为原生身份机制，不覆盖 Thread Message，不将其他 Thread 消息写入当前 Thread。编辑与重试分别由 Revision 和 Execution/Correlation 表达。

### 8.4 Context Manifest

Manifest 必须证明本轮使用了哪些 Region：

```text
providerId
regionId
kind
selected
tokenEstimate
trust
priority
sourceObjectRefs
contentHash
reason
```

Manifest 用于审计、调试和可解释 Surface，不包含 Credential 明文或未脱敏秘密。

### 8.5 与 Memory、Summary、Observer 的关系

```text
Thread Message Domain Event
├─ Memory Pipeline → Memory Region
├─ Summary Service → Summary Region
├─ Continuity Query → Continuity Region
├─ Observer Service → Agent State Region
└─ Surface Projection
```

这些消费者并列读取权威事件；Continuity 不是 Memory，Summary 不是 Message Authority，Observer 不能直接修改 Context。是否进入模型输入最终由 ContextPolicy 和 ContextCompiler 决定。

---

## 9. 资产联邦与多发行数据边界

资产联邦的覆盖优先级固定为：

```text
官方 @app  <  Workshop @workshop  <  用户本地 @data
```

官方与 Workshop 资源为只读。模型需要动态生成 manifest 时，应在内存中通过受限虚拟协议提供，不能回写安装或订阅目录。后端与 Electron 分别扫描其所属资源类型，但必须遵守同一覆盖顺序和 PathResolver containment 规则。

跨发行版共享同一数据语义：Agent 数据、Workspace、SQLite、TriviumDB、用户安装的 Skills/Extensions 和自定义资源位于 `@data`。安装资源与 Workshop 订阅内容可重新获取，不能被当作用户存档写入或云同步的唯一来源。

---

## 10. API 与流式契约

### 10.1 后端权威 API

客户端创建或选择 Thread 后，只提交当前输入：

```text
POST /api/chat
{ threadId, content, attachmentIds? }
```

后端从 Thread 读取 Agent、channel、策略与历史，编译上下文并持久化消息。客户端不得上传完整历史数组来参与上下文组装。

REST 保持统一响应信封；API DTO 与 SSE discriminated union 放在 `@infos/shared`，防止前后端字段漂移。Shared只保存两个及以上Package共同遵守的稳定边界契约，不保存具体Application Manifest、单一前端功能实现、产品策略常量或Backend Service/Repository。具体Application必须在自身Package定义Manifest并通过公开入口导出。

### 10.2 SSE 事件

流式事件至少包括：`delta`、`thinking`、`tool_call`、`tool_result`、`status`、`error`、`done`。

- 工具调用与结果必须用 `callId` 关联；
- 工具参数统一为 `args`，结果统一为 `result`，状态使用 `success`；
- 流成功结束必须显式发送 `done`，前端不能仅依赖 EOF 判断成功；
- 未收到 `done` 的流应视为可恢复的截断状态。

---

## 11. 迁移策略与架构修复经验

### 11.1 演进原则

AIOS 迁移采用小步、可验证和可回滚的方式：每次只解决一个边界问题，旧数据先备份后迁移，接口兼容层只在明确过渡期存在。任何迁移完成后都应能独立运行、通过类型检查和覆盖相应的领域测试。

| 演进主题          | 核心结果                           | 验证重点                     |
| ----------------- | ---------------------------------- | ---------------------------- |
| Session → Thread  | 后端权威 Thread 与消息事实流       | 客户端不再提交完整历史       |
| Context 编译      | 历史仅作为原生消息注入一次         | 无 XML 历史重复              |
| 前端适配          | 窗口级 UI 状态与 Thread 视图订阅   | 刷新后持久资源不丢失         |
| Workspace         | Agent 私有根和 containment         | 非授权路径不能读写           |
| Memory            | Candidate、Gate、Provenance        | 不同 Thread 不混批提炼       |
| Capability        | `(agentId, channel)` + fail-closed | 社交/群聊不暴露高风险工具    |
| Daemon / Provider | Node 后端与 Electron 能力解耦      | 无桌面 Provider 时可解释降级 |

历史 `conversation_logs` 迁移到 `thread_messages` 时，应按 `(sessionId, agentId, source)` 建 Thread，生成 `pairId`、默认 active 状态和初始 revision，并保留原表/备份以支持审计。旧 `session.{agentId}.current` 等全局指针不可作为新架构的权威来源。

### 11.2 能力桥接的已验证教训

能力提供者链路必须避免以下常见断点：

1. 所有启动入口都需要启动同一 CapabilityBridge，不能只在某个 daemon 入口注册。
2. 工具名与能力名可以不同，必须存在显式映射（例如 `take_screenshot → screen_capture`），不能依赖偶然同名。
3. Provider 返回值必须在边界处标准化；截图等多模态能力需要返回可供 ReAct/LLM 消费的结构，而非底层 API 的随意字段。
4. 权限检查优先于 Provider 路由，防止平台工具绕过 CapabilityGate。
5. Provider 协议置于 shared 包；注册、心跳、调用、结果和错误格式不可由两端各自复制。
6. Provider WebSocket/IPC 连接在生产形态必须鉴权；主动断连与心跳超时统一为 offline 语义，避免节点记录行为不一致。

### 11.3 API 兼容期

兼容接口只能内部转换到 Thread API，且必须有移除计划：旧 Session 创建/清空/查询接口迁移到 `/api/threads`，旧聊天全量 `messages` 载荷迁移到 `{ threadId, content }`。兼容层不得重新引入前端上下文组装。

---

## 12.统一 Application 与内部 Agent

### 12.1 Application 不分类

通用 Application 只有一种自治形态。Arca、Research、Minecraft Companion、Coding Workspace 等都使用相同的 Application Identity、Host、Capability 和 Federation 模型。以下差异只是内部策略：

```text
有 UI /无 UI
前台 /后台
常驻 /按需启动
Kernel托管启动 /用户或外部系统启动
单进程 /多进程
使用 LLM /不使用 LLM
包含内部 Agent /纯确定性逻辑
```

`Package` 是安装与分发单位，`Tool` 是 Agent-facing 薄 ABI，`Capability` 是版本化能力契约，`Client` 是可选交互面；它们均不是 Application 类型。

### 12.2 Application Realm与Kernel的唯一耦合面

唯一Kernel为自治子应用签发隔离的Application Realm。Realm是受控Kernel视图，不是第二套Kernel实例；它拥有`appId/realmId/principalId/LifecycleScope`，并只能通过Realm内的Port、Capability Handle、Scoped Tool、Context Provider、Event和Task Binding使用Kernel机制。

```text
Application Realm
├─发布 Capability Offer
├─声明 Capability Requirement
├─通过 Handle调用 Bound Port
├─发布 Event / Receipt / Checkpoint
└─可选连接独立 Client
```

Application Realm不得直接读取Kernel数据库、持有Kernel内部Service、复用主应用Thread Channel，或获取原始Credential。申请`model.inference`、`search.web`、`web.page`、`document.semantic`等都是正常能力依赖，不构成代码耦合。Stronghold不适用本节：它是主应用模块，直接遵循主应用内部Service、`group` Thread和CapabilityGate边界。

### 12.3内部 Agent / Worker

Application 可以包含零个、一个或多个内部 Agent/Worker，但这只是实现细节，不产生 `Sub Application` 分类。内部 Agent 自行维护历史和工作状态，通过 Application Host 的受限 Capability Binding 执行任务；它不能写主 Agent Thread、主 Agent Canonical Memory 或人格 Authority。主应用也不能因为 Application 含 Agent 就自动获得派活能力：可调用关系必须由 Endpoint、Capability Offer 与显式 Tool Projection 声明。

Application 与主应用的双向关系固定分为：Application 通过 `offeredCapabilities + endpoints` 声明对外 Operation，通过可选 `toolProjections` 把允许主 Agent 使用的 Operation 投影为 Tool；Application 通过 `requestedCapabilities` 向 Kernel 请求模型、人格、知识、工作区、审批或主 Agent 协作。Tool Projection 必须随在线 Offer 注册和注销，Realm 私有工具不得进入主 Thread 工具管理。

```text
Principal Agent
→ Task / Capability Grant
→ Application Host
→内部 Agent / Worker（可选）
→ Application Checkpoint / Result / Receipt
```

内部 Agent 的记忆候选若需回流，必须经过 Application Checkpoint 与主 Agent MemoryGate；Application 自身领域状态仍由自己的 Store/Authority 管理。Social沿用部分历史领域结构，但其跨Package依赖已收口到Shared Port与公开Host ABI，不作为新Application的目录模板。

### 12.4开发者参考实现

Arca是标准自治Application模板。新应用应复制其独立Host、稳定Identity、可选独立Client、NodeProvider、Capability Offer/Requirement、独立Store/Authority及断线重连边界。现有`AppManager/AgentAppRuntime`已演进为Application Realm生命周期宿主，负责进程内Realm的Scoped Tool、Task Binding与生命周期；外部Host仍通过Node Federation接入同一Realm协议。Arca任务与Social私有会话已迁入Realm，`arca/social`不再是主应用Thread Channel，也不再进入Agent静态能力矩阵。Stronghold明确禁止注册到Realm Manager。

Social已通过Shared中的Storage/Execution/Event Port、Social自身的Data Service以及单一公开Application Host ABI完成边界收口。Social不再深路径导入Backend源码，也不允许直接持有DrizzleDb、GatewayHub或Backend Repository实现；公开Host ABI只暴露白名单宿主契约，新增能力应优先进入Shared Port或领域Facade。

---

## 13. Kernel Object、Execution 与系统事件

### 13.1 架构宪法

以下约束是AIOS实现和评审的固定基线：

1. Agent是长期Principal与资源所有者，不是Process；具体运行必须归属唯一`executionId`。
2. 可观察副作用必须追溯到Principal、Process、Execution、Capability与因果链。
3. Resource是存在之物，Capability是访问权，Tool是面向模型的操作ABI；工具名白名单不能代替资源授权。
4. Capability只能委派、收窄、到期和撤销，Skill、fallback与默认值不得隐式扩权。
5. 持久事实使用Durable Event；Token、动画、进度和心跳等临时体验使用Ephemeral Frame。
6. Application只能持有Port与Capability Handle，不得持有数据库、Backend Service实例、Service Locator或全局AppContext。
7. Renderer与Surface不拥有业务事实；关闭窗口、销毁DOM或重建Surface不得改变领域权威状态。
8. Context Compiler只映射资源，不拥有或修改Identity、Memory、Thread、Workspace与Capability。
9. Observer只生成测量结果；是否进入Context由独立Policy决定。
10. 跨边界调用必须可取消、可超时、可审计并校验对象Generation；崩溃后持久日志必须保持合法前缀。
11. Kernel提供Object、Execution、Capability、IPC、Lifecycle、Scheduler与Audit机制，业务策略尽量留在用户空间。
12. Stronghold永久属于主应用，`group`是其专属Channel；Application身份只由`appId/realmId`表达。

### 13.2 OS领域本体

| AIOS对象        | OS类比                | 固定语义                              |
| --------------- | --------------------- | ------------------------------------- |
| PrincipalAgent  | Security Principal    | 长期身份、人格、私有资源与授权主体    |
| Thread          | TTY / Journal         | 持久交互边界与消息事实流，不执行代码  |
| Task            | Job                   | 用户期望完成的工作，可跨多次执行      |
| Process         | Process               | Task、Application或驻留服务的运行载体 |
| Execution       | Execution attempt     | 一次有起止、预算、结果和因果链的运行  |
| Tool Call       | System call           | 对Kernel Service或Adapter的结构化请求 |
| Context Runtime | Virtual address space | 本轮模型可见资源的临时映射            |
| Workspace       | Filesystem namespace  | Principal或Application的可写文件空间  |
| Surface         | Display object        | 领域事实的可重建视觉投影              |

`Task = 要完成什么`，`Process = 谁承载运行`，`Execution = 某次尝试`，`Turn = 一次用户可感知事务`，`Thread = 持久交流与事实记录`。禁止用Thread或“当前活跃Agent”推导执行主体。

### 13.3 Kernel Object

可寻址、可授权、可订阅或受生命周期管理的实体必须可投影为Kernel Object：

```typescript
interface KernelObjectRef {
  objectType: string
  objectId: string
  generation: number
  ownerPrincipalId: string
}
```

领域表继续持有权威数据，Object Registry只提供投影，不建立万能对象大表。对象可按领域选择支持`inspect`、`subscribe`、`snapshot`、`grant`、`revoke`、`suspend`、`resume`与`close`。`generation`用于拒绝页面导航、Application重启、Surface替换、Document Revision、Provider重连或Checkpoint恢复后的过期句柄。

### 13.4 Execution模型

```typescript
interface ExecutionDescriptor {
  executionId: string
  processId: string
  principalId: string
  taskId?: string
  parentExecutionId?: string
  threadId?: string
  class: 'interactive' | 'foreground' | 'background' | 'resident' | 'maintenance' | 'realtime'
  priority: number
  deadline?: string
  budget: {
    maxDurationMs?: number
    maxLlmCalls?: number
    maxInputTokens?: number
    maxOutputTokens?: number
    maxToolCalls?: number
    maxConcurrentIo?: number
  }
}
```

状态机固定为`created → queued → running → waiting_io | waiting_approval | suspended → running → completed | failed | cancelled | timed_out`，终态必须携带结构化ExitStatus。聊天Turn、后台任务、Application命令、主动行为和SubAgent均使用同一Execution身份与预算语义。

### 13.5 Capability Handle与Tool ABI

Capability Handle必须绑定主体、Kernel Object、允许操作、资源范围、父句柄、有效期与撤销属性。子句柄必须满足操作集、资源范围、有效期和风险均不超过父句柄。ToolExecutor作为系统调用分发器，按以下链路执行：

```text
解析对象与操作
→ 校验Capability Handle
→ Policy / Approval
→ 路由Service或Adapter
→ Deadline / Cancellation
→ 结构化结果
→ Durable Audit Event
```

### 13.6 Durable Event、Ephemeral Frame与Kernel Envelope

Durable Event用于消息提交、工具接受/拒绝、审批请求与完成、Agent求助请求与完成、文件修改、Task迁移、Application生命周期、Checkpoint与文档提交等事实；Ephemeral Frame用于Token、Thinking、进度、短时Toast、音频播放帧、动画和心跳。Frame可合并、降频或丢弃，Event必须可恢复和审计。重要通知应先成为Durable Notification事实，再按目标Client/Input Seat投影为Toast；TTS应物化为Audio Asset并由目标Audio Output Capability播放，不得向所有Gateway连接无差别广播音频。

REST、SSE、WebSocket、Electron IPC、MCP与内存EventBus可以保持不同Carrier，但必须共享协议版本、Message/Correlation/Causation、Principal/Process/Execution、Object Generation、Operation、Capability、Deadline、Durability与结构化Payload语义。

### 13.7 Context Runtime映射

Context是由Identity、Memory、Thread、Capability、Skill、Workspace、Flow State、Environment和Current Input等Region组成的临时地址空间。Region必须记录来源对象、可见性、优先级、Token估算、新鲜度、必需性与物化方法。RAG相当于按需缺页处理，Token Budget相当于地址空间配额；Context Manifest必须能解释每段内容的来源、版本、预算与裁剪原因。

### 13.8 主 Agent 的近期工具上下文

主 Agent 的 `desktop` 对话把当前工作区焦点和近期工具结果纳入标准上下文生命周期。工作区焦点仅属于本轮请求，必须校验 Agent、真实 Thread、文件版本和终端 ExecutionSession；未保存选区只有用户显式附加才进入模型。近期读取结果按 Thread、Agent、Pair 在进程内保留原始返回文本；来源、范围、版本、读取参数随原有助手消息元数据保存。Context Compiler 直接从当前活跃消息窗口收集对应工具 Region，由统一预算按新近顺序决定正文或来源降级，并写入 Context Manifest。文件变化、不可核验、退出窗口、回滚和内存回收都会释放正文；进程重启后仍可根据对话中的来源重读。

私有心流只保留目标与事实；旧 `workContext` 正文列和逐轮表由 `0001_remove_work_context` 迁移删除，旧工具摘录表由 `0003_remove_tool_observations` 删除。ReAct 每次模型请求前计算输入预算；达到容量边界时按来源降级较早的可重读结果，最近一次读取保留原文，不另调模型生成工作续接摘要。工具正文不写入审计转写和初始提示词持久化快照，也不进入长期记忆；后台任务与 Realm 维持各自执行上下文，不继承日常工具缓存。

---

## 14. 架构决策门槛与演进检查表

新增Kernel级抽象前必须回答：资源与权威状态是什么、生命周期和终态是什么、Principal/Process/Execution如何归属、需要什么Capability、哪些是Durable Event、如何取消超时与幂等、如何检测旧Generation、崩溃后如何恢复、性能与UX如何测量、是否应留在用户空间、替代的旧胶水及移除条件是什么。

新增或修改架构相关功能时，应验证：

- [ ] Agent、Thread、Memory、Workspace、Capability 的状态所有权明确；
- [ ] 后端没有引入全局活跃 Agent/Thread 依赖；
- [ ] Context Compiler 对资源保持只读，历史不会重复注入；
- [ ] 主应用Channel只包含`desktop/group`，应用身份只由`appId/realmId`表达；
- [ ] Stronghold保持主应用模块且`group`专属，不注册Application Realm；
- [ ] 任何文件路径经过 containment 检查；
- [ ] 任何平台工具也经过 CapabilityGate；
- [ ] Thread 与消息 API/SSE 契约同步更新 shared 类型；
- [ ] 官方/Workshop 只读资源不被运行时写入；
- [ ] 新存档或同步规则覆盖 SQLite 与 TriviumDB 多文件一致性；
- [ ] Application 使用 Arca 式自治边界，不新增平行应用分类；内部 Agent 不绕过 Checkpoint、Workspace 或 MemoryGate 隔离。

---

## 15. 相关规范

- [项目结构](./A01_PROJECT_STRUCTURE.md)
- [后端架构](./A02_BACKEND_ARCHITECTURE.md)
- [前端架构](./A03_FRONTEND_ARCHITECTURE.md)
- [部署与多发行](./A04_DEPLOYMENT.md)
- [记忆引擎](./A05_MEMORY_ENGINE.md)
- [扩展系统](./A06_EXTENSION_SYSTEM.md)
- [跨平台与路径](./A07_CROSS_PLATFORM.md)
- [模式与角色管理](./M01_MODE_SYSTEM.md)
- [能力门控](./M02_CAPABILITY_GATE.md)
- [API 响应与流式规范](./S02_API_SPEC.md)
- [Steam 与资产联邦](./M04_STEAM_INTEGRATION.md)
