# 记忆引擎架构 (PEDSA)

> **适用范围**：`packages/backend/src/services/memory/`
> **核心引擎**：SQLite (Drizzle) + TriviumDB (Vector + Graph)
> **理论基础**：PEDSA v2 (Pipeline for Embedded Directed Semantic Analysis)
> **最后更新**：2026-10-17

---

## 1. 记忆存储层级

| 分层                  | 载体                   | 存储内容                       | 检索方式              | 生命周期         |
| --------------------- | ---------------------- | ------------------------------ | --------------------- | ---------------- |
| **Layer 0 (Working)** | JSON / LLM Context     | 当前会话 Context               | 顺序读取              | 短期（单次会话） |
| **Layer 1 (Vector)**  | **TriviumDB**          | 事件向量 + 文本索引            | 向量检索 + BM25       | 长期             |
| **Layer 2 (Graph)**   | **TriviumDB**          | 事件图谱 + 关系边              | 图谱扩散 + 确定性 BFS | 长期             |
| **Layer 3 (Diary)**   | **Workspace Markdown** | 每日人格日记 `dailynotes/*.md` | 按日期读取            | 永久             |

> Layer 3 的每日人格日记写入 Agent Workspace，**不进入事件记忆库**；另有全 Agent 共享的 **Facts Store**（`facts.tdb`），默认经工具访问，可在知识库面板独立开启有效事实的自动召回。该召回使用独立的动态 XML，不进入事件记忆 RAG 管线。TriviumDB 为运行/检索权威，SQLite 保存完整备份与事务日志。

---

## 2. 写入管线 (EventNote Pipeline)

长记忆不再经"摘要节点"，而是 **Agent 主动记事 + 后台兜底补记**：

1. **主动记事**：Agent 在 ReAct 中调用 `write_event_note` / `revise_event_note`，只创建本回合 `EventNoteDraft`。
   - 正文以当前 Agent 自己的第一人称主语开篇：中文用“我”，英文用“I”，时间背景放在主语之后。工具入口与提交入口共用开篇校验；不符合约定的调用返回纠正说明，由 Agent 重写，不机械加前缀或替换名字。该校验只约束开篇格式，事实归属仍由提示词约束：他人的经历用“我得知……”等保留来源，不得转写为自己的经历。后台补记与反思使用相同视角要求；不批量改写历史记忆，也不改变客观 Facts Store。
2. **回合提交**：Assistant 消息成功持久化后，Draft 才正式提交为 EventNote，并登记消息覆盖关系。
3. **后台补记**：只处理尚未被覆盖的连续消息区间，可产出 0~N 条事件，并写入 `ConversationCoverage`（含 `reviewed_no_event`）。
4. **时间链**：按 `eventAt` 追加/插入并修复 `temporal_next` / `temporal_prev`。
5. **关系维护**：由后台 Reflection 建立 `caused_by` / `same_event` / `same_topic` / `involves_*` 边。

---

## 3. 检索策略

记忆检索拆成两条合同不同的路径：

1. **对话前自动 RAG**：默认向量 + BM25；可在总览页启用 **SA-PPR 高级管线**（含 FISTA / DPP / ContextRNN / Leiden / 反馈闭环）。固定补充物理时间轴末尾事件与每个命中事件的直接前驱，均不占 `top_k`。
2. **Agent 主动图查询**（`query_event_notes`）：确定性 **BFS**，严格遵守方向、边标签、最大深度、最大节点数与返回 Token 预算，**不受 SA-PPR 开关影响**。

---

## 4. 记忆维护与补记

当前事件记忆由主动记录、后台补记和关系维护分工处理：

- **后台补记**：每个已启用 Agent 累计在线运行 8 小时后，补记其所有普通 Thread 中尚未主动记录或审阅的完整对话。每分钟只检查是否到点；轮数、容量、Thread 休眠、日界和窗口退出均不能提前触发补记。
- **持久计时**：独立轻量心跳每 30 秒把在线时长累加到 SQLite，正常关闭时补存尾段。关机、退出、关闭长记忆后台开关和角色停用期间暂停累计，恢复后沿用原值；进程重启不根据墙上时钟补算离线时间，长时间系统挂起也不补算。意外断电最多可能损失最后一个尚未落盘的心跳间隔。新版计时与旧静默计时隔离，不继承旧门控积攒的时长。
- **主动记事与周期结算**：主动记事只覆盖对应来源，不清零八小时时钟。周期到点固定消息 ID 上界，分批和重试只处理该边界之前的数据，后来追加或尚未回复完整的对话留到后续周期。所有批次审阅完成后才推进 Agent 的周期进度；无事件时也保存 `reviewed_no_event`，不重复调用模型。
- **容量分批**：按补记模型的上下文容量，扣除已渲染人格、任务提示词和输出预留后动态分成多批；通常保留完整轮次，单轮正文过大时进一步按 Token 切片，不截掉正文。片段结果持久保存，整轮所有片段完成且来源仍有效后才提交覆盖；不受前台聊天窗口或最近一万轮读取上限影响。
- **人格与叙事**：补记、反思均读取所属 Agent 的人设、名称、专属称呼和通道人格补充。补记以角色自己的视角记事；关系维护保留已有叙事声音，不为了统一格式重写主动记事。只同步已确认未被用户修改的旧内置任务提示词，用户定制正文保留。
- **失败与并发**：失败按 5、10、20、40、60 分钟退避，最长间隔 1 小时；Coverage Claim 防重复，执行前重新校验覆盖范围，提炼期间消息发生变化则丢弃旧结果。分片及整批模型结果先持久化，后续写入失败时沿用原结果。编辑、撤回只重开命中的来源，未变化轮次的已审阅结论保留，不会整批重新凑数。
- **关系维护**：每 5 分钟增量维护；失败按 5、15、30、60 分钟退避，连续五次失败停止自动调用。维护修订不重新触发维护自身；决策持久化后可恢复未完成操作。
- **时间语义**：数据库存储 UTC 时刻；上下文、提炼与关系维护中的时间使用设备本地时间并附显式时区偏移。`eventAt` 为事件时间，`createdAt` 为记录或修订时间。

2026-10-21 验证：全量 334 个测试文件、2,112 项测试通过；工作区与测试代码类型检查、ESLint 均通过。回归覆盖累计在线与离线暂停、重启续接、主动记事排除、空事件覆盖、容量分批、重复正文分片身份、失败缓存恢复与来源编辑失效。本次未运行应用构建。

---

## 5. TriviumDB 接入规范

后端与社交应用统一固定 **0.8.11**，主文件仍为 v9，无需为本次升级迁移数据或重新生成向量。Store 注册表负责旧格式写入前备份、完整文件组重建/清理及一致性快照；持久化正文旁路文件 `.tdb.pld.<generation>`、属性/图索引、flush marker，以及发布恢复日志 `.publish` 与 `.publish.0/1/2` 必须按同一数据库文件组处理。升级备份按目标版本分目录保存，清空、永久遗忘和维度重建同时清理旧版本对应库的副本。每个常驻 Store 的 Payload 缓存上限为 32 MiB、单条缓存上限为 4 MiB；只读临时 Store 使用 8 MiB。具体回退约束见 [A08_DEVOPS](./A08_DEVOPS.md#23-迁移原则)。

`indexText(id, text)` 替换节点的完整 BM25 正文，多字段需合并后一次登记；修改 Payload 不会自动更新独立正文。常驻 Store 保持 `loadTextIndex: true`，`buildTextIndex()` 用于提前预热关键词自动机，加载、损坏和预算错误向请求传播；初始化失败关闭未注册的句柄，后续可重试。文本登记仍需 flush/close 持久化，不属于节点事务的 WAL 原子提交；继续保留 SQLite 完整备份和事务重放路径，不因库升级删除这些恢复来源。

TS 层必须通过 `VectorWriteHelper` 操作数据库，确保原子性：

```typescript
// insertWithId 确保 SQLite ID ↔ TriviumDB ID 一致
store.insertWithId(sqliteId, vector, payload)
// 必须调 buildTextIndex() 增量索引才生效
store.buildTextIndex()
// 开启自动压缩防止内存膨胀
store.enableAutoCompaction(300)
```

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
