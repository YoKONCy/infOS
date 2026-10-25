# 前端架构与性能优化

> **适用范围**：`packages/frontend/` 全部代码
> **技术栈**：Vue 3 + Vite + Pinia + TailwindCSS 4 + logic composables
> **最后更新**：2026-10-17

---

## 1. 核心架构

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

- **Electron 模式**：通过 `window.electron` 调用主进程 IPC
- **Browser 模式**：通过 `fetch/WebSocket` 调用后端 API

所有 API 调用统一封装在 `api/` 目录下，并根据环境自动切换实现。

---

## 3. 性能优化 (P0 级别)

> 本规范基于 infOS 现有渲染审计和流式性能优化经验。

### 3.1 `<keep-alive>` 白名单

- **原则**：只缓存切换频繁且初始化开销大的页面。
- **Electron 白名单**：`['DashboardView']`
- **Browser/Docker 例外**：`WebShellView` 作为 Web 容器入口承载浏览器模式的长生命周期 Shell 状态，顶层允许在 Browser/Docker 模式缓存 `['WebShellView']`。
- **必须销毁**：`Pet3DView` (释放 WebGL)、`LauncherView` (停止下载计时器)、`ChatInterface` (断开 SSE)

### 3.2 响应式性能

- **禁止深度响应**：对大型数组（消息列表、记忆列表、日志、任务）和物理引擎对象（Three.js）必须使用 `shallowRef` 或 `markRaw`。
- **避免多余 watch**：禁止在 `useStreamMarkdown` 等高产出逻辑中使用冗余的深度监听。

### 3.3 流式增量渲染 (30fps)

针对 SSE 流式 Markdown 消息，采用 **"稳定区/尾部区"** 分段架构：

1. **稳定区 (Stable)**：已完全闭合的代码块或段落，只在边界推进时渲染一次，渲染后变为静态 DOM。
2. **尾部区 (Tail)**：正在追加的文本，使用轻量级流水线渲染。
3. **调度**：使用 `useThrottleFn` 限制渲染频率为 33ms (30fps)，避免 token 级频繁重渲。

### 3.4 对话历史分页与动态窗口化

对话页不得一次加载并挂载整个 Thread，也不得依赖固定 200 条 Projection 上限掩盖 DOM 增长。采用以下组合策略：

- 首次只请求最新 60 条消息；滚动到顶部时按游标继续加载更早历史，并保持当前滚动锚点。
- Renderer 仅挂载视口附近的消息分段；远端分段使用实测高度占位，`ResizeObserver` 持续修正动态高度。
- 流式消息、当前播放消息和交互 Surface 必须保持真实 DOM，不得被窗口化卸载。
- 已提交 Markdown 以源码为键使用有界 LRU 缓存；消息与 Surface 按 `messageId + revision` 保持对象身份。
- 不可见时暂停动画、Video、Audio、Canvas，并卸载 iframe、Mermaid 与 Programmable Surface 等重型运行时；恢复时使用缓存高度避免滚动跳变。
- Mermaid、KaTeX 等重型渲染依赖按首次实际使用动态加载。

IntersectionObserver 负责可见性和重型节点生命周期，动态消息窗口负责控制 Vue 组件与普通 Markdown DOM 数量；两者职责不可混淆。

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

### 4.2 路由分包

使用 `defineAsyncComponent` 实现路由级代码分割：

```typescript
const DashboardView = () => import('@/views/DashboardView.vue')
const Pet3DView = () => import('@/views/Pet3DView.vue') // 3D 组件必须异步加载
```

---

## 5. 3D 与动画规范 (Three.js)

- **资源管理**：所有 Texture/Geometry 必须在 `onUnmounted` 中手动 dispose。
- **降级处理**：低功耗设备模式下（由 backend 探测），禁用 Bloom、SAO 等昂贵 Shader。
- **离屏渲染**：主 UI 操作时，降低 3D 渲染帧率。

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

核心节点包括`text`、`markdown`、`code`、`tool-call`、`tool-result`、`status`、`approval`、`progress`、`image`、`chart`、`document`与`app`。节点必须具有稳定`nodeId`和递增`revision`。

协议操作固定为：

```text
create_surface
attach_node
patch_node
replace_range
commit_surface
freeze_surface
resume_surface
destroy_surface
```

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

Conversation Projection 必须支持游标窗口，Snapshot 只返回请求窗口内的消息与对应 Surface，并携带`hasMoreBefore/beforeCursor`。前端追加历史时按`messageId + revision`复用已有对象，不得整体替换未变化的消息树；实时 Frame 只更新目标 Surface。工具结果必须按`callId`建立索引，禁止模板渲染阶段反复线性扫描 Surface Node。

输入栏 Token 计数在 ReAct 中读取当前 Thread 与 Principal 的活动 Surface 状态，逐轮更新，并区分请求估算与上游实测。生成期间停止下一轮预算预览请求，防止旧 HTTP 响应覆盖实时统计；切换角色或 Thread 清空旧预览，结束后再恢复草稿预算预览。输入占用不与累计 Token 消费混用。

草稿预算预览不触发远程记忆检索，提示注明“不含待检索记忆”；发送后的逐轮统计仍包含本轮实际注入的记忆。模型配置页重新获取模型列表时清空旧候选，接口失败展示后端的真实原因；服务商成功返回空列表时提示手动填写模型名称，不显示获取成功的通知。

输入栏以单个“文件”入口选择任意类型的文件，也支持向对话区域拖入文件或粘贴文件，三种入口复用同一上传、预览和发送流程。原件上限为 100MB；支持且足够小的图片、文本沿用原生识图、转述或上下文装配，大文本、未知格式、非 UTF-8 文本及当前模型无法识别的图片只保留原件引用。Agent 获得的是服务端存储路径与 attachment 引用，不使用客户端本地路径。拖入目录只提示先压缩，嵌套输入栏不会重复上传；切换会话会撤销尚未完成批次并清理迟到的附件。“语音”按钮仍分别进入语音转写和原生音频提示占位，原生音频不启动录音或上传。选择器弹层 Teleport 到 body，点击外部、Escape、滚动、窗口缩放及切换 Thread 时关闭；卸载释放监听。

会话工具视窗自动排列为已启用系统协议项、普通启用项、关闭项（含模式未开放项）。各区内按真实 `packageId` 聚合同包工具，包内按函数名排序，包与独立工具按最小函数名排序；不维护工具名称或前缀顺序表。分组来源由内置清单、扩展 Package、MCP 服务及应用注册自动提供。开关状态变化时响应式重排，搜索在排序后执行以保持相对顺序，排序不修改原始工具数组。

文件写入与编辑的折叠栏显示增删行数，和展开的 Diff 共用一次预览计算。参数流按 75ms 合并，结束立即采用实际执行统计；读取引用、行范围和批量步骤均可预览，旧文不可用时删除数显示待确认，不能伪装成已写入。折叠时释放 Diff 轨道实例，后台视图停止预览解析，长文件继续窗口化渲染。

Markdown 正文行距为 1.9，段落、标题、引用和列表分别设置留白；流式分块之间显式保留同样的段落节奏，空白块不额外占位。工具轨迹与原生思考的宽度为正文的 96%，窄屏恢复完整宽度；主题继续复用现有颜色令牌。

### 8.4 性能与UX不变量

必须监测首Surface时间、流式帧率、最长主线程阻塞、长消息DOM变更量、不可见Surface CPU/GPU占用和重连恢复成功率。工具卡、审批卡和复杂节点在流式过程中不得闪烁或丢失展开状态；未收到`commit/done`的流必须标记为截断，不能伪装成功。

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

侧栏不再包含应用分组；社交配置归入“设置”。Arca 的运行、连接和诊断界面由 Arca 自身的“设置 → 连接与运行”承载，不再注册为综合面板 Tab。Electron 从新标签页打开 Arca，浏览器部署从状态栏应用入口打开。Host 离线时仍可进入 Arca 的连接设置。

## 10. 桌宠 HUD 与主应用对话

Pet3DView 是角色的轻量交互面，不承载完整对话历史。空闲只保留菜单入口，悬停后提供“对话 / 语音 / 互动 / 更多”；触碰反应、语音状态、字幕与需要处理的事项分别展示。完整正文保留在主应用同一 Thread，通过 agentId/threadId/messageId 定位。旧统一大气泡路径已移除。

语音设置由 Electron 主进程持有，Windows 全局 PTT 支持侧键与按下/松开状态。麦克风预先准备，关闭、取消与权限迟到有明确的资源边界。TTS 只读取独立 spokenReply，缺少口语答复时不得回退正文。

## 11. 系统设定整页草稿

`UserSettingsTab` 持有用户信息、语言、外观、健全模式和预填充的统一草稿。选择项与开关立即提交，文本编辑只修改草稿，附近的保存按钮提交整页；旧的可选自动保存开关不再控制这套固定交互。

`useSystemSettingsPage` 通过页面作用域收集各区域快照。每次点击固定当时的值，KV 配置批量写入，背景、天气及设备操作沿同一队列执行，避免请求乱序。背景材质滑块在调整结束时保存；天气文本也参与其他入口的保存，头像则在确认裁切后上传。子组件离开该页面时仍可保持各自原有行为。

未读取成功的配置不能以默认值提交。保存失败保留草稿，重试重新收集整页；后续任意保存都会按顺序继续未完成的设备或资源操作，已成功的操作不重复执行。刷新不会覆盖已有文本草稿。不同服务与设备接口并非跨端原子事务，任一部分失败时显示失败并允许重试。

_本文档由 Carola 整理，适用于 infOS-TS 前端架构规范。_
