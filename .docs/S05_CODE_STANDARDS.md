# 代码质量标准

> **适用范围**：infOS-TS 全项目
> **最后更新**：2026-10-17

---

## 1. 文件大小参考上限

> 柔性指导，不是硬限。超过时应考虑拆分，但逻辑内聚性强时允许适当超出。

| 类型                       | 参考行数    | 超过后建议拆分           |
| -------------------------- | ----------- | ------------------------ |
| Vue SFC (`.vue`)           | **~400 行** | 提取 composable / 子组件 |
| TypeScript Service (`.ts`) | **~500 行** | 按职责拆分为多个文件     |
| Electron 主进程模块        | **~300 行** | 按功能域拆分文件         |
| Router 文件                | **~300 行** | 按子资源拆分             |
| Repository 文件            | **~400 行** | 按操作类型拆分           |

---

## 2. 三层架构约束

```
Router 层  →  仅负责：接收请求 → Zod 校验 → 调用 Service → 包装响应
Service 层 →  仅负责：业务逻辑编排 → 调用 Repository → 调用外部服务
Repository 层 →  仅负责：数据访问（SQLite / TriviumDB）
```

### 禁止事项

| 层                  | 禁止行为                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| Router              | 直接操作 DB/Repository/文件系统、包含跨资源业务编排、catch 后吞错误                                 |
| Service             | import Hono Context、直接构造 HTTP 响应                                                             |
| Repository          | 包含业务逻辑、直接返回 HTTP 响应                                                                    |
| Gateway             | 承担领域业务编排；持久通知通过注入的 Repository 接入                                                |
| Shared Package      | 保存具体Application Manifest、单一产品实现、UI专用生成器、Backend Service/Repository或领域策略常量   |
| Application Package | 深路径导入 Backend 内部 Service/Repository/Logger；只能使用 Shared Port 与公开 Application Host ABI |

---

## 3. 路径规范

**路径永远不能硬编码**。必须通过环境变量 / 配置 / 运行时工厂获取。

```typescript
// ❌ 禁止
const dbPath = 'C:\\Users\\pero\\data\\infos.db'

// ✅ 正确
const dbPath = env.PERO_DATABASE_PATH ?? path.join(getDataDir(), 'infos.db')
```

路径操作必须使用 `node:path`（`path.join`, `path.resolve`），不手动拼接分隔符。

---

## 4. 响应式数据策略 (Vue)

| 场景                                 | 用           | 禁止用                    |
| ------------------------------------ | ------------ | ------------------------- |
| 大型数组（memories, logs, messages） | `shallowRef` | `ref`（深度响应性能灾难） |
| Three.js 对象                        | `shallowRef` | `ref`                     |
| 简单标量                             | `ref`        | —                         |
| 跨组件共享状态                       | Pinia Store  | —                         |
| 组件内部 UI 逻辑                     | Composable   | Pinia Store               |

---

## 5. Pinia Store vs Composable 边界

| 场景                        | Pinia Store | Composable |
| --------------------------- | ----------- | ---------- |
| 跨组件/跨页面共享的全局状态 | ✅          |            |
| 需要 DevTools 调试的状态    | ✅          |            |
| 组件内部的 UI 状态          |             | ✅         |
| 表单逻辑、输入处理          |             | ✅         |
| 生命周期绑定的逻辑          |             | ✅         |
| 可复用的无状态逻辑          |             | ✅         |

**命名**：Store → `useXxxStore.ts` (放 `stores/`)，Composable → `useXxx.ts` (放 `composables/{domain}/`)

---

## 6. 前端性能核心要求

| 优先级 | 要求                                                                       |
| ------ | -------------------------------------------------------------------------- |
| **P0** | `<keep-alive>` 白名单控制（顶层缓存 MainView，主界面 Tab 范围见 A03）       |
| **P0** | 使用 `useEventListener` / `useInterval` composable 管理事件/定时器生命周期 |
| **P0** | SSE 流式 Markdown 采用"稳定区/尾部区"分段渲染 + 30fps 帧率限制             |
| **P0** | IntersectionObserver 暂停不可见消息的动画/媒体                             |
| **P1** | 历史消息分页与视口窗口化，保留滚动锚点，详见 A03                            |
| **P1** | Tab 组件 `defineAsyncComponent` 异步加载                                   |
| **P1** | Vite `manualChunks` 分包                                                   |

---

## 7. 依赖管理

- `shared` 不依赖 `backend` / `frontend` / `electron`
- `backend` 不依赖 `frontend` / `electron`
- `frontend` 不依赖 `backend` / `electron`
- `electron` 仅在主进程中可依赖其他包
- **`backend` / `frontend` / `shared` 保持 0 个 Electron 依赖**
- 跨 Package 导入必须使用包名与公开入口，禁止`../../../other-package/src/...`深路径导入
- 模块级 Service Locator 只允许遗留Tool兼容边界；必须提供`clear/dispose`并绑定`LifecycleScope`，Router不得使用

---

_本文档由 Carola 整理，适用于 infOS-TS 代码质量标准。_
