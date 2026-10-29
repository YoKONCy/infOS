# 社交应用：编排、账号与交付

社交应用把同一人格在不同平台的账号映射到独立会话，负责入站持久化、参与决策、消息发送及恢复。宿主提供收窄的能力端口；平台差异留在适配器，通用运行时不解释 OneBot、Telegram 或 Discord 原始字段。

## 模型入口与业务能力

模型只调用 `social_act`。普通生成文字不发送，也不作为角色发言入库。日常回复使用 `{"reply":"正文"}`；查询与复杂工作通过 steps 编排，call 步骤调用当前目录里的能力。`social`、`social_group`、`social_account` 是目录中的业务能力，参数为 `{action,input,account_id?}`，不是与 social_act 并列的模型 FC 工具。

```json
{
  "steps": [
    { "op": "call", "tool": "social_group", "args": { "action": "state_get", "input": {} } }
  ]
}
```

每种 action 有独立输入结构，业务定义与校验在 `packages/shared/src/socialTools.ts`、`runtime/socialCommonOperations.ts` 和各适配器操作表中。`socialActDefinition.ts` 将当前授权目录嵌入入口参数，`socialOrchestration.ts` 执行步骤、引用、依赖和恢复。兼容执行器名称只供内部路由，不能据其存在认定仍向模型暴露独立工具。

不支持 anyOf 的模型传输层可合并分支的可选字段，但须保留 action 参数说明；执行层仍用原始结构校验。参数兼容不放宽身份、操作范围或权限。

## 参与行为与执行生命周期

- `pass` 结束不参与；`wait` 等待补充；`observe` 关注指定事件至到期；`defer` 保存稍后重新判断的意图。它们属于同一入口，不能绕过发送控制。
- steps 的 call/send/wait/observe/if/parallel/yield 由编排器解释。parallel 仅并行独立只读调用，条件使用真实结果；需要理解内容或组织措辞时交回模型。
- `messages[].delay_ms` 从前一步完成后起算，表示已决定内容的延迟发送；`after` 表示发送后继续关注，两者不等同于 defer。
- 结果引用使用 `{"$ref":"步骤ID.data.字段"}`，成功依赖须声明 depends_on。默认普通发送结束，查询返回模型；显式 next 控制继续或结束。
- 步骤结果与已发送部分分别保存。后续失败不能抹除已确认发送；相关新消息可取消剩余发送并重新判断，其他会话不能任意打断。
- reason/intention 记录简短行为理由和后续关注点，不作为平台正文，也不记录逐字内部思考。停止、切换角色或清理会话须取消未执行部分。

入口 Schema 负责精确参数，`prompts/social_rules.md` 维护跨操作的行为指导，适配器提供当前平台变量和能力差异。维护时避免重复大段规则，更不能向模型塞入存储、调度器或迁移过程。

## 平台提供的业务范围

- 日常社交：联系人与资料、备注、好友申请和删除、历史消息与转发、图片与资源、收藏表情、资料卡点赞、戳一戳、消息回应与撤回、已读、联系人记忆、主人私聊模式和状态卡片。
- 群事务：群资料与成员、名片、群名与头像、禁言和成员管理、入群申请、公告与精华、群文件与目录、相册查询上传和互动。
- 账号与空间：资料、签名、头像、在线状态；文字与多图说说、可见范围、发布记录和删除；好友动态、说说列表与详情、点赞、评论和转发。
- 等待、延后由 social_act 行为参数处理；任务控制、私有心流与宿主通信按当前身份加入 call 能力目录。上列业务是适配器能力的并集，不表示所有平台都支持全部操作。

## 平台边界与调用链

### 同一人格、账号与任务闭环

桌面与社交使用同一个 `agentId`。`AgentAccountIdentity` 区分人格、平台和账号，`AgentConversationIdentity` 再区分私聊、群聊和会话。各入口共享人格与已授权工作状态，历史、心流和发送权限仍按会话隔离。主人在任一已绑定平台的私聊中可通过 `social_act` 的 call 步骤调用 `manage_task` 查询同一人格的任务；结果仍按创建时的原始来源投递，不因查询入口改变而转发。

宿主通过收窄的 `SocialHostCapabilityPort` 提供当前工作摘要和浏览器工具，每次调用重新核验平台、已连接账号和主人身份。仅已绑定主人私聊获得该端口的浏览器能力，普通联系人与群聊不继承主机权限。工具复用主应用的 RegistryToolExecutor、策略检查、审批、取消与回执；不提供通用终端或直接读取 Cookie 的接口。视觉关闭时不提供截图工具，客户端浏览器离线时不生成工具定义。

浏览器登录分区按人格和平台账号派生，会话分别持有活动页面；背景任务继承来源账号的登录分区，使用自己的页面会话。页面切换、关闭、下载记录和站点存储受该范围约束，模型参数不能覆盖宿主绑定。NIT 内部调用继续传递同一范围。

主应用的 `interact_with_social` 显式接收 `platform`、`account_id`，通过现有后台任务系统持久化派发并返回任务编号。执行器使用稳定关联号调用 `chat_in_group`；托管编排返回 `waiting`，由任务续行查询 `get_task`，真实终态才提交交付。取消传播到 `cancel_task`；派发记录丢失时进入阻塞，避免自动重复发送。委派继承父 Execution，不能占着一个后台槽位再等待同类槽位。任务、宿主咨询与每日记忆回流按当前 persona grant 路由，不沿用启动时的旧角色。

普通后台任务的社交结果先以稳定投递编号写入原私聊历史，再通过原平台发送；历史中的“已生成”不代表平台已送达。发送失败或结果不明仍由 TaskDelivery 的独立账本处理，不能把 uncertain 当作完成。父任务等待子任务后获得实际结果、失败原因、产出引用和验证等级。

取消或修改任务时，同一修订事务保存 `cancellationPending` 意图；先撤销全部子任务，再收口外部委派。应用离线或进程中断后由续行扫描重试取消。旧委派尚未收口时不执行修改后的新任务，也不允许删除唯一的取消记录。

通用运行时只依赖 `AbstractSocialAdapter`、`SocialOperationProvider` 和存储端口。`adapters/registry.ts` 是内置适配器装配根，已注册 QQ/NapCat、微信 ClawBot/iLink 私聊、Telegram Bot 和 Discord Bot；新增平台通过设置页显式启用，旧配置继续只启动原 QQ 网关。以后新增平台无需向通用调度器、桥接层或宿主增加协议判断。

- 适配器负责连接、规范化消息、私聊目标解析、附件准备、历史分页和可选能力。原始 OneBot 字段、数字 QQ 号、`message_seq`、QQ 表情与空间访问全部留在 `adapters/napcat/`。
- `SocialOperations` 按可信现场的平台路由业务；`SocialCommonOperations` 提供本地群状态机与机器人标记。其他平台无需实现 QQ 业务即可使用这些通用操作。平台业务只暴露自身支持的动作。
- call 中的业务能力使用 `{action,input,account_id?}`。平台由所在回合绑定；多平台场景缺少选择时失败，不能默认落到第一个适配器。普通联系人不能切换账号。群状态配置即使在主人回合也只能修改当前账号、当前群。
- 宿主通过应用清单的 `chat_in_group` 委派社交任务，参数包含 `group_id`、`intent` 和可选 `platform`、`account_id`；有多个候选时必须明确选择。宿主任务控制与创作投递通过社交应用注册的端口核验身份，不解释 QQ 配置；私聊会话标识不要求等于主人用户标识。
- 动作权限元数据由提供者声明，宿主策略执行器据此审批，不再导入 QQ 动作表。内部权限元数据不发送给模型；未知社交动作采用保守审批策略，平台执行器再次校验权限。

### 连接配置与生命周期

`social.connections` 是连接配置数组，每项包含 `id`、`adapter`、`enabled?`、`ownerId?` 以及适配器自己的设置。例如当前 QQ：

```json
{
  "connections": [
    { "id": "qq", "adapter": "napcat", "ownerId": "12345678", "enabled": true }
  ]
}
```

当前每个平台注册一个网关，由该网关管理多个登录账号；禁止重复平台或重复连接标识，不能通过增加同平台配置项创建多个入站消费者。平台 ID 使用小写协议标识，用户、账号、会话与消息 ID 是有长度限制的不透明字符串，通用层不要求数字。

缺少 `connections` 的旧配置在装配根转为默认 NapCat 连接，兼容顶层 `ownerQq`、旧群策略和无平台前缀名单。新名单使用 `平台:标识`；旧无前缀身份只归属于声明兼容的旧适配器，不能匹配其他平台。更新主人配置会撤销该平台持有旧身份的会话；禁用或替换连接会注销业务提供者、释放传输入口并断开连接。配置更新串行执行，停止时先取消等待中的连接操作。新适配器的 `connect(signal)` 必须响应取消，`disconnect()` 必须清理重连与监听。

反向 WebSocket 宿主只处理传输租约，入口为 `/api/social/ws?platform=qq`。平台声明账号请求头，宿主不读取 OneBot 字段。旧 URL 仅在唯一传输入口时可省略平台；多个入口时拒绝隐式选择。Electron 生成的 NapCat 配置已显式指定平台。旧 NapCat 注册函数仅作为宿主兼容别名保留，新装配使用 `registerSocialTransport`。

### 身份、存储与历史

消息、会话、回合、队列、删除屏障、重放上下文与群策略均包含平台和账号范围。消息唯一键为 `(角色,平台,账号,会话类型,会话标识,消息标识)`；不同平台、账号和群允许使用相同消息 ID。消息查询必须在数据库执行 LIMIT 前筛选身份；无法唯一定位的旧式消息查询明确失败。

入站消息在适配器边界转换为 `messageId`、`accountId`、`timestampMs`、`isMentioned`、附件与引用等规范字段。原始事件保留诊断信息，恢复时由对应适配器解释旧格式；通用核心不读取原始 OneBot 字段。历史游标是不透明字符串，分页解释由适配器承担。

迁移 `0023_social_platform_scope.sql` 为回合和删除屏障补充平台范围，重建消息唯一索引与待处理队列；旧回合按已保存的规范事件回填，缺少历史身份时兼容归属 QQ。迁移随正常数据库启动执行，不能跳过迁移直接使用新代码。迁移的旧数据兼容分支应通过独立夹具验证，不能把当前用户库当作试验数据。

前端通用连接列表、主人设置、状态与数据管理按平台工作；NapCat 安装、登录、进程和终端设置独立在 `components/social/platforms/NapcatSettings.vue`，由前端平台注册表装配。收藏表情按平台和账号选择，未实现该能力的平台不提供收藏入口。

### 设置界面的平台层级

本页沿用 infOS 既有的直角像素风。平台入口、图标底座、配置面板、输入框、标签和二维码容器均使用直角，不另引入圆角卡片风格。

QQ、微信、Telegram、Discord 是固定的一级入口，未启用的平台也保留自身的接入页，进入页面不自动启用连接。各平台内再提供连接与账号、联系人和会话数据等二级功能，切换平台时返回该平台的连接页。

- QQ 使用独立的 `QqSettings.vue`，承载 NapCat 进程、管理页、日志与主人 QQ 号；收藏表情和状态卡片只放在 QQ 的二级导航。
- 微信使用 `WeixinSettings.vue`，围绕二维码、扫码确认、验证码和私聊账号组织页面；过期二维码不再展示为可扫码图片，不提供群聊设置。
- Telegram 使用 `TelegramSettings.vue`，独立展示 BotFather、Token、群隐私配置、群组和论坛话题说明，以及数字主人 User ID。
- Discord 使用 `DiscordSettings.vue`，独立展示 Bot Token、Message Content Intent、服务器与频道授权、线程权限和主人 User ID。
- 角色、跨平台默认社交策略与全局维护位于独立的“通用设置”，明确作用于全部平台。平台内联系人按平台过滤，会话清理固定当前平台；会影响全部平台的数据清理只在全局维护中提供。

各平台可以复用请求生命周期、账号列表和基础表单组件，但不再使用带平台分支的通用登录页面。切换页面会取消旧管理请求、停止轮询并清除前端持有的 Token 和验证码。

## 群聊状态机与主动观察

普通社交聊天的可靠恢复记录使用 `kind:conversation`，主 Agent 明确委派的单次社交工作使用 `kind:task`。工具调用、步骤失败、PASS、等待和编排都不会把普通聊天升级为任务。任务中心只请求 `kind=task`；社交配置的“社交回合”区域保留恢复状态与诊断记录。旧记录按 `social:command:` 委派标识兼容分类，普通记录默认视为聊天；不清理现有数据。存储层在终态 100 条数量限制之前按分类筛选，避免聊天流量挤掉真正任务。

会话按平台、角色、平台账号、会话类型和会话标识隔离。主动观察单独记录 `nextReviewTime`，不再共享跨群观察名额或 20～40 分钟的全局冷却；重试、延后意图和托管编排继续使用各自的唤醒状态。共享请求限流仍属于资源保护，不代替群聊状态机。

默认每群首次观察在收到新消息约 30 秒后具备时间条件，正常观察间隔 180 秒；仍需至少 3 条待观察消息，且不处于运行、收集、重试、延后或托管编排阶段。轮询间隔 10 秒，默认 0～8 点静音。观察批次与缓冲容量覆盖 1～20 条的门槛；各群在同次扫描中分别唤醒。主动观察给予角色判断机会，不保证必定发言。

参与节奏分为活跃续聊、普通旁观与低活跃。回复后默认保留 120 秒活跃续聊；普通 PASS 会立即退出续聊，当前回合执行期间积压的普通消息留在观察缓冲，不再以三秒续聊窗口请求模型。排队的新提及独立保留，并在领取批次时优先纳入。私聊不采用群聊 PASS 退避。

群聊连续前三次 PASS 分别设置 10、20、60 分钟的最短观察冷却；第四次进入 `mention_only` 低活跃。冷却结束仍需足够的待观察消息，不进行空轮询。修改默认策略或群覆盖不能缩短已经生效的 PASS 冷却。明确的新提及在开始处理时重置连续计数和退避；实际回复也重置计数。普通消息、重试与恢复同一完成回合不会重置或重复增加计数。

低活跃不因消息量、时钟或重启恢复自主观察。新的群提及仍可开启短暂交流，回复后续聊自然到期或再次 PASS 时回到低活跃；一次提及不会永久恢复自主观察。`social_act({"low_activity":true})` 可主动进入，也可与 `reply` 或 `messages` 合用，在本轮结束后进入；仅适用于普通群聊回合，不能与等待、延后、yield 或 `next:continue` 混用。既有明确请求及其有限重试不丢弃。该模式限制群聊自主唤醒，不暂停独立的社交记忆整理与明确委派任务；委派任务不修改群聊模式与 PASS 退避。

`socialActivityStore.ts` 将模式、连续次数、冷却截止时间和最后一次已应用的回合 ID 保存于配置键 `social.groupActivity`，按平台、角色、账号和群标识隔离；不保存正文。更新串行合并，持久化成功后发布内存状态，回合 ID 防止重试重复累计。Bridge 在连接适配器之前加载状态；加载失败时不以默认活跃模式继续启动。普通回合在提交终态之前保存节奏，终态恢复记录仅保留必要的退出与低活跃布尔值。

“通用设置 → 社交模式 → 群聊参与节奏”显示各群模式、连续 PASS 次数、最早观察时间，并提供“恢复正常观察”。对应 `GET /api/social/group-activity/:agentId` 和 `POST /api/social/group-activity/:agentId/resume`；恢复请求必须指定当前角色所属的已连接平台账号和群，清除退避并重新按正常观察间隔等待，不复活旧计划。

设置页编辑默认策略，Agent 在 `social_act` 的 call 步骤使用 `social_group` 的以下操作：

- `state_get`：`input:{group_id}`，读取实际策略、群覆盖、待观察消息数、当前阶段、门控原因与下一次观察时间。
- `state_configure`：`input:{group_id,policy:{...}}`，部分更新本群的 `proactiveGroupEnabled`、`minMessagesForReview`、`reviewIntervalSeconds`、`nightSilenceEnabled`、`nightSilenceStart`、`nightSilenceEnd`；或使用 `input:{group_id,reset:true}` 恢复继承默认策略。观察间隔范围 30～3600 秒。

社交回合省略群号时自动补入当前群；即使是主人回合，也不能借此修改当前会话之外的群或账号。宿主主应用可显式选择已连接账号和群号。群覆盖存于 `social.mode.groupPolicies`，按平台、角色、账号和群标识索引。配置校验与调度器共用共享类型和范围，串行持久化成功后才应用到运行时，并返回实际生效状态；保存默认设置不会覆盖旧页面载入后由 Agent 新增的群策略。外部修改 `social` 配置也会即时同步。

普通历史会话不再恢复为无账号的空观察会话；未完成回合与明确请求按原账号恢复。旧聊天历史不会仅因重启而被重新当作新话题发送。发送仍必须通过 `social_act` 提交，群策略配置不代替发言，也不解除互聊保护。

`social_act.end_participation` 默认为 false。单独提交 `{"end_participation":true}` 等同于不发言并退出本会话的活跃续聊；与 `reply` 或 `messages` 合用时，确认本轮结束后退回 `idle`。退出决定随编排计划持久化，经 `end_participation` 结果字段传递为终态 Outcome 的 `endParticipation`；会话管理器清理活跃计时，保留正常群观察规则和排队的新提及。它不退出群、不禁用会话，也不影响其他账号或群。退出不能与等待、延后、yield 或 `next:continue` 合用。

普通 `pass` 会退出 `engaged`，并按上述规则推进群聊退避。纯 PASS 可在互聊保护已阻止继续执行时收尾，但不绕过取消、不执行能力或发送，也不重置保护预算；夹带步骤或发送的 PASS 在参数校验阶段拒绝。已经确认送达的内容仍保留原交付结果，后续 PASS 不回滚发送。低活跃与互聊保护分别管理参与意愿和资源预算，手动恢复观察不能解除互聊保护。

修改调度时重点保护多群独立推进、消息门槛、当前群作用域、配置持久化失败与即时同步，以及跨平台同标识隔离。

## 空间实现

发布与删除使用 NapCat 4.18.38 原生 `send_qzone_msg`、`delete_qzone_msg`。每次发布保存 tid、正文、可见范围与时间；删除后标记记录。可见范围显式指定为 public、friends、selected、private、exclude；selected 和 exclude 必须提供 target_uins。

浏览与互动通过 NapCat 获取当前账号的临时空间凭据，访问固定空间 CGI 地址。凭据不落盘、不暴露给模型。只解析 JSON/JSONP 与动态数据，不执行返回脚本、不跟随重定向；响应有超时和大小上限。查询返回账号绑定、30 分钟有效的 post_id，详情和互动只能使用该引用。

空间 CGI 不属于 NapCat 稳定 OneBot 契约，仍需实号联调确认不同账号权限、网络和服务端响应。接口错误必须返回失败，不能伪装为空列表。

协议核对来源：[NapCat 4.18.38](https://github.com/NapNeko/NapCatQQ/tree/v4.18.38/packages/napcat-onebot/action)、[空间发布](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-onebot/action/extends/SendQzoneMsg.ts)、[空间 CGI 参考](https://github.com/Eganchiyu/qzone-sdk/tree/main/src/qzone_sdk)。

## 结果不明的操作

写操作在发出前保存操作日志，并按账号串行。相同调用恢复时复用已完成结果；相同参数的 pending 或 uncertain 操作会阻止重复提交。超时、取消、断连或投递后记录失败均不能直接自动重放。

主人可用 social_account.operations 查看记录，核对实际结果后通过 operation_resolve 标记 completed 或 not_sent。未确认的日志不随普通历史截断丢弃。说说发布记录独立保留最近 500 条。

## 收藏表情

### 按需视觉与原生表情

入站和引用上下文提供消息正文、占位及可选图片来源，不再自动附带图片像素。Agent 可在 `social_act` 的 `call` 步骤调用 `social` 的 `image_read`，参数为 `input.message_ids` 和可选 `max_images`（1～3，默认 3）；不需要看图时无需调用。读取后以 `yield` 或 `next:continue` 返回当前模型，再依据实际画面组织回复。

单次图片读取最多三张，同一入口编排多个读图或其他视觉步骤时，多模态输出去重后总计仍最多三张，额外图片数量通过 `images_omitted` 返回。图片只通过多模态部分传递，文字观察保留数量与来源，不复制 base64。读取范围固定于当前平台、角色、账号和会话；未入库的引用通过对应适配器读取，并核验返回的来源范围。取消向上传播，不能降格成“图片不存在”。

QQ `face` 原生表情与普通 `image` 附件分别处理：`[QQ表情:编号]` 是入站占位，不代表已获取画面；有平台提供的实际图片资源时可读取，否则返回 `native_emoji_no_pixels`。可用 `emoji_list` 获取真实来源引用，再用 `[native_emoji:来源引用]` 复用，不拼接或猜测图片地址。NapCat 在完整正文拆分前及最终协议转换时拒绝直接发送 QQ 入站占位，返回 `DELIVERY_NOT_SENT`，不静默丢弃正文或擅自按编号转发表情。

收藏属于平台账号资源，不能从角色资源包或另一个平台推导收藏权限。

### 使用方式

- 表情归属 QQ 账号，由 NapCat 的收藏管理接口读写。角色资源包不再提供预设表情，旧 `use_stickers` 配置读取时忽略。
- 模型经 social_act 调用 social 的 `sticker_list`、`sticker_search`、`sticker_read`、`sticker_collect`、`sticker_describe`、`sticker_delete`。内部 legacy 执行器 social_sticker 不作为单独 FC 入口。
- 回复使用 `[sticker:查询返回的ID]`，桥接层按原有位置交错发送文字与表情。发送前重新核验账号收藏；失效标记不泄露给用户，也不记为发送成功。
- 工具仅接入社交回合，不注册到主 Agent 工具库。账号由可信入站消息绑定，模型不能指定其他账号。
- `collect` 接受当前会话来源 `message_id` 与从 1 开始的 `image_index`；可同时提供最多 200 字的描述。下载在 NapCat 主机上执行，兼容分机部署。
- 有视觉能力的社交模型可用 `read` 查看收藏图片；没有视觉能力时使用现有描述。图片经多模态部分传递，不把 base64 重复塞进文字上下文。

### 管理入口

社交配置 → 收藏表情：选择已连接且支持收藏能力的平台及账号，同步、搜索、分页查看、修改描述、移除收藏。GIF 保留动图播放。删除在卡片内确认，无原生弹窗。

### 接口与结果确认

- 使用 `fetch_custom_face_detail`、`add_custom_face`、`set_custom_face_desc`、`delete_custom_face`、`download_file`。
- NapCat `download_file` 未传文件名时，以文件 MD5 命名；以此去重和确认收藏结果。
- 删除使用 `resId`，不使用 MD5。写操作串行，完成后再次拉取 QQ 收藏核验。
- 收藏成功但描述更新失败会返回已收藏的 ID 与警告，不把整次收藏报为失败。
- 超时或结果未确认会明确反馈，提示先同步确认，避免盲目重试。
- 收藏列表缓存 30 秒。一次最多拉取 4096 条，达到上限时返回 `truncated`；工具默认每页 20 条，前端每页 30 条。
- 图片预览限制 20 MB、15 秒，仅接受实际 PNG、JPEG、GIF、WebP 数据，不代理模型任意传入的 URL。

### 错误恢复边界

账号隔离、失效引用过滤、删除后重新核验和收藏部分成功均属于协议行为。缓存列表不能证明写入已经送达；核验收藏使用刷新后的平台结果，结果未知时先同步再决定是否重试。

## 微信、Telegram 与 Discord 接入

设置页的“连接微信 / Telegram / Discord”会创建无凭据的平台连接。账号与协议状态保存在 `@data/social_private`，不写入可导出的 `social` 配置；管理接口只返回账号标识、连接状态和稳定错误码。凭据与游标使用 AES-256-GCM 私有文件，密钥单独保存在同一私有根目录；这用于隔离普通配置与检测篡改，不承诺抵御已取得该系统用户全部文件权限的攻击者。临时文件原子替换，同连接写入串行。媒体缓存按内容哈希保存，保留 7 天，最多 200 个文件和约 256 MiB；单个附件最多 25 MiB，Telegram 下载最多 20 MiB。

### 通用接收与发送契约

- `deliverMessage(message, signal)` 只在消息与回复队列持久提交或被激活策略明确忽略后确认，不等待模型。入库失败不会确认，停止会取消等待；迟到的入库不重新激活已停止的状态机。传统事件入口继续兼容 QQ。
- 微信和 Telegram 仅在持久确认后更新接收游标。Discord Gateway 回调先存私有待处理队列，接收失败保留队列并重试；SDK 会话恢复与已有频道历史补拉提供额外恢复能力，不承诺任意离线时长下的完整事件重放。
- 平台原始 Token、上下文令牌、媒体密钥与带凭据下载地址不进入通用消息记录。平台先下载、解密或解析附件，再交付本地文件。管理快照不返回令牌，登录和管理响应禁止缓存。
- `canObserveGroup` 单独门控主动群观察，不能用在线状态替代消息可见性。`getSendReadiness` 用于发送和任务投递；微信缺少对端上下文时阻止发送。
- 发送账本生成 `deliveryId`，Discord 用它生成短期去重 nonce，微信用它生成关联 client_id。平台请求已接受仍与对端实际接收、已读区分；没有服务端消息号时不伪造消息号。网络或分段发送结果不明继续走现有 uncertain 处理。

### 微信私聊

使用 `weixin-ilink`，从腾讯 iLink 扫码登录，支持验证码、服务重定向、二维码过期与取消。扫码确认身份作为默认主人候选；管理页可显式修改主人身份。每个账号独立维护 `get_updates_buf`、对端上下文和长轮询取消信号。文字、图片、视频和文件通过 iLink 与加密 CDN 发送，语音可接收为附件并保留平台提供的转写文本。媒体发送失败不得伪装成功。

当前不声明群聊、好友目录、朋友圈或任意远程历史能力。上下文令牌没有在本实现中假设固定有效期；实际服务端失效、扫码权限和设备兼容性需要真实账号联调。文本和媒体使用独立请求，部分成功时依赖发送账本保留不确定状态。

协议依据：[Tencent/openclaw-weixin 协议说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md)、[扫码实现](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts)。兼容版本固定为 2.4.10；上游采用 MIT 许可证。infOS 独立实现协议，不依赖 OpenClaw 运行时。

### Telegram

使用 `telegram-bot`，通过 BotFather 创建 Bot 并在管理页添加 Token。采用 grammY API 客户端与自行控制确认顺序的长轮询。存在远端 Webhook 时拒绝启用，不擅自删除旧部署；409 消费冲突要求检查其他部署。账号、chat ID、主题 ID 和发送者分别映射；主题包含在不透明会话标识内。SDK 的更新游标在规范消息持久接收后推进。

群主动观察需在管理页确认完整群消息读取，同时在 Telegram 关闭隐私模式或授予相应管理员权限。未开启此项仍可处理可见的命令、提及与私聊。原生 `is_bot` 身份进入互聊保护。当前不声明任意远程历史、好友目录或完整成员枚举能力；群状态工具仍可使用。文字默认纯文本，结构化提及单独转换为实体。

### Discord

使用 `discord-bot`，在开发者后台创建 Bot，通过安装链接加入服务器并添加 Token。采用 discord.js Gateway 和 REST；启用完整群观察前需在开发者后台配置 Message Content Intent，并授予目标频道的查看、历史读取和发送权限。仅声明必要 Intent，不申请在线状态与全部成员权限。私聊频道、文字频道、帖子线程分别维护会话；不把整个服务器合并为一个群。

支持文字、附件、引用读取和按不透明消息游标分页补拉已有频道历史。结构化提及使用明确用户白名单，默认不允许 everyone、角色或隐式回复提及。SDK 的 POST 自动重试关闭，避免结果不明时直接重复发送；断开销毁 Gateway 并停止收件箱任务。当前不提供语音频道、屏幕共享和平台管理写操作。

### 发行与外部平台边界

grammY、discord.js 等属于 Social 的生产依赖，由现有依赖收集器递归处理。开发目录可运行不代表发行目录包含全部协议依赖；目标产物应核对实际解析版本、适配器加载和媒体资源路径。平台真实账号权限、服务端限流、二维码有效期与设备兼容不能由模拟服务证明。

## 上下文、记忆与提示词归属

SocialAppCompiler 独立于主 ContextCompiler。人格通过当前授权读取同一角色资源；历史、社交记忆、联系人印象和私有心流由社交运行时提供，不能用桌面会话状态补齐。

| 材料 | 来源与作用域 | 默认编排位置 |
| --- | --- | --- |
| 人格及称呼 | Persona Grant、角色配置；owner_appellation 只控制表达，不改变身份 | 稳定人格和规则区 |
| 长期社交记忆 | 应用自己的 social.tdb，由 SocialScorer 维护；受记忆读取授权控制 | 动态区的 long_term_memory |
| 原生对话历史 | 当前角色、平台、账号、私聊/群聊范围的持久消息 | 原生 user/assistant 历史 |
| 联系人印象 | 当前触发者的持久印象，内容是资料，不是授权 | social_context 中的 contact_context |
| 跨会话私聊 | 群场景按触发者读取最近私聊，最多 10 条；存储包装器注入平台/账号范围 | social_context 中的 cross_session_private_chat |
| 当前身份与平台现场 | 可信入站消息、绑定账号和适配器 | social_session；当前输入附加 current_social_turn |
| 私有心流 | Realm × 平台/账号/会话类型/会话标识 × Agent | 动态 flow_state；独立能力组件说明更新协议 |

社交长记忆使用自身 BM25/关键词检索，不访问主应用 CanonicalMemory / MemoryProvider。跨会话记录由 `scopedSocialStorage` 在查询 LIMIT 之前限制平台和账号；不能在编译器里用事后过滤替代存储隔离。补充读取失败可缺省该材料，不应阻断当前群聊。

受管理框架由 prepareManagedFramework 取得生效快照，按变量生成历史与靠近输入的 turn_context；没有管理框架时使用编译器的回退编排。共享 XML 组件只规定结构，不拥有数据。主应用的角色 mood/vibe/mind 不传给 Social Compiler，模板也按 channel 排除社交三状态；社交心流仍是自身 Realm 会话状态，不是主对话心流。

预览中的“示例变量未提供”表示示例 JSON 缺少某变量，不表示运行时没有加载该材料。排查时区分预览、实际生效框架、Compiler 变量和最终请求，不能为了消除预览警告注入错误作用域的数据。主提示词工作区见 [B17](./B17_PROMPT_WORKSPACE.md)。

## 源码导航与扩展约束

| 修改目标 | 入口 |
| --- | --- |
| 入站装配、授权与能力目录 | `packages/apps/social/runtime/index.ts` |
| 入口参数与编排执行 | `runtime/socialActDefinition.ts`、`runtime/socialOrchestration.ts` |
| 当前变量、记忆和历史投影 | `runtime/compiler.ts`、`runtime/socialScorer.ts` |
| 存储作用域与数据库实现 | `runtime/socialStorageScope.ts`、`packages/backend/src/applications/sqliteSocialStoragePort.ts` |
| 通用本地操作与平台业务路由 | `runtime/socialCommonOperations.ts`、`runtime/socialOperations.ts` |
| 适配器装配及 QQ 操作 | `adapters/registry.ts`、`adapters/napcat/napcatActions.ts` |
| 提示词正文 | `prompts/social_rules.md`、`prompts/abilities/sticker_expression.md`、`prompts/tasks/social_segment_summarizer.md` |

上述 runtime/adapters/prompts 路径均相对于 `packages/apps/social/`。新增平台须实现规范消息、身份范围、取消、投递回执与可选能力声明，不给通用核心增加平台字段分支。新增操作同时维护参数、权限元数据、执行与结果未知恢复；不能只添加模型说明。维护回归聚焦越权、重复提交、部分发送、取消重启和离线交付，真实平台权限与登录另行验证。
