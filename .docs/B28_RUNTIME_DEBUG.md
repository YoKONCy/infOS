# 统一运行时调试

运行时调试面向 Agent 排查 infOS 的当前运行现场、开发与检查修正候选。Agent 不再热加载贡献；正式应用、重载、回退由用户管理入口发起。插件导出是可选的交付方式。

## 入口和权限

- 输入栏提供独立的「调试」按钮，默认关闭，仅普通桌面工作会话可开启，作用域为 `Thread + Agent`。
- 唯一内置 FC 工具为 `runtime_debug`，参数是可选 `code`、`timeoutMs`。没有按检查、加载、恢复拆出多个 FC 工具，也没有固定 action 枚举。
- 不传 `code` 读取现场与 SDK 契约。执行代码沿用 CapabilityGate、Thread 当前模式、禁用工具及已有审批链；普通自动执行不能跳过 Node 脚本审批，自动审批调用已有审批员，全权限模式沿用现有执行授权。
- tools 字段仅提供稳定的调试入口和调用约定；应用目录、数据目录、日志目录、Agent 工作区和独立调试工作区由空参数调用的结果返回。运行现场属于动态数据，不再反复追加到工具定义中，也不写入角色人设。工具说明提供者从注册原件生成副本，同一轮 ReAct 菜单不变时复用结果，防止说明随调用次数增长或跨 Thread 混用。
- Realm、后台任务、群聊、ambient、follow-up 均不能使用该入口。切离工作模式、清除该会话或后端退出时关闭调试执行入口；独立资源候选与备份继续保留。

## 调试 SDK

`code` 是支持 `await` / `return` 的 JavaScript；通过 `debug` 访问宿主提供的接口，通过 `require('node:...')` 使用 Node 内置模块。Agent 应先读取现场，再根据实际信息决定操作。

| 接口 | 行为 |
| --- | --- |
| `debug.inspect()` | 版本、Node 运行版本、PID、任务/执行摘要、扩展故障、实际路径、SDK 和恢复记录 |
| `debug.files.list/read/write` | 在当前调试工作区读写文件；拒绝越界与符号链接，文件大小和工作区数量有界 |
| `debug.read('@app/…')` | 读取应用文本；另支持 `@data`、`@logs`、`@debug`，最多返回末尾 64000 字符；拒绝数据库及二进制运行文件 |
| `debug.logs()` | 最近最多 5 个日志文件，每个返回末尾 16000 字符 |
| `debug.check()` | JavaScript / TypeScript 语法检查、文件摘要、诊断；不是完整类型检查或测试套件 |
| `debug.resources.list()` | 查看用户资源版本与待执行切换，不执行或加载代码 |
| `debug.resources.checkout(kind)` | 备份 `skills`、`custom`、`agents`、`packages` 之一，返回独立候选目录 |
| `debug.resources.changes(id)` | 列出候选相对备份的增删改 |
| `debug.load({id, entry, kind})` | 兼容名称，只检查并准备独立候选，不执行顶层代码或激活贡献 |
| `debug.recover(id)` | 回到上一份准备记录，不激活代码，不覆盖工作区源文件 |
| `debug.electron()` | 经既有 Desktop Capability BoundPort 查询 Electron 版本、发行形态、真实路径、窗口状态、固定页面快照与内置 Daemon 状态 |
| `debug.export({name, version})` | 可选导出用户 Package ZIP；不自动安装、授权或持久激活 |

TypeScript 入口会转为独立的 JavaScript 快照，使用相对 TypeScript 导入时明确写 `.ts` 扩展名。加载契约沿用贡献工厂 `createContribution(host)` 或对应静态导出；`host` 只含公开身份、数据目录、取消信号和 `onDispose`，不暴露 AppContext。定时器、连接、监听器等必须注册释放函数。

候选插件由用户导入插件页审核和授权；用户资源候选由「工具与扩展 → 资源版本」审阅、登记应用并重启。SDK 不开放应用、重载、重启或授权 RPC。普通 Agent 的 write_file、edit_file、delete_file 同样拒绝直接修改运行资源或备份，要求先创建候选；真实路径检查涵盖工作区符号链接。任意 Node 或终端命令仍由既有权限和审批约束，不宣称为操作系统隔离。未经用户操作，不将候选修改发布到运行目录。

## 留档与恢复

数据位于 `@data/debug/<session UUID>/`：

```text
workspace/    调试源文件
releases/     每次准备的独立快照
data/         保留的调试数据目录
runs/         执行前落盘的脚本、完成结果或错误
exports/      可选导出目录与 ZIP
state.json    当前候选摘要、历史快照及关闭记录
```

关闭或重启后默认不重新启用调试，也不自动加载历史代码。记录继续保留供后续诊断；已崩溃的后端不能依靠其中的 Agent 继续调用工具。严重核心缺陷仍需正式发版，或使用外部宿主恢复进程。

## 边界

脚本运行于独立 Worker，具备超时、取消、输出和 RPC 数量限制；这是可终止的执行边界，不是操作系统沙箱。经过审批的任意 Node 代码具有该后端进程的系统权限，文件助手的目录限制不约束直接使用 Node API 的代码。

插件正式启用后仍复用进程内扩展点。资源回退不能撤销已发生的网络请求、消息或插件运行数据修改。普通退出、强制结束、断电或残留启动标记不会自动进入恢复模式。用户主动选择安全启动、资源目录切换中断或恢复索引损坏时才暂停第三方插件及 MCP 自动连接；角色、人设、技能清单及角色能力配置仍加载，不把资料隐藏成角色不存在。Electron 诊断只执行固定只读脚本，不向 Agent 开放任意渲染器 JavaScript。

调试候选不修改发行 ASAR、镜像只读层或内核 bundle，不提供自动重写安装版核心再重启的机制。依赖额外 npm 包的持久扩展继续走独立 Package 依赖准备流程；当前临时快照主要使用 Node 内置模块和工作区内的相对模块。

## 用户资源版本与离线恢复

`@data/resource-versions/<UUID>/base` 保存编辑前资源，`candidate` 供编辑，用户确认后另冻结 `release`。正式切换在取得后端实例锁后、加载资源之前执行。原目录还会保留为数据根下的 `.resource-old-*` 副本；中断切换会恢复基线并进入恢复模式。版本记录使用原子替换与跨进程文件锁，不记录整次应用运行是否正常退出。旧实现因残留启动标记产生的无来源恢复状态会在下次启动清除；用户明确选择的安全启动仍保持有效。

资源按目录分类创建版本，备份排除 `.git`、`node_modules`，拒绝符号链接并限制数量与体积。依赖由托管插件流程重新准备。不要手改托管插件的授权摘要；源码变更仍须在插件页重新审核。提示词页配置继续沿用数据库中已有的草稿、发布版本与恢复入口，不复制整个业务数据库。恢复记录和 `.resource-*` 现场目录不向远端同步；应用远端全量快照时保留本机版本记录。索引损坏时原件留档，启动降级为恢复模式，不删除快照。

前端提供文件增删改列表与修改前、候选文本预览；二进制或大文件保留真实文件供外部查看。待执行切换可以取消；回退按同类别实际应用顺序进行。已应用的备份不会被自动清理，未应用或已回退记录可由用户删除。

Electron 托盘「拓展恢复」使用原生窗口，不依赖后端 HTTP。可安全启动、安排最近资源回退或打开备份目录。重启只负责当前客户端托管的后端；开发或外部后端由用户手动重启。

发行包包含独立 `recovery.mjs`，无需装配数据库、HTTP 服务与插件：

```sh
# Docker 运行中可用 exec；服务已崩溃时用 run，并继承原数据卷。
docker compose run --rm --no-deps backend node /app/backend/recovery.mjs --list
docker compose run --rm --no-deps backend node /app/backend/recovery.mjs --safe
docker compose run --rm --no-deps backend node /app/backend/recovery.mjs --rollback <版本UUID>
docker compose run --rm --no-deps backend node /app/backend/recovery.mjs --cancel <版本UUID>
docker compose run --rm --no-deps backend node /app/backend/recovery.mjs --resume
docker compose restart backend
```

`--safe` 暂停第三方加载，`--resume` 是用户明确恢复；回退仅登记下次启动操作。源码部署可使用 `pnpm exec tsx packages/backend/src/recovery.ts` 搭配相同参数。必须保持相同 `PERO_DATA_DIR`，不要换数据卷或删除数据库来恢复拓展。

## 实现入口

- 后端：`services/debug/`、`tools/runtimeDebug/`、`routers/runtimeDebug.router.ts`。
- 前端：`components/chat/RuntimeDebugToggle.vue`。
- Electron：`main/services/runtimeDiagnostics.ts`、`desktop.environment/runtimeDiagnostics`。
- 验证：调试服务、Worker/文件边界、审批、API、按钮与 Electron 只读诊断定向单测；夹具全部在 `TEMP/runtime-debug`。
