# 记忆引擎架构

> **适用范围**：`packages/backend/src/services/memory/`
> **核心引擎**：SQLite (Drizzle) + TriviumDB (Vector + Graph)
> **范围**：事件记忆、自动检索与主动图查询；社交应用有独立的记忆处理流程
> **最后更新**：2026-11-09

---

## 1. 记忆存储层级

| 分层                  | 载体                   | 存储内容                       | 检索方式              | 生命周期         |
| --------------------- | ---------------------- | ------------------------------ | --------------------- | ---------------- |
| **Layer 0 (Working)** | JSON / LLM Context     | 当前会话 Context               | 顺序读取              | 短期（单次会话） |
| **Layer 1 (Vector)**  | **TriviumDB**          | 事件向量 + 文本索引            | 向量检索 + BM25       | 长期             |
| **Layer 2 (Graph)**   | **TriviumDB**          | 事件图谱 + 关系边              | 图谱扩散 + 确定性 BFS | 长期             |
| **Layer 3 (Diary)**   | **Workspace Markdown** | 每日人格日记 `dailynotes/*.md` | 按日期读取            | 永久             |
| **Notebook** | **Workspace Markdown** | 主文件 `notes/MEMORY.md` 与同级附页 | 主文件预算注入、附页按需读取 | 按文件维护 |

> Layer 3 的每日人格日记写入 Agent Workspace，**不进入事件记忆库**；另有全 Agent 共享的 **Facts Store**（`facts.tdb`），默认经工具访问，可在知识库面板独立开启有效事实的自动召回。该召回使用独立的动态 XML，不进入事件记忆 RAG 管线。TriviumDB 为运行/检索权威，SQLite 保存完整备份与事务日志。

内置工作区能力片段 `components/abilities/workspace` 向角色说明日记目录 `dailynotes/`、日期命名和分篇规则，并提示先列目录、再按需读取；实际访问沿用文件工具授权与当前执行会话的路径范围。

---

## 2. 写入管线 (EventNote Pipeline)

事件记忆由后台根据主线对话与有效亲历加工，Agent 使用 `query_event_notes` 查询和回读来源。

1. 后台补记扫描角色主线的独立消息与亲历引用，按各自 Channel 处理未覆盖来源，产出事件并登记 Coverage，包括 `reviewed_no_event`。
2. 消息以 `message:<id>@<revision>` 覆盖，用户输入和正式角色发言均可作为来源。批次与最终写入核对主线身份、代次和来源修订。
3. 时间链按 `eventAt` 维护，关系维护由后台 Reflection 建立因果、同一事件、主题及参与对象关联。
4. `EventNoteDraftCommitter` 保留已受理历史草稿的 Outbox 恢复职责，沿原操作编号与 Coverage 幂等处理。当前 Agent 工具目录提供事件读取能力。

主、侧会话共享角色事件查询能力。主线提供自动对话炼化来源，角色级反思、关系与日记调度遵循后台总开关及逐角色开关。来源撤回标记追溯状态，永久遗忘使用用户记忆管理入口。

### 共享事实的修改权限

`write_fact`、`supersede_fact`、`delete_fact`、`add_fact_object_alias` 和 `remove_fact_object_alias` 统一校验所属角色的有效 MainThread、代次及当前场景授权。模型工具目录和执行器共同收窄能力，处理器从受信上下文取得身份。NIT 内部调用沿同一校验路径。

新增、取代和别名操作在准备事务提交前再次核对会话，永久删除在清理队列实际接纳时核对。已持久受理的事实操作沿原事务回执恢复。用户管理页的编辑、恢复和永久遗忘使用用户侧领域入口。

### 工作区记事本

每位角色使用 `notes/MEMORY.md` 保存简短要点和附页索引，其他 Markdown 文件放在同一目录。文件按需创建，角色和用户通过现有 Workspace、VirtualWorkspace 与文件工具维护内容。

`NotebookContextProvider` 每次主应用前台编译固定主文件正文与指纹，最多读取 16000 字符，再交给统一 Region 与模型请求预算选择，正文放不下时可降为位置说明。附页按需读取。主、侧会话及据点按各自工具权限使用同一角色目录。

据点模式开放 `read_file`、`write_file`、`edit_file`、`get_file_info` 与 `list_directory`，执行器在 Hook 后限制到 `notes` 目录及直接 Markdown 文件，并核对真实路径。极简模式按上下文规则读取已有主文件，提示词只提供已有要点作为参考。聊天与工作模式通过获准文件工具维护记事本。任务独立工作区和应用 Realm 沿各自授权接入，前台记事本 Provider 按请求作用域装配。

记事本随工作区备份恢复。正文整理及删除通过文件操作完成，用户记忆管理中的结构化遗忘负责相应事件、事实和日记来源。

---

## 3. 检索策略

记忆检索拆成两条合同不同的路径：

1. **对话前自动 RAG**：默认向量 + BM25；可在「核心记忆」→「RAG 配置」→「高级检索」启用 **SA-PPR 高级管线**（含 FISTA / DPP / ContextRNN / Leiden / 反馈闭环）。固定补充物理时间轴末尾事件与每个命中事件的直接前驱，均不占 `top_k`，但受记忆专属 Token 上限约束；基础管线另有独立相关度门槛（见 3.1）。
2. **Agent 主动图查询**（`query_event_notes`）：确定性 **BFS**，严格遵守方向、边标签、最大深度、最大节点数与返回 Token 预算，**不受 SA-PPR 开关影响**。

### 3.1 自动 RAG 的最终选择

检索完成后，`services/memory/automaticRagSelection.ts` 把直接命中与固定补充合成最终注入列表；`ContextCompiler` 与预算计数共用同一 `memory_context` 格式。每个候选带注入理由：`direct`（直接命中）、`latest`（时间轴末尾）、`previous`（某个命中的直接前驱）。同一事件兼有多个理由时按优先级最高者计，展示位置不变。

- **专属 Token 上限**：`channels.<desktop|group>.memoryTokenBudget`，按通道配置，0 表示不限，可配范围 0–32000，在总览 → 核心记忆 → RAG 配置的通道页设置。默认桌面 2000、群聊 1000：桌面默认 8 条命中最终最多 17 条，短事件约 1.1K Token；群聊每个角色各自注入，默认最多 7 条约 0.5K。默认值不影响常见短记忆，只拦住长正文或调高条数后的成本失控。旧配置缺少该字段时按通道补默认值，不重置其他设置。
- **按完整事件取舍**：优先级为直接命中（按名次）→ 末尾事件 → 前驱（按所依附命中的名次）。放不下的事件整条跳过，不截断正文；后续更短的事件仍可使用剩余额度。前驱只在其依附的命中被保留时才有注入理由。最终输出保持“末尾 → 命中 → 前驱”的展示顺序。
- **来源去重**：`ContextCompiler` 用本轮实际装配进上下文的 user/assistant 消息（含当前输入）构造 `VisibleMemorySource`，与 `EventNote.origin` 比对。只有来源被完整覆盖才排除：`messageIds` 全部可见；没有 `messageIds` 时要求 `pairIds` 全部是两侧都可见的历史对话对，当前对话对不算完整可见。任一来源消息不可见（窗口外的较早消息、当前对话对里未显示的旧回复）都保留，因为摘要可能含模型看不到的信息；人工修订过的事件不按来源排除。被排除的命中不占 `top_k`，基础路径会多取一倍候选供递补；其前驱不再随之补充。时间轴末尾补充改用来源不可见的最近事件。预览不追加历史时不做来源去重。
- **正文去重**：对正文做 NFKC 归一、忽略大小写与全部空白后取 SHA-256，不同 ID 的相同正文只保留优先级最高的一条；命中列表在截取 `top_k` 前先去重。
- **基础管线相关度门槛**：`basic.enableRelevanceGate`（默认开）与 `basic.minSimilarity`（默认 0.2），只在未开启 SA-PPR 时生效，在 RAG 配置的“检索策略”页设置。混合检索的排序分数不当作阈值；门槛使用独立证据：查询向量与事件向量的余弦相似度达到下限，或事件的人物/地点/物品/主题标签（至少 2 个字符）出现在查询中。Embedding 不可用（文本回退）时没有可校准的向量证据，改为标签或正文与查询有文字重合（拉丁词或 CJK 二字组）即放行。门槛只用自动 RAG 已生成的查询向量，不增加 Embedding 请求；基础检索多取一倍候选供过滤后递补。候选不足时少放，不按 `top_k` 补满；直接前驱限额 `ceil(top_k / 2)`，按命中名次分配；末尾事件作为时间锚点保留 1 条。完全无关的查询因此只注入末尾事件。
  - 默认 0.2 是保守值：主流中文 embedding 中明显无关的文本余弦通常低于此值，相关文本普遍更高；基线偏高的模型（如 e5 系列）上它几乎不排除候选，宁可少滤也不误删。需要更强过滤时再按自己的模型调高。
  - 关闭门槛即回到旧行为：按 `top_k` 补满、每个命中都补前驱。旧配置缺少 `basic` 时补默认值（门槛开启）。
  - SA-PPR 管线不受此门槛影响，仍由 `advanced.minScore` 在上游过滤向量候选与种子；该分数可超过 1，不是余弦阈值。
- 该上限只约束记忆区块，不代替全局 Region/模型窗口预算；整体超窗仍由上下文编译的统一预算处理。
- 注入位置不变：内置框架仍把记忆放在尾部 `turn_context` user 快照，记忆变化不改变 system 前缀。一次执行只在 `ContextCompiler.compile` 检索一次，ReAct 工具续轮复用同一编译结果。

---

## 4. 记忆维护与补记

当前事件记忆由后台补记和关系维护分工处理：

- **后台开关作用域**：`memory.background.enabled` 保留为总开关；各角色通过 `memory.background.agent.<agentId>.enabled` 单独保存，缺省为开启，最终执行条件为总开关和角色开关同时开启。配置单项、批量写入、导入及删除均热更新；入口在「核心记忆」的「按角色设置」。关闭一个角色会取消该角色在途后台任务，暂停其在线时长累计、补记、关系维护、日记、社交炼化与检索反馈学习；已有记忆、队列和周期进度保留。关系任务查询在取限额前排除暂停角色，避免其积压占满其他角色的调度批次。记事本维护与记忆读取沿用文件权限和检索配置。
- **后台补记**：每个已启用 Agent 累计在线运行 8 小时后，处理其主线及有效亲历中尚未覆盖或审阅的来源。每分钟只检查是否到点；轮数、容量、Thread 休眠、日界和窗口退出均不能提前触发补记。
- **持久计时**：独立轻量心跳每 30 秒把在线时长累加到 SQLite，正常关闭时补存尾段。关机、退出、关闭长记忆后台开关和角色停用期间暂停累计，恢复后沿用原值；进程重启不根据墙上时钟补算离线时间，长时间系统挂起也不补算。意外断电最多可能损失最后一个尚未落盘的心跳间隔。新版计时与旧静默计时隔离，不继承旧门控积攒的时长。
- **来源覆盖与周期结算**：历史草稿覆盖各自来源，周期按在线时长独立推进。周期到点固定消息 ID 上界，分批和重试只处理该边界之前的数据，后来追加或尚未回复完整的对话留到后续周期。所有批次审阅完成后才推进 Agent 的周期进度；无事件时也保存 `reviewed_no_event`，不重复调用模型。
- **容量分批**：按补记模型的上下文容量，扣除已渲染人格、任务提示词和输出预留后动态分成多批。主线以独立消息来源组织，每份来源正文过大时进一步按 Token 切片，全部片段结果持久保存，来源仍有效后提交覆盖。扫描范围由持久周期边界确定。
- **人格与叙事**：补记、反思均读取所属 Agent 的人设、名称、专属称呼和通道人格补充。补记以角色自己的视角记事；关系维护保留已有叙事声音，保留已有事件的叙事与事实归属。只同步已确认未被用户修改的旧内置任务提示词，用户定制正文保留。
- **失败与并发**：失败按 5、10、20、40、60 分钟退避，最长间隔 1 小时。Coverage Claim 防重复，执行前重新校验覆盖范围，提炼期间消息发生变化则丢弃旧结果。分片及整批模型结果先持久化，后续写入失败时沿用原结果。编辑、撤回针对命中的来源处理，其余来源的已审阅结论保留。
- **关系维护**：每 5 分钟增量维护；失败按 5、15、30、60 分钟退避，连续五次失败停止自动调用。维护修订不重新触发维护自身；决策持久化后可恢复未完成操作。
- **时间语义**：数据库存储 UTC 时刻；上下文、提炼与关系维护中的时间使用设备本地时间并附显式时区偏移。`eventAt` 为事件时间，`createdAt` 为记录或修订时间。
---

## 5. TriviumDB 接入规范

Store 继续使用标准数据库文件组和既有重建流程。维护互斥、旧引用保护及错误详情见 [B29 索引维护与诊断](./B29_INDEX_MAINTENANCE.md)。原生 close 的文件资源释放由 TriviumDB 上游负责，文件操作失败不能据此单独判断为杀毒软件拦截。

TriviumDB 由上游 npm 包提供；后端与社交应用的依赖声明必须同步。当前接入使用 `0.9.0` 正式版 / 主文件格式 v10，文件头持久化向量类型、元素宽度与 CRC。升级沿用旧格式写入前备份和引擎迁移，不自动重新生成 Embedding。仓库维护 TS 适配、存储一致性与发行集成，不维护该库的 Rust 源码或 Cargo 编译链。版本与格式处理入口为 `packages/backend/src/repositories/storeRegistry.ts`、`triviumFiles.ts`。Store 注册表负责旧格式写入前备份、完整文件组重建/清理及一致性快照；持久化正文旁路文件 `.tdb.pld.<generation>`、属性/图索引、flush marker，以及发布恢复日志 `.publish` 与 `.publish.0`–`.publish.8` 必须按同一数据库文件组处理。升级备份按目标版本分目录保存，清空、永久遗忘和维度重建同时清理旧版本对应库的副本。每个常驻 Store 的 Payload 缓存上限为 32 MiB、单条缓存上限为 4 MiB；只读临时 Store 使用 8 MiB。旧库恢复、索引兼容和回退约束统一见 [A08_DEVOPS](./A08_DEVOPS.md#23-迁移原则)。

正式版继续采用 v10 主文件格式，从 beta.4 切换不新增磁盘格式迁移。上游修复 Windows 后台关闭发布与再次打开时的文件身份/锁路径竞态，维度迁移发布改用不覆盖目标的排他原子重命名；应用继续使用现有注册表维护和文件组恢复协议，不自行替代上游的发布实现。嵌入式 Console 为新增可选 API，本项目暂未接入。依据见[上游 0.9.0 正式版说明](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0/docs/changes/0.9.0.md)。

Node.js 既有 CRUD、图查询、检索、事务和 `close()` 签名保持兼容。各 Store 未显式传入 `runtime`，复用上游默认共享资源运行时，仍由各实例的 `memoryLimitMb` 限制内核预算。同步 `close()` 成功意味着 WAL、映射和文件锁已释放；失败则保留资源以便重试，不得继续替换文件。新增关闭诊断、目录快照与 `rebuildTextIndex()` 暂未接入应用流程；备份继续采用注册表现有文件组协议。上游将 QuIVer 自动构建阈值提前到 `ceil(666667 / dim)`（限制在 209–834 节点，1536 维为 435 节点），已有索引不因此自动重建。API 与生命周期依据见[上游 beta.2 变更说明](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0-beta.2/docs/changes/0.9.0-beta.2.md)。

备份排除 `.lock` 运行期锁，而 beta.4 的 `readOnly` 模式要求锁文件已存在且不会补建。注册表 `openExistingReader()` 在确认主库存在后，先检查锁路径位于受管数据根内且没有符号链接；验证独立快照副本时由 `captureSnapshot()` 显式传入快照目标根，不能误用业务数据根。随后以 `wx`、`0600` 补建空锁，仅忽略已经存在的竞争结果，仍由引擎取得共享锁。已有锁不覆盖、移除或替换，不回退到可写打开，也不创建缺失主库。此规则同时覆盖启动索引描述、旧维度读取与快照副本检查；主库、向量、正文、维度旁路文件保持原样，锁竞争、权限、损坏和其他 I/O 错误继续传播。恢复后文档知识库启动仍从 SQLite 恢复派生检索状态，不因缺锁清除原文或旧维度文件。

`JsEdge`、`JsIncomingEdge` 保留 `metadata: unknown`，既有调用继续读取已声明字段。数字 ID 的输入与输出要求 JavaScript 安全整数，数量参数要求有限、整数且在有效范围内；TQL 超出安全整数范围的整数值使用十进制字符串返回，不能无条件转为 `number`。beta.4 的 Node 错误增加按稳定 `code` 区分的 `details`，其中整数可能为 `number | string`，调用方须按实际字段类型读取。WAL 写入、Windows 映射替换或约束发布故障可能隔离 writer 及共享句柄，必须释放后重开并核实实际状态，不能把失败写入当作未发生而直接重试。依据见[上游 beta.4 变更说明](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0-beta.4/docs/changes/0.9.0-beta.4.md)。

`indexText(id, text)` 替换节点的完整 BM25 正文，多字段需合并后一次登记；修改 Payload 不会自动更新独立正文。常驻 Store 保持 `loadTextIndex: true`，`buildTextIndex()` 用于提前预热关键词自动机，加载、损坏和预算错误向请求传播；初始化失败关闭未注册的句柄，后续可重试。文本登记仍需 flush/close 持久化，不属于节点事务的 WAL 原子提交；继续保留 SQLite 完整备份和事务重放路径，不因库升级删除这些恢复来源。

原生 JSON 边界拒绝 `undefined` 等非法值。事实记录构造时省略未设置的 `source`、`confidence`；自动修订事件通过删除复制后 origin 的人工修订字段清除标记，不写入 `manualEdit: undefined`。不通过整体字符串化把非法数值或不支持的对象静默改成其他内容。

事件记忆与事实分别由领域服务、Repository 和 Store Registry 协调 SQLite 事务记录、TDB 写入与失败重放。维护写入时应沿用领域提交入口；`indexText()` 登记正文，`buildTextIndex()` 用于预热关键词自动机，索引也可按需编译。具体过程见 `eventMemoryService.ts`、`facts.repo.ts` 和 `storeRegistry.ts`。

---

## 6. 核心数据对象

### 6.1 EventNote (TDB + SQLite 备份)

Agent 第一人称事件记事：`id`、`agentId`、`narrative`、`eventAt`（系统权威时间）、`createdAt`、`importance`、`affect{tones,valence,arousal}`、`participants/places/objects/topics`、`origin{mode,threadId,pairIds,messageIds,channel}`、`status(active/archived)`。运行时以 TriviumDB 为权威，SQLite 保存完整备份与事务日志。

### 6.2 ConversationCoverage (SQLite)

记录对话区间的覆盖结论：`outcome = event_recorded | reviewed_no_event`，据此避免后台重复炼化，并在对话回溯/清理时定位受影响事件。

### 6.3 Facts (共享 Store)

全 Agent 共享的对象事实库（`facts.tdb`）：`objectKey` / `statement`，支持 `superseded_by` 取代链；支持工具访问与默认关闭的自动召回，详见 [文档知识库](B03_DOCUMENT_KNOWLEDGE.md#可选自动召回)。

## 7. 记忆边界与来源追溯

长记忆的事件记事体系必须遵守以下约束：

1. 事件记忆归属 `agentId`，不归属 Session 或 Thread；Thread 仅提供可追溯来源（`origin.pairIds/messageIds/channel`）。
2. 系统消息时间是事件时间的唯一权威（`eventAt`），Agent 不填写或推断时间。
3. 同一事件由 `EventNote` 承载；后台只对未覆盖区间补记，零事件区间以 `reviewed_no_event` 记录，避免重复扫描。
4. 每个 EventNote 保留完整 **Provenance**（来源消息、channel、创建方式），可回答"从哪来、是否已被修订"。
5. Agent 私有 Store（`memory.tdb`）与共享 `facts.tdb` 按 Agent/全局隔离；TriviumDB 为运行权威，SQLite 为完整备份 + 事务日志（`operationId` 幂等提交，可全量重建）。

---

## 8. Memory Resource与Context映射

长期记忆是跨Execution持久的Resource，不是Prompt字符串或Context Compiler私有状态。Memory Region进入模型前必须记录：

- `agentId`、Store与来源对象；
- Snapshot/Revision或查询时间；
- 检索Query、命中依据和排序分数；
- Token预算、裁剪原因与可见性；
- Provenance、Trust与是否为Derived Observation。

Context Compiler只能按Policy将Memory Resource物化为Region，不得在编译期间修改事件记忆。RAG按需检索等价于Context地址空间的缺页处理；相同资源Snapshot、Query和Policy应产生可复现的Context Manifest。Observer产生的Agent State属于独立Derived Resource，默认不进入Prompt，必须由Thread ContextPolicy与Observer Policy双重启用。

记忆跨Application回流必须经过`infos.knowledge.submit_candidate`或等价Checkpoint/MemoryCandidate Port与主Agent MemoryGate；Application自己的领域状态和私有记忆仍由其Store/Authority持有，不能直接写入Agent的事件记忆。Application查询知识使用收窄的`infos.knowledge.query` Capability，只获得结果与Provenance，不获得TriviumDB文件、Repository或数据库连接。具体协议见 [A10_APPLICATION_INTEGRATION](./A10_APPLICATION_INTEGRATION.md)。

---

## 9. ContextRNN 按需生命周期

ContextRNN 是 SA-PPR 高级管线的可选子模块，默认关闭。只有 `advanced.enableSaPpr && advanced.enableContextRnn` 同时成立且实际进入自动 RAG 时，`ContextRnnRuntime` 才创建模型实例并加载权重；打开设置本身不创建实例。基础向量/BM25 查询和 Agent 主动图谱查询不调用 RNN。

- 反馈训练还要求 `advanced.enableFeedback`；关闭 ContextRNN 时配置校验与前端会同时关闭反馈，检索不再保留训练轨迹。
- 热关闭高级管线或 ContextRNN 后，统一落盘尚未保存的变更并释放实例。配置代次使等待 Embedding 的旧检索、旧反馈失效，防止迟到请求重新创建或训练已关闭的模型。
- 隐状态按 Agent 与 Channel 隔离；投影、输出、minGRU 权重保持现有共享格式，已有二进制文件可继续读取。
- 状态和各类权重分别记录脏标记。检查点只写发生变更的项，加载已有文件不会产生脏标记，无变更时不写盘、不打印保存日志。
- KernelScheduler 的周期计划支持轻量 `shouldRun` 条件；RNN 未实例化、关闭或无变更时，保存计划不创建 Execution，也不增加运行统计。
- 专用记忆配置接口和通用配置的单项、批量、导入、删除入口都同步生命周期。进程退出只刷新已创建实例的未保存变更，不创建模型。

## 10. 人工编辑档案

- 核心记忆详情支持编辑正文、重要度、情感与人物/地点/物品/主题标签；有效事实支持编辑正文、来源与可信度，历史或已撤回事实保持只读。
- 人工编辑创建替代版本，旧正文保留于 SQLite。记忆沿用所属 Agent、事件时间、原始对话来源与归档状态；事实沿用对象、原观察时间与原记录者。修改者与前版本单独记录于修订事务，记忆的 `origin.manualEdit` 还用于详情展示。人工修改不伪造新的聊天回合，不新增对话覆盖，也不触发本条目的后台反思。
- 记忆保存默认复用原向量，用户可选择重新生成。无论是否生成，正文文本索引都会更新；人物、地点与物品实体边依据新标签重建，新实体不额外请求向量模型。事实仍采用文本索引，不提供虚假的向量开关。
- 重新生成的向量在准备修订事务前完成；失败不会发布新版本。已准备事务持久保存本次向量，失败重试与启动重放沿用该向量，不重复调用模型。
- 客户端同一草稿重试沿用 `operationId`。事务内检查旧版本是否仍有效，归档状态是否变化；并发修订仅允许一个版本接管。迟到请求不能复活已被再次替代的旧条目。冲突响应保留编辑草稿，由用户刷新后决定如何处理。
- 保存完成后刷新详情、列表、统计与图谱；未保存的修改关闭前需要明确放弃。已生成的日记与进行中的对话上下文不因档案编辑自动重写。
- 归档记忆可从列表、详情或批量操作恢复；知识库中的已撤回事实提供「还原」。还原保留同一条记录的正文、原始来源、观察时间和记录者，不重新生成向量。被新修订替代的旧版本不允许直接恢复为有效条目，避免绕过版本链。
- 记忆恢复同步失效旧检索轨迹并恢复索引；事实恢复使用事务日志同步 SQLite 与 TDB，索引中断可重试，旧事务重放以数据库当前状态为准。永久删除及来源遗忘的标记继续优先拦截，包括已经创建过的还原事务，不能借还原复活删除数据。

_本文档由 Carola 整理，适用于 infOS-TS 记忆引擎架构规范。_
