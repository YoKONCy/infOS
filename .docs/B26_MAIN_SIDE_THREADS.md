# 主侧会话与角色持续状态

## 权威归属

每个已登记角色持有唯一 `main` Thread 和任意数量的 `side` Thread。主线负责日常连续交互和自动对话补记。Thread 类型、用途、交互模式和执行模式分别表达各自职责。

| 数据 | 权威位置 | 作用域 |
| --- | --- | --- |
| 人设与公开档案 | Agent / Identity | 角色 |
| 表达与持续状态 | `agent_character_state_events` | 角色共享 |
| 长记忆 | SQLite 事件账本与角色 TriviumDB Store | 角色共享 |
| 历史、心流、计划、酒馆局部变量 | 对应 Thread | 会话 |
| 正式发言与发布回执 | `thread_messages` 的 `publication_id` | 独立消息 |
| 执行输入快照、过程与结果 | `conversation_executions` | 一次逻辑执行 |
| 发言的来源修订关联 | `conversation_message_sources` | 消息之间的多对多关系 |
| 待回应问题与接续现场 | `conversation_expectations` | 主线与重置代次 |
| 房间事实 | `group_chat_messages` | 据点房间 |
| 角色亲历 | `agent_experiences` 引用房间消息 | 角色主线与重置代次 |
| 角色当前心流 | `flow_states` 与 `flow_state_revisions` | 主会话与据点共用 MainThread，侧会话独立 |
| 当前选中会话 | 客户端窗口 | 窗口偏好 |

PrincipalAgent 继续通过 `agentId` 关联 Identity、Memory、Workspace、Context Runtime、Thread 和 Capability 等资源。主 Thread 提供稳定的连续性交互入口。

角色身份与长记忆按角色资源管理。聊天记录分别由主线、侧线、据点房间及社交会话持有，主线与据点直接装配同一角色的近期原文并共享当前心流。侧会话与社交使用自己的历史和心流范围。长期认识通过有来源的记忆沉淀与检索连接。

## 创建、迁移与默认入口

`0025_main_side_threads.sql` 为现有 Thread 增加 `thread_kind='side'`、`generation=1`。历史 ID、消息、用途、设置和原有状态记录原地保留。新角色共享状态表从空事件流开始，读取时使用表达默认值，持续目标、承诺和关系初始为空。

容器为全部已登记角色补建空主线，角色创建和会话查询入口同样确保主线存在。角色启用状态沿用角色配置。数据库部分唯一索引 `idx_threads_main_agent` 保证每个角色至多一条主线，`ThreadRepository.ensureMainThread` 提供幂等创建。

`getOrCreateLatest(agentId, 'desktop', 'conversation')` 的兼容入口解析主线。普通创建和检查点复制生成侧线。后台任务及应用内部 Thread 继续沿用原 `purpose` 和列表过滤规则。

主应用首次进入、桌宠、语音及主动行为默认解析主线。用户显式选择侧线后，主应用按窗口保存选择，桌宠沿用自己的会话偏好。主动调度始终取得角色主线。

### 主会话入口与显示

会话列表在分页前先按 `thread_kind` 排列主线，再按消息和创建时间排列侧线。主应用将主线放在历史滚动区上方，以单行直角入口承载固定的「主会话」标识和清空重置入口，通过房屋图标、左侧色条与当前会话标记区别于侧线。工作区切换抽屉与桌宠选择器复用 `MainThreadCard.vue`，桌宠滚动列表将其固定在顶部。

对话日志在所选时间顺序内继续优先展示主线，主线的改名入口同样按类型隐藏。

前端通过 `threadDisplayName` 统一显示会话身份。主线标题、重命名按钮和改名对话框由类型判定隐藏，主线的聊天栏、导出标题、会话选项、用量筛选和批注来源均显示固定类型标识。用量筛选和表达批注返回 `threadKind` 供客户端判定。侧线继续显示用户标题并支持编辑。

## 连续交流与执行

主线的用户输入、角色发言和后台任务交付分别保存。一次 Execution 可以消费多条输入，发表零条或多条正式消息。主线消息的 `pair_id` 留空，`publication_id` 提供幂等身份，`execution_id` 关联逻辑执行。用户输入的发布身份由队列提交身份与主线代次生成，重复提交返回同一消息。

`conversation` 工具提供三个操作。`publish` 提交正式发言并返回 `messageId`，同一执行可以连续发表多条消息。`wait` 批量保存问题、已发布消息的修订引用、接续要点和可选到期时间，然后结束本次执行。`resolve` 使用本次有效用户输入回应一个或多个事项，`publish.responds_to` 可以将发表与回应结算放进同一事务。等待期限省略时持续保留，读取待回应现场时结算已到期事项。

后续用户输入通过普通队列创建新 Execution。编译器提供仍有效的问题和接续要点，模型依据实际回答选择回应事项，也可以继续当前新话题。等待现场持久保存，重启后可由后续交流接续。主线工具菜单开放独立的执行结束操作，提问使用 `conversation` 保存现场。

`finish_task.reply` 在主线中可省略。普通自然语言最终答复由编排层以独立发布身份保存，工具发表的消息即时进入投影。过程记录与正式消息分别结算，失败、暂停和中断记录保留自己的投影。已发表消息继续作为有效交流事实存在。

执行记录的输入来源固定到消息修订，任务结果事件引用对应交付消息。来源编辑、撤回或代次变化后，提交入口重新校验有效性。角色状态、心流、计划和文件快照沿用现有来源列，主线在这些列中保存逻辑执行编号。侧会话继续使用已有配对合同，原生工具调用和结果保持完整协议组。

## 历史预算与记忆范围

角色主会话与据点直接读取相关近期正式消息。主会话读取本角色当前代次的据点亲历，据点读取本角色主会话的近期原文。另一场景的条数按当前窗口实际选入的正式聊天消息数取二分之一，向上取整。当前窗口为空时，采用现有 Channel 默认消息窗口数作为计算基准。

条数筛选复用 `getActiveMessages` 与亲历查询，在数据库截取前筛选 user、assistant 正式消息，保留完整正文。所选资料进入统一 Region 和最终模型请求选择，整体长度由同一模型输入窗口处理。清单保留消息身份、代次、场景、时间及真实发言者，正文由原场景权威持有。

跨场景原文在实际执行时惰性装配，亲历更新本身只保存来源。据点来源更正、撤回和主线重置会影响后续编译。侧会话历史按自身范围读取，Realm 与 Social 各有独立的历史与心流合同。工作工具轨迹继续由工作上下文选择规则处理。

`memory.runtime.channels.<channel>.historyTokenBudget` 控制主线和据点近期历史容量，默认 `16384 Token`，可设置为 `1024–262144`。主线按独立消息向前读取，工作模式在剩余材料预算内恢复来源仍有效的完整工具过程。零条发言的执行通过仍在窗口内的输入来源接续，生成附件绑定到该执行最后一条正式发言。模型完整输入容量继续约束人设、检索、工具定义及全部资料。旧 `contextPairs` 字段保留侧会话策略的兼容语义。

动态填充继续提供贴近当前输入和前移到上一条输入两档，定位依据稳定用户消息身份。主线的独立发言数量由实际交流决定，执行资源继续受模型调用和工具迭代预算约束。

主线记忆覆盖键采用 `message:<id>@<revision>`，单条用户输入、角色发言和任务结果均可成为有效来源。`current_execution` 选择本次消费与发表的来源，`uncovered_sources` 选择截至本次尚未覆盖的来源。旧配对范围继续用于已有侧会话数据。

## 工作上下文清理

主应用前台桌面对话提供 `clear_work_context`，主、侧会话均可在自身工具策略允许时调用。工具在 NIT 脚本外直接执行，以当前会话、代次、逻辑执行和函数调用 ID 保存幂等回执。

`work_context_clears` 记录清理时已存在的消息和交流执行身份。最新边界保存来源集合，旧行仅保留操作回执。重复调用沿原回执返回，当前请求与热轨迹只在新边界实际提交时清理。ContextCompiler、历史工作投影及短期读取资料使用同一边界。清理调用所属的完整原生工具批次作为新过程的起点，本次执行较早过程从下一次模型请求退出，之后产生的工作轨迹继续积累。

执行器使用编译时保留的普通会话资料重建请求，当前已发布的正式发言继续作为交流资料。角色记事本在清理结算时重新读取并作为独立快照注入。热轨迹按当前会话单独失效，在途旧缓存提交也会被拒绝。原始消息、执行审计及后台记忆来源各自保存在对应权威记录。

清理后恢复的同一逻辑执行记录已应用的调用标识，后续轨迹沿该边界继续积累。侧会话分页预算按清理后的有效材料计费。

清理边界随会话逻辑备份导出，导入重写消息、执行、轮次及调用引用。检查点复制当前边界并映射实际复制的消息，主线重置删除旧代次的清理回执。当前入口限定前台桌面对话，据点及应用场景各自的清理合同列入后续规划。

## 生命周期与重置

服务端返回 `threadKind`、`generation`、`canDelete`、`canFork` 和 `canReset`。主线支持消息编辑、撤回和重新生成，整条会话通过清空重置维护。

`POST /api/chat/threads/:id/reset` 取得历史变更占用，取消当前执行、待审批和待回答事项，推进持久代次，清理当前消息与会话现场。消息以 `deletedBy='reset'` 软删除，保留来源追溯。心流、修订记录、计划和计划变更在同一事务清理。

重置保留 Thread ID、模型与工具等设置、角色共享状态、长记忆和工作区文件。亲历保留原来源记录，当前视角只读取新代次的经历。

酒馆变量使用串行队列和 `scopeEpochs`。局部变量清理与 Thread 代次通过同一 SQLite 事务提交，全局变量保留。旧代次产生的局部和全局写入均在提交时失效。

危险区域的全量清空记录同样保留主线身份，取消在途交互并清理局部变量。该入口使用全局变量提交版本失效，与记录清理在同一事务保存，全局变量内容保留。

执行、队列输入、任务交付、工具状态、计划、心流和记事提交携带相应代次。消息与计数同事务提交。运行时注销和队列派发通过本次占用身份结算，旧执行的结束回调只释放自己的占用。

重置后发布 `thread_reset`，客户端更新代次并刷新投影。Surface 帧与快照携带 `threadGeneration`，Compositor 和桌宠据此丢弃过期帧。

## 角色共享状态

共享字段包括 `mood`、`vibe`、`mind`、`ongoingGoals`、`commitments` 和 `relationships`。后三项使用最多 8000 字符的当前文本记录，空字符串表达清除。心流字段 `currentGoal / privateFacts` 在主会话与据点共用 MainThread 持久记录，侧会话独立保存；任务和计划持有自己的实际进度。心流补丁与撤回见 [角色状态](./B10_CHARACTER_STATE.md)。

`update_state` 与 `finish_task` 共用 `PetStateService`。状态补丁附带角色、Thread、代次、逻辑执行来源和工具调用编号，重试按完整来源幂等。临时触碰、闲置与欢迎台词保留原始事件时间，按六小时有效期和池容量投影。

上下文编译携带角色状态版本，执行期间共享版本引用。另一场景先提交后，旧版本更新返回冲突和当前状态，执行方可据此重试。NIT 子工具继承同一版本及代次。

撤回通过追加来源补偿事件处理，重放时跳过被撤回贡献，后续其他场景的有效字段继续生效。主线重置保留角色共享事件。

旧 `thread_character_state_events` 作为会话兼容资料保留，检查点可以复制其历史基线。新执行统一读取角色共享权威。

## 记忆来源与恢复

自动对话补记只扫描主线。SideThread 支持共享记忆检索及工作区记事本维护，自动补记的入队、批次执行与最终写入均检查主线身份和代次。已选角色的后台开关继续控制该角色的补记与共享记忆维护。

主线普通对话、主动活动及任务交付按其来源记录炼化。据点经历使用 `experience:<id>` 作为覆盖键，后台按私聊和据点来源分别分批，并保留各自 Channel。亲历提炼直接读取权威房间消息。

记事来源携带 `generation`、`messageRevisions` 和可选 `experienceIds`。SQLite 准备写入与异步向量化后的 TDB 提交边界均核验来源。过期且尚未形成 TDB 记忆的准备记录标为 `discarded`，清理占位条目，修订则解除原条目的待替代关联。共享库维护和用户编辑沿用各自权限。跨会话修订通过 `origin.sources` 保留各份来源引用。

消息提交事件和事实同事务写入 Outbox。主线执行结算发布 `conversation.execution.settled`。`EventNoteDraftCommitter.consumeExecution` 与 `consumeMessage` 保留已受理历史草稿的恢复职责，按原操作编号和 Coverage 幂等处理。当前 Agent 通过查询使用事件记忆，主动要点写入记事本，共享事实修改统一核验有效 MainThread。具体职责见 [记忆引擎](./A05_MEMORY_ENGINE.md)。

消息撤回保留已形成的记忆，来源页标示撤回或修订状态。永久遗忘沿用 `PrivacyDeletionService` 清理记忆及其派生资料，并登记跨会话来源的遗忘标记。记忆重置同时记录聊天和亲历来源截止编号，后续补记遵守截止标记。

## 据点执行与亲历

参与姿态、交流、活动、邀请和持续关注以主线及代次为个人身份锚点，公开事件与逐条亲历沿房间来源提交。具体数据、工具、恢复与投影合同见[据点生活](./B32_STRONGHOLD_LIFE.md)。

Stronghold 是主应用内部场景。`GroupChatService.sendMessage` 在同一事务保存公共消息、当时在场者的亲历引用与 Outbox 事件。需要回复的消息还持有 `metadataJson.replyIntent`，记录目标主线与代次、待回复队列和结算进度。每条消息分别确定在场关系，普通旁听只形成亲历。角色移动将位置与成员资格一起提交。

`StrongholdRoundService` 从该意图恢复调度，Outbox 唤醒和内核周期扫描共用同一入口。已保存的角色回复按房间、角色、轮次及主线代次去重。进程中断后继续处理未结算队列，撤回来源或重置目标主线后跳过相应旧请求。单个角色最多尝试三次，随后继续本轮其他角色。外部工具的执行恢复沿用其各自的幂等和取消契约。

准备和执行期间新追加的接收者保存在同一持久意图中，角色结算读取最新队列。执行目标须仍为对应角色的有效 MainThread，公开回复提交核验具体来源消息仍然有效。条件等待的独立维护恢复及任务回填去重见[主动行为](./B20_PROACTIVE_WORK.md#据点接话与条件等待)。

需要发言时，`StrongholdTurnService` 以角色主线为身份锚点，经 KernelScheduler 和 ConversationTurnService 执行。受信任的场景适配器为本次 Execution 编译 `group` 权限与场景输入，并提供实际选入的正式消息数。当前房间历史由据点亲历适配器供给，主线私聊近期原文作为独立来源进入 Region，当前心流从同一 MainThread 读取。

桌面工作模式的热轨迹按桌面 Thread 接续。据点从当前房间读取角色亲历，使用本次场景输入和执行消息，酒馆局部变量按 `group + roomId + agentId + 主ThreadId` 划分，房间之间分别保存。

最终回复投递回原房间，原始输出、工具调用和上下文清单作为该条房间消息的审计元数据保存。新的房间×角色隐藏 Thread 问答副本写入已退出，旧隐藏 Thread 留作历史资料。`recordPairVisibility` 只保留旧亲历数据兼容入口。

主线的「生活经历」从输入栏工具区打开独立侧栏，按需读取最近 60 条来源引用。列表以最近经历在前，按本地日期分组，显示发言者头像、据点与发生时间，支持在这批记录内搜索正文、发言者和据点。默认展示正文节选，展开单条后按需渲染完整原文。刷新保留现有列表，切换会话、重置代次及离开对话页时收起侧栏，旧请求回执按作用域失效。模型编译通过同一亲历查询按所需消息条数读取近期原文，长期经历通过事件记忆检索取得。

侧栏样式集中在 `ThreadExperiences.vue` 与 `thread-experiences.css`，搜索、头像、日期分组、时间线节点及原文区域使用直角边框、主题强调色和像素工具文字。原文中的代码、图片和公式容器通过局部样式保持同样的边框形态。`PDrawer` 共用主题遮罩令牌与直角关闭按钮，焦点管理、Escape 关闭和滚动锁由抽屉统一持有。

Social 使用独立 Application、Realm、授权、历史与心流。子应用的宿主咨询携带宿主签发的 Realm，输入由应用提交的请求与辅助资料组成，结果返回原应用。社交长记忆与角色共享资源的进一步接入列入后续方案。

## 展示与恢复兼容

主线 Assistant Surface 设置 `processCollapsed`，正式发言独立显示。完整思考、工具、重试及中间叙述保留，用户可展开。`surface.publish` 在执行期间同步已发表消息，`surface.commit` 或 `surface.settled` 结算本次实时现场。实时流、历史投影与队列恢复共用这些合同。

主线撤回针对所选消息。`POST /api/chat/threads/:id/regenerate` 接受消息 ID、修订和客户端幂等身份，登记独立的用户操作，再由队列派发新执行。选中角色发言时替换该条发言，选中用户输入时保留输入并重做其相关回复，其他交流消息保留。首条替代发言发表时，在同一事务中撤回选定的旧回复并更新计数，发表前失败时原回复继续有效。角色主动发言同样适用。原消息内容及修订保存在执行触发资料中，所用用户附件按原归属恢复到本次输入。

旧 `rewind` 的重新生成合同继续支持原调用方。文件恢复由 `restoreFiles` 单独控制，按逻辑执行关联快照并核对现有文件。来源变化按消费关系撤销执行贡献，已回答事项的回应来源变化后重新开放有效问题。

逻辑备份包含独立消息、执行、待回应事项、来源关系、角色状态事件、亲历和所引用的房间记录，并重写发布、执行与消息来源编号。导入的主线与本机另一条主线冲突时，以侧线保留导入会话。运行中的执行恢复为中断记录，等待现场按有效来源保留。逻辑导入将携带的据点回复意图标为已结束，完整快照保留原意图用于恢复。整库恢复由数据库迁移保留或补建主线。

心流通过 `(thread_id, agent_id)` 唯一索引参与逻辑导入的冲突识别与跳过、替换处理，导入时重写角色及会话引用。导入后归属侧线的亲历继续作为历史资料保存，据点编译与待回应目标只选择当前有效 MainThread 的亲历。

已有房间及公共消息沿原记录保存，新消息按实际在场者生成当前主线代次的亲历。历史可见关系按已保存来源读取，旧隐藏会话保留其原有历史归属。

分布式快照写出 `schemaVersion=2`，当前实现可读取版本 1 并迁移。旧客户端对新快照执行版本拒绝，避免把主线当作普通旧会话操作。

## 源码入口

- `database/schema.ts`、`database/migrations/0025_main_side_threads.sql`
- `repositories/thread.repo.ts`、`services/thread/threadService.ts`、`services/thread/threadForkService.ts`
- `repositories/conversation.repo.ts`、`tools/conversation`、`packages/shared/src/conversation.ts`
- `services/conversation/conversationTurnService.ts`、`conversationQueueService.ts`
- `services/agent/petStateService.ts`、`services/context/contextCompiler.ts`
- `services/stronghold/groupChatService.ts`、`strongholdRoundService.ts`、`strongholdTurnService.ts`
- `services/memory/eventMemoryFallbackService.ts`、`eventNoteDraftCommitter.ts`
- `services/prompt/sillyTavernVariables.ts`、`services/maintenance/privacyDeletionService.ts`
- `projections/conversationProjectionService.ts`、`conversationSurfaceSession.ts`
- 前端 `stores/useThreadStore.ts`、`stores/usePetStateStore.ts`、`components/compositor/ConversationSurface.vue`
