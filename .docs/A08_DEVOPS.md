# DevOps 与运维规范

> **版本**：0.9.6 · **更新时间**：2026-10-17
> **适用范围**：CI/CD、数据库迁移、版本发布、安全、可观测性、API 文档
> **依赖规范**：[A04_DEPLOYMENT](./A04_DEPLOYMENT.md)、[S04_TESTING_STANDARDS](./S04_TESTING_STANDARDS.md)
>
> **当前事实**：普通 CI 执行 lint、测试和全包构建；Tag Release 构建 Windows 标准版、便携版、Steam 版，并在 Docker Hub 凭据存在时构建推送前后端镜像。Dockerfile、Compose、镜像黑盒验收和多架构发布仍需按实施路线完成生产校准。

---

## 1. CI/CD 流水线

### 运行时与依赖安全门禁

普通 CI 增加阻断式安全任务：使用 `.node-version`，核对 Electron 开发 / 打包 / 锁文件及 Docker Node 基线，并执行官方依赖审计。本地回补必须核验精确补丁、锁文件和回归测试，原始报告单独保留。Release 在业务构建前探测 Electron 实际内嵌 Node；原生重编译读取同一 Electron 声明，打包前再次检查，打包后在现有 afterPack 链路检查实际 EXE 副本。详见 [运行时与依赖安全基线](./B27_RUNTIME_SECURITY.md)。

当前 Electron 44.9.3 仍标注内嵌 Node 24.22.0，尚不满足 24.22.1 安全基线，桌面 Release 应被门禁拒绝，不能据此宣称已具备安全发包条件。

### 1.1 工具选型

GitHub Actions，与项目 GitHub 仓库原生集成。

### 1.2 流水线设计

```yaml
# .github/workflows/ci.yml 骨架
name: CI

on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint # ESLint + Prettier 检查

  test:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:run # Vitest 全量测试，只执行一次

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm build # 全包构建验证

  # 可选：Electron 打包（仅 main/release 分支）
  electron-build:
    if: github.ref == 'refs/heads/main'
    runs-on: windows-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm electron:build
      - uses: actions/upload-artifact@v4
        with:
          name: electron-dist
          path: dist_electron/
```

### 1.3 分支策略

CI/CD 不设覆盖率百分比门禁，也不自动上传 Codecov。需要定位遗漏时可手动运行 `pnpm test:coverage`，报告不设最低比例。

| 分支        | 用途     | CI 触发                             |
| ----------- | -------- | ----------------------------------- |
| `main`      | 稳定版本 | lint → test → build → Electron 打包 |
| `dev`       | 开发主线 | lint → test → build                 |
| `feature/*` | 功能分支 | PR 时触发 lint + test               |
| `release/*` | 发布准备 | 全量 CI + Steam 构建                |

### 1.4 Electron 启动环境

Electron 启动环境必须在派生进程前清理继承的 `NODE_OPTIONS`，不能等主进程初始化后再处理。开发入口同时移除继承的 `ELECTRON_RUN_AS_NODE`；发行版 Daemon、Application Host 与打包烟雾测试只显式设置 `ELECTRON_RUN_AS_NODE=1`。普通 Node 开发后台、终端任务和 `NODE_EXTRA_CA_CERTS` 不受该清理影响。

---

## 2. 数据库迁移策略

### 2.1 SQLite 迁移 — Drizzle Kit

```bash
# 生成迁移文件
pnpm drizzle-kit generate

# 执行迁移（兼容既有单基线库）
pnpm --filter @infos/backend db:migrate

# 推送 schema 变更（开发阶段快捷方式）
pnpm drizzle-kit push
```

### 2.2 迁移文件管理

```
packages/backend/src/database/
  ├── schema.ts              ← Drizzle schema 定义（唯一真理源）
  ├── migrations/             ← 按 journal 顺序执行的 Drizzle SQL 与快照
  │   ├── 0000_baseline.sql
  │   ├── 0001_remove_work_context.sql
  │   └── meta/
  └── schemaMigrations.ts    ← 旧单基线库登记薄层；实际迁移交给 Drizzle
```

### 2.3 迁移原则

- **向前兼容**：新增列给默认值，不删除现有列（可标记 deprecated）
- **不可逆操作需确认**：删表、改列类型等操作需要人工审批
- **每次 PR 最多一个迁移文件**：避免迁移冲突
- **TriviumDB 升级需保护完整文件组**：当前固定 0.8.11，与 0.8.9 使用相同的主文件格式 v9；本次不要求数据迁移、重算 Embedding 或重建 QuIVer。已有 QuIVer 若要应用 0.8.10 的新构图策略，可通过既有索引重建流程生成；本次不自动触发全库重建。首次可写打开 v5–v8 库前，注册表持有共享读锁并保留完整、带 SHA-256 清单的副本；有待恢复 WAL 时停止旧格式迁移，先正常恢复并退出。不要只备份 `.tdb` 主文件。

新升级备份位于 `@data/.store-upgrades/0.8.11/<原数据库相对路径>/<文件组摘要>/`，不参与分布式同步。0.8.9 等旧版本备份继续保留并纳入角色发现、重建、清空和永久删除的定向清理，防止已遗忘正文被恢复。回退版本前必须停止应用，并从同一备份目录恢复整组文件；主文件格式相同不代表可以忽略新版发布中断现场。社交图谱不能作为可丢弃向量缓存处理。

0.8.10 起的 Mmap 发布恢复增加 `.tdb.publish`、`.tdb.publish.0/1/2` 及其 `.tmp` 文件。受管文件识别、备份与重建清理包含这些文件；不要自行删除尚未恢复的日志或旧代备份。可写句柄由引擎恢复未提交发布；只读检查遇到待恢复状态时返回错误，不能用半发布文件创建同步快照。快照发现也检查仅有旁路文件的库，避免主文件暂缺时静默漏掉恢复现场。

分布式导出使用 bundle v2，记录引擎版本及格式版本；接收端仍接受旧 bundle v1，拒绝未来格式。导出时暂停引擎自动压实、同步刷新并冻结 SQLite 和数据库文件组，之后从独立暂存目录打包；不能异步遍历正在变化的 `.tdb.pld.<generation>`。旧版 infOS 不接受新 bundle，双端应一起升级。

现有 SQLite 库早期由启动器直接执行 `0000_baseline`，没有 Drizzle 迁移记录。启动时的薄层只为这类库登记已完成的基线；新旧库后续都由 Drizzle migrator 按 `_journal.json` 执行。`0001_remove_work_context` 删除旧工作正文列与逐轮表，保留目标与私有事实；`0003_remove_tool_observations` 删除退役的工具摘录表。近期工具正文改为进程内短期缓存，来源随原对话元数据保存。旧摘录不迁入长期历史，新迁移不修改对话消息。

---

## 3. 版本发布策略

### 3.1 版本号规范

采用 **SemVer**（语义化版本）：`MAJOR.MINOR.PATCH`

| 类型   | 含义                        | 示例            |
| ------ | --------------------------- | --------------- |
| MAJOR  | 不兼容的 API / 数据格式变更 | `2.0.0`         |
| MINOR  | 新功能（向后兼容）          | `1.1.0`         |
| PATCH  | Bug 修复                    | `1.0.1`         |
| 预发布 | Alpha / Beta / RC           | `1.0.0-alpha.1` |

所有子包版本号通过 `pnpm version:sync` 统一同步。

### 3.2 Changelog 自动生成

使用 **changesets** 管理版本和变更日志：

```bash
# 开发者在 PR 中添加变更描述
pnpm changeset

# 发布时自动生成 CHANGELOG.md + 更新版本号
pnpm changeset version
pnpm changeset publish
```

### 3.3 发布渠道

| 渠道           | 触发条件                               | 产物                                  |
| -------------- | -------------------------------------- | ------------------------------------- |
| GitHub Release | 推送版本 Tag                           | `.exe` 安装包 + 便携版 + 发布说明     |
| Steam          | Tag Release 构建，SteamPipe 另行发布   | Depot 构建产物                        |
| Docker Hub     | 推送版本 Tag 且配置 Registry 凭据      | Backend/Frontend 版本镜像             |

---

## 4. 安全规范

### 4.1 输入验证

后端已通过 Hono + Zod 在 Router 层做 schema 验证：

```typescript
// 所有用户输入使用项目级validate()包装器
app.post('/api/chat', validate('json', chatSchema), handler)
```

**补充要点**：

- **校验信封**：Zod失败统一返回HTTP 400、`VALIDATION_ERROR`和`data.fields`，Router只能使用项目级`validate()`包装器
- **响应契约**：业务码必须注册；HTTP 201绑定`CREATED`，HTTP 202绑定`ACCEPTED`
- **路径遍历防护**：PathResolver 的 `resolve()` 必须检查解析后的路径不超出 roots 边界
- **SQL 注入**：Drizzle ORM 的参数化查询天然防注入
- **XSS**：Vue 的模板自动转义 + CSP 头（Electron 版由 `webPreferences` 控制）

### 4.2 依赖安全

```bash
# 定期检查依赖漏洞
pnpm audit

# GitHub Dependabot 自动创建漏洞修复 PR
# 配置 .github/dependabot.yml
```

### 4.3 敏感信息管理

| 信息类型      | 存储位置                | 注意事项                       |
| ------------- | ----------------------- | ------------------------------ |
| LLM API Key   | `config.json`（@data/） | 不提交 Git；进入手动完整同步包时必须使用同步会话密钥加密，并由目标 Server 主密钥重新封装 |
| Gateway Token | `gateway_token.json`    | 机器身份凭据，不进入同步包；目标 Server 保留自己的 Token |
| Steam App ID  | 代码硬编码 `4457100`    | 公开信息，无需保护             |

---

## 5. 可观测性

### 5.1 日志（已有）

见 [S03_LOGGING_SPEC](./S03_LOGGING_SPEC.md)，使用 consola，日志消息中文。

### 5.2 健康检查

```typescript
// 后端健康检查端点
app.get('/health', (c) => c.json({
  code: 'OK',
  data: {
    status: 'ok',
    uptime: process.uptime(),
    version: APP_VERSION,
    memory: process.memoryUsage(),
  }
}))

// Docker Compose 健康检查
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:9120/api/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

### 5.3 APM / 分布式追踪（可选）

Docker 版可接入 OpenTelemetry：

```typescript
// 仅 Docker 版启用，Electron 版跳过
if (isDocker && process.env.OTEL_ENDPOINT) {
  initOpenTelemetry({
    serviceName: 'infos-backend',
    endpoint: process.env.OTEL_ENDPOINT,
  })
}
```

**当前不需要实现**，infOS 是单用户应用，日志 + 健康检查已足够。

---

### 5.4 Execution与系统性能预算

架构变更必须同时记录正确性、安全性与性能结果，至少覆盖：

- 用户提交到接收确认、首Token与首Surface延迟；
- 流式帧率、最长主线程阻塞和长消息DOM变更量；
- 对话首屏消息数、历史分页响应时间、已挂载消息组件数与占位高度误差；
- Markdown缓存命中率、富文本解析P95、重型Surface挂载数和Renderer内存；
- 每个Execution的内存、Token、LLM、工具与并发I/O用量；
- 前台任务受后台负载影响的P95延迟；
- Provider超时、取消、stale-handle和重复消息比率；
- 重启后Task、Surface、Outbox与Checkpoint恢复成功率；
- 数据迁移、WAL checkpoint、备份与回滚成功率。

Scheduler必须保证交互优先、同Agent与跨Agent公平、模型与Provider并发预算、Backpressure、Deadline、暂停恢复和饥饿保护。后台状态必须向用户解释WaitReason、资源占用与取消结果。

---

## 6. API 文档

### 6.1 方案

使用 Hono 的 **OpenAPI** 插件 + **Scalar** 可视化：

```typescript
import { swaggerUI } from '@hono/swagger-ui'
import { OpenAPIHono } from '@hono/zod-openapi'

const app = new OpenAPIHono()

// Zod schema 同时用于验证和文档生成
app.openapi(chatRoute, handler)

// 挂载 Scalar UI
app.get('/docs', swaggerUI({ url: '/openapi.json' }))
```

### 6.2 优势

- **Zod schema 复用**：验证逻辑和文档描述是同一份代码，保证一致性
- **零额外维护**：不需要手写 Swagger YAML
- **内置 Playground**：Scalar 自带请求测试功能

---

## 7. 安全与验证基线

### 7.1 信任层级

```text
Kernel Core
> Built-in System Service
> Signed/Official Application
> User-installed Application
> External MCP/Provider
> Model-generated Code / Web Content
```

不同层级必须拥有不同默认Capability、隔离和审批要求。Markdown不执行脚本；Programmable Surface、Web Application和Document Island必须使用独立沙箱，不能共享主前端全局对象。截图、剪贴板、Cookie、网络拦截与原生输入属于高风险能力。Audit记录能力决策与副作用，不默认记录敏感明文；Snapshot进入模型前必须脱敏，Capability Handle不得进入Prompt或普通日志。

### 7.2 强制验证矩阵

- **协议契约**：Shared序列化、版本协商、Correlation/Causation、Generation、Cancellation、Deadline与Capability不可扩权；
- **状态机**：Execution、Task、Application、Surface与Capability的非法跃迁、重复请求和崩溃恢复；
- **故障注入**：SSE断开、Provider掉线、Tool超时、Approval跨重启、SQLite提交后Surface未送达、TDB flush中断、Application崩溃、Kernel短时断线、主Agent Execution取消、旧Generation与重复Idempotency Key；
- **性能回归**：Surface、Scheduler和IPC变更必须与基线比较，不接受只验证功能正确。

第三方 Application Adapter 还必须验证配对与身份冒充、协议降级、应用版本不兼容、Capability过期/撤销、任务重复提交、断线重连、Adapter崩溃重启和主Agent取消后的任务独立性。默认测试环境使用Mock Kernel，不允许生态贡献者测试依赖真实用户Credential或私有数据。

### 7.3 数据与兼容策略

领域表与TriviumDB继续持有业务权威；同一事务写入Outbox并异步产生Durable Event，不采用全面事件溯源。迁移使用Strangler Adapter，兼容层必须注明移除条件，禁止无限期双写与双协议。用户能力和持久数据优先兼容，内部重复协议在迁移完成后应果断删除。

---

## 8. 里程碑对照表

| 里程碑           | 需落地的运维项                       |
| ---------------- | ------------------------------------ |
| 首个模块开发完成 | CI/CD 流水线（§1）                   |
| 数据库模块开发   | Drizzle 迁移配置（§2）               |
| 后端 Hono 搭建   | 健康检查（§5.2）、Dependabot（§4.2） |
| 首批 Router 完成 | API 文档生成（§6）                   |
| 首个 Alpha 发布  | 版本策略 + Changelog（§3）           |
| Docker 版上线    | APM 评估（§5.3）                     |

---

_本文档由 Carola 整理，适用于 infOS 运维与 DevOps 规范。_
