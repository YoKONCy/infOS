# 前端架构与性能优化

> **适用范围**：`packages/frontend/` 全部代码
> **技术栈**：Vue 3 + Vite + Pinia + TailwindCSS 4 + logic composables
> **最后更新**：2026-11-12

---

## 1. 核心架构

对话 Store 记录服务端主侧类型、代次与操作能力，窗口单独保存会话选择。角色状态 Store 按 Agent 缓存共享投影。主线过程通过 Surface 的 `processCollapsed` 默认收起，实时与历史沿用统一字段，重置通知和 `threadGeneration` 用于丢弃迟到结果。完整规则见 [主侧会话](./B26_MAIN_SIDE_THREADS.md)。

前端采用 **"视图-Store-逻辑"** 三层分离架构，并引入 **Transport 层** 实现跨环境兼容。

```
┌─────────────────────────────────────────────────────────┐
│  View 层 (views/ components/)                            │
│  职责：UI 渲染、组件编排、用户交互                        │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Logic 层 (composables/)                                 │
│  职责：响应式业务逻辑 (useXxx)、生命周期管理、UI 状态控制   │
└───────────┬───────────┴───────────┬─────────────────────┘
            │                       │
┌───────────▼───────────┐   ┌───────▼─────────────────────┐
│  State 层 (stores/)    │   │  Transport 层 (api/)         │
│  职责：跨组件全局数据    │   │  职责：通信适配 (IPC/REST)   │
└───────────────────────┘   └─────────────────────────────┘
```

---

## 2. 跨环境兼容 (Transport)

同一组件必须能同时运行在 **Electron (桌面)** 和 **Browser (Docker 版)** 中。

- **业务通信**：Electron 和浏览器均通过 HTTP、SSE 与 WebSocket 连接当前服务端；`api/transport.ts` 管理地址、设备凭据和请求。
- **客户端能力**：桌面窗口、托盘等 Electron 专有操作通过 `window.electron` 与主进程 IPC；浏览器环境使用相应 Web 能力或受限回退。

所有 API 调用统一封装在 `api/` 目录下，并根据环境自动切换实现。

### 首次上手引导

桌面版引导分启动器和主界面两段，步骤文案定义在 `composables/launcher/onboardingScripts.ts`，由 `OnboardingOverlay.vue` 渲染。启动器允许在高亮区域选择伙伴，再通过真实启动按钮进入主界面；主界面优先介绍聊天。`DesktopOnboarding.vue` 仅依据当前角色或主模型的指派以及模型列表判断是否已有模型，不将此判断视为连接测试；查询失败或环境变量等未覆盖的配置使用可跳过的选择。用户选择配置模型后，非模态提示随实际模型配置页面显示，可收起或返回聊天。

`onboardingFlow.ts` 通过本地缓存和服务端配置保存启动器、主界面及完成状态，使用 `runId` 防止旧窗口覆盖后发起的引导。跳过和完成均记为完成，启动器“关于”中可重新打开；配置中途关闭应用时，下次会从主界面引导重新开始。

---

## 3. 性能优化 (P0 级别)

> 本规范基于 infOS 现有渲染审计和流式性能优化经验。

### 3.1 `<keep-alive>` 白名单

- **原则**：只缓存切换频繁且初始化开销大的页面。
- **顶层路由**：Electron 和浏览器共用 `MainView`；`App.vue` 在完成认证后仅将 `MainView` 加入顶层缓存。
- **主界面 Tab**：`MainView.vue` 承载 7 个一级主舞台入口（`ChatTab`、`StrongholdTab`、`WorkspaceTab`、`CompanionsTab`、`MemoryHubTab`、`TasksTab`，Electron 桌面端另有独立的 `CardsTab`），统一纳入 `:max="7"` 的 `KeepAlive` 缓存；已就绪的一级入口通过 `useMainNav.ts` 双帧 `requestAnimationFrame` 调度切换（首帧先更新 `activeNavTab` 高亮，次帧激活目标页面），并在 `onActivated` 中执行带新鲜度窗口的后台静默刷新（SWR），不再闪烁骨架屏。二级聚合台（伙伴、记忆馆）默认静态直载高频首屏子页，其余子标签与居中模态设置中心（`SettingsHubModal.vue`）继续采用 `v-if` 按需挂载，离开子标签或关闭设置弹窗时立即卸载以释放 DOM 与响应式内存；`LogsTab.vue` 在收起或切换会话条目时同步清空已拉取的调试消息数组，`BackupsTab.vue` 仅在展开底部折叠面板时按需加载嵌入态 `ResetTab.vue`。组件在停用和卸载时分别处理连接、计时器及重型视图资源。
- **独立路由**：`LauncherView` 和 `Pet3DView` 仅 Electron 可访问，浏览器对应路径转向主界面。

### 3.2 响应式性能

- **禁止深度响应**：对大型数组（消息列表、记忆列表、日志、任务）和物理引擎对象（Three.js）必须使用 `shallowRef` 或 `markRaw`。
- **避免多余 watch**：禁止在 `useStreamMarkdown` 等高产出逻辑中使用冗余的深度监听。

### 3.3 首帧同步富文本与流式帧合并 (60fps)

针对历史与 SSE 流式 Markdown 消息，采用 **"稳定区同步首帧 + 尾部区帧合并"** 分段架构：

1. **稳定区 (Stable)**：已闭合的消息与稳定分段在首帧同步执行 `renderChatRichTextResult` 并直接挂载净化后的 HTML，消除纯文本占位切换到富文本时的排版跳动。
2. **尾部区 (Tail)**：正在追加的流式块沿同一富文本管线渲染，不额外经历纯文本降级态。
3. **调度**：流式未闭合块通过 `requestAnimationFrame` 将同一显示帧内的多次 delta 合并为单次 DOM 更新（最高 60fps），收口转为 `stable` 时立即取消挂起帧并同步提交最终分段。

### 3.4 对话历史分页、渐进窗口与会话投影缓存

对话页不得一次加载并挂载整个 Thread，也不得依赖固定 200 条 Projection 上限掩盖 DOM 增长。采用以下组合策略：

- 首次只请求最新 60 条消息；`ChatContainer.vue` 初次仅挂载底部最新 24 条消息窗口，用户上滚接近窗口顶部时每次锁定锚点渐进展开 24 条，触达已拉取边界后再按游标继续加载更早历史。
- `useThreadStore.ts` 与 `ChatTab.vue` 维护最多 12 条最近访问会话的 LRU 投影快照与会话列表缓存（SWR），切换角色或重返已访问会话时 `0ms` 还原消息与 Compositor 作用域，并在后台静默校验增量；淘汰旧会话时同步调用 `compositor.disposeScope` 回收作用域。
- 流式消息、当前播放消息和交互 Surface 必须保持真实 DOM，不得被窗口化卸载。
- 已提交 Markdown 以源码为键使用有界 LRU 缓存；消息与 Surface 按 `messageId + revision` 保持对象身份。
- `useMessageVisibility.ts` 将同一批 `IntersectionObserver` 回调合并后通过 `setSuspendedBatch` 一次性提交，不可见时以容器样式类暂停动画并暂停 Video、Audio，卸载 iframe、Mermaid 与 Programmable Surface 等重型运行时；恢复时使用缓存高度避免滚动跳变。
- KaTeX、Mermaid 等重型渲染依赖按首次命中公式或图表语法时动态加载。

IntersectionObserver 负责可见性和重型节点生命周期，动态消息窗口负责控制 Vue 组件与普通 Markdown DOM 数量；两者职责不可混淆。

### 3.5 ReAct 执行段折叠

`ConversationSurface` 在 Markdown 分段与 NIT 父子调用归并之后，由 `compositor/executionGroups.ts` 将连续工具、思考、重试及状态节点归为执行段。可见正文构成段落边界；审批、提问、独立附件及错误提示保持在段外。空白正文不创建边界，工具结果按调用 ID 回填原卡片，不改变展示顺序或持久化内容。

含工具调用的执行段通过 `ExecutionProcess.vue` 渲染哑光微立体折叠胶囊（`正在探索`／`走过 {0} 步足迹`），左侧叠置最多 4 枚由 `TrajectoryIcon.vue` 绘制的双调微刻精工图标，中间汇总 NIT 连携计数、代码增删统计、提醒时间、异常徽标与总耗时，右侧提供独立微凸扳机小键；主会话 `processCollapsed` 外层总胶囊启用且仅包含单一工具执行段时，内层切换为 `headless` 模式仅输出纵向导轨以避免双重折叠头。执行中默认展开，Surface 从 `open` 进入结束状态时自动收起；历史记录初次挂载默认收起。用户可逐段展开，后续结果更新不覆盖选择；NIT 子调用仍留在原有父工具内部。折叠保留已挂载卡片和内部交互状态，同时通过 `active` 暂停隐藏内容的重型运行时。

展开态通过 `trajectory-tactile.css` 的双线微刻压痕纵向主轴（`.traj-spine`）统一串联段内思考节点（`thinking` 采用 `2px` 错位叠纸碎碎念便签，`native-reasoning` 采用无框精简单行，提交后自动收起并保留单行正文预览）与异构工具节点（`ToolCallCard.vue`：NIT 编排双舱主条与虚线圆角分叉树及独立轻内凹沙箱脚本抽屉、NIT 纯沙箱演算条、代码变更 5 格内凹比例尺双舱条、定时提醒硬卡打孔小票、角色心情叙事胶囊、据点房间穿梭小键、托盘置物条、画面光圈条，以及常规高频工具的无框静默灵动行）。主轴节点统一挂载 `23×23px` 哑光微立体铭牌（`ToolArchetypeSignature.vue`），运行脉动与悬停微动严格遵循减少动态效果设置。

---

## 4. 组件规范

### 4.1 逻辑分层示例

```typescript
// composables/chat/useChatFlow.ts (Logic 层)
export function useChatFlow() {
  const messages = shallowRef<ChatMessage[]>([])
  async function sendMessage(text: string) {
    /* ... */
  }
  return { messages, sendMessage }
}
```

```vue
<!-- components/chat/ChatBox.vue (View 层) -->
<script setup>
const { messages, sendMessage } = useChatFlow()
</script>
<template>
  <MessageList :items="messages" />
  <ChatInput @send="sendMessage" />
</template>
```

### 4.2 路由分包与主导航结构

`router/index.ts` 使用动态导入加载 `MainView`、`LauncherView`、`DetachedPanelView` 和 `Pet3DView`；`MainView.vue` 通过 `defineAsyncComponent` 和 `composables/main/tabRegistry.ts` 按需加载主界面各分区。

主界面采用 **「常驻紧凑图标轨 + 居中模态设置中心」** 两层扁平导航（`useMainNav.ts`）：

- **左侧常驻紧凑轨（`MainNav.vue`，`78px`）**：顶部常驻 `infOS` 品牌标识与 `PEROPEROCHAT` 英文副标；中部固定一级舞台入口（对话 `chat`、据点 `stronghold`、工作区 `workspace`、伙伴 `companions`、记忆馆 `memory_hub`、任务 `tasks`，Electron 桌面端另有独立的卡片 `cards`），桌面端切换页面时导航轨宽度恒定不跳变，任务与卡片均支持直接右键摘出为独立桌面面板；底部固定「设置」入口。
- **二级聚合工作台与独立功能页**：`CompanionsTab.vue`（状态总览／共享空间／伙伴设定）与 `MemoryHubTab.vue`（核心记忆／知识库／对话日志）以顶部横向标签组织子视图；`TasksTab.vue`（任务中心）与 `CardsTab.vue`（桌面卡片与收纳框预制件）各自作为独立一级页面运行。
- **居中模态设置中心（`SettingsHubModal.vue`）**：挂载于主首页工作面（`#desktop-home-panel`）内部，天然保留顶部窗口标签栏（含实时主题切换）且遮罩不叠加模糊；承载 4 大扁平分组（常规与陪伴、连接与服务、能力与安全、极客与维护）并提供关键字即时过滤，消除嵌套竖向侧边栏；弹窗独立声明浅/深色实体面板令牌，与全局壁纸半透明材质彻底解耦以保证表单可读性。`setTab(id)` 完整兼容历史 `pageId` 映射与桌面独立面板摘出重定向。

---

## 5. 3D 与动画规范 (Three.js)

- **资源管理**：所有 Texture/Geometry 必须在 `onUnmounted` 中手动 dispose。
- **画质选择**：桌宠画质档位调整渲染分辨率、阴影贴图和目标帧率；具体设置由客户端处理。
- **隐藏窗口**：桌宠隐藏时暂停画面更新，持续隐藏后回收视觉资源；重新显示时再加载。实现与使用方式见 [桌宠与 3D 造型](../packages/wiki/companion/desktop-pet.md)。

---

## 6. CSS 样式体系

### 6.1 核心原则：Tailwind-First

**Tailwind 是默认选择，scoped CSS 是例外。**

所有组件的布局、间距、颜色、字体、交互状态优先使用 Tailwind utility class 直接写在模板中。只有以下场景才使用 scoped CSS：

- 复杂动画 (`@keyframes`)
- 伪元素 (`::before`, `::after`)
- 滚动条自定义 (`::-webkit-scrollbar`)
- WebGL/Canvas 容器的特殊布局

**禁止的做法**：在 `<style scoped>` 中用自定义类名重新发明 Tailwind 已经提供的 utility（如 `display: flex`、`padding: 8px`、`color: xxx`）。

### 6.2 架构分层

```
┌─────────────────────────────────────────────────────────┐
│  Tailwind Utilities (模板 class="..." 中直接使用)        │
│  ★ 主力：布局/间距/颜色/字体/交互/响应式 全部在这里      │
└──────────────────┬──────────────────────────────────────┘
                   │ 混合使用
┌──────────────────▼──────────────────────────────────────┐
│  全局像素类 (style.css 中定义)                           │
│  pixel-border-*, pixel-btn-*, press-effect, font-pixel  │
│  ★ 像素风视觉语言，直接在模板 class 中引用               │
└──────────────────┬──────────────────────────────────────┘
                   │ 支撑
┌──────────────────▼──────────────────────────────────────┐
│  tokens.css (CSS Variables)                              │
│  颜色令牌单一真相源 → 通过 @theme 桥接到 Tailwind        │
└──────────────────┬──────────────────────────────────────┘
                   │ 仅在必要时
┌──────────────────▼──────────────────────────────────────┐
│  <style scoped> (例外场景)                               │
│  仅用于: @keyframes / 伪元素 / 滚动条 / 复杂选择器       │
└─────────────────────────────────────────────────────────┘
```

### 6.3 模板写法示例

```vue
<!-- ✅ 正确：Tailwind + 全局像素类混合 -->
<div class="flex items-center gap-3 p-4 bg-white pixel-border-sky press-effect">
  <span class="text-sm font-bold text-slate-600 font-pixel">标题</span>
</div>

<!-- ❌ 错误：用 scoped CSS 重写同样效果 -->
<div class="my-card">
  <span class="my-card-title">标题</span>
</div>
<style scoped>
.my-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
}
.my-card-title {
  font-size: 14px;
  font-weight: 700;
}
</style>
```

### 6.4 Tailwind 使用范围

#### ✅ 允许使用

| 用途   | 示例                                                                 |
| ------ | -------------------------------------------------------------------- |
| 布局   | `flex`, `grid`, `items-center`, `justify-between`                    |
| 间距   | `p-4`, `m-2`, `gap-3`, `space-y-2`                                   |
| 排版   | `text-lg`, `font-bold`, `font-pixel`, `tracking-wide`                |
| 尺寸   | `w-10`, `h-10`, `min-w-0`, `max-w-xs`                                |
| 颜色   | `bg-white`, `bg-sky-50`, `text-slate-700`, `bg-sky-face`             |
| 边框   | `border`, `border-sky-100`, `rounded-xl`                             |
| 阴影   | `shadow-md`, `shadow-sky-100/50`                                     |
| 交互   | `hover:bg-sky-50`, `group-hover:scale-105`, `active:translate-y-0.5` |
| 过渡   | `transition-all`, `duration-300`                                     |
| 响应式 | `md:grid-cols-2`, `sm:hidden`                                        |
| 条件   | `:class="[cond ? 'bg-white' : 'bg-transparent']"`                    |

#### ❌ 禁止

| 禁止行为                                       | 原因                                                 |
| ---------------------------------------------- | ---------------------------------------------------- |
| `bg-[#ff00ff]` 硬编码颜色                      | 必须通过 tokens.css → @theme 桥接                    |
| `w-[137px]` 硬编码尺寸                         | 用标准尺寸或极端情况 scoped CSS                      |
| `@apply` 在 scoped style 中大量使用            | 失去了 Tailwind 的优势                               |
| scoped CSS 重写 Tailwind utility               | 不要用 `.card { display: flex }` 代替 `class="flex"` |
| 用 Tailwind `box-shadow` 替代 `pixel-border-*` | 像素风类是项目核心视觉，不可替代                     |

### 6.5 色彩使用优先级

```
1. @theme 桥接色 (bg-sky-face, text-pink-shadow, border-sky-100)
   ↓ 通用中性色
2. Tailwind 原生色板 (bg-white, text-slate-700, bg-emerald-50)
   ↓ 极端情况需要自定义
3. tokens.css var() 在 scoped CSS 中 (仅 @keyframes / 伪元素等)
   ↓ 禁止
4. ❌ 硬编码 (bg-[#ff0000], color: #xxx)
```

### 6.6 像素风全局类 (pixel-\*)

以下定义在 `style.css` 中的类是项目核心视觉语言，**直接在模板 class 中引用**：

| 类别     | 类名                                                                                                     | 用途                      |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| 像素边框 | `pixel-border-sm`, `pixel-border-sky`, `pixel-border-pink`, `pixel-border-emerald`, `pixel-border-amber` | FC 风多层 box-shadow 边框 |
| 像素按钮 | `pixel-btn-sky`, `pixel-btn-pink`, `pixel-btn-yellow`                                                    | 完整像素风按钮样式        |
| 像素卡片 | `pixel-card`, `pixel-card-moe`                                                                           | 像素风卡片容器            |
| 像素字体 | `font-pixel`                                                                                             | Zpix/DotGothic16 像素字体 |
| 像素网格 | `pixel-grid-overlay`                                                                                     | 4px 网格纹理叠加层        |
| 交互效果 | `press-effect`, `bouncy-hover`, `pixel-hover-lift`                                                       | 按下/悬浮/抬升效果        |
| 像素动画 | `animate-pixel-bounce`, `animate-pixel-float`, `animate-pixel-shake`                                     | 像素步进动画              |

### 6.7 scoped CSS 保留场景

仅在以下场景使用 `<style scoped>`：

```vue
<style scoped>
/* ✅ 动画关键帧 */
@keyframes fade-slide { ... }
.fade-slide-enter-active { ... }

/* ✅ 伪元素 */
.indicator::before { content: ''; ... }

/* ✅ 滚动条 */
.scrollarea::-webkit-scrollbar { width: 4px; }

/* ✅ 多层嵌套选择器（Tailwind 无法表达） */
.timeline-item:last-child { border-bottom: none; }

/* ❌ 禁止：重写 Tailwind utility */
.my-box { display: flex; padding: 8px; color: red; }
</style>
```

## 7. AIOS 前端状态边界

前端是后端持久资源的视图订阅者，详细模型见 [A09_AIOS_ARCHITECTURE](./A09_AIOS_ARCHITECTURE.md)。

- `activeAgentId`、`activeThreadId` 和窗口布局属于**窗口级 UI 状态**；后端不维护全局活跃 Agent/Thread。
- Store 可缓存 Agent、Thread、消息等展示数据，但 SQLite/文件系统中的持久资源以 API 返回和事件流为准。
- 发送聊天请求只提交 `{ threadId, content, attachmentIds? }`；不得将前端消息数组作为上下文上传。
- 切换 Agent 必须连带选择/创建属于该 Agent 的 Thread，禁止交叉组合。
- group 日志按据点 `roomId` 聚合展示；按 Agent 划分的 group Thread 仅服务后端隔离上下文，不能作为用户可见的房间分组。
- SSE 必须以显式 `done` 判定成功结束，工具事件通过 `callId` 关联。

---

## 8. Surface Protocol与Compositor

### 8.1 权威边界

Surface是领域事实的语义视觉投影，不是业务真相。后端持有业务事实、Execution状态、Projection与可恢复的最终Surface Commit；客户端Compositor持有窗口级Surface Tree、布局、可见性、动画、输入焦点与Stable Block/Active Tail。Renderer崩溃、DOM销毁或窗口关闭不得改变权威状态，断线后必须可由领域事实和Projection Snapshot重建。

Internal Surface Protocol仅供infOS系统组件、Projection、Shell与Compositor使用。第三方Application通过第二层Frontend Adapter接入Tab、任务、会话、状态和授权UI；未受信任的远程内容只能使用External Presentation Protocol或隔离WebView/iframe，不得向主Renderer提交Vue组件、HTML、JavaScript或DOM Patch。Frontend Adapter只能通过类型化IPC访问自己的Backend Adapter，不持有远程Credential、Kernel Service或任意本地端口权限。

### 8.2 语义节点与操作

当前节点类型包括 `markdown`、`thinking`、`native-reasoning`、`model-retry`、`code`、`math`、`mermaid`、`tool-call`、`tool-result`、`status`、`error`、`attachment`、`approval`、`progress`、`input`、`panel`、`table`、`notification`、`document` 和 `programmable-island`。节点有 `nodeId`、`revision` 和生命周期标记；完整定义见 `packages/shared/src/types/surface.types.ts`。

协议操作固定为：

```text
surface.open
surface.append-text
surface.append-tool-arguments
surface.upsert-node
surface.patch-node
surface.commit
surface.fail
surface.dispose
```

实时帧包含协议版本、Surface 身份、generation、revision、sequence、operationId 和具体操作；同一 generation 内的 sequence 递增。

聊天HTML始终作为源码展示；可执行内容只能进入独立沙箱Surface。流式Frame不进入持久日志，网络delta只做帧合并，不得人为拆词减速。

### 8.3 Compositor职责

- 管理Surface Tree、Revision和稳定Node ID；
- 将Surface安排到聊天、窗口、通知、桌宠或任务中心；
- 路由键盘、鼠标、触控和辅助功能输入；
- 根据可见性冻结动画、Canvas、视频与重型组件；
- 支持增量Commit、回放、重连和最终权威渲染；
- 阻止不可信内容越过沙箱与Presentation边界。

流式渲染采用稳定区与活动尾部：已完成复杂子树保持稳定身份，快速流与最终完整渲染分离；Mermaid、KaTeX、代码和工具卡拥有独立生命周期。非当前视图继续推进Projection，但停止无意义DOM更新。

聊天富文本在客户端窗口内存中驻留完整渲染快照，包含资源卡、隔离预览的分段与已净化 HTML。内容、预览模式和语言未变化时保留原分段对象及 DOM；滚动恢复、页面重新激活或会话信息变化不重新分段和解析。组件持有当前快照，不受共享缓存淘汰影响；组件重挂载可复用有容量上限的最近快照。流式尾部不进入共享缓存，源码更新或语言切换才生成新结果，离屏期间继续暂停解析和媒体。缓存只服务当前客户端窗口，不写入服务端或浏览器长期存储。

`chatRichRenderer` 保留同步返回 HTML 的 `renderChatRichText`；管理缓存的调用方使用 `renderChatRichTextResult` 的 `html/mathReady`。`prepareChatRichText` 按需准备公式依赖，`peromath` 围栏与渲染共用 Marked 词法和语言归一化规则。依赖未就绪的源码降级结果不进入底层 HTML 缓存、组件驻留快照或共享快照；聊天与资源预览订阅依赖就绪事件后重渲染，销毁/替换预览时清理订阅，离屏聊天等恢复可见再渲染。

审批集合独立于主界面呈现：`useApprovalStore` 前台每 4 秒拉取全局 pending，窗口隐藏或被应用标签覆盖时降为每 60 秒补齐，恢复可见立即刷新。Gateway 新审批只投递当前角色的输入席位，不能替代所有角色的全局兜底；结果等价时保留原 Map，避免重复触发依赖更新。停止 Store 轮询会同时清理前台/后台定时器。

Conversation Projection 必须支持游标窗口，Snapshot 只返回请求窗口内的消息与对应 Surface，并携带`hasMoreBefore/beforeCursor`。前端追加历史时按`messageId + revision`复用已有对象，不得整体替换未变化的消息树；实时 Frame 只更新目标 Surface。工具结果必须按`callId`建立索引，禁止模板渲染阶段反复线性扫描 Surface Node。

输入栏 Token 计数在 ReAct 中读取当前 Thread 与 Principal 的活动 Surface 状态，逐轮更新，并区分请求估算与上游实测。生成期间停止下一轮预算预览请求，防止旧 HTTP 响应覆盖实时统计；切换角色或 Thread 清空旧预览，结束后再恢复草稿预算预览。输入占用不与累计 Token 消费混用。

草稿预算预览不触发远程记忆检索，提示注明“不含待检索记忆”；发送后的逐轮统计仍包含本轮实际注入的记忆。模型配置页重新获取模型列表时清空旧候选，接口失败展示后端的真实原因；服务商成功返回空列表时提示手动填写模型名称，不显示获取成功的通知。

输入栏以单个“文件”入口选择任意类型的文件，也支持向对话区域拖入文件或粘贴文件，三种入口复用同一上传、预览和发送流程。粘贴或拖入文件后立即在本地生成 `0ms` 占位缩略预览，并以最多 3 路并发异步校验能力、建会话及上传原件；原件仍上传中时锁住发送按钮直至拿到服务端 `attachmentId`。原件上限为 100MB；支持且足够小的图片、文本沿用原生识图、转述或上下文装配，大文本、未知格式、非 UTF-8 文本及当前模型无法识别的图片只保留原件引用。Agent 获得的是服务端存储路径与 attachment 引用，不使用客户端本地路径。拖入目录只提示先压缩，嵌套输入栏不会重复上传；切换会话会撤销尚未完成批次并清理迟到的附件。录音按钮按会话设置面板中选择的语音方式（转写／原音）录制，并在开始前复核实际能力。

输入栏页脚左侧通过主设置入口打开会话设置，模式图标、当前模式与模型名称分别占据图标区和两行文字。入口复用 `InputBarFoldout` 的 Teleport、定位、材质变量与开合动画（`variant="text"`，自定义 `trigger` 与 `head-actions` 插槽）。`SessionSettingsPanel.vue` 组织面板，`SessionModelControls.vue` 读写会话模型与思考设置，会话模式、执行权限和识图／语音由 `InputBar.vue` 保存，面板向输入栏发出选择意图；上述会话设置均采用乐观先行与最新意图覆盖（Last-Write-Wins），后台持久化期间不阻塞控件连续切换或消息发送，失败时回滚至最近一次权威状态。弹层点击外部、按 Escape、外部滚动及切换 Thread 时关闭，窗口缩放时重新定位，卸载释放监听。

`SessionSlider.vue` 从同一组档位名称生成等宽标签与刻度，内部轨道连接首尾标签中心。透明的原生 `input[type=range]` 承接鼠标、触屏与键盘输入，原生手柄中心与可见刻度对齐。`input` 事件只预览，`change` 事件提交。档位文字与上方轨道刻度节点均可直接提交对应下标，取消或失焦时清理预览。模型思考的首档为“跟随”，其余档位沿用共享模型兼容规则。`SessionModelControls.vue` 提交后立即乐观更新当前档位并同步可用模型缓存，成功后对齐服务端结果，失败且无更新提交时回滚已保存值，切换 Thread 清理预览并忽略旧回执。后台刷新保留已有模型图标，解除控件禁用本身无需重新请求配置。

思考档位的图形与当前值整体作为按钮，点击按当前模型支持的顺序切换下一档，末档回到跟随，提示文字展示下一档名称。执行权限当前值同样支持循环切换，并复用 `commitExecution`，提升到自动审批或完整权限时先进入待确认状态。

`SessionSegment.vue` 用 transform 移动等宽选中条，键盘遵循 radiogroup 约定。临时保存锁维持控件原有颜色，能力不可用的具体选项单独弱化。各档说明叠在同一网格预留高度，面板预留滚动条空间，折叠区用 `grid-template-rows` 过渡。执行权限的待确认档位以虚线手柄标识，提升到自动审批或完整权限经用户确认后才交给输入栏保存。各选择器处理自己的方向键，面板关闭方向键轮转按钮。

输入栏工具行的入口统一使用 `input-tool-trigger`，由 `InputBar.vue` 与 `input-toolbar.css` 提供统一硬朗机械分仓键帽样式。会话设置、Skills 与会话工具采用左侧色块徽标仓 + 右侧标签计数的双仓键帽，指令与添加文件位于左侧工具轨末端；右侧状态区承载角色主会话的“生活经历”（`ThreadExperiences.vue`，紧贴会话心流左侧，展开右侧抽屉时自动收起输入栏弹层）、会话心流入口与像素切角晶环上下文容量指示器（默认展示顺时针占用晶环与纯百分比，悬停或聚焦展开精确现用／上限 Token 与轮次说明），紧接语音与发送主键帽；仅据点群聊在输入框上方保留房间与成员状态条。`InputBarFoldout` 浮层显式使用 Electron 的 `no-drag` 区域。紧凑布局将入口收为等宽图标键帽，完整操作名称由提示和无障碍标签提供，会话设置图标继续标示高权限状态；移动布局为同一组入口扩大点击区域，弹层内容由各组件单独管理。

会话工具视窗自动排列为已启用系统协议项、普通启用项、关闭项（含模式未开放项）。各区内按真实 `packageId` 聚合同包工具，包内按函数名排序，包与独立工具按最小函数名排序；不维护工具名称或前缀顺序表。分组来源由内置清单、扩展 Package、MCP 服务及应用注册自动提供。开关状态变化时响应式重排，搜索在排序后执行以保持相对顺序，排序不修改原始工具数组。

`ThreadSkillControls.vue` 复用 `InputBarFoldout`，在对话和工作区输入栏提供本会话 Skills 勾选、搜索及全部关闭。选择由会话接口保存，保存期间锁定发送与冲突配置操作；切换 Thread 或卸载后忽略旧请求回执。仅用户选中的技能指引进入后续上下文，极简模式暂停使用并保留选择；权限与数据契约见[会话 Skills](M02_CAPABILITY_GATE.md#32-会话-skills)。

文件写入与编辑的折叠栏显示增删行数，和展开的 Diff 共用一次预览计算。参数流按 75ms 合并，结束立即采用实际执行统计；读取引用、行范围和批量步骤均可预览，旧文不可用时删除数显示待确认，不能伪装成已写入。折叠时释放 Diff 轨道实例，后台视图停止预览解析，长文件继续窗口化渲染。

Markdown 正文行距为 1.9，段落、标题、引用和列表分别设置留白；流式分块之间显式保留同样的段落节奏，空白块不额外占位。工具轨迹与原生思考的宽度为正文的 96%，窄屏恢复完整宽度；主题继续复用现有颜色令牌。

### 8.4 性能与UX不变量

Surface 协议处理保持生成代次、帧序号与提交状态一致。工具与审批节点在恢复时沿用稳定身份。未收到 `commit/done` 的流标记为截断，保留恢复所需的原始记录。

### 8.5 工作区焦点与材料展示

工作区 Tab 必须等真实 Thread 就绪后再创建文件树与终端会话。切换 Agent 或 Thread 时清除终端引用和显式选区，同时保护未保存的编辑器缓冲。“本轮材料”只控制下一次请求，展示实际附带的文件、选区和终端。近期工具结果由统一上下文预算自动管理，不提供独立材料列表或手动材料管理入口；诊断详情可通过 Context Manifest 查看本轮采用和预算降级情况。

---

## 9. Electron 应用标签宿主

Electron 主窗口顶部使用 `DesktopTabBar`，固定首页承载原有综合面板。新标签页通过 `DesktopNewTab` 提供网址搜索、应用入口和工作区快捷入口。浏览器与独立 Web 子应用由主进程 `DesktopTabManager` 使用 `WebContentsView` 承载，前端通过 `useDesktopTabs` 投影带 Revision 的标签快照。

- 主进程持有标签、原生视图、可见性与关闭流程；前端持有新标签页输入和布局测量。
- 切换标签保留页面；关闭标签释放其 `webContents`，不停止 Arca Host 或其他后台任务。
- 用户浏览器标签不参与 Agent 临时页面的空闲回收；用户活动标签与 Agent 操作目标分别维护。
- 主题、更新中心与系统窗口控制属于外壳；应用内的重复窗口控制在嵌入模式下隐藏。
- Arca 使用受限 preload，通过草稿状态上报保护关闭流程；外部网页不加载系统 preload。
- 全局对话框可见时隐藏原生子视图，关闭对话框后恢复活动标签；尺寸由布局测量与窗口缩放共同确定。
- 浏览器部署继续使用原有综合面板，Electron 专属标签能力不引入前端 Electron 依赖。

对话容器通过 `BrowserObserver.vue` 展示 Agent 浏览器的只读旁观小窗，展示位置和尺寸全部由前端维护。组件只调用会话发现与取帧 API，不挂载网页、不传递输入或视口尺寸；收起及页面不可见时停止取帧。采集、权限、会话隔离与失效规则统一见 [部署说明：只读旁观画面](A04_DEPLOYMENT.md#只读旁观画面)。

侧栏不再包含应用分组；社交配置归入“设置”。Arca 的运行、连接和诊断界面由 Arca 自身的“设置 → 连接与运行”承载，不再注册为综合面板 Tab。Electron 从新标签页打开 Arca，浏览器部署从状态栏应用入口打开。Host 离线时仍可进入 Arca 的连接设置。

## 10. 桌宠 HUD 与主应用对话

Pet3DView 是角色的轻量交互面，不承载完整对话历史。空闲只保留菜单入口，悬停后提供“对话 / 语音 / 互动 / 更多”；触碰反应、语音状态、字幕与需要处理的事项分别展示。完整正文保留在主应用同一 Thread，通过 agentId/threadId/messageId 定位。旧统一大气泡路径已移除。

语音设置由 Electron 主进程持有，Windows 全局 PTT 支持侧键与按下/松开状态。麦克风预先准备，关闭、取消与权限迟到有明确的资源边界。TTS 只读取独立 spokenReply，缺少口语答复时不得回退正文。

## 11. 个人与外观整页草稿

`UserSettingsTab`（设置中心「个人与外观」）持有用户信息、语言、外观、健全模式、壁纸与感官动效的统一草稿；助手回复预填充与动态填充深度已拆入 `PromptManagementTab` 的「回复策略」（`PromptReplyStrategyPanel.vue`）子页维护。选择项与开关立即提交，文本编辑只修改草稿，附近的保存按钮提交整页；旧的可选自动保存开关不再控制这套固定交互。

`useSystemSettingsPage` 通过页面作用域收集各区域快照。每次点击固定当时的值，KV 配置批量写入，背景、天气及设备操作沿同一队列执行，避免请求乱序。背景材质滑块在调整结束时保存；天气文本也参与其他入口的保存，头像则在确认裁切后上传。子组件离开该页面时仍可保持各自原有行为。

未读取成功的配置不能以默认值提交。保存失败保留草稿，重试重新收集整页；后续任意保存都会按顺序继续未完成的设备或资源操作，已成功的操作不重复执行。刷新不会覆盖已有文本草稿。不同服务与设备接口并非跨端原子事务，任一部分失败时显示失败并允许重试。

### 桌面感知、权限与独立面板

主窗口按心智模型将原桌面与家拆分为三处：共享空间（置物架与地点记忆）归入 `CompanionsTab.vue`，桌宠快捷键与桌面感知归入设置中心「感知与桌宠」（`DesktopPerceptionSettingsTab.vue`，`perception_pet`），桌面操作开关、内置／追加保护名单、文件保护限额与授权记录归入设置中心「桌面权限与安全」（`DesktopSecuritySettingsTab.vue`，`desktop_security`）。状态栏感知卡片支持就地启停感知，点击设置或权限入口时由 `MainView` 直接打开设置中心 `perception_pet` 或 `desktop_security`（仅在 `desktop_home` 已摘出为独立面板时通过 `revealPerceptionSettings()` 广播定位）。

`DesktopHomeSettings.vue` 继续通过 `tabRegistry` 注册为 `desktop_home` 以承载已摘出的 Electron 独立面板窗口（`#/panel/desktop_home`），各子分区均通过 `v-if` 按需挂载，不再后台驻留隐藏实例。角色与 Thread 范围选择器由共享空间和授权记录共用。`usePerception` 在订阅期间通过同源 `BroadcastChannel` 传递分区跳转请求，使已摘出的面板也能切到感知分区，最后一个订阅者卸载时关闭通道。

桌面操作开关与停止快捷键使用 `DesktopControlSettings` 的即时保存路径，原生设备设置通过各自 IPC 提交。后端文件保护保留明确的保存与重置操作。浏览器仅呈现共享空间、授权记录和后端文件保护分区。各数据来源与权限约束见 [桌面自动化](B02_DESKTOP_AUTOMATION.md)。

## 12. 内容区宽度与紧凑工作台

主应用的 `.main-content` 是 `app-content` 内联尺寸容器。角色管理、已安装拓展与备份页的布局断点按此容器计算，不能把窗口宽度当成减去导航栏后的可用宽度；适配规则集中于 `assets/responsive-pages.css`。角色图鉴在窄内容区将角色列表改为横向条目、档案改为下方工作区，保留档案抽屉入口。

角色图鉴左栏将标题、数量与刷新组织为同一标题行，`AgentCardTransfer.vue` 提供紧凑的角色卡工具行。导入按钮、导出按钮组、数量角标、刷新与新增入口显式使用直角边框。导入按钮调用文件选择，PNG、ZIP 格式按钮直接导出当前角色，拖放与批量导入预览共用原有处理入口。未保存修改时禁用导入导出，并用同一说明行提示保存。窄内容区将工具行放在横向角色列表上方，隐藏常驻拖放说明，动作的完整名称保留在悬停提示与无障碍标签中。

工作区的 `useWorkspaceLayout` 用 ResizeObserver 读取自身宽度。可用宽度不超过 1000px 时启用局部紧凑模式，初次切入收起两侧栏；用户展开资源或协作栏时互斥显示，并提供遮罩和 Escape 关闭。该模式不更改 Electron 全局的移动布局标记，宽窗口仍保留三栏与拖动调宽。窗口宽度媒体查询不得在此模式之外将已展开侧栏暗中改成悬浮层。

启动器将未配置模型显示为警告，但允许进入应用；模型列表读取失败显示检查未完成，不当作未配置。检测逻辑与固定状态文案位于 `composables/launcher/launcherChecks.ts`，检测卡片不显示原始错误正文。

_本文档由 Carola 整理，适用于 infOS-TS 前端架构规范。_
