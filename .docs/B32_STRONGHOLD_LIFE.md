# 据点生活、活动与关注

## 数据与身份

据点是主应用场景。角色使用唯一 MainThread、当前代次和共享心流，公开消息仍由房间持有。`stronghold_life_records` 保存参与、交流、活动、邀请、关注、用户在场状态及操作回执。每项记录携带身份、房间、修订和来源，结构由 `packages/shared/src/strongholdLife.ts` 定义。

参与记录按 `threadId + generation` 唯一定位，引用当前交流与活动。状态包括 `available / listening / conversing / occupied / resting`，实际执行占用由 Kernel 和主线运行时管理。主线重置后旧代次参与与关注失效，公共活动继续保存，旧成员标为暂离，后续本人加入建立当前代次关联。

生活事件复用 `group_chat_messages` 的系统消息。`metadataJson.lifeEvent` 保存种类、行为者、关联对象及结构化内容，`agent_experiences` 固定实际见证者。状态、消息、亲历与 Outbox 在同一 SQLite 事务中提交。操作回执与 `deliveryKey` 分别防止状态重复应用和公共事件重复发布。

## 交流与参与结果

`finish_task.participation` 可提交参与姿态、表达目的、交流对象、交流或活动引用及预期参与修订。正式发言与参与结果共同落盘，静默执行通过 `finishSilent` 保存参与决定和关注消费位置。

`share / question` 为下一位有效伙伴登记接话意图，明确对象优先，原交流成员按发言位置轮转。程序检查当前位置、角色自主设置、参与姿态和该交流中已有的待回复请求。普通候选避开专注与休息角色，明确对象继续按其有效自主授权处理。

接话请求保存 `responseContexts`，固定原发起者、发起消息及本次回应阶段。发起者的邀请或分享先交给接收者处理，接收者处于 `response`。接收者向原发起者追问、提交邀请回应或兑现已有等待时，原发起者取得 `settlement`，完成澄清或回报结算。回应中的独立分支，以及结算阶段产生的新问题、传唤与新邀请，进入持久空闲等待，恢复时按这些阶段继续处理。

传唤、`finish_task.next_activity`、自然接话及关注均经同一个请求入口核验。`deferredAgentIds` 保存延后接收者，`deferredUntil` 沿用 60 秒安静窗口。Kernel 的普通回复扫描只领取即时队列，ProactiveService 的正常空闲机会再通过 `runIdle` 领取一条有效延后请求。领取后优先处理原文，保持角色冷却及房间串行，`freshInitiativeAgentIds` 标记本次取得了新的自主机会。请求核验来源主线、目标主线、代次、位置、亲历与邀请状态，失效时结算旧请求。

交流采用 `active / quiet / closed`。当前回应及即时队列结算后进入安静，当前默认安静窗口为 60 秒。延后事项保持独立待接续身份。到期收束仅释放仍指向该交流且处于交谈状态的参与记录。共同活动和有效关注沿各自状态继续保存。

显式用户请求优先于同房间尚未执行的自主接话。房间串行、主线注意力、执行取消与已发布回复复用继续由原轮次链路负责。来源消息的 `replyIntent` 固定目标主线和代次，恢复读取同一个请求。

空闲执行跳过专注、休息角色，以及处于旁听且已有持续关注的角色。明确输入与已命中条件通过持久请求接续。状态推进与事件匹配由规则完成，模型在实际接话或有效空闲机会中决定表达与后续参与。

## 活动与邀请

`stronghold_activity` 只在据点通道开放，提供下列操作。

| 操作 | 合同 |
| --- | --- |
| `list` | 读取当前活动、邀请及其最新修订 |
| `create` | 建立活动，本人作为参与者加入 |
| `update` | 实际参与者更新标题、说明或公共进展 |
| `join / leave` | 调整本人的参与关系 |
| `pause / resume / end` | 实际参与者推进活动生命周期 |
| `invite` | 向在场伙伴提出邀请，相同有效邀请复用原身份 |
| `respond` | 接收者接受、拒绝或稍后回应，发起者可以取消 |

活动采用 `active / paused / ended`，成员分别保存 `participating / observing / away / left`。修改提供当前 `id + revision`，并发旧修订返回冲突。成员加入只由本人操作或本人接受邀请提交。最后所有成员明确退出时结束活动，实际参与者全部离场时暂停并保存进展。

相同进度、已生效的暂停状态及相同成员状态沿原修订返回，实际变化再发布事件。邀请的相同有效回应沿原状态结算，关注据实际事件匹配。

邀请默认有效 15 分钟，可传 `expiresAt`。接受时重新核验接收身份、代次、位置、邀请状态及活动有效性，成员加入与回应事件同事务提交。角色发起的邀请按对方据点自主设置唤醒，用户直接邀请建立显式请求。过期、来源撤回、离场或主线代次变化由恢复程序结算。

## 生活事件与持续关注

成员出入和环境变更通过 StrongholdService 的领域事务产生事件。跨房间移动分别固定旧房间离场见证者和新房间到达见证者，操作者与实际移动者按各自身份核验。环境相同值更新直接结束。用户通过明确进入、离开或真实发言确认在场，重复操作沿原回执恢复。

`stronghold_watch` 提供 `list / set / cancel`。关注只向本人装配，条件覆盖特定人的消息、被提及、成员出入、环境字段、邀请、活动和约定到时。记录保存意图、有效期、来源、观察位置、待消费消息和已登记请求，默认有效 24 小时。较晚的约定延长至到时后 60 秒，也可提供明确的 `expiresAt`，到时条件采用一次性消费。

事件先核对来源有效性、本人代次、位置和实际亲历。同一角色同一房间的多个命中在恢复轮次中合并到最新有效来源，建立一次请求。真正开始执行时固定 `processingMessageIds`，排队期间追加的变化随本次装配一起处理。正式回复或静默结算后消费这份输入快照，连续关注保留执行中新到达的事件。时间条件以稳定身份保存真实到时事件，重启复查沿该事件恢复。

本人的发言和本人操作经过确定性过滤，到时事件沿其专用条件处理。请求通过 `watchIdsByAgent` 保存本次消费的关注，执行产生的发言与动作继续携带 `lifeWatchIds`、`lifeWatchAgentIds`。同一关注因果链中，已处理角色的后续回声沿消费身份过滤，重新登记关注仍受该来源关系约束。新的外部事件或正式领取的新自主机会建立新的匹配关系。关注命中直接处理并结算本次条件，后续独立话题按空闲机会接续。

关注通常由本次来源消息锚定。空闲执行静默登记的关注由简短公开动作事件锚定，意图仍保存在本人关注中。自主关注遵守角色设置，来自真实用户安排的条件保留显式接续属性。过期、离场、来源失效或代次变化结算为终态。

## 上下文与记忆来源

`StrongholdLifeContextProvider` 为桌面主线和据点执行提供当前房间生活资料及本人关注，沿 ContextCompiler 的 continuity Region 参与预算选择。实体身份与修订进入 Manifest。SideThread、后台任务及 Social Realm 使用各自装配范围。

据点执行通过 `StrongholdLifeService.retrievalQuery` 单独组织自动召回线索，经 `ConversationTurnService` 传给 ContextCompiler，用于事件记忆、知识与事实召回。普通接话使用真实来源发言、发言者和直接关联活动。关注执行使用同一请求命中的本人意图及 `processingMessageIds` 固定的事件，活动取标题与进展，环境取实际变化字段，到时事件取约定意图。来源超出历史窗口时仍直接读取有效原文。

空闲执行使用主线心流的 `currentGoal` 及本人正在参与或旁观的活动标题，优先当前参与记录指向的活动，其余情况仅选唯一有效活动。线索为空时显式跳过自动召回。完整房间、成员档案、可见历史和执行指令进入本次模型场景输入。检索文本与场景输入分别传递。

公开事件的结构化载荷随亲历进入 `queryMemoryExperiencesThrough`，保留源消息编号、活动修订、公共进展和成员关系。后台沿既有 `experience:<id>` 覆盖键、角色开关、来源校验和遗忘截止加工事件记忆，日记与记事本继续按各自职责维护。记忆的归并、生长和检索策略在记忆领域演进。

消息撤回取消相关关注、邀请和调度，公共活动保留来源变化标记。删除核心记忆继续由记忆领域处理，历史来源的有效性由消息与亲历合同维护。

## 恢复、备份与客户端

Kernel 的 `stronghold-life-recovery` 每 5 秒核对生活状态并恢复持久回复请求。核对本身执行规则，接话仍经过 StrongholdRoundService 和 KernelScheduler。服务重建读取数据库状态、回应阶段、关注消费与回执，延后请求保留空闲等待属性。旧代次、无效亲历、离场及过期邀请在再次处理前结算。

逻辑备份将生活记录纳入对话模块，并跟随所选主线及其房间来源选择。导入重写角色、Thread、对象与消息引用，关注和待回应邀请取消、交流收束、活动暂停且成员暂离。完整备份和分布式快照包含权威 SQLite 数据，恢复后执行当前迁移与生活状态核对。全量清空记录及恢复出厂覆盖生活表。

据点 Projection 的 `life` 提供公开参与、交流、活动和邀请。前端右侧面板可确认用户在场、发起活动、加入退出、暂停恢复、结束和处理邀请。客户端仅提交意图，服务端校验修订并提交事实。

用户操作入口为 `POST /api/stronghold/rooms/:roomId/presence` 和 `/activities`，操作携带 UUID `operationId`。`GET /life` 读取公开快照。活动修改提供当前修订，失败后重新读取现场。

## 源码入口

- `database/strongholdLifeSchema.ts`、`database/migrations/0036_stronghold_life.sql`
- `repositories/strongholdLife.repo.ts`
- `services/stronghold/strongholdLifeService.ts`、`strongholdActivityService.ts`、`strongholdWatchService.ts`、`strongholdLifeContext.ts`
- `services/stronghold/groupChatService.ts`、`strongholdCausality.ts`、`strongholdRoundService.ts`、`strongholdTurnService.ts`、`strongholdService.ts`
- `tools/strongholdLife`、`tools/finishTask`、`routers/stronghold.router.ts`
- `projections/strongholdProjectionService.ts`、`components/stronghold/StrongholdLifePanel.vue`
