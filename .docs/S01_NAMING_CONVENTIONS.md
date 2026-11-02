# 命名与注释规范

> **适用范围**：infOS-TS 全项目
> **最后更新**：2026-10-17

---

## 1. 文件命名

| 类型             | 规则                           | 示例                                             |
| ---------------- | ------------------------------ | ------------------------------------------------ |
| TypeScript 文件  | **camelCase**                  | `eventMemoryService.ts`, `llmJsonParser.ts`       |
| Vue 单文件组件   | **PascalCase**                 | `ChatInterface.vue`, `MessageItem.vue`           |
| 测试文件         | `<模块名>.test.ts`             | `memoryService.test.ts`                          |
| 集成测试         | `<场景名>.integration.test.ts` | `memoryPipeline.integration.test.ts`             |
| 常量/枚举文件    | camelCase                      | `responseCodes.ts`, `memoryTypes.ts`             |
| 类型定义文件     | camelCase + `.types.ts`        | `api.types.ts`, `memory.types.ts`                |
| 平台特有实现     | 后缀命名                       | `activeWindow.win32.ts`, `activeWindow.linux.ts` |
| 配置文件         | 各工具标准                     | `tsconfig.json`, `electron-builder.base.yml`     |

---

## 2. 代码命名

### 2.1 TypeScript

| 类型               | 规则                 | 示例                                                   |
| ------------------ | -------------------- | ------------------------------------------------------ |
| 变量、函数         | **camelCase**        | `const pageSize`, `function getMemories()`             |
| 类、接口、类型别名 | **PascalCase**       | `class MemoryService`, `interface AppContext`          |
| 枚举名             | **PascalCase**       | `enum MemorySource`                                    |
| 枚举值             | **snake_case 小写**  | `MemorySource.desktop`, `MemorySource.group_chat`      |
| 常量               | **UPPER_SNAKE_CASE** | `const MAX_PAGE_SIZE = 100`                            |
| 泛型参数           | **单字母大写**       | `<T>`, `<K, V>`                                        |
| 布尔变量           | `is/has/should` 前缀 | `isElectron`, `hasPermission`                          |
| 私有属性           | 无下划线前缀         | `private db: DrizzleDb`（TypeScript `private` 已标识） |

### 2.2 Vue 组件

| 类型        | 规则                 | 示例                                |
| ----------- | -------------------- | ----------------------------------- |
| 组件文件名  | PascalCase           | `MessageItem.vue`                   |
| 模板中使用  | PascalCase           | `<MessageItem />`                   |
| Pinia Store | `use + 名词 + Store` | `useAgentStore`, `useConfigStore`   |
| Composable  | `use + 动词/名词`    | `useChatScroll`, `useEventListener` |
| 事件名      | **kebab-case**       | `@update-config`, `@agent-switch`   |
| CSS 类名    | **kebab-case**       | `.message-item`, `.chat-input-bar`  |
| Prop        | **camelCase**        | `:modelConfig="config"`             |

### 2.3 后端路由

| 类型       | 规则                | 示例                                  |
| ---------- | ------------------- | ------------------------------------- |
| URL 路径   | **kebab-case 复数** | `/api/memories`, `/api/model-configs` |
| URL 参数   | **camelCase**       | `?pageSize=20&agentId=pero`           |
| 请求体字段 | **camelCase**       | `{ "memoryContent": "..." }`          |
| 响应体字段 | **camelCase**       | `{ "hasMore": true }`                 |

### 2.4 数据库

| 类型         | 规则                | 示例                                          |
| ------------ | ------------------- | --------------------------------------------- |
| 表名         | **snake_case 复数** | `memory_nodes`, `conversation_logs`           |
| 列名         | **snake_case**      | `agent_id`, `created_at`, `is_deleted`        |
| 索引名       | `idx_<表>_<列>`     | `idx_memories_agent_id`                       |
| Drizzle 变量 | **camelCase**       | `export const taskPlans = sqliteTable(...)` |

### 2.5 API 业务状态码

| 约束                      | 说明                                               |
| ------------------------- | -------------------------------------------------- |
| 命名格式                  | **UPPER_SNAKE_CASE**                               |
| 只允许使用规范表中的 code | 新增必须更新 `API_SPEC.md`                         |
| 示例                      | `OK`, `NOT_FOUND`, `LLM_ERROR`, `VALIDATION_ERROR` |

---

## 3. 注释规范

### 3.1 语言要求

- **所有代码注释必须使用中文**（函数名、专业术语等本就是英文的除外）
- **日志消息通过对应运行端的 i18n 入口获取**，中文作为词条原文，结构化数据字段用英文 key；动态值使用占位符。维护规则见 [国际化说明](./B25_I18N.md)。
- 变量名、函数名、类名使用英文

```typescript
// ✅ 正确
/** 记录 Agent 后台补记状态 */
logger.info(t('logs.memory', 'Agent 八小时补记周期已完成'), { agentId })

// ❌ 错误
/** Log completed memory maintenance */
logger.info('Memory maintenance completed', { agentId })
```

### 3.2 注释风格

#### 文件头注释（仅在文件职责不明显时使用）

```typescript
/**
 * 向量写入助手 — 封装"写入-失败-补偿"模式，消除重复代码。
 * 所有 TriviumDB 写入操作应通过此 Helper 执行。
 */
```

#### 函数注释（JSDoc）

```typescript
/** 生成向量并写入 TriviumDB，失败自动入补偿队列 */
async upsertWithFallback(opts: UpsertOptions): Promise<void>

/**
 * 执行记忆维护全流程。
 *
 * @param agentId - 目标 Agent
 * @param options - 维护选项（可选跳过某些步骤）
 * @returns 维护报告
 */
async runMaintenance(agentId: string, options?: MaintenanceOptions): Promise<Report>
```

#### 行内注释

```typescript
// 按优先级从低到高扫描（后扫覆盖先扫）
await this.scanDir(appDir, 'official')

const enriched = tags
  ? `${tags} ${tags} ${content}` // 标签重复两次以增加权重
  : content
```

### 3.3 平台特有代码标注

使用 `@platform` 标签标注平台特有代码：

```typescript
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// @platform WINDOWS — 使用 Win32 API 获取活动窗口标题
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

| 标签                 | 含义            |
| -------------------- | --------------- |
| `@platform WINDOWS`  | Windows 专有    |
| `@platform LINUX`    | Linux 专有      |
| `@platform DARWIN`   | macOS 专有      |
| `@platform ELECTRON` | Electron 专有   |
| `@platform DOCKER`   | Docker/容器专有 |

---

## 4. 目录与导出

### 4.1 桶导出 (Barrel Export)

每个功能模块目录提供 `index.ts` 桶导出：

```typescript
// services/memory/index.ts
export { EventMemoryService } from './eventMemoryService'
export { EventReflectionService } from './eventReflectionService'
export { DailyNotesService } from './dailyNotesService'
```

### 4.2 导入排序

按以下分组排列，组间空行分隔：

```typescript
// 1. Node.js 内置模块
import path from 'node:path'
import fs from 'node:fs'

// 2. 第三方依赖
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

// 3. Workspace 内部包
import type { ApiResponse } from '@infos/shared'

// 4. 项目内部模块（相对路径）
import { EventNoteRepository } from '../repositories/eventNote.repo'
import { parseLlmJson } from '../shared/llmJsonParser'
```

---

_本文档由 Carola 整理，适用于 infOS-TS 全项目命名规范。_
