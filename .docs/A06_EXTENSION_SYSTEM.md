# Package 与用户空间贡献系统

> **适用范围**：`packages/backend/src/packages/`、`packages/shared/src/types/package.types.ts`
> **状态**：内置贡献与显式授权的用户插件共存；安装、授权、激活相互独立
> **最后更新**：2026-10-28

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
Web UI
Asset
Schema / Migration
```

Manifest 只描述静态意图，不保存运行实例、连接、Handle、进程或健康状态。

### 2.1 当前生产开放范围

用户通过“工具与扩展 → 插件”上传 ZIP，由服务端安装到数据目录。安装阶段不加载模块，也不准备依赖。

1. 用户上传包使用 `trust: user | generated`；`signed` 还须通过现有 Publisher 与文件签名验证。上传包或用户扫描目录不能靠声明 `official` 冒充内置来源。
2. 用户确认版本、内容摘要与申请权限后，执行型贡献才能获得 `runtime:execute` Grant。更新、回退、本地修改均须重新审核；启用状态跨进程重启保留。
3. 当前已接通 `tool`、`skill`、`event-subscriber`、`service`、`capability-provider`、`context-provider`、`agent-flow`、`presenter`、`web-ui`、`asset`。
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

## 8. 资源原语与架构扩展约束

Package 扩展沿用统一运行时与授权链。下列资源原语是设计扩展的约束，不表示每种资源已有独立产品接口：

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

## 9. 激活与释放的不变量

Package 相关变更至少验证：

- Manifest 重复 ID、无效 Entry 与越界路径
- required Capability 缺失时拒绝激活，激活失败原子回滚。
- 停用后 Tool、Provider、Skill、Event 与 Process 全部释放。
- Consumer 只能获得 Bound Port；历史清单只在安装边界兼容。
- 不恢复旧 ExtensionManager / ExtensionLoader / ServiceRunner 路径；用户安装和云同步目录统一为 `packages/`。

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

### 10.1 拓展 Tab 的统一管理投影

工作台的「工具与扩展 → 已安装」通过 `GET /api/integrations/installed` 汇总当前业务服务端的插件、Skill、角色包、已登记桌宠模型、MCP 服务与拓展功能。`extensionInventory.ts` 只投影各管理器的数据，不持有安装记录、不新增资源生命周期，也不读取客户端的文件系统。

数据权威与管理去向：

| 分类 | 权威来源 | 操作入口 |
| --- | --- | --- |
| 插件与内置扩展 | PackageRegistry、PackageManagementService、IntegrationService | 用户插件进入对应插件卡片；内置扩展进入对应配置卡片 |
| Skill | SkillLoader 的有效清单、ToolRegistry 的实际工具集合 | 独立 Skill 进入技能管理；插件内 Skill 进入所属插件管理 |
| 角色包 | AgentManager 的有效角色与其配置元数据 | 进入指定角色档案；插件内资源归所属插件管理 |
| 桌宠模型 | AssetRegistry 的服务端元数据索引 | 展示资源信息；插件管理的资源进入所属插件。已发现不表示客户端已加载 |
| MCP | MCP 配置与实时连接状态 | 展开指定服务的现有管理面板 |
| 联网搜索、PDF 解析 | IntegrationService | 进入对应来源配置 |

所有操作继续走原有启停、授权、导入、回退与卸载接口。统一列表不提供绕过领域约束的文件删除功能。插件所属关系按真实注册的包根目录与资源路径边界确定，不使用字符串前缀匹配；来源按宿主登记的路径与安装记录确定，不采信资源自行声明的 `source` 或信任等级。

列表提供分类、来源、状态筛选和名称、标识、作者搜索。仅展示明确声明的版本和环境要求，不为缺失版本补 `1.0.0`，不把声明要求当作已验证兼容性。Skill 的缺失依赖由已加载的技能和工具判断；不为列表额外扫描脚本或加载技能正文。角色仅投影必要元数据，不返回提示词、私密配置或社交账号绑定；MCP 不返回命令、环境变量或连接凭证。

各分类独立读取，一类失败通过 `unavailable` 返回，其余分类仍可使用；前端明确标识读取失败，避免把错误显示成空列表。用户刷新会调用已有 `POST /api/assets/rescan` 更新模型索引；普通进入页面只读取已登记状态。离开管理面板后重新读取列表，保留当前筛选条件。此入口不查询市场更新，也不执行工坊订阅。

AssetRegistry 补充扫描服务端 `@data/models`，打包模式读取 `INFOS_RESOURCES_ROOT/assets/3d`，源码模式读取项目 `public/assets/3d`。未部署在服务端的模型不会因为客户端存在同名文件而显示为已安装。

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
| `web-ui` | `webUi` 声明静态页面；可选 `entry` 导出本贡献的 `actions`，通过隔离页面桥交互 |
| `asset` | `entry` 指向资源目录；只在激活期间开放白名单 MIME 与受限读取 |
| `capability-provider` | `definition`、`offer`、`invoke`；复用现有 CapabilityDirectory |
| `service` | `entry` 由既有进程 Supervisor 启动、停用和回收 |

当前真正触发的流程事件：`agent:beforeRun`、`agent:afterRun`、`agent:beforeRequest`、`agent:afterRequest`、`chat:beforeSend`、`chat:afterReply`、`chat:beforeToolCall`、`chat:afterToolCall`。请求前钩子只能调整普通消息正文，不能修改系统消息、工具协议、主体身份或工具白名单；超出输入预算的变更回退原请求。工具参数变更发生在后续权限校验与审批之前。

记忆提供 `memory:beforeCreate`、`memory:afterCreate`、`memory:beforeDelete` 与 `memory:afterRetrieve` 观察点；不接受借钩子绕过事件时间、Agent 归属或持久化事务的修改。旧的 `agent:onSwitch` / `agent:onMoodChange` 事件名仅保留兼容类型，不表示新增了触发位置。

普通异步钩子和上下文扩展有超时与失败隔离；钩子 `context.abort()` 只停止本次钩子链传播，不代替取消 Agent Execution。纯同步死循环等任意原生代码行为不在这个逻辑超时边界内，必须通过插件代码信任授权处理。

声明式 UI 命名区域为 `dashboard.overview`、`chat.header`、`chat.footer`、`integrations`，由 PCard/PButton 渲染，不执行插件 HTML/CSS。完整页面使用下述 `web-ui` 贡献，在独立 iframe 中运行；插件自定义文字属于插件内容。停用立即撤销面板动作、页面会话、工具、Hook、Context Provider 与资源注册；前端在后续状态同步时撤下对应内容。

当前贡献工厂不动态开放 `application`、内核 `policy` 或底层 `runtime-adapter`；这些能力遵循各自的 Realm、Principal 和 Capability 契约。

## 12. 完整 WebUI

### 声明与入口

一个 Package 可以同时贡献多个工具、轻量面板与多个完整页面。入口位于“工具与扩展 → 插件”的相应插件卡片，只有激活状态可打开；页面在现有拓展 Tab 内显示，不增加全局导航。静态文件与后端模块都来自当前连接后端的同一个安装版本，适用于本机 Electron、远程 Electron 与 Docker/Web。

```json
{
  "manifestVersion": 2,
  "packageId": "example.preferences",
  "name": "偏好示例",
  "version": "1.0.0",
  "trust": "user",
  "contributions": [
    {
      "id": "preferences",
      "kind": "web-ui",
      "entry": "preferences.mjs",
      "webUi": {
        "root": "web",
        "index": "index.html",
        "title": "偏好设置",
        "actions": ["load", "save"]
      }
    }
  ]
}
```

`webUi.root` 是包内静态根，`index` 默认 `index.html`，HTML 使用 UTF-8 且有显式 `<head>`。Vue、React 等由作者预先构建为静态资源，使用相对资源地址，例如 Vite `base: './'`；页面内路由使用 Hash 路由。纯静态界面可以省略 `entry` 和 `actions`。带后端入口的贡献沿用 `runtime:execute` 代码信任授权，安装与上传不执行模块；完整页面不开放 Application 的自治运行时入口。

### 后端模块与页面 SDK

后端入口导出 `actions` 或 `createContribution(host)`；只接受清单列出的动作。它是本贡献的交互模块，不是任意 `serviceId + method` 路由。跨 Package 或 Application 协作仍使用原有 Capability/Bound Port 契约。模块可以通过 `host.dataDirectory` 保存插件数据，模块自身权限仍按 Node 代码信任约定处理。

```js
export function createContribution(host) {
  let draft = { text: '' }
  return {
    actions: {
      load() { return draft },
      async save(input, context) {
        context.signal.throwIfAborted()
        if (typeof input?.text !== 'string' || input.text.length > 1000)
          throw new Error('输入内容无效')
        context.report({ stage: 'saving' })
        draft = { text: input.text }
        // 本示例仅保存内存草稿；持久数据应写入 host.dataDirectory。
        return draft
      }
    }
  }
}
```

宿主在入口 HTML 的 `<head>` 前部注入 `window.infosPlugin`，其类型为 `PackageWebUiClient`：

```js
const unsubscribe = infosPlugin.onContext(({ theme, locale }) => {
  // theme 为 light/dark；页面自行根据 locale 翻译自己的文案。
})
const controller = new AbortController()
const result = await infosPlugin.call('save', { text: '你好' }, {
  signal: controller.signal,
  onProgress(value) { /* 更新页面进度。 */ }
})
unsubscribe()
```

动作输入、进度和返回值使用 JSON。`call` 经宿主鉴权发送一次 POST，以 SSE 返回进度和最终结果；断流不重发写操作。动作持有备份写入计数直到结束，避免 SSE 响应头返回后快照与动作文件写入交错。`context.clientId` 来自已验证的客户端身份，`context.signal` 关联页面关闭、身份撤销、停用与截止时间；处理器需在耗时操作中响应取消。取消不能撤销已经完成的写入。原始调用异常留在服务端诊断，页面收到本地化错误；SDK 本地协议异常以稳定的 `PACKAGE_WEB_UI_*` 标识报告。

### 资源与生命周期

| 接口 | 职责 |
| --- | --- |
| `POST /api/packages/web-ui/open` | 以当前客户端身份打开指定 `packageId`、`contributionId` |
| `GET /api/packages/web-ui/sessions/:id` | 核对同一身份与激活实例，延长宿主心跳 |
| `DELETE /api/packages/web-ui/sessions/:id` | 关闭页面会话并取消交互 |
| `POST /api/packages/web-ui/sessions/:id/call` | 调用声明动作，通过 SSE 返回进度、结果或错误 |
| `GET /api/packages/web-ui/files/:ticket/*` | 按只读票据提供静态文件，不接受业务调用 |

插件页面使用 SDK，以上会话 API 由 infOS 前端持有；会话 ID 不作为免鉴权业务凭据。

- iframe 仅使用 `sandbox="allow-scripts"`，不开放同源权限、Electron API 或宿主凭据。宿主按窗口来源、opaque origin 与随机通道校验消息；页面只获得所属贡献的桥。
- 静态票据只能读取激活时登记并核对摘要的文件。模块脚本和 CSS 正确返回 MIME 与 CORS 头；JSON 文件不被当作 REST 信封改写。资源路径同时校验词法边界、真实路径和文件摘要。
- 页面 CSP 允许脚本、样式、图片、字体及读取当前票据目录内的资源，业务网络交互通过页面桥；不开放直接访问宿主业务 API、任意外网、子框架、表单提交或 Worker。iframe 存储为隔离来源，持久配置应由后端动作管理。
- 资源票据与业务会话分离；业务调用还要求创建会话时的同一客户端身份与凭据。凭据不注入 HTML、SDK 或资源 URL。角色身份与 Agent 权限不会因打开页面自动授予。
- 每页最多八个在途动作，动作限时 60 秒；输入及最终结果上限 256 KiB，每次动作最多 128 个进度事件、每个 8 KiB。静态单文件最大 16 MiB，资源扫描有文件数量、总大小和目录深度边界；安装包仍受既有 20 MiB ZIP / 64 MiB 解包限制。
- 页面会话五分钟无宿主心跳失效；前端每十五秒确认状态。停用、重载、更新、回退、卸载或撤销身份会取消旧会话与在途动作。旧清理函数不撤销新激活实例；后端重启后页面需重新打开。
- Docker 的 `/api/` 使用 `^~` 前缀路由，静态扩展名正则不截获页面资源。其他反向代理也应保留外部 Host，并让 `/api/packages/web-ui/` 透传资源与 SSE，不缓存票据响应。

源码入口：后端 `packages/packageWebUi.ts`、`packageWebUiBootstrap.ts` 和 `routers/packageWebUi.router.ts`；前端 `integrations/PackageWebUiPane.vue` 与 `api/modules/packageWebUiApi.ts`。隔离语义参考 [HTML iframe 规范](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) 与 [CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)。
