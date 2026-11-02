# 插件、技能与子应用

infOS 提供多种扩展方式，包括官方内置的拓展功能与扩展工具，以及插件、技能、MCP 服务和子应用。它们在界面中有各自的入口，在运行时也各自承担不同职责。

本章先介绍你能在哪里使用它们，再以 Arca 和 Pictoria 为例，说明主应用与子应用如何通过双方适配器协作。

## 先认识几种扩展方式

| 方式 | 它提供什么 | 常见入口 |
| --- | --- | --- |
| **插件** | 一个可安装的包，可以提供工具、技能、服务、界面或其他已支持的功能。 | 「工具与扩展」→「插件」 |
| **技能** | 一套按需加载的工作说明和资源，帮助伙伴完成特定类型的工作。 | 「工具与扩展」→「技能」 |
| **MCP 服务** | 连接外部服务，把服务提供的工具接入 infOS。 | 「工具与扩展」→「MCP 服务」 |
| **拓展功能** | 官方直接提供的内部功能，通过统一接入层对接外部服务；目前包括联网搜索和 PDF 解析。 | 「工具与扩展」→「拓展功能」 |
| **扩展工具** | 官方适配并以工具形式提供的扩展，如 DeepWiki 和 Sciverse.space。 | 「工具与扩展」→「扩展工具」 |
| **子应用** | 有自己业务、界面和运行生命周期的应用，可以与 infOS 协作。 | 应用入口；社交应用另有「社交配置」 |

「工具与扩展」的「已安装」汇总插件、技能、角色包、桌宠模型、MCP 服务和拓展功能等资源，并提供对应管理入口。「扩展工具」用于管理官方扩展工具；「资源版本」用于管理受保护资源的候选版本。

技能、MCP 服务和子应用都可能为伙伴的工作提供支持，但它们的安装、配置和可用范围分别管理。工具如何获得角色和会话授权，请看[工具与权限](/work/tools)。

## 官方拓展功能

「拓展功能」是 infOS 官方直接提供的内部拓展功能，用来把外部服务的接入与主应用业务解耦。官方接入层负责按功能管理来源配置、启用状态和调用，并将各服务的接口差异收在对应适配中。这里的隔离指接入职责和接口边界；实际运行环境与权限由具体实现决定。

目前页面提供两项功能：

- **联网搜索**：配置并选择搜索来源，供伙伴查找网页和相关信息。当前支持 Tavily、Brave Search 和 SearXNG 来源。
- **PDF 解析**：配置并选择解析来源，为上传的 PDF 提取文字。当前支持 MinerU 轻量解析、MinerU 和 HTTP 解析服务。

在「工具与扩展」→「拓展功能」中，点击对应卡片的「管理来源」，可以「添加来源」，填写服务地址和所需配置；保存后点击「使用」启用该来源。页面还提供来源配置、移除和功能停用。搜索结果和 PDF 解析实际可用性取决于所选服务及其配置。

拓展功能的入口由 infOS 提供，选用的服务可以由外部服务商或自行部署的服务提供。它与「插件」的安装包、「扩展工具」提供给伙伴的专用工具，以及拥有独立业务流程的子应用分别管理。

## 使用插件

1. 打开左侧「工具与扩展」，进入「插件」。
2. 点击「导入 ZIP」，选择插件包。
3. 在列表中点击「启用」，按界面提示审核插件版本和申请的权限。
4. 启用后，可以查看运行状态；提供界面的插件会显示相应的打开按钮。

插件安装后还需要按提示审核和启用。页面也提供停用、重载、读取本地修改、回退和卸载入口，具体按钮取决于插件状态。更新、回退或修改包内容后，需要重新审核相应内容。

::: warning 只安装信任的插件
执行型插件代码以服务进程的权限运行。审核时请确认来源和申请的权限；界面列出的权限帮助你了解插件请求的能力，插件代码的运行环境依赖服务进程自身的权限。
:::

一个插件包可以包含多种功能。当前用户插件入口已接通工具、技能、事件订阅、服务、能力提供者、上下文提供者、界面和资源等贡献类型。应用、运行时适配器和策略目前需要各自的受控接入方式；在用户上传的插件包中直接声明这些类型会导致激活失败。

## 子应用是什么？

子应用有自己的业务对象和处理流程。例如，Arca 管理文稿、版本和审阅；Pictoria 管理画布、素材和创作工作流。它们可以提供自己的界面、数据和任务，并通过约定的接口与 infOS 交换请求和结果。

以「请伙伴协助修改一篇 Arca 文稿」为例：

1. 你在 Arca 中打开文稿，或者在对话中提出协作需求。
2. infOS 根据可用工具和授权发起协作；Arca 核对文稿、版本和协作范围。
3. 协作任务处理后形成待审变更，你可以在 Arca 中查看并决定如何处理。

文稿仍由 Arca 管理，角色任务和原对话的接续由相应宿主流程处理。不同应用的任务所有权和交付方式以各自实现为准。

### 在哪里打开？

- **Steam 版或 Electron 桌面版**：点击主窗口顶部的「+」新建标签页，从「应用」区域选择 Arca 或 Pictoria。
- **浏览器访问**：在主界面底部状态栏选择 Arca 或 Pictoria 的图标，应用会在新页面打开；浏览器需要允许弹出窗口。入口在非移动布局中显示。
- **社交应用**：在左侧「社交配置」管理社交平台及相关设置。

Arca 和 Pictoria 的协作功能需要对应后台可用。Arca 后台尚未连接时，页面可以进入连接设置；Pictoria 打开画布时会检查后台连接。实际启动方式取决于本机、远程或 Docker 部署；遇到问题时，可以查看应用状态或 Arca 的「设置 → 连接与运行」。应用还各自提供独立运行方式。

## 主应用与子应用：双方适配器

可以把双方适配器理解为两边的翻译和接线：一边了解 infOS 怎样提出请求，另一边了解子应用怎样处理自己的业务。通用接入基础设施负责连接、身份、能力绑定和消息传递。

```mermaid
flowchart LR
  Host[infOS 主应用<br/>角色 / 工具 / 能力] <--> Foundation[通用接入基础设施]
  Foundation <--> HostAdapter[infOS 侧适配器]
  HostAdapter <--> AppAdapter[子应用侧适配器]
  AppAdapter <--> App[子应用本体<br/>界面 / 业务 / 数据 / 任务]
```

| 部分 | 负责什么 |
| --- | --- |
| **通用接入基础设施** | 管理应用身份、连接状态、能力目录、授权与调用所需的共同机制。 |
| **infOS 侧适配器** | 把子应用公开的能力接入宿主，处理连接、工具投影，以及对应应用的结果和界面接入。 |
| **子应用侧适配器** | 声明并发布子应用支持的操作，把接收到的请求交给应用自己的业务流程。 |
| **子应用本体** | 管理自己的业务数据和行为，例如文稿、画布、素材或应用内任务。 |

这里的「双方」指 **infOS 侧和子应用侧**。前端界面也有自己的接入与桥接代码，负责标签页、页面通信和状态展示；它与业务能力的双方适配配合使用。

## 双向能力如何连接？

一个应用的声明会分别列出它提供的能力、希望使用的宿主能力，以及准备提供给主 Agent 的工具。这三个方向可以分别配置：

```text
子应用向 infOS 提供：可供调用的能力
子应用向主 Agent 提供：由选定操作投影的工具
子应用向 infOS 请求：模型、角色或其他宿主能力
```

声明中的 **Endpoint** 标识应用提供操作的入口；**能力提供（Offer）** 描述该入口有哪些操作；**工具投影（Tool Projection）** 把其中选定的操作变成伙伴可调用的工具。反方向的 **能力需求（Requirement）** 则描述子应用希望从宿主获得什么支持。

以 Pictoria 为例：它发布画布和创作相关操作，其中一部分通过 `pictoria` 工具供主 Agent 使用；它也声明了对宿主模型生成能力的需求。具体能力还要结合应用状态、绑定和授权才能使用。

### 伙伴调用子应用

以在线工具投影为例，调用经过以下路径：

```text
伙伴选择工具
→ 角色与会话工具门禁、执行策略和审批
→ infOS 侧适配器与已绑定的能力端口
→ 子应用侧适配器
→ 子应用处理操作并返回结果
```

子应用启动、对应能力就绪后，声明过的工具才会出现在在线工具目录中。子应用停止或连接断开时，相关工具会下线；恢复连接后，再按当前状态和权限开放。在线的子应用工具会在「角色管理 → 能力协议」的「子应用」分组中显示来源，也受会话模式与工具开关约束。

有些操作会提交一项需要时间的工作。收到「已受理」后，可以通过对应应用的任务状态和结果了解进展；结果交付到哪里由该应用和调用场景决定。

### 子应用使用宿主能力

反方向上，应用可以声明需要的人格、知识、工作区或模型等能力。宿主按应用实例、能力和资源范围管理授权，并通过受控能力接口提供结果。能使用哪些能力，要看该应用的声明、实际接线、当前提供者和授权状态。

例如，Arca 声明了读取角色人格、查询知识、读取工作区资料和使用模型生成等可选需求。具体协作还会核对角色、文稿、版本和范围；文稿改动以待审提案的形式交给用户处理。

## 界面、连接与生命周期

应用界面和后台各有自己的状态。桌面版通过标签页承载 Arca 和 Pictoria，浏览器版通过新页面访问；页面使用对应的受控桥接与宿主通信。

关闭一个应用页面后，后台是否继续运行取决于应用和部署方式。例如，Pictoria 已接收的创作任务由其后台执行，关闭画布页面后可以重新打开查看；托管后台的停止、桌面退出和远程连接则遵循各自的生命周期。

应用下线会影响依赖它的工具和能力调用。检查问题时，可以依次查看应用后台与连接状态、角色的工具权限、当前会话模式及审批结果。

**Application Realm** 用于标识应用实例及其工具边界；具体运行隔离还取决于进程和部署方式。Arca 与 Pictoria 有各自的应用宿主；内置 Social 使用兼容运行时和独立的社交上下文流程。据点群聊则属于主应用内部功能。

## 当前接入范围

目前可以从以下实例了解不同的接入方式：

- **Arca**：提供文稿读取和协作能力。伙伴可以在授权范围内查看文稿、发起协作或提交待审变更；Arca 管理文稿和审阅流程。
- **Pictoria**：提供画布与创作能力。伙伴可以通过工具查看创作步骤、提交工作流或提出画布修改建议；Pictoria 管理创作任务和画布内容。
- **内置 Social**：负责社交平台相关功能，使用自己的兼容运行时和社交上下文流程。用户可以在「社交配置」中管理相关设置。

Arca 和 Pictoria 的工具随应用及对应能力上线、下线，实际调用还要经过角色、会话和执行权限检查。接入新的子应用时，需要为它实现双方适配器，建立连接，并配置所需能力和授权。

从工具声明来看，应用工具管理层目前接收 `invoke`（调用操作）和 `submit_task`（提交任务）两类调用语义。Arca 和 Pictoria 目前声明的工具使用 `invoke`；其中某些操作本身会提交后台任务，后续进度和结果由相应应用处理。`open_session`（打开会话）工具声明需要专门的会话通道，目前会被跳过。

## 源码入口

- [Application 类型与声明](https://github.com/YoKONCy/infOS/blob/main/packages/shared/src/types/application.types.ts)、[接入与授权](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/applications/applicationIntegrationService.ts)、[应用工具管理](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/applications/applicationToolManager.ts)
- [能力绑定与工具上线](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/applications/applicationCapabilityRuntime.ts)、[应用运行域](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/applications/applicationRealm.ts)
- [Arca 声明](https://github.com/YoKONCy/infOS/blob/main/packages/apps/arca/src/manifest.ts)、[Arca 协作](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/applications/arcaCollaboration.ts)、[Pictoria 声明](https://github.com/YoKONCy/infOS/blob/main/packages/apps/pictoria/src/manifest.ts)、[Pictoria 接入](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/applications/pictoriaIntegration.ts)
- [插件管理界面](https://github.com/YoKONCy/infOS/blob/main/packages/frontend/src/components/integrations/PackageManagerPane.vue)、[插件运行时](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/packages/packageRuntime.ts)、[桌面应用入口](https://github.com/YoKONCy/infOS/blob/main/packages/frontend/src/components/layout/DesktopNewTab.vue)
- [拓展功能配置界面](https://github.com/YoKONCy/infOS/blob/main/packages/frontend/src/components/integrations/FeatureSourcesPage.vue)、[来源管理与搜索接入](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/services/integrations/integrationService.ts)、[PDF 解析接入](https://github.com/YoKONCy/infOS/blob/main/packages/backend/src/services/integrations/pdfParserService.ts)
