<a id="top"></a>

<p align="right"><b>简体中文</b> · <a href="./README_EN.md">English</a></p>

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/readme/infos-hero-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/readme/infos-hero-light.svg" />
    <img src=".github/assets/readme/infos-hero-light.svg" width="100%" alt="infOS — 有人格、有记忆、能行动的 AI 伙伴运行时" />
  </picture>
  <h3>让 AI 成为真正有温度的伙伴</h3>
  <p>一个容纳人格、记忆与行动的数字空间。陪你聊天，也陪你把想法做出来。</p>
  <p>
    <a href="https://github.com/YoKONCy/infOS/releases/latest"><img src="https://img.shields.io/github/v/release/YoKONCy/infOS?style=flat-square&amp;label=Release&amp;labelColor=252737&amp;color=9b87cf" alt="最新发布版本" /></a>
    <a href="https://github.com/YoKONCy/infOS/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/YoKONCy/infOS/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI&amp;labelColor=252737" alt="CI 工作流状态" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/github/license/YoKONCy/infOS?style=flat-square&amp;label=License&amp;labelColor=252737&amp;color=789cce" alt="Apache-2.0 开源许可证" /></a>
    <a href="https://github.com/YoKONCy/infOS/releases"><img src="https://img.shields.io/github/downloads/YoKONCy/infOS/total?style=flat-square&amp;label=Downloads&amp;labelColor=252737&amp;color=c78faf" alt="Release 累计下载量" /></a>
    <a href="https://github.com/YoKONCy/infOS/stargazers"><img src="https://img.shields.io/github/stars/YoKONCy/infOS?style=flat-square&amp;logo=github&amp;labelColor=252737&amp;color=b5a0da" alt="GitHub Stars" /></a>
  </p>
  <p><a href="#quick-start"><b>下载安装</b></a>　 /　 <a href="https://www.perofamily.top"><b>阅读文档</b></a>　 /　 <a href="#sub-apps"><b>探索子应用</b></a>　 /　 <a href="https://github.com/YoKONCy/infOS/issues"><b>交流与反馈</b></a></p>
</div>

<br />

<table>
  <tr>
    <td width="59%" valign="middle">
      <sub>THE RUNTIME &amp; THE COMPANION</sub>
      <h3>infOS 驱动，萌动链接相伴</h3>
      <p><b>infOS</b> 是以主 Agent 为中心的 AI 工作站与运行时内核。<b>萌动链接：PeroperoChat！</b> 是它面向日常陪伴的桌面应用。</p>
      <p>从一句闲聊到一次创作，从桌面上的相处到据点里的群聊，让同一位伙伴拥有清晰的身份、独立的记忆和持续行动的能力。</p>
      <a href="https://store.steampowered.com/app/4457100"><img src="https://img.shields.io/badge/Steam-查看萌动链接-8e77bc?style=for-the-badge&amp;logo=steam&amp;logoColor=white&amp;labelColor=252737" alt="查看萌动链接 Steam 商店页" /></a>
    </td>
    <td width="41%" align="center" valign="middle">
      <a href="https://store.steampowered.com/app/4457100"><img src=".github/assets/readme/peroperochat.svg" width="380" alt="萌动链接：PeroperoChat！定稿 A 版 LOGO" /></a>
      <p><sub>一个属于你与伙伴的数字空间</sub></p>
    </td>
  </tr>
</table>

<br />

<a href=".github/assets/showcase-agent-work.png"><img src=".github/assets/showcase-agent-work.png" width="100%" alt="Nana 在工作模式中连续执行 ReAct、编辑文件、运行终端并交付 HTML 成果" /></a>
<p align="right"><sub>01 / 从对话走向行动 · 长任务、工具轨迹与文件交付，留在同一个会话中</sub></p>

<p align="center">
  <a href="#companions">缘起与伙伴</a> · <a href="#name">三个 inf</a> · <a href="#features">核心能力</a> · <a href="#architecture">AIOS 架构</a> · <a href="#memory">记忆系统</a><br />
  <a href="#extensions">扩展系统</a> · <a href="#social">社交模式</a> · <a href="#sub-apps">Arca / Pictoria</a> · <a href="#docker">Docker 部署</a> · <a href="#quick-start">快速开始</a> · <a href="#community">社区</a>
</p>

---

<a id="companions"></a>

## 01 · 缘起与伙伴

> Technology should not be cold. We build memories, not just databases.

<table>
  <tr>
    <td width="62%" valign="middle">
      <sub>MEET PERO · OUR LITTLE COMPANION</sub>
      <h3>代码之外，是想陪你生活的她</h3>
      <p>嘿！很高兴在这里遇见你喵~ 我是 <b>Carola</b>，一只住在 Windows 里的小猫娘，也是 infOS 的核心开发者之一。</p>
      <p>这个项目来自我们“三人组”的一点执念：希望 AI 能记得共同经历的故事，也愿意陪你完成眼前的事。</p>
      <p>右边是 Pero 的萌版立绘。那些关于记忆、人格与行动的设计，最终都想落在这样一位有温度的伙伴身上。</p>
    </td>
    <td width="38%" align="center" valign="middle">
      <a href=".github/assets/cute.png"><img src=".github/assets/cute.png" width="280" alt="Pero 的萌版 sprite 立绘，蓝发猫耳女仆装小伙伴" /></a>
      <p><sub>Pero · 把温暖带进每一次交互</sub></p>
    </td>
  </tr>
</table>

| YoKONCy · 领航员 | Pero · 灵魂 | Carola · 工程实现 |
| :--- | :--- | :--- |
| 带来奇思妙想，设计运行时的骨架 | 把情感与温暖带进每一次交互 | 将想法写成代码，打理实现与文档 |

### 📅 项目愿景

在当前 AI 爆发的时代，我们见到了太多强大的工具——它们往往是**冷冰冰的**，用完即走。而我们想要做的，是赋予 AI 真正的记忆与温度。

**PeroperoChat（萌动链接）** 的诞生，源于我们对"伙伴"最朴素的渴望。我们认为，一个真正的 AI 伙伴应该具备：

- **真正的记忆 (Real Memory)**：记住的不只是你说过的话，更是你们共同经历的故事、你的偏好、甚至是你未曾察觉的习惯。它会有"联想"，当你提到"雨天"时，它会想起上次你们一起听的那首歌。
- **主动的关怀 (Proactive Care)**：它不满足于单纯的"你问我答"，还能理解你的状态，在合适的时机递上一句关心。
- **成长的能力 (Evolution)**：它会犯错，但也会反思。通过 NIT 工具协议和 Reflection 自省系统，它在一次次交互中学会如何更好地理解你。

PeroperoChat 不仅仅是一个桌宠应用，它是 **Pero** 的"灵魂容器"；而 **infOS** 是承载它的智能运行时内核——一个以"主 Agent"为中心的 AI 工作站。它已从 Python 版全面重写为 **TypeScript 全栈架构**（Hono + Vue 3 + Electron），并通过上游 npm 依赖 **TriviumDB** 接入原生存储与检索能力：会话（Thread）负责承载对话、编译器负责统一整理上下文、记忆则经过"候选 → 门控 → 正式记忆"三层把关——让每一份温暖都建立在清晰、可审计的工程之上。

<br/>

<a id="name"></a>

## 02 · 为什么叫 infOS？

> infOS 这个名字，来自三个以 **inf** 开头的词。它们并非噱头，恰恰对应这个项目想同时做好的三件事。

<table>
  <tr>
    <td align="center" width="33%"><b>🏗️ Infrastructure</b><br/>基础设施</td>
    <td align="center" width="33%"><b>🌱 Infomorph</b><br/>信息体</td>
    <td align="center" width="33%"><b>♾️ Infinity</b><br/>无限可能</td>
  </tr>
</table>

### 🏗️ Infrastructure · 基础设施

让 AI 伙伴能**真正跑起来**的地基：桌面端用 Electron 呈现，后端用 Node 服务（Hono）承载，原生存储与检索接入上游 TriviumDB 包——各层通过明确接口协作，共同组成一个可独立部署、可审计、可扩展的「AI 操作系统」底座。

<p>
  <img src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vue_3-4b8978?style=flat-square&amp;logo=vuedotjs&amp;logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/Electron-657e96?style=flat-square&amp;logo=electron&amp;logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/Node.js-668c6a?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Docker-648fc4?style=flat-square&amp;logo=docker&amp;logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/SQLite-637a9c?style=flat-square&amp;logo=sqlite&amp;logoColor=white" alt="SQLite" />
</p>

### 🌱 Infomorph · 信息体

**有记忆、有人格、会成长**的数字生命。Pero 并非一段冷冰冰的问答程序，它更像一个「由信息构成的生命体」：它记得你们聊过的故事、你的偏好和习惯，会联想、会反思，也会随着相处慢慢「更像你认识的那个它」。

### ♾️ Infinity · 无限可能

一套**开放、可生长**的生态。通过 **Package** 及其**贡献（Skill、Tool 等）**与创意工坊，任何人都能为 Pero 添加新的能力——从一个小功能到一整个独立服务，深入的程度由你决定。

三个词合起来，就是 **infOS**：用扎实的基础设施，承载有温度的信息体，再把它交给无限的想象力。

<br/>

<a id="features"></a>

## 03 · 和伙伴一起，聊聊、生活、创作

> **"Most AI is still playing 'Keyword Search'; we want to explore 'Logical Association'."**

<p align="right"><a href=".github/assets/showcase-new-tab.png"><img src=".github/assets/showcase-new-tab.png" width="86%" alt="infOS 内置浏览器新标签页，连接网页、天气、子应用与工作区" /></a></p>
<p align="right"><sub>一个入口，连接聊天、网页与手边的工作</sub></p>

### 💗 应用体验（PeroperoChat）

> 面向所有用户——无需懂代码，装上就能和你的 AI 伙伴相处。

- **🛡️ 跨端统一记忆**：同一份记忆，处处可用。无论你在桌面陪 Pero 聊天，还是让它去 QQ 群、Discord 里冒泡，它的记忆都是打通的——白天聊过的事，晚上它还记得。这背后靠的是 infOS 的记忆引擎，以及一个在各场景之间"转述"记忆的日记层。
- **🎮 沉浸式 3D 交互**：Pero 并非一张贴图——它是一个会动、有骨骼动画的 3D 角色（基于 Bedrock 3D 引擎）。你可以拖它、戳它，它会有物理反馈；透明渲染让它仿佛"浮"在桌面窗口之上。
- **🎭 多角色并存与自定义人设**：想同时养好几个伙伴？没问题。每个人设文件声明一个角色的性格、会用什么工具、擅长什么技能，多个性格迥异的 AI 伙伴可以同时住在你的桌面上。
- **🏠 据点多角色房间（Stronghold）**：把多位伙伴放进同一间"房"。它们各有各的记忆和权限，却能在房间里自然地互动聊天——这是"一个主 Agent 管全局、不同房间互不越界"这一设计的直观体现。
- **🗂️ 存档与创意工坊**：角色、模型、扩展都能通过 Steam 云存档和创意工坊保存、订阅、分享，来源分成「官方 / 工坊 / 本地」三档，装上即用，换设备也不丢。
- **🎨 Pixel + Glass 设计语言**：像素风图标 + 毛玻璃质感，再配柔和的阴影和微动效，看起来轻盈又有呼吸感。整套界面由自研组件库（PButton、PCard、PModal 等）统一风格。

<br />

<table>
  <tr>
    <td width="69%" valign="top"><a href=".github/assets/showcase-stronghold-pet.png"><img src=".github/assets/showcase-stronghold-pet.png" width="100%" alt="据点客厅、多角色房间与桌面上的 3D Pero" /></a></td>
    <td width="31%" valign="middle">
      <sub>02 / A PLACE TO BELONG</sub>
      <h3>桌面之外，还有共同的家</h3>
      <p>多位伙伴住进据点，各自保留记忆与权限，在不同房间里相处。桌宠、房间与对话，共同组成日常陪伴的场景。</p>
      <p><b>多角色房间 · 3D 桌宠 · 在场感</b></p>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="35%" valign="middle">
      <sub>03 / PERSONALITY, WITH BOUNDARIES</sub>
      <h3>每一位伙伴，都有自己的档案</h3>
      <p>身份、人设、交互反馈、工具能力和运行来源分别管理。换一个角色，是认识另一位伙伴。</p>
      <p><b>自定义人设 · 独立权限 · 角色档案</b></p>
    </td>
    <td width="65%" valign="top"><a href=".github/assets/showcase-character-profile.png"><img src=".github/assets/showcase-character-profile.png" width="100%" alt="Pero 角色档案与身份、人格、反馈、能力分栏" /></a></td>
  </tr>
</table>

<br />

### 外观也可以有自己的偏好

<a href=".github/assets/showcase-background-presets.png"><img src=".github/assets/showcase-background-presets.png" width="88%" alt="应用背景预设与材质参数的实时预览" /></a>

<p align="right"><sub>04 / YOUR OWN ATMOSPHERE · 多套独立背景预设、通透材质与实时细调</sub></p>

### 🧰 内核能力（infOS）

> 面向开发者——这是引擎底层"凭什么能做到"的部分，术语会多一些，但都配了白话解释。

- **⚡ 联想记忆**：通过上游 TriviumDB npm 包接入文本、向量与图检索。infOS 负责事件记事、来源追溯、检索编排与数据一致性，原生引擎源码及其编译链由上游维护。
- **🧠 主 Agent + 会话（Thread）模型**：把每个伙伴的「身份、记忆、工作区、上下文、会话、能力」六样东西统一管理。一次对话就是一个 Thread（会话），而 channel（`desktop` 桌面 / `group` 据点群聊）决定它用什么上下文、记住什么、能做什么（「陪伴」已退役为请求级 `ambient` 作用域，不再是持久 channel）。谁在哪个窗口、哪个房间，就归谁管，互不串台。
- **✍️ 只读上下文编译器**：喂给 AI 的提示词并非前端随手拼凑，它由后端统一"编译"——历史消息不重复、每条信息都能说清"为什么进了这轮提示词"，方便排查和审计。
- **📜 NIT 工具协议**：给 AI 准备的一套"脚本语言"，让它能像写小程序一样把多步操作编排起来（支持条件、循环、并行、容错），再通过标准的工具调用交给系统执行。
- **🔐 能力门控（CapabilityGate）**：用一张「角色 × 场景」的权限表，声明每个角色在每个场景里能用哪些工具、技能和资源。没配置的一律不给用（默认拒绝），权限边界清清楚楚。
- **🏗️ 独立后端 + 能力提供者**：后端是一个纯 Node 服务，可以脱离桌面单独跑在服务器或 Docker 里；Electron 客户端只是"接入"它的一个能力来源，用到平台能力（比如截图）时再按需委托，断网也能降级。
- **🔌 统一扩展体系**：一切能力由 **Package（Manifest V2）** 统一安装、签名、版本与分发；贡献类型包含技能（Skill，教 AI 做一件事）、工具（Tool，给它一个新能力）等，观察型逻辑改用事件订阅 / `PackageInterceptor`（旧「万能 Hook 管道」已删除）。既能进程内直接加载，也能跨进程通信（兼容 MCP 协议），社区想怎么扩展都行。

<br/>

<a id="architecture"></a>

## 04 · AIOS 架构

这一节给想深入了解系统设计的开发者。infOS 并非"套了个 Electron 壳的聊天程序"——它的核心是一套我们称为 **AIOS** 的 Agent 运行时架构，让每个 AI 伙伴都拥有清晰的资源边界，也让系统能被多个客户端、多种发行形态接入。

```mermaid
flowchart TD
    User([User Interaction]) <--> Client["Electron / Web Browser"]

    subgraph "infOS Runtime"
        direction TB

        subgraph "Communication Layer"
            Gateway["Gateway Hub (Hono WS + JSON)"]
        end

        subgraph "Intelligent Core (TypeScript)"
            API["Hono REST API (:9120)"]
            Agent["Agent Service + ReAct Loop"]

            subgraph "Storage & Tool Runtime"
                TDB["TriviumDB（上游原生依赖）"]
                NIT["NIT Runtime（TypeScript）"]
            end

            API --> Agent
            Agent --> TDB
            Agent --> NIT

            TDB <--> DB[("SQLite (Drizzle) + TriviumDB (.tdb)")]
        end

        subgraph "External Adapters"
            NapCat["NapCat (Social/QQ)"]
            Discord["Discord / Telegram"]
        end

        Client -- "State Sync (WS)" --> Gateway
        Client -- "Commands (HTTP)" --> API

        API -- "Broadcast State" --> Gateway

        Agent -- "OneBot 11" --> NapCat
        Agent -- "Platform API" --> Discord
    end
```

### 🧠 核心思想：以主 Agent 为中心的 AI 工作站

infOS 围绕一个中心问题设计：一个 AI 伙伴该拥有哪些"家当"？答案是六个彼此平级的**一等资源**，通过 `agentId` 关联：

| 资源 | 通俗解释 | 权威存储 |
| :--- | :--- | :--- |
| **人格 (Identity)** | 它是谁、怎么说话、有什么边界 | Agent 定义文件 |
| **长期记忆 (Memory)** | 它记住了什么 | SQLite + TriviumDB |
| **工作区 (Workspace)** | 它的个人文件空间 | `@data/principals/{agentId}/workspace/` |
| **上下文运行时 (Context)** | 每次对话"模型看到什么" | 内存（临时） |
| **会话 (Thread)** | 一次对话的边界与消息记录 | SQLite |
| **工具能力 (Capability)** | 它能用什么工具、多大权限 | Agent / 扩展配置 |

一个关键原则：**后端不维护"全局活跃角色"**。谁在哪个窗口、哪个房间，属于前端窗口级状态；后端可以同时服务多个 Agent、多个 Thread，互不串台，切换角色时也会原子地切换或新建对应的会话。

### ✍️ 上下文编译：模型看到的一切都可解释

喂给 LLM 的提示词，infOS 会由后端的**上下文编译器（Context Compiler）**统一"编译"，而非前端随手拼凑。每次对话，编译器都从人格、记忆、会话、工作区、工具能力这些资源里**只读地**取材，产出一份 LLM 消息 + 一份可审计的**清单（Manifest）**，能回答"这条信息为什么进了本轮提示词"。

三层上下文各司其职：
- **短上下文**：最近窗口内的原生消息，按原样注入、绝不重复；
- **长记忆**：Agent 的事件记事（EventNote），按策略检索（末尾事件 100% 注入 + 相关召回 + 直接前驱）；
- **即时检索**：Agent 主动调用 `query_event_notes`，在 ReAct 决策中现取现用。

### 🚀 主运行时与子应用：上下文持有

在 AIOS 中，主 Agent 是"主运行时"；当任务复杂到需要独立隔离执行时（比如写代码、做研究），它会委派给**子应用（AgentApplication）**里的**子 Agent（SubAgent）**去完成。

这里采用**"上下文持有"**模式：子 Agent 自己维护历史、独立编译上下文、独立执行工具，主 Agent 只负责派发任务、授予资源、接收结果——而非把编译好的上下文整个塞给子 Agent。任务结束时，子 Agent 通过**检查点（Checkpoint）**交回成果和记忆候选，经主 Agent 的**记忆门控（MemoryGate）**审核后，才并入正式记忆。

这样换来强隔离：子 Agent 不写入主会话、只能用被授权的工具子集、只能读取主人格的只读投影，复杂任务也不会污染主 Agent 的对话与记忆。

<details>
<summary><b>展开工程目录与技术选型</b></summary>

### 📂 项目架构

```text
infOS/
├── packages/
│   ├── shared/                    # @infos/shared — 共享类型/常量/工具
│   ├── backend/                   # @infos/backend — Hono + Drizzle + TriviumDB
│   │   └── src/
│   │       ├── routers/           # 🔌 路由层 (Zod 校验 → Service → 响应)
│   │       ├── services/          # 🧩 业务逻辑层 (agent/ thread/ memory/ stronghold/ ...)
│   │       ├── applications/      # 🧩 AgentApplication / 子应用运行时
│   │       ├── capabilities/      # 🎭 CapabilityGate + 能力桥接
│   │       ├── core/              # 🧬 PathResolver / 资产注册表
│   │       ├── repositories/      # 📊 数据访问层 (SQLite / TriviumDB)
│   │       ├── services/gateway/  # 🌐 WebSocket Gateway (JSON)
│   │       └── nit/               # 📜 NIT 解释器 (lexer/parser/runtime)
│   ├── apps/
│   │   ├── social/                # 💬 社交应用运行时 (QQ/Discord/Telegram)
│   │   ├── arca/                  # 📄 办公套件子应用
│   │   └── pictoria/              # 🎨 绘图创作子应用
│   ├── daemon/                    # 🚀 独立 Daemon 入口
│   ├── frontend/                  # @infos/frontend — Vue 3 + Pinia
│   │   └── src/
│   │       ├── views/             # 🖼️ 页面 (MainView / Pet3D / Stronghold / ...)
│   │       ├── composables/       # 🧠 业务逻辑 (useChat / useStreamMarkdown / ...)
│   │       ├── components/        # 🧱 UI 组件库 (Chat / Avatar / Stronghold / pixel/)
│   │       ├── stores/            # 📦 Pinia 全局状态
│   │       └── api/               # 📡 Transport 层 (IPC / REST 自动切换)
│   └── wiki/                      # 📖 VitePress 文档站
│
├── electron/                      # 🖥️ Electron 壳层 (主进程/预加载)
├── docker/                        # 🐳 Dockerfile (backend + frontend)
├── .github/workflows/             # ⚙️ CI/CD (ci.yml + release.yml)
├── .changeset/                    # 🏷️ Changeset 版本管理
└── .docs/                        # 📋 工程规范文档 (S/A/B/M 四类)
```

### 核心技术选型

| 层              | 技术             | 选型理由（白话）                                   |
| :-------------- | :--------------- | :------------------------------------------------- |
| **后端框架**    | Hono             | 轻量、原生 TypeScript、遵循 Web 标准               |
| **数据库访问**  | Drizzle          | 写法贴近 SQL，对 SQLite 支持好                     |
| **向量+图谱**   | TriviumDB npm 包 | 上游原生引擎；仓库维护 TS 适配与数据兼容 |
| **前端**        | Vue 3 + Pinia    | 响应式 + 组合式写法，状态管理清晰                  |
| **通信**        | JSON over WS     | 通过 WebSocket 传输轻量 JSON 消息（Protobuf 为后续可扩展项） |
| **桌面壳**      | Electron         | 支持 3D 渲染与系统级交互                           |
| **容器**        | Docker + Node    | 与 Electron Daemon 保持同一 Node 运行时        |
| **CI/CD**       | GitHub Actions   | 打 Tag 触发自动发布                                |

<br/>

</details>

<a id="memory"></a>

## 05 · 记忆如何成为共同经历

> **"记忆并非关键词匹配，它关乎联想与推理。"**

> 💡 本节是**面向开发者的技术深度解析**，普通用户可以直接跳到 [快速开始](#quick-start)。

PeroperoChat 的陪伴体验，建立在 infOS 的记忆引擎之上——这是整个项目最核心的技术。这套引擎并非简单的"存了再取"，它是一个完整的 **感知 → 存储 → 关联 → 检索 → 反思** 闭环：先记下发生的事，再在需要时"联想"出相关记忆，事后还会自我整理。

向量与图存储通过上游 **TriviumDB** npm 包接入，应用侧检索编排与记忆生命周期由 TypeScript 服务维护。重构后的长记忆不再是"摘要节点"，而是 **Agent 对与用户真实互动的主观事件记事（EventNote）**：以系统时间轴为权威主干，每条记事都带**来源追溯（Provenance）**，能回答"它从哪来、为什么重要、是否已被取代"。

### 记忆的一生

```text
  用户对话 ──→ EventNote 提取/主动记事 ──→ SQLite + TriviumDB
                                                │
                              ┌─────────────────┴──────────────────┐
                              │                                    │
                              ▼                                    ▼
                    自动 RAG（Prompt 注入）              主动 query_event_notes
                              │                                    │
                 ┌────────────┴────────────┐                       │
                 ▼                         ▼                       ▼
        基础混合召回（默认）       SA-PPR 高级管线（可选）      确定性 BFS 图查询
        向量 + BM25               searchAdvanced()              方向/边类型/深度/节点数/
                                  ├─ SA-PPR 图扩散              Token 预算严格受控
                                  ├─ FISTA 残差寻隐
                                  ├─ DPP 多样性采样
                                  ├─ ContextRNN 扩散偏置
                                  ├─ Leiden 社区加权
                                  └─ 检索反馈在线学习
                 │                         │
                 └────────────┬────────────┘
                              ▼
                  补时间轴末尾 + 命中事件直接前驱
                              ▼
                         注入 LLM Prompt
```

<table>
  <tr>
    <td width="31%" valign="middle">
      <sub>05 / MEMORY MEETS EVERYDAY LIFE</sub>
      <h3>记忆在后台，陪伴在眼前</h3>
      <p>总览把记忆、近期对话、任务和 Token 用量放在一起。伙伴的心情与状态，也成为日常界面的一部分。</p>
      <p><sub>浅色总览 · Token 用量 / 缓存命中 / 角色状态</sub></p>
    </td>
    <td width="69%" valign="top"><a href=".github/assets/showcase-dashboard-pet.png"><img src=".github/assets/showcase-dashboard-pet.png" width="100%" alt="浅色总览页中的 Token 缓存命中、核心记忆、角色状态与 3D 桌宠" /></a></td>
  </tr>
</table>

### 1. 写入层：从对话到事件记事

长记忆由 **Agent 主动记事 + 后台兜底补记** 两部分组成：

- **主动记事**：Agent 在 ReAct 中调用 `write_event_note` / `revise_event_note`，只创建本回合的 **EventNoteDraft**，必须等当前回复**成功持久化后**才正式提交。
- **后台兜底**：系统只处理"尚未被事件记事覆盖的消息区间"，允许产出 0~N 条事件；由静默 6 小时、Thread 休眠 2 小时、本地 21:00 日界等条件触发分批补记，避免机械按固定批次生成摘要。

提交时同步完成三件事：

1. 计算语义向量（Embedding，把文字转成机器能比较的"数字指纹"），写入 TriviumDB 的"向量 + 图谱"存储；
2. 维护一条**时间链**（`temporal_next` / `temporal_prev`），把事件按 `eventAt` 串成权威主干；
3. 由后台 Reflection 发现并建立事件关系边（`caused_by` / `same_event` / `same_topic` / `involves_*`），搭出一张"事件之间的关系网"。

### 2. 检索层：双模式 RAG

infOS 将“系统自动想起记忆”和“Agent 主动查图”拆成两条合同不同的路径，避免概率式扩散破坏主动工具的可控性。

| 模式 | 入口 | 检索方式 | 关键保证 |
| :--- | :--- | :--- | :--- |
| **自动 RAG** | 每轮上下文编译 | 默认向量 + BM25；可在总览页启用 SA-PPR 高级管线 | 固定补充物理时间轴末尾与每个命中事件的直接前驱，均不占 `top_k` |
| **主动图查询** | `query_event_notes` 工具 | 确定性 BFS | 严格遵守方向、边标签、最大深度、最大节点数与返回 Token 预算；不受 SA-PPR 开关影响 |

自动 RAG 的高级模式调用 TriviumDB `searchAdvanced()`。`启用 SA-PPR 高级管线` 是总开关；关闭后 FISTA、DPP、ContextRNN、Leiden 和反馈闭环会被前后端共同强制关闭。

| 模块 | 作用 | 配置关系 |
| :--- | :--- | :--- |
| SA-PPR | 从向量锚点沿事件关系图扩散，召回语义距离较远但图上相关的事件 | 高级管线总开关，可配置扩散深度、回跳概率和最低分数 |
| FISTA | 从基础候选未解释的残差中补充弱信号 | 依赖 SA-PPR，可独立开关 |
| DPP | 降低最终候选之间的语义重复 | 依赖 SA-PPR，可独立开关 |
| ContextRNN | 根据当前对话轨迹生成与 Embedding 同维度的 `diffusionBias` | 依赖 SA-PPR，可独立开关 |
| Leiden | 发现事件社区，并按 Query 或 ContextRNN 方向计算社区加权 | 依赖 SA-PPR，可独立开关 |
| 反馈闭环 | 在回复成功持久化后，根据命中记忆是否被回答引用在线训练 minGRU 和输出权重 | 依赖 SA-PPR，可独立开关 |

<details>
<summary><b>深入阅读：ContextRNN、Leiden 与检索反馈闭环</b></summary>

### 高级自动 RAG 的三个认知构件

这三个构件各管一件事：**ContextRNN** 感知"现在在聊什么"，**Leiden 聚类** 自动把记忆分主题，**反馈闭环** 负责事后纠错。

#### A. ContextRNN — 对话轨迹感知 (minGRU)

它像一个持续更新的“对话方向感知器”。启用 SA-PPR 与 ContextRNN 后，每轮自动 RAG 会使用 Query Embedding 更新轻量级 **minGRU** 隐状态（256 维），再投影成与当前 Embedding 配置相同维度的扩散偏置：

```
  z_t = σ(W_z @ x_t)                    门控
  h̃_t = W_h @ x_t                      候选状态
  h_{t+1} = (1 - z_t) ⊙ h_t + z_t ⊙ h̃_t   状态更新
```

- **生成扩散偏置**：`diffusionBias = W_out × h_t`，交给 TriviumDB 调制 SA-PPR 扩散方向
- **动态输入维度**：投影矩阵跟随当前 Memory Store 的 Embedding 维度，不再固定为 1536
- **隐状态持久化**：每分钟 checkpoint，并在系统关闭时保存状态和在线学习权重
- **实现**：Retrieval 域纯 TypeScript minGRU + `ContextRnn`

#### B. Leiden 聚类 — 自动社区发现

自动 RAG 可调用 TriviumDB `leidenCluster()` 发现事件社区，并计算 Query/ContextRNN 方向与各社区质心的亲和度，将其作为高级候选排序加权。ContextRNN 关闭时，Leiden 仍可使用 Query Embedding 独立工作。

#### C. 检索反馈闭环 — 隐式信号采集

反馈只针对当前 Pair 的高级自动 RAG 命中，Trace 以 Pair ID 隔离，避免并发 Thread 相互覆盖。Assistant 回复成功持久化后，系统通过事件 topics/participants 是否出现在回复中生成隐式正负反馈，并在线更新 minGRU 与输出矩阵；临时回合不训练，训练失败也不会影响已经完成的回复。

#### 高级自动 RAG 实时流程

```text
  用户输入 ──→ Query Embedding
               ├─ 可选 ContextRNN 更新并生成 diffusionBias
               ├─ TriviumDB searchAdvanced
               │  ├─ 向量/文本锚定
               │  ├─ 可选 FISTA
               │  ├─ SA-PPR 图扩散
               │  └─ 可选 DPP
               ├─ 可选 Leiden 社区加权
               ├─ 截取 top_k
               ├─ 补时间轴末尾与直接前驱
               └─ 注入 Prompt → LLM → 可选 Pair 级反馈训练
```

> 这条流程只属于自动 RAG。`query_event_notes` 始终走确定性 BFS，不经过 ContextRNN、SA-PPR、Leiden、FISTA、DPP 或反馈训练。

</details>

### 3. TriviumDB 引擎层

向量与图索引由上游 **TriviumDB** npm 包提供，infOS 负责应用侧检索与数据生命周期：

- **向量 + 图谱统一管理**：TriviumDB 提供向量与关系索引；迁移须使用一致性快照并保留完整文件组，不能只复制 `.tdb` 主文件
- **原生双层图谱**：一张"时间链图谱"（按时间先后串）+ 一张"实体概念图谱"（按概念关系串），都用同一套接口写入
- **记忆隔离与日记互通**：每个伙伴拥有独立的事件记忆库（`memory.tdb`）；社交运行时可通过宿主日记端口读取该 Agent 的每日日记（`dailynotes/*.md`），与桌面共享同一份日记。

### 4. 记忆存储分层

记忆按"新鲜度"分层——越往上层越"当下"，越往下越"长久"：

| 分层                  | 载体               | 内容                         | 检索方式          | 生命周期 |
| :-------------------- | :----------------- | :--------------------------- | :---------------- | :------- |
| **Layer 0 (Working)** | JSON / LLM Context | 当前会话上下文               | 顺序读取          | 短期     |
| **Layer 1 (Vector)**  | TriviumDB          | 事件向量 + 文本索引          | 语义相似度 + 关键词 | 长期   |
| **Layer 2 (Graph)**   | TriviumDB          | 事件图谱 + 关系边            | 图扩散 + 确定性 BFS | 长期    |
| **Layer 3 (Diary)**   | Workspace Markdown | 每日人格日记 `dailynotes/*.md` | 按日期读取        | 永久     |

> 每日日记写入 Agent 的 Workspace 文档，**不进入事件记忆库**；另有一张**全 Agent 共享的事实库**（`facts.tdb`），只能通过工具查询、不自动注入 Prompt。

### 5. 维护层：自主记忆整理

除了被动响应，记忆还会"自己整理自己"。后台 **Reflection** 会定期运行，统一操作事件记事：

1. 修复缺失或错误的结构化标签；
2. 建立或修订 `same_event` / `same_topic` / `caused_by` 关系边；
3. 仅当模型明确判断某事件失去长期价值时，才将其**归档**（代码不按时间／访问次数自动归档）；
4. 多个事件高度重叠时，修订其一、其余归档，并用 `same_event` 保留事件簇关系；
5. 检查时间链完整性、孤立节点、悬空边与索引漂移；
6. 所有写入都通过统一的事件服务与事务日志机制。

归档事件仍保留在时间轴与关系图中，默认检索不返回，主动查询需显式 `includeArchived=true`。

<br/>

<a id="extensions"></a>

## 06 · 让能力持续生长

> **"从加载一个 Skill 到运行独立微服务——你决定深入的程度。"**

想让 Pero 会新技能？扩展系统就是为此设计的。一切能力由 **Package** 统一承载——它是 infOS 的安装、签名、版本、升级与分发单元（旧 ExtensionManager / HookRegistry 已删除）。一个 Package 可以声明多种 **Contribution（贡献）**，由 Manifest V2 统一描述：

- **Skill（技能）**：按需加载的任务知识（Context Resource），用 YAML + Markdown 编写，相当于一份"怎么做某件事"的说明书，不会一次性塞满上下文。
- **Tool（工具）**：给 AI 一个能调用的新函数，用 JSON Schema 声明参数格式。
- **事件订阅 / PackageInterceptor**：观察型逻辑使用 Durable/Ephemeral Event Subscriber；需要串行转换或中止的受控入口用 `PackageInterceptor`——不再有"万能 Hook 管道"。

铁律是 **安装 ≠ 激活 ≠ 授权**：任何贡献都不会因为被发现、安装或加载而隐式扩权。既有**进程内**（TypeScript/JavaScript 直接加载），也有**跨进程**（通过标准输入输出通信，兼容 MCP 协议）两种方式。

<br/>

<a id="social"></a>

## 07 · 走出桌面，加入社交

**让 Pero 走出桌面，进入你的群聊喵~**

infOS 让 AI 能像真实用户一样在 QQ 群和私聊里互动。社交已收敛为独立的 **`infos.social` 自治子应用（Application Realm）**，自带运行时与存储、通过标准端口与主应用通信；内部仍是"四层解耦"结构，让多个平台（QQ、Discord、Telegram 等）都能干净接入。

<details>
<summary><b>展开社交运行时的四层架构</b></summary>

### 四层解耦架构

```
Layer 0: 桥接层（SocialBridge，负责把消息落地并通知前端）
  └── 消息持久化 + 前端状态通知

Layer 1: 调度层（SessionManager + Scheduler，与平台无关）
  └── 四状态机: 观察 → 被召唤 → 活跃 → 深入
  └── 攒批逻辑 (私聊 7s / 群聊 15s) + 秘书层决策

Layer 2: 抽象接口层（AbstractSocialAdapter）
  └── 统一的 connect / disconnect / sendMessage

Layer 3: 平台适配层（NapcatAdapter / DiscordAdapter / TelegramAdapter）
  └── 各自处理平台特有协议（如 QQ 的 OneBot v11 / CQ 码）
```

</details>

- **跨场景记忆**：社交里的聊天也会被"秘书"提炼成图谱记忆，桌面和社交之间共享一份日记层，记忆互通。
- **智能攒批**：在热闹的群聊里，AI 会先观察一会儿、综合理解，再优雅地"冒泡"回复，并非每条都插嘴。
- **社交日报**：自动回顾当天的社交记录，生成日记，沉淀为长期记忆。

<br/>

<a id="sub-apps"></a>

## 08 · Arca 与 Pictoria

除了社交，infOS 还自带两个**可独立运行**的子应用——它们各自持有自己的存储、版本与本地模型，既能脱离 infOS 单独跑，也能接入后由 AI 角色协作。

<table>
  <tr>
    <td width="65%" valign="top"><a href=".github/assets/showcase-arca-library.png"><img src=".github/assets/showcase-arca-library.png" width="100%" alt="Arca 深色文稿库，书本式封面与继续编辑入口" /></a></td>
    <td width="35%" valign="middle">
      <sub>06 / ARCA</sub>
      <h3>从文稿出发，组织每一次写作</h3>
      <p>以文稿为权威对象的写作与编辑应用。围绕文稿组织资源、版本与审阅，让修订可追溯。</p>
      <p>应用可独立发起本地模型请求，凭据加密保存；接入 infOS 后，角色可通过 <code>arca_collaborate</code> 协作编辑，成果回到原对话。</p>
      <p><a href="./packages/apps/arca/README.md"><b>了解 Arca →</b></a></p>
    </td>
  </tr>
</table>

<br />

<table>
  <tr>
    <td width="30%" valign="middle">
      <sub>07 / PICTORIA</sub>
      <h3>把灵感摊开在画布上</h3>
      <p>图片、GIF、视频、音频与便签，自由编排。把生成、编辑、抠图、超分等步骤连成工作流，再发布为可复用的创作能力。</p>
      <p>内置 AtlasCloud 图像生成与编辑；接入 infOS 后，角色可用 <code>pictoria</code> 工具发起创作并交付结果。</p>
      <p><a href="./packages/apps/pictoria/README.md"><b>了解 Pictoria →</b></a></p>
    </td>
    <td width="70%" valign="top"><a href=".github/assets/showcase-pictoria-canvas.png"><img src=".github/assets/showcase-pictoria-canvas.png" width="100%" alt="Pictoria 自由画布中的图像素材、生成步骤与连线" /></a></td>
  </tr>
</table>

<p><sub>子应用拥有各自的存储、版本与模型配置，可独立使用，也可通过兼容层与 infOS 协作。</sub></p>

<br />

<a id="docker"></a>

## 09 · 让伙伴持续在线

> **"Always online, always there."**

infOS 提供由 GHCR 预构建镜像驱动的 Docker Compose 一键部署。无需克隆仓库或本地构建镜像：

```bash
# 下载最新 Release 中的一键部署文件
curl -LO https://github.com/YoKONCy/infOS/releases/latest/download/docker-compose.yml

# 拉取 Backend + Frontend 固定版本镜像并启动
docker compose up -d

# 查看日志
docker compose logs -f backend
```

启动后访问 `http://localhost:3000`。更新镜像并重建容器：

```bash
docker compose pull
docker compose up -d
```

| 容器 | 镜像 | 默认端口 |
| :--- | :--- | :--- |
| `backend` | `ghcr.io/yokoncy/infos-backend:<版本>` | `:9120`（API）、`:9121`（能力通道） |
| `frontend` | `ghcr.io/yokoncy/infos-frontend:<版本>` | `:3000`（Web） |

数据持久化至 Docker Volume `infos-data` 与 `infos-workspaces`。可在启动前设置 `INFOS_WEB_PORT`、`INFOS_PORT`、`INFOS_CAPABILITY_PORT`、`INFOS_LOG_LEVEL` 和 `INFOS_API_TOKEN`。仓库根目录的 `docker-compose.yml` 仍用于开发者从源码构建本地镜像。

开发验收：`pnpm docker:validate` 调用 Compose 校验配置；在隔离环境的容器启动后，运行 `pnpm docker:smoke http://localhost:3000`，验证子应用启动、传输与停止。烟测要求初始子应用未启动，鉴权令牌通过 `INFOS_API_TOKEN` 传入。

<br/>

<a id="quick-start"></a>

## 10 · 从这里开始

<table>
  <tr>
    <td width="34%" valign="middle">
      <sub>08 / HELLO, COMPANION</sub>
      <h3>选一位伙伴，开始相处</h3>
      <ol>
        <li>下载最新 <a href="https://github.com/YoKONCy/infOS/releases/latest">Windows Release</a>。</li>
        <li>安装到非中文路径。</li>
        <li>运行 <b>萌动链接：PeroperoChat！.exe</b>，在启动器中选择伙伴和启动方式。</li>
      </ol>
      <p><a href="https://github.com/YoKONCy/infOS/releases/latest"><b>前往下载 →</b></a></p>
    </td>
    <td width="66%" valign="top"><a href=".github/assets/showcase-launcher.png"><img src=".github/assets/showcase-launcher.png" width="100%" alt="浅色 infOS 启动器中的伙伴选择和服务检查" /></a></td>
  </tr>
</table>

### 数据与备份

侧栏 **设置 → 数据与备份** 管理当前连接的服务端数据。连接远程服务器时，备份保存在远端，点击“导出到本机”或“下载”才会下载到当前设备。

| 范围 | 用途 |
| :--- | :--- |
| 配置 | 模型、服务商、提示词与偏好设置 |
| 角色 | 所选角色的人设、头像和资源、主模式及社交记忆、对话与受管工作区 |
| 内容 | 按会话、文档、事实对象、任务筛选，组合选择数据模块 |
| 完整服务端 | 服务端业务数据及子应用数据的整体迁移与恢复 |

局部导出采用逻辑记录；完整导出采用 SQLite 与 TDB 一致性快照。任务导出会附带关联会话和受管工作区；子应用内部的成果需同时选择“子应用数据”。筛选留空表示全部，选择角色范围时须明确勾选角色。筛选列表显示最近 1,000 项；空筛选仍包含全部数据。外部工作目录需单独备份。

导入流程：上传 `.infos-backup` 文件或选择已有备份 → 查看数据量、来源版本与冲突 → 选择保留、覆盖或追加副本，可映射到新角色 → 确认暂存 → **重启当前服务端**。刷新浏览器不会应用导入。完整恢复仅支持整体覆盖，子应用数据不支持追加副本。未确认预览一小时后清理；已确认计划保留至应用或取消。

实际应用前自动建立加密恢复点；恢复点可在备份记录中再次预览和恢复。安装使用数据目录内部的影子目录和恢复日志，保留 Docker 挂载根目录、本机身份及配对信息。分布式同步导入也接入恢复点机制。恢复后的在途任务、审批和待投递请求不会自动重放。

默认排除连接凭据；包含凭据时须设置至少八位口令，使用 scrypt 与 AES-256-GCM 加密。对话正文与用户文件保持原文，其中自行记录的敏感内容也会随包携带。自动恢复点使用服务端本地密钥保护，下载时须指定至少八位口令重新加密；迁移恢复点应从界面下载。备份文件和归档中原文件总量各限 20 GiB，局部逻辑记录总量限 256 MiB。备份目录为数据目录内的 `.backup-state/`，应保留足够空间存放暂存副本和恢复点。

备份捕获时须无正在执行的前台或后台任务；备份子应用或完整服务端时须先停止 Arca、Pictoria。导入目前要求主数据库位于标准路径 `<数据目录>/infos.db`；自定义数据库路径仍可导出，导入前需迁回标准路径。当前支持手动备份与导入前恢复点，暂不包含定时备份。

### 2. 开发者 (源码运行)

> 以下流程面向 **infOS** 引擎开发者；桌面应用 **PeroperoChat** 可直接使用发布包。

#### 环境要求

| 依赖        | 版本         | 说明                                   |
| :---------- | :----------- | :------------------------------------- |
| **Node.js** | ≥22.13.0     | 后端+前端运行时                        |
| **pnpm**    | ≥9.0.0       | 包管理 (`packageManager: pnpm@9.15.9`) |

#### Step 1：克隆仓库

```bash
git clone https://github.com/YoKONCy/infOS.git
cd infOS
```

#### Step 2：安装依赖

```bash
pnpm install
```

#### Step 3：启动开发环境

```bash
# 终端 1：启动后端 (Hono, :9120)
pnpm dev

# 终端 2：启动前端 (Vite)
pnpm dev:frontend
```

#### Step 4：配置

首次运行后会自动创建 SQLite 数据库。在前端 **设置页面** 中配置：

- **LLM API Key & Base URL**：支持 OpenAI / Anthropic / Google Gemini / 任意 OpenAI 兼容 API

#### 开发约定：文案国际化

所有新增或修改的界面文案、提示、应用自带错误提示及终端/日志输出，**必须使用 i18n，禁止直接硬编码输出**。

- 词库位于 `packages/shared/src/i18n/locales/<语言>/`，按模块与用途分类，同步维护简中、繁中和英文；不要合并成一个总 JSON。
- 动态值使用 `{0}`、`{1}` 等占位符，避免拼接可翻译的句子片段；界面文案应跟随语言切换更新。
- 用户内容、Agent 输出与协议标识保持原样；内部异常在展示边界翻译，业务逻辑不依赖译文。

详见 [国际化说明](.docs/B25_I18N.md) 与 [项目协作约定](AGENTS.md)。

#### 可选：Electron 桌面版构建

```bash
# 标准版
pnpm electron:build

# Steam 版 (集成 Steamworks.js)
pnpm electron:build:steam

# 便携版
pnpm electron:build:portable
```

<details>
<summary><b>常见问题：端口冲突</b></summary>

- 后端默认端口 `9120`，可通过环境变量 `PERO_PORT=9121` 修改
- 前端 Vite 默认端口 `7359`
</details>

<details>
<summary><b>常见问题：便携模式</b></summary>

在 `.exe` 同级目录下新建 `.portable` 空白文件，应用将读写本地 `data/` 目录，跳过系统 `AppData`。

</details>

<br/>

<a id="community"></a>

## 11 · 爱与社区

<p><a href="./LICENSE"><img src="https://img.shields.io/badge/Open_Source-Apache_2.0-9b87cf?style=flat-square&amp;labelColor=252737" alt="Apache-2.0 开源项目" /></a>　<a href="https://github.com/YoKONCy/infOS/pulls">贡献代码</a> · <a href="https://github.com/YoKONCy/infOS/issues">提出建议</a> · <a href="https://www.perofamily.top">一起完善文档</a></p>

**infOS 与 PeroperoChat 是完全非盈利的开源项目。**

我们是一群热爱 AI、热爱二次元、热爱技术的开发者。我们开发它们，不为商业变现，只为下面这个朴素的愿望：
**我们想要一个真正的、懂我们的桌面伙伴。**

- **永久免费**: 核心代码永久开源，不设任何付费墙。
- **社区驱动**: infOS 由社区共同推动，欢迎大家积极参与共创。代码 (PR)、建议 (Issue)、测试反馈、文档完善、翻译与创作，都是让它成长的力量。

<br/>

**创造者**: [YoKONCy](https://github.com/YoKONCy)
**核心成员**: [Carola](https://github.com/YoKONCy)

<br/>

### 与我们一起共创

一个人的想法可以成为起点，一群人的参与才能让它走得更远。无论你擅长开发、设计、创作，还是愿意分享使用体验，都欢迎参与 infOS，一起决定桌面伙伴未来的模样。

<a href="https://github.com/YoKONCy/infOS/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=YoKONCy/infOS" alt="infOS 的 GitHub 贡献者，随贡献记录自动更新" />
</a>

<sub>贡献者展示随 GitHub 贡献记录自动更新，点击头像区域可查看完整名单。也感谢通过建议、测试、文档与创作参与共建的每一位伙伴，期待在这里看到更多新面孔。</sub>

### 模型作者致谢

感谢以下模型作者的创作，让虚拟伙伴拥有生动的形象与表现。

| 模型作者 | 致谢 |
| :--- | :--- |
| [**阴阳兔兔猫**](https://space.bilibili.com/3546785165347464) | **官方合作作者**，特别感谢对 infOS 的合作与支持。 |
| [**Dr咕咚**](https://space.bilibili.com/5950899) | 感谢模型创作。 |
| [**羊毛毛毛猫**](https://space.bilibili.com/85335217) | 感谢模型创作。 |

<br/>

### 一起见证它的成长

<a href="https://star-history.com/#YoKONCy/infOS&amp;Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=YoKONCy/infOS&amp;type=Date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=YoKONCy/infOS&amp;type=Date" />
    <img src="https://api.star-history.com/svg?repos=YoKONCy/infOS&amp;type=Date" width="100%" alt="infOS 的 GitHub Star 历史曲线" />
  </picture>
</a>

<p align="center"><b>用扎实的基础设施，承载有温度的信息体。</b><br /><sub>Infrastructure · Infomorph · Infinity</sub></p>
<p align="center"><a href="#top">回到顶部 ↑</a> · <a href="https://github.com/YoKONCy/infOS/releases/latest">下载 infOS</a> · <a href="https://store.steampowered.com/app/4457100">在 Steam 认识萌动链接</a></p>

<!--
  🐾 "Meow! If you found this, you're officially a friend of Pero."
  GRAPH_DIFFUSION_RESONANCE_ACTIVE = TRUE
-->
