# Package 与用户空间贡献系统

> **适用范围**：`packages/backend/src/packages/`、`packages/shared/src/types/package.types.ts`
> **状态**：内置贡献与显式授权的用户插件共存；安装、授权、激活相互独立
> **最后更新**：2026-10-24

---

## 1. 定位

`Package` 是 infOS 的安装、签名、版本、升级与分发单元，不是运行时对象，也不是权限主体。旧 Extension Loader、ExtensionManager、ServiceRunner 与 HookRegistry 已完全删除。

```text
Package Manifest
→ Package Installer
→ Package Registry
→ Package Runtime
→ Contribution Activator
→ Lifecycle Scope
→ Runtime Object / Capability Offer / Tool ABI / Resource
```

Package 的安装不等于激活，激活不等于授权。任何 Contribution 都不得因被发现、安装或加载而隐式扩权。

用户 Package 的物理安装根统一为：

```text
@data/packages
```

历史 `@data/extensions` 只允许在安装边界执行一次性目录迁移，不得重新引入旧运行时。

---

## 2. Manifest V2

公共静态 ABI 定义在 `@infos/shared/types/package.types`。

```typescript
interface PackageManifest {
  manifestVersion: 2
  packageId: string
  name: string
  version: string
  trust: 'official' | 'signed' | 'user' | 'generated'
  contributions: PackageContribution[]
  requires?: PackageCapabilityRequirement[]
  permissions?: PackagePermission[]
  platforms?: PlatformId[]
}
```

一个 Package 可以声明多种 Contribution：

```text
Application
Service Process
Capability Provider
Runtime Adapter
Tool ABI
Skill Resource
Policy
Event Subscriber
Presenter
Asset
Schema / Migration
```

Manifest 只描述静态意图，不保存运行实例、连接、Handle、进程或健康状态。

### 2.1 当前生产开放范围

用户通过“工具与扩展 → 插件”上传 ZIP，由服务端安装到数据目录。安装阶段不加载模块，也不准备依赖。

1. 用户上传包使用 `trust: user | generated`；`signed` 还须通过现有 Publisher 与文件签名验证。上传包或用户扫描目录不能靠声明 `official` 冒充内置来源。
2. 用户确认版本、内容摘要与申请权限后，执行型贡献才能获得 `runtime:execute` Grant。更新、回退、本地修改均须重新审核；启用状态跨进程重启保留。
3. 当前已接通 `tool`、`skill`、`event-subscriber`、`service`、`capability-provider`、`context-provider`、`agent-flow`、`presenter`、`asset`。
4. `runtime-adapter`、`application`、`policy` 仍通过原有受控入口接入；上传包直接声明这些 Kind 会激活失败，不能冒充已实现。
5. `runtime:execute` 是明确的本机代码信任授权，不是 OS 沙箱。Node 插件具有服务进程的实际权限；其他 Permission 声明不能被宣传成隔离 Node 内置模块的安全机制。普通 Agent 工具调用仍经过 CapabilityGate、Realm、执行模式和审批。
6. Service Process 由现有 Supervisor 管理。进程分离用于生命周期管理，不表示操作系统权限隔离；没有 Capability Binding 的 Requirement 仍不能视为已授权。

Contribution清单表示目标 ABI，不表示所有 Kind当前均已开放。

---

## 3. 安装边界

`PackageInstaller` 负责：

-发现 `manifest.json`；-校验 Manifest V2；-拒绝越出 Package Root 的 Entry；-将历史清单输入一次性投影为 Manifest V2；-将 `@data/extensions` 原子迁移到 `@data/packages`；-把已验证清单写入 `PackageRegistry`。

历史清单输入是安装边界私有结构，不属于 Shared 公共 ABI，也不得进入 Package Runtime。

```text
历史 manifest.json
→ LegacyPackageManifestInput
→ legacyPackageManifestToPackage()
→ PackageManifest V2
→ Registry
```

兼容投影只保留数据升级价值，不保留旧 Loader、旧 Hook、旧 Service Locator 或旧执行语义。

---

## 4. Runtime 与原子激活

`PackageRuntime` 按 Package 创建 `LifecycleScope`，并按 Contribution 顺序激活。

```text
installed
→ activating
→ active
→ deactivating
→ installed
```

约束：

1.激活前必须解析所有 `required=true` 的 Capability Requirement；2.每个 Activator 必须返回释放函数或注册到 LifecycleScope；3.任一 Contribution 失败时，已激活项必须逆序回滚；4.停用必须回收 Tool、Skill 目录、Event Subscriber、Provider Offer、Process 与其他资源；5. Package 不能持有全局 AppContext 或其他 Package 实例。

---

## 5. Contribution 语义

### 5.1 Tool ABI

Tool 是面向模型的调用 ABI，不是 Package 间协议。Tool Handler 可以调用 Bound Port，但不能直接获得 Provider 实例。

```text
LLM Tool Call
→ ToolExecutor
→ CapabilityGate / Policy / Approval
→ Bound Port
→ Kernel Envelope
→ Provider
```

### 5.2 Skill Resource

Skill 是按需加载的任务知识与 Context Resource。`requiredTools` 只投影为 Capability Requirement，不能解锁权限。

```text
SKILL.md
→ SkillLoader
→ Context Resource
→ Requirement
→现有 Handle/Policy 的权限交集
```

### 5.3 Service Process

Service 是运行载体，通过 `PackageProcessSupervisor` 管理。跨进程调用使用 `PackageProcessTransport`，默认实现为逐行 JSON-RPC stdio。

Service 必须通过 Capability Offer 发布能力，不能被 Consumer 通过 `serviceId + method` 或进程对象直接调用。

### 5.4 Event Subscriber 与 Interceptor

观察型逻辑使用 Durable/Ephemeral Event Subscriber；需要串行转换或中止的受控入口使用 `PackageInterceptor`。禁止恢复万能 Hook 管道。

### 5.5 Capability Provider / Runtime Adapter

Provider 声明可实现操作，Adapter 把外部 Runtime 投影成 Kernel Object、Snapshot、Stable Handle 与 Verification。Provider 不能成为 Consumer 的权限来源。

### 5.6 Presenter

Presenter 把业务事实或 Runtime Snapshot 投影为 Surface Node，不直接持有前端组件实例，也不把二进制正文塞入 SSE。

---

## 6.跨 Package 协作

唯一标准路径：

```text
Capability Definition
→ Provider Offer / Consumer Requirement
→ Capability Directory
→ Policy Binding
→ Capability Handle
→ Bound Port
→ Kernel Envelope
→ Provider
```

有效权限是以下集合的交集：

```text
Consumer Handle
∩ Provider Offer
∩ Provider 运行权限
∩当前 Policy
∩资源 Scope
∩ Deadline / Generation
```

禁止：

-直接 import 其他 Package 的实现；-共享 AppContext、Repository 或数据库连接；-通过 Tool 名称作为 Package 间协议；-使用全局 Service Locator；-把 Capability Handle 放入 Prompt 或普通日志；

- Provider 代替 Consumer 获取更高权限。

---

## 7.权限与信任

Package Trust 只描述来源可信度，不直接授予能力。权限声明仍需在安装、激活和调用阶段分别验证。

```text
Package Permission       安装时静态意图
Capability Requirement 运行时所需能力
Capability Handle       实际可使用权限
Policy / Approval       当前调用裁决
```

审批产生的临时授权必须可撤销、可到期、可收窄，并绑定 Principal、Execution、资源与操作。

---

## 8.下一阶段 OS 基建

Package Runtime 已完成后，下一阶段不再建设第二套插件框架，而是补齐用户空间资源原语：

```text
Asset / File Handle
Transfer Object
Runtime Event Subscription
Scoped Credential
```

这些原语分别服务Browser、Social附件、Cloud Sync、模型资源、MCP与Document Runtime。实现顺序服从固定依赖：先建立Kernel Object与Execution身份，再建立Envelope与Capability Handle/Bound Port，最后开放Runtime Adapter、Web/Document Runtime和更强隔离；不得绕过基础协议直接增加应用专用Host API。

### 8.1 Skill、Tool与Application边界

- Package是安装与分发单元，可以贡献Application、Service Process、Capability Provider、Runtime Adapter、Tool ABI、Skill Resource、Policy、Event Subscriber、Presenter与Asset。
- Skill是Context Resource与流程知识，只能声明Capability Requirement；加载Skill不得解锁父Execution没有的能力。
- Tool是Capability面向LLM的ABI；Application和Package之间直接使用Bound Port，不以Tool名作为内部RPC。
- Consumer不得导入Provider实现、持有对方实例、共享AppContext或使用任意`serviceId + method`绕过契约。
- Provider权限不能替Consumer扩权；有效权限始终是Consumer Handle、Provider Offer、Provider运行权限、Policy、资源Scope与Deadline/Generation的交集。

### 8.2 统一Application模型

infOS只有一种通用自治Application形态：稳定Application Identity、独立Host/领域逻辑、按需独立Store/Authority、独立生命周期与故障边界，以及可选Capability、Client、Tool ABI和内部Agent/Worker。`Tool`、`Service`、`Client`、`Runtime Adapter`和`SubAgent`只能是Application组成部分，不形成平行应用分类。

Application不得读取Kernel数据库或依赖主Agent Thread；它通过Node/Application Federation发布Offer、声明Requirement、获得收窄Handle，并上报Event、Checkpoint与Receipt。`disconnected_from_kernel`允许本地Authority继续受限工作，但所有依赖Kernel Credential、远程Node或主Agent资源的操作必须暂停。

### 8.3 第三方 Application 三层 Adapter

第三方开源应用不作为同进程 Contribution 直接加载。标准接入分为：

1. infOS 官方通用 Integration Foundation，负责身份、协议、Capability、安全、任务和审计；
2. 贡献者实现的 infOS 侧 Backend/Frontend Adapter，负责领域映射和 UI 集成；
3. 贡献者在目标应用内实现的 Plugin、Extension、MCP Server 或 Sidecar，负责调用应用内部 API。

第二、三层变化不得要求 Kernel 增加应用专用 Service。Adapter 内部使用 Application Protocol 和 Bound Port；只把允许 Agent 使用的 Operation 投影为 Tool。完整规范见 [A10_APPLICATION_INTEGRATION](./A10_APPLICATION_INTEGRATION.md)。

### 8.4 任务移交与生命周期

长任务必须使用 `submitTask` 语义：目标 Application 持久接收后立即返回 `taskId`，随后使用独立 Application Principal、Kernel Execution 和 Abort 域执行。调用工具的 AbortSignal 只约束提交过程，不得控制已接收任务。主 Agent Execution 的取消不能隐式停止 Application Task。

若贡献者只把长任务包装为同步 Tool Promise、继承主 Agent `parentExecutionId`、复用主 Agent AbortSignal，或把 Realm dispose 注册到 Agent Scope，则不符合 Application 接入规范。

---

## 9.验收规则

Package 相关变更至少验证：

- Manifest 重复 ID、无效 Entry 与越界路径
- required Capability 缺失时拒绝激活 -激活失败原子回滚 -停用后 Tool、Provider、Skill、Event 与 Process 全部释放
- Consumer 只能获得 Bound Port -历史清单只在安装边界出现 -生产源码不存在 ExtensionManager、ExtensionLoader 或 ServiceRunner -用户安装和云同步目录统一为 `packages/`

## 10. 用户插件管理与发行目录

```text
@data/packages/.managed/index.json             安装记录、启用状态和审核摘要
@data/packages/.managed/releases/<UUID>/       独立版本代码、锁文件、node_modules
@data/package-cache/                          pnpm 下载缓存
@data/package-data/<packageId 的 SHA-256 前缀>/ 插件持久数据，重载和更新不清除
```

Electron 标准版、便携版和 Docker 都通过 PathResolver 使用各自的数据根，插件不写入 ASAR、resources 或镜像内置源码。服务端上传接口接收文件字节，不接收客户端本地路径。安装目录可在插件卡片中查看；运行数据应写入工厂参数 `host.dataDirectory`，不要写入版本源码目录。

上传 ZIP 须在根目录或唯一顶层目录包含 `manifest.json`。支持已编译的 ESM `.mjs` / 带 `type: module` 的 `.js`；不在服务端隐式构建 TypeScript。拒绝路径逃逸、Windows 特殊文件名、预装 node_modules、包管理配置注入，限制压缩大小、展开大小和文件数量。

依赖来自插件自己的 `package.json.dependencies` / `optionalDependencies`，支持注册表版本如 `1.2.3`、`^1.2.3`、`~1.2.3`；拒绝 file、workspace、Git 与任意 URL 依赖。启用时用随发行版携带的 pnpm 准备依赖，默认 npm 官方 registry，不依赖用户安装 Node 或 pnpm。移除包管理器覆盖配置和生命周期脚本，使用 `--ignore-scripts`；需要安装脚本编译的原生依赖不会被偷偷执行，应由作者提供兼容的运行产物。

更新导入后停用，留存上一版本，审核后再启用。回退也保持停用直到重新审核。重载复制到新的代际目录，同时刷新入口与全部相对 import；不会仅给入口 URL 加参数。读取本地修改同样创建新代际并撤销旧内容授权。每包独立的数据目录不参与源码摘要，不随代码重载删除。

管理 API 均处于现有 API 鉴权边界：

| 操作 | API |
| --- | --- |
| 列表 / ZIP 上传 | `GET /api/packages` / `POST /api/packages/install` |
| 内容授权 | `POST /api/packages/:id/authorize`，传 `digest`、`permissions` |
| 启停 | `PUT /api/packages/:id/enabled` |
| 重载 / 读取修改 / 回退 | `POST /api/packages/:id/reload|review|rollback` |
| 卸载安装文件 | `DELETE /api/packages/:id`；独立运行数据保留 |
| UI 插槽与动作 | `GET /api/packages/panels/:slot` / `POST /api/packages/panel-actions` |
| 已激活静态资源 | `GET /api/packages/assets/:编码后的 packageId/contributionId?file=相对路径` |

## 11. 编写贡献与扩展点

最小工具包清单：

```json
{
  "manifestVersion": 2,
  "packageId": "example.hello",
  "name": "示例工具",
  "version": "1.0.0",
  "trust": "user",
  "permissions": [],
  "contributions": [{ "id": "hello", "kind": "tool", "entry": "hello.mjs" }]
}
```

`hello.mjs` 可以导出静态 `definition` / `execute`，也可以导出贡献工厂。工厂只收到公共作用域，不收到 AppContext；通过 `onDispose` 回收监听器、计时器、连接，通过 `signal` 响应停用。多个贡献可以共用模块，但各自有独立工厂调用与释放注册。

```js
export function createContribution(host) {
  const controller = new AbortController()
  host.onDispose(() => controller.abort())
  return {
    definition: {
      name: 'example_hello',
      description: '返回一句问候',
      parameters: { type: 'object', properties: {} }
    },
    async execute(args, toolContext) {
      return '你好'
    }
  }
}
```

| Kind | 模块契约与调用位置 |
| --- | --- |
| `tool` | `definition`、`execute(args, toolContext)`；工具注册表与现有权限链，重名拒绝覆盖 |
| `skill` | `entry` 指向技能目录；资源装卸不授予工具权限 |
| `event-subscriber` | `hooks` 或 `onEvent`，接入现有 PackageHookBus / KernelEventBus |
| `agent-flow` | `hooks`；Agent 开始、结束、模型请求前后及工具执行前后 |
| `context-provider` | `provide(request)` 返回 ContextRegion 数组；宿主强制外部信任、可选、命名空间 ID，统一 Token 预算与过期处理 |
| `presenter` | `panel`、可选 `onAction(actionId)`；声明式卡片、字段与按钮 |
| `asset` | `entry` 指向资源目录；只在激活期间开放白名单 MIME 与受限读取 |
| `capability-provider` | `definition`、`offer`、`invoke`；复用现有 CapabilityDirectory |
| `service` | `entry` 由既有进程 Supervisor 启动、停用和回收 |

当前真正触发的流程事件：`agent:beforeRun`、`agent:afterRun`、`agent:beforeRequest`、`agent:afterRequest`、`chat:beforeSend`、`chat:afterReply`、`chat:beforeToolCall`、`chat:afterToolCall`。请求前钩子只能调整普通消息正文，不能修改系统消息、工具协议、主体身份或工具白名单；超出输入预算的变更回退原请求。工具参数变更发生在后续权限校验与审批之前。

记忆提供 `memory:beforeCreate`、`memory:afterCreate`、`memory:beforeDelete` 与 `memory:afterRetrieve` 观察点；不接受借钩子绕过事件时间、Agent 归属或持久化事务的修改。旧的 `agent:onSwitch` / `agent:onMoodChange` 事件名仅保留兼容类型，不表示新增了触发位置。

普通异步钩子和上下文扩展有超时与失败隔离；钩子 `context.abort()` 只停止本次钩子链传播，不代替取消 Agent Execution。纯同步死循环等任意原生代码行为不在这个逻辑超时边界内，必须通过插件代码信任授权处理。

UI 命名区域为 `dashboard.overview`、`chat.header`、`chat.footer`、`integrations`。前端使用实际 PCard/PButton 与主题变量，包含自定义背景的半透明承托；不执行插件 HTML、CSS 或 Vue 源码。插件自定义文字属于插件内容。停用立即撤销面板动作路由、工具、Hook、Context Provider 与资源注册；用户页面下次激活或定时刷新后同步撤下卡片。

`application`、内核 `policy` 和底层 `runtime-adapter` 的动态开放不包含在本轮基础设施内；它们继续遵循各自正式的 Realm、Principal 和 Capability 契约。
