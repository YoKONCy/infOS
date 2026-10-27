# 成就与 Steam 提交

> 状态：已接入内部成就、总览展示和可选 Steam 提交；Steam 后台定义与发布须单独配置。
> 更新时间：2026-10-27。

## 职责与身份

成就定义位于 `packages/shared/src/achievements.ts`。服务端拥有达成事实，客户端负责展示，Electron 主进程是 Steam 提交适配器；后端不导入 Steam SDK，也不向 Agent 注册解锁工具。

当前客户端接入系统只有安装实例管理凭据与配对设备凭据，没有独立用户账号体系。首版以服务端鉴权得到的 `ClientIdentity.id` 作为 `subject_id`，跨角色共享，同一服务端不同配对身份不共享记录；使用同一管理凭据的客户端属于同一身份。设备重新配对产生新身份时，不自动认领旧设备记录。不能将此范围宣传为已实现跨设备用户账户。

HTTP 请求不接受自报成就身份。`chat.router` 从凭据取得身份，仅为普通生成传入 `achievementSubjectId`；队列输入持久化此内部字段，恢复时保留原身份，不按消费队列的客户端重新归属。既有队列没有该字段时不追认。

## 首个成就：崭新启程

内部 ID 为 `fresh_start`，Steam API Name 为 `ACH_FRESH_START`，描述为“完成与角色的首次有效对话。”。

判定位于 `ConversationTurnService.persistAssistant`：输入由普通 HTTP 对话入口提供身份，包含非空正文或已接受的附件，属于 desktop 持久对话，正式回复非空，且未主动发起、未交接、未暂停、未取消。临时输出、后台任务、Realm 内部调用、续写/重生成及恢复内部执行不产生首次达成。

普通执行和流式执行共用此保存入口，队列使用流式入口。模型执行失败走 `persistFailedAssistant`，不会携带成就。回复中的任务失败说明或正常拒绝仍可以是有效对话，不另调用模型评价回答质量。

`ThreadService` 把已判定的成就随回复传入 `ThreadRepository`；消息与达成行在同一个 SQLite 事务内提交。复合主键 `(subject_id, achievement_id)` 保留首次时间和来源消息，重复事件与切换角色不会重复写入。事务回滚时两者都不保留，因此不依赖瞬时 WebSocket 推送，也不需要扫描全部历史补记。

旧历史没有可靠的发起客户端归属，不自动据此解锁。已有用户升级后完成一次符合规则的新对话即可达成。删除某条对话、删除角色或重置记忆不撤销成就；恢复出厂设置清理内部记录，不调用 Steam 的成就重置接口。

## 存储与接口

`0024_achievements` 增加 `achievements` 表：身份、成就标识、首次时间、来源消息、首次 Steam 账号及提交时间。`achievements.sourceId` 配置用于区分服务端成就通知来源，不是凭据。完整 SQLite 备份保留成就。

- `GET /api/achievements`：只返回当前鉴权身份的目录与达成状态，未解锁项的时间为空。
- `POST /api/achievements/steam`：只对已达成项认领 Steam 账号或记下 SDK 提交回执；不能解锁成就。首次账号绑定后不允许覆盖为另一账号。

账号和回执是已认证客户端报告的提交关联，不是服务端验证 Steam 登录票据的证明，不提供反作弊或 Steam 身份认证承诺。界面显示“已提交 Steam”，不把 SDK 接受请求冒充 Steam 云端确认。

## Steam 适配

`electron/main/services/steamAchievements.ts` 自行读取已选择服务器和凭据，取得快照后，仅处理共享目录允许的成就 ID。渲染进程的 `steam-achievements-sync` 不接受账号、成就名或服务器参数。Native API 名称来自本地内置目录，不使用服务器给出的任意 API 名称。

提交顺序：检查当前 Steam 用户 → 读取当前服务端记录 → 认领账号 → 调用现有 `steamworks.js` 成就与统计接口 → 报告提交时间。每次异步返回后核对服务器、凭据和 Steam 用户，避免切换连接后串用结果。网络请求有超时、禁止重定向，不转发聊天内容或个人配置。

启动后和每分钟尝试补交，窗口收到正式回复通知或重新获得焦点时也可请求提交。已完成的记录通过 SDK 状态跳过重复写入。Steam 不可用、后台成就未配置或接口失败时保留内部成就，后续重试；退出时停止后台调度。Steam 账号不匹配时只提示使用首次绑定账号，不向新账号重放。

Steam 后台的配置、图标与文案见 `resources/steam/achievements/README.md`。该配置未发布前，不能把本地代码完成等同于 Steam 上已可解锁。

## 客户端投影

总览的旅途成就卡片显示锁定、达成日期及 Steam 提交状态，复用像素卡片和主题变量，徽章来自同一 SVG，Steam PNG 也由此导出。文案维护简中、繁中、英文。

`useAchievements` 在鉴权后读取快照，订阅回复就绪、连接恢复与窗口焦点事件，并每分钟补读一次。推送仅触发刷新，不能直接解锁。退出鉴权时清空投影，进行中的旧读取不能覆盖新身份状态。

产品通知以服务端来源、身份与成就 ID 去重，仅在聚焦窗口显示；SDK 已接受提交时不再额外显示产品 Toast，避免与 Steam 提示重叠。Steam 未完成提交时仍可显示产品内达成通知。

## 源码入口

- 规则与落盘：`services/conversation/conversationTurnService.ts`、`services/thread/threadService.ts`、`repositories/thread.repo.ts`。
- 查询与关联：`repositories/achievement.repo.ts`、`services/system/achievementService.ts`、`routers/achievements.router.ts`。
- Steam：`electron/main/services/steam.ts`、`steamAchievements.ts`。
- 展示：`packages/frontend/src/stores/useAchievementStore.ts`、`composables/system/useAchievements.ts`、`components/achievements/`。

扩展市场和工坊发布不属于本成就系统的当前实现。
