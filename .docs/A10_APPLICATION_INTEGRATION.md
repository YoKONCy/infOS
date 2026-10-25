# Application 接入协议与 Arca 参考实现

> **适用范围**：第三方开源应用、Application Node、生态 Adapter、Arca 迁移
> **性质**：Application 接入设计规范；通用协议约束与扩展方向，不是所有第三方应用的支持清单。
> **最后更新**：2026-10-26

---

## 1. 定位

infOS 不要求 OpenCode、Pi、SillyTavern 等第三方应用重写为进程内 `AgentAppRuntime`。第三方应用保持自己的进程、UI、后端、Agent、会话、任务、数据和插件生态；infOS 通过标准 Application Integration Protocol 完成身份核验、通信、能力授权、任务调度、审计和 UI 集成。

Arca 的 Host、Client 和桥接代码是阅读本规范的参考入口；本文的通用 Envelope、跨语言 SDK 及外部生态步骤属于设计契约，不能据此假设已有可直接使用的完整产品接口。实现入口为 `packages/node-sdk/`、`packages/node-host/`、`packages/apps/arca/` 和后端 `applications/`。Social 是历史兼容特例，不定义第三方 Application ABI，也不作为首个迁移模板。

核心原则：

1. Application 是自治运行体，不是主 Agent 的子函数；
2. Application 可以包含零个、一个或多个内部 Agent/Worker；是否含 Agent 只是内部实现，不改变接入模型；
3. 主应用与 Application 的可用关系完全由双方 Adapter 声明并协商，不预设“主 Agent 一定可以派活”；
4. Application 向主应用提供 Endpoint 与 Capability Offer；只有显式 `toolProjections` 才会把其中部分 Operation 投影为 Agent Tool；
5. 有内部 Agent 的应用可把 Tool 投影到 Task、Session 或 Agent Endpoint，由应用内部 Agent 承接；无内部 Agent 的应用可把 Tool 直接投影到确定性 Command/Query Operation；
6. Application 通过 `requestedCapabilities` 向 Kernel 请求模型、人格、知识、工作区、审批或主 Agent 协作等反向支持；未声明、未绑定或已撤销的能力不可调用；
7. Tool 是面向 Agent 的 ABI，不是 Adapter 内部 RPC；Application、Kernel 和其他 Application 之间使用 Endpoint、Envelope 与 Bound Port；
8. Application Task 接收成功后拥有独立 Execution、取消域和持久状态；
9. 主 Agent 的单次 ReAct、Thread 或 Execution 失败不得级联停止 Application；
10. 同进程 Realm 只能提供逻辑隔离，第三方应用默认使用独立进程或远程 Node。

---

## 2. 三层 Adapter

```text
infOS Kernel / Application Integration Foundation
  ↓ 标准 Application Protocol
infOS 侧 Application-specific Adapter
  ↓ 目标应用桥接协议
目标应用内部 Adapter / Plugin / Extension / Sidecar
  ↓ 内部 API、事件、任务和存储
原始第三方应用
```

### 2.1 第一层：通用 Integration Foundation

由 infOS 官方维护，负责：

- Application Node 注册、身份认证、配对和版本协商；
- Instance、Endpoint、Session 和 Task 的稳定地址；
- Heartbeat、Lease、断线重连和健康状态；
- Envelope、Schema、Correlation、Deadline、Cancellation 和 Idempotency；
- Capability Requirement、Offer、Binding、Handle 和撤销；
- 速率限制、Backpressure、审批、审计和风险裁决；
- Task、Event、Resource、Surface 的通用协议；
- Adapter 兼容性诊断和故障隔离。

该层不得理解 OpenCode Session、SillyTavern 角色卡或 Arca Document 等应用私有结构。

### 2.2 第二层：infOS 侧专属 Adapter

由应用接入贡献者实现，负责将目标应用映射到 infOS：

- Backend Adapter：连接管理、协议翻译、Endpoint 和 Capability 映射；
- Frontend Adapter：Tab、状态、任务、会话、授权和错误投影；
- Tool Projection：将允许模型使用的 Operation 投影为 Agent Tool；
- Presentation Projection：把应用状态转换为受限 External Presentation；
- Manifest：声明目标应用版本、Transport、Endpoint、能力与权限。

第二层只依赖公开 Application SDK、Node SDK 和 Capability Port，不得 import Kernel Service、Repository、AppContext 或目标应用数据库。

### 2.3 第三层：应用内部 Adapter

由接入贡献者在目标应用侧实现，可采用：

- 官方插件或 Extension；
- MCP Server；
- HTTP/WebSocket API；
- stdio Bridge；
- CLI Wrapper；
- 独立 Sidecar；
- 最后才使用受版本约束的 Patch。

它负责调用应用内部 API，发布应用能力、事件和任务状态，并提供配对与连接配置。目标应用内部变化主要由第二、三层吸收，不得迫使 Kernel 增加应用专用分支。

---

## 3. 通用对象模型

```text
ApplicationDefinition   应用与协议声明
ApplicationInstallation 本机安装和 Adapter 版本
ApplicationInstance     一次运行实例
ApplicationNode         协议连接和身份
ApplicationEndpoint     Agent、Task、Resource、Session等入口
ApplicationTask         持久工作及其状态
ApplicationSession      持续交互上下文
ApplicationSurface      外部展示投影
```

Application Endpoint 的通用种类：

```text
command | query | task | event | resource | session | agent | surface
```

不是所有 Application 都是 Agent。Agent Tool 只是 Operation 的一种投影，前端、Kernel 服务和其他 Application 可以通过同一 Bound Port 使用原始 Operation。

---

## 4. 通信协议

### 4.1 Envelope

```typescript
interface ApplicationEnvelope<T = unknown> {
  protocolVersion: string
  messageId: string
  correlationId: string
  causationId?: string
  source: ApplicationAddress
  target: ApplicationAddress
  operation: string
  mode: 'request' | 'response' | 'event' | 'stream'
  payload: T
  capabilityHandleId?: string
  deadline?: string
  idempotencyKey?: string
  trace?: { executionId?: string; taskId?: string }
}

interface ApplicationAddress {
  nodeId: string
  appId: string
  instanceId: string
  endpoint?: string
  sessionId?: string
}
```

`causationId` 只记录因果，不建立生命周期父子关系。Application Task 除非显式声明级联取消，不得继承调用方 Agent Execution 的 `parentExecutionId` 或 AbortSignal。

### 4.2 三种调用模式

- **Invoke**：短查询或短命令，同步返回；
- **Submit Task**：长任务完成所有权移交，立即返回稳定 `taskId`；
- **Open Session**：持续 Agent-to-Agent 或应用会话，后续独立发送消息。

长任务的标准流程：

```text
Agent Tool Call
→ Adapter验证与授权
→ Application接收并持久化
→ 返回 accepted + taskId
→ Application创建独立Kernel Execution
→ Event/Query投影进度
→ Result/Receipt完成
```

工具调用的取消只控制提交过程。任务被 Application 接收后，只有显式 `cancelTask(taskId)`、应用策略或 Application 生命周期终止才能取消。

---

## 5. Capability 暴露

infOS 通过 Capability Port 暴露内部资源，不向 Application 注入 Service 实例、数据库连接、裸路径或 API Key。

首批标准 Capability：

```text
infos.persona.read
infos.knowledge.query
infos.knowledge.submit_candidate
infos.workspace.open
infos.asset.read
infos.model.generate
infos.model.embed
infos.presentation.publish
infos.task.report
```

### 5.1 Persona Projection

“完整人设”指版本化、可授权的 Persona Projection，不是最终 System Prompt：

```typescript
interface PersonaProjection {
  agentId: string
  version: string
  displayName: string
  persona: string
  ownerAppellation: string
  channelPatch?: string
  traits?: string[]
}
```

System Protocol、API Key、隐藏安全规则、工具策略和未授权记忆不得进入 Persona Projection。

### 5.2 Knowledge 与 Workspace

Knowledge 默认提供 `query_only` 检索，不暴露数据库文件。写入通过 Candidate/Gate。Workspace 使用相对路径 File Handle，不向 Application 泄露或接受任意宿主绝对路径。

### 5.3 模型

Application 获得逻辑 Model Handle，不获得 Provider API Key。模型调用作为 Application Principal 的 Kernel Execution 记账和限额。

---

### 5.4 双向 Capability 与 Tool Projection

Application Manifest 必须把两个方向分开声明：

```text
Application → Kernel：requestedCapabilities
Application → 主应用：offeredCapabilities + endpoints
Operation → 主 Agent：toolProjections（可选）
```

`offeredCapabilities` 描述 Application 对外提供的版本化能力，Operation 必须属于已声明 Endpoint；`toolProjections` 只是其中允许主 Agent 使用的薄投影，必须绑定 `endpointId + operation`，并声明 `invoke | submit_task | open_session` 调用语义和 `while_ready` 在线生命周期。没有 `toolProjections` 时，Application 即使在线也不会向主 Agent贡献工具。

Application 断线、Offer 撤销、协议不兼容或 Endpoint 不再 ready 时，相关 Tool Projection 必须立即从主 Agent 可见工具集合注销；不得保留“离线占位工具”等到调用时才失败。Application Realm 私有工具也不得进入主 Thread 的 Char Ops 工具管理。

反向能力由 `requestedCapabilities` 声明。常规机器支持通过 Bound Port 直接调用 Kernel；只有需要主 Agent判断的咨询、确认、补充资源、报告或澄清才使用显式 Host Collaboration Capability。Kernel 不根据 Application 是否含 Agent 推导能力，也不自动授予主 Agent派活入口。

---

## 6. 生命周期与故障边界

```text
installed → starting → ready ⇄ disconnected_from_kernel
                         ⇄ suspended → stopping → stopped
                                      → failed
```

- 主 Agent ReAct、Thread、前端 Surface 或调用工具失败，不停止 Application；
- Application 与 Kernel 断线后，可以继续不依赖 Kernel Credential 和远程资源的本地工作；
- 依赖 Kernel Capability 的操作进入等待或明确失败，不得用缓存 Handle 越权继续；
- Application Runtime 崩溃由 Supervisor 按退避策略重启并从 Checkpoint 恢复；
- 第三方 Application 默认运行于独立进程、Node Host 或远程 Node；
- Backend 内存 Runtime Map 不得成为通用 Application 的权威生命周期载体。

---

## 7. Manifest 与生态 SDK

Application Adapter Manifest 至少声明：

```yaml
id: community.example
adapterVersion: 1.0.0
protocolVersion: 1
compatibility:
  infosProtocol: ^1.0
  applicationVersions: '>=1 <2'
connection:
  transports: [websocket, stdio]
endpoints:
  - id: agent
    kind: agent
  - id: task
    kind: task
requestedCapabilities:
  - infos.persona.read
  - infos.knowledge.query
offeredCapabilities:
  - example.agent.invoke
  - example.task.execute
```

生态工具的设计目标如下；这不是当前仓库的包清单，不能据此引用尚未提供的 SDK 或 CLI。现有协议实现从 node-sdk / node-host 阅读：

- `@infos/application-sdk`：第二层 Backend Adapter；
- `@infos/application-ui-sdk`：第二层前端 Surface；
- 语言无关 JSON Schema/OpenAPI/WebSocket 协议；
- TypeScript、Python、Rust 的第三层 SDK；
- Mock Kernel、协议校验器和故障注入工具；
- `validate/test/pack` CLI。

社区 Adapter 默认进入独立进程，且不能获得当前内置兼容 `AppRuntimeContext` 中的 `llmService`、`agentManager`、`threadService`、`storeRegistry` 等实例。

---

## 8. 参考实现的接入步骤与扩展约束

### 8.1 分层关系（设计模型）

```text
Application Integration Foundation
  ↕ Application Protocol / Capability Handle
Arca infOS Adapter
  ├─ Backend Adapter
  ├─ Arca Tab / Task / Document Projection
  └─ Tool Projection
  ↕ Arca Bridge Protocol
Arca Application Host Adapter
  ├─ Document Engine API
  ├─ Collaboration Runtime
  ├─ Task / Event / Receipt
  └─ Persona / Knowledge Consumer
  ↕
Arca Host + Arca Client
```

### 8.2 协议边界

1. 从现有 `node-sdk`、`node-host` 和 Arca Federation 中抽取 Application Address、Hello、Endpoint、Task 和 Event；
2. 定义 Application Manifest、Envelope 和错误目录；
3. 区分 Capability Offer 与 Agent Tool Projection；
4. 为 Persona、Knowledge、Workspace 和 Model 定义首批 Port；
5. 添加版本协商、Correlation、Deadline、Idempotency 和 Lease 契约测试。

### 8.3 适配器职责

1. 保持 Arca Document Engine 和 Host 为对象 Authority；
2. 将 infOS 内 Arca UI Tab 明确为第二层 Frontend Adapter；
3. 将现有 Arca Capability Runtime/Federation Connector 收敛为第二层 Backend Adapter；
4. 在 Arca Host 提供第三层 Adapter，不让 infOS Adapter 直连 Document Store；
5. 所有 Arca 长任务改为 `submitTask → taskId → event/result`；
6. 主 Agent 只通过 Arca Tool Projection、Session 或 Task API 通信。

### 8.4 资源授权约束

1. Arca 通过 `infos.persona.read` 获取版本化 Persona Projection；
2. 通过 `infos.knowledge.query` 使用知识库；
3. 通过 `infos.workspace.open` 获得收窄 File Handle；
4. 通过 `infos.model.generate` 使用模型但不接触 Credential；
5. 断开 Kernel 后验证本地 Document Authority 继续工作，依赖 Kernel 的能力进入等待。

### 8.5 外部应用适配的验证目标

完成一个非 Arca、非 Social 的外部应用 Adapter，验证协议未被 Document 领域绑死。候选优先选择具有稳定插件或 MCP/HTTP 接口的编码 Agent。

---

## 9. 接入必须保护的不变量

- 主 Agent Execution 取消后，已接收的 Arca Task 继续运行；
- Arca Adapter 或 Client 崩溃不损坏 Document Authority；
- Kernel 短时断线时，本地文档事务继续，Kernel Capability 调用暂停；
- Adapter 不能读取未授权 Persona、Knowledge、Workspace 或 Credential；
- Tool、前端和其他 Application 使用同一 Operation 契约；
- Application 版本不兼容时明确拒绝，不静默降级；
- 重复 Task 提交通过 Idempotency Key 不产生重复副作用；
- 所有跨边界调用可追溯到 Application Principal、Execution、Capability Handle 和 Receipt。
