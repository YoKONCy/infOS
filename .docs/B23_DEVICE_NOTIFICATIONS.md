# PeroperoChat 后台通知接入

infOS 负责通知持久化、设备鉴权、实时提示和分页补收；PeroperoChat 的原生接收服务负责本地收件箱、系统通知与点击导航。接收服务不依赖 WebView、聊天流、Live2D 或输入席位。Electron、源码服务和 Docker 使用同一协议，不需要额外部署推送服务器。

## 1. 设备凭据

扫描 infOS 的配对码后，向相同服务器发送：

```http
POST /api/client-access/pair
Content-Type: application/json

{"code":"配对码","name":"PeroperoChat 手机","remember":true,"credentialMode":"bearer"}
```

成功响应的 `data` 包含 `{deviceId, expiresAt, token}`，其中授权 `expiresAt` 为毫秒时间戳。原生端把这份**设备令牌**存进安全存储，界面和后台服务复用它；后续 HTTP、WebSocket 握手携带 `Authorization: Bearer <token>`。不要分别配对两次，不要把实例管理令牌当手机设备令牌。默认浏览器配对仍只写 HttpOnly Cookie，不回传 token。`/login` 同样支持显式 `credentialMode`。

原生端不依赖 WebView 与 Service 共享 Cookie，不把 token 放进日志或通知跳转参数。`expiresAt` 到期需要重新授权；撤销设备、退出登录会使对应 WebSocket 失效。临时切换独立模式只断开订阅，**不调用 `/logout`**。

## 2. 轻量连接

连接 `<服务器同一入口>/ws/gateway`，HTTP 对应 `ws`，HTTPS 对应 `wss`。握手示例：

```json
{
  "protocolVersion": 1,
  "id": "每个请求的唯一 ID",
  "type": "hello",
  "sourceId": "peroperochat-background",
  "targetId": "backend",
  "timestamp": 1792627200000,
  "payload": {
    "profile": "notifications",
    "deviceName": "PeroperoChat 手机",
    "supportedVersions": [1]
  }
}
```

`hello.payload.token` 可省略。服务器优先使用 HTTP 升级时验证的设备身份，该旧字段只用于未进行传输层认证的兼容连接；不会再拿设备令牌与实例管理令牌比较。`deviceId` 由服务器确定，客户端不能指定。

收到 `hello_ack` 后检查 `features` 包含 `notifications-v1`，并核对 `deviceId`。此连接只允许 `gateway.notifications.pull`、`gateway.notifications.receipt`、`gateway.notifications.presence` 与心跳，不注册能力 Host，不抢占其他界面的 Node Session 或 Input Seat。其他业务请求返回 `GATEWAY_NOTIFICATION_ONLY`。

每 25～30 秒发送 `type: "heartbeat"`、空 payload，收到 `heartbeat_ack`。超过 90 秒无活动会断开。原生端需设握手和心跳响应超时，并使用带抖动、有限上限的断线退避；网络恢复时立即重试。认证失败或授权撤销需提示重新授权，不能无限重试无效凭据。

## 3. 实时提示与补收

所有 RPC 沿用上面的信封，把 `type` 改成 `request`，payload 使用下表；响应 `type: "response"`、`id` 与请求一致，数据直接在 payload 中。

| 操作 | payload |
|---|---|
| 分页补收 | `{"action":"gateway.notifications.pull","afterSequence":0,"limit":50}` |
| 接收回执 | `{"action":"gateway.notifications.receipt","receipts":[{"notificationId":"…","revision":1,"state":"received"}]}` |
| 展示回执 | 同上，`state: "presented"` |
| 实际已读 | 同上，`state: "read"` |
| 前台状态 | `{"action":"gateway.notifications.presence","foreground":true,"threadId":"正在显示的会话"}` |

`hello_ack`、`heartbeat_ack` 都包含 `latestSequence`；新通知产生时另外发送 `push`，payload 为 `{"action":"notification_available","latestSequence":123}`。这些是补收提示，不能直接拿来推进客户端游标。

每次成功握手、网络恢复，及收到新序号提示后，串行拉取分页。即使提示丢失，下一次握手或心跳也能发现落后。第一页 `afterSequence` 使用本地保存的位置；首次使用零。`limit` 为 1～100。

补收正在进行时仍需记下新提示的最大水位；本轮结束后若游标落后，继续补收，不能因当前忙碌而丢弃提示。

分页响应：

```json
{
  "notifications": [{
    "sequence": 123,
    "notificationId": "conversation:thread-id:message-id",
    "principalId": "keromi",
    "revision": 1,
    "title": "可洛米 已回复",
    "body": "会话标题",
    "level": "info",
    "createdAt": "2026-10-21T08:00:00.000Z",
    "expiresAt": "2026-10-28T08:00:00.000Z",
    "source": "conversation",
    "target": {"kind":"conversation","agentId":"keromi","threadId":"thread-id","messageId":"message-id"},
    "presentation": "notify"
  }],
  "nextSequence": 123,
  "latestSequence": 123,
  "hasMore": false,
  "resetRequired": false
}
```

分页覆盖此授权设备可访问的所有角色，不能按当前选中角色另建或跳过这个游标。数据库中的序号跨重启保留，与普通 Gateway 内存事件游标无关。

**本地事务顺序：**

1. 以服务器实例、设备身份、`notificationId + revision` 去重，将整页通知和 `nextSequence` 一起持久化到本地收件箱。
2. 本地事务成功后再发送 `received` 回执。不要因为刚收到了网络包就确认。
3. 按本地未展示队列调用系统通知；展示成功后持久化展示标记，再发送 `presented`。
4. `hasMore` 为 true 时继续拉下一页；空通知页也要保存返回的 `nextSequence`。不要把 `latestSequence` 当下一页位置。

每批回执最多 100 条。成功响应 `{accepted}` 后可移除这批待发回执；过时修订或已删除项目会被忽略，不需要无限重试。失败则保留并重试。重连后从零拉取也会排除该设备已确认收到的项目，因此**接收回执提交后，本地收件箱承担尚未展示通知的恢复责任**。每台设备只启动一个原生消费服务，界面不再启动第二套系统通知消费循环。

数据库恢复到旧快照，导致客户端游标超过服务器序号时，返回 `resetRequired: true`。客户端将游标复位为零重新补收，保留本地去重记录。若用户主动清空本地通知库，也应重新配对为新设备，避免沿用已确认收到的旧设备状态。

## 4. 收到、展示与已读

- `received`：该设备已安全保存通知，不表示用户阅读。
- `presented`：该设备已展示通知，不影响其他设备的待收记录。
- `read`：用户实际查看后提交，将通知标为全局已读，停止其他设备尚未发生的补收；不替代任务中心自身的已读操作。

旧桌面 `gateway.notifications.ack` 保留原请求格式，认证设备的回执改为该设备的 `presented`。不会再因为电脑展示过 Toast，手机就漏收通知。客户端已经展示的系统通知由客户端管理；本协议不承诺跨设备即时撤下已展示的系统通知。

## 5. 前台静默与导航

界面与后台复用同一设备身份，但各自使用独立连接标识。界面打开目标会话时发送 `presence`，每 30 秒及会话切换时更新；退后台发送 `foreground:false`。前台声明 90 秒失效，断线也失效，普通心跳不会延长它。原生 Service 也可代界面发送声明，但不能在界面退出后继续声明前台。

同设备正在显示目标会话时，分页条目的 `presentation` 为 `silent`：仍存收件箱并确认接收，只跳过系统横幅。其余情况为 `notify`；原生端展示前再检查一次实际界面状态和 `expiresAt`，避免网络在途时用户已切到该会话。静默状态不能视作实际已读。

每台手机只选一个前台状态发布者，推荐由 Service 接收界面生命周期事件后代发；不要由界面和后台分别维持相互矛盾的前台声明。`presentation` 是服务器租约推算的展示提示，原生端已知的实际界面状态优先。

`target.kind` 支持 `conversation`、`task`、`reminder`、`application`，按实际存在的 `threadId/messageId/taskId/scheduleId/applicationCallId` 导航。点击通知后先核对服务器与当前模式，按已有 HTTP 接口重新读取目标；会话已删除、消息已撤回或任务不存在时，显示简短提示并返回会话列表／任务中心，不能创建幽灵消息或自动续接任务。

## 6. 来源、过期与模式隔离

已接入普通桌面对话成功完成、已保存的主动消息、后台任务重要状态、定时提醒和应用创作结果。回复通知使用后台专用投递，保留现有 Electron 完成提醒，避免多弹一次桌面 Toast。通知生成时就写库，手机未连接也会记录；同一通知 ID 重试创建不会重复入库。

后台通道仅返回预览：标题最多 200、正文最多 1000 个 UTF-16 单元，不切断代理字符对。完整任务结果通过目标页面读取，不随通知传输工具记录或完整任务正文。

默认补收有效期为生成后七天；过期和全局已读条目不再补收。升级时只把近期未读历史通知纳入新补收序列，旧版本已展示的历史通知不重新轰炸。任务或应用删除后的既有通知抑制规则继续应用。

只有 PeroperoChat **远程模式**允许启动此服务。模式必须由手机持久保存：切回独立模式时关闭通知连接、取消重连和在途请求，停止展示旧服务器队列；切回远程模式再按服务器与设备恢复收件箱。模式切换、退出登录、撤销授权都应让旧连接的异步回调失效。切换模式不停止 infOS 服务端任务，不修改服务器全局模式。

服务被系统停止、手机断网或 infOS 未运行时，实时连接不能投递；服务恢复连接后再补收。Android 的后台存活和系统通知权限由移动端实现。

## 维护入口与协议验证

服务端通知持久化入口为 `packages/backend/src/repositories/durableNotification.repo.ts`，设备目标筛选位于 `services/gateway/notificationTargetFilter.ts`；Web 客户端补收逻辑为 `packages/frontend/src/composables/main/useRemoteNotifications.ts`。迁移 `0022_device_notifications.sql` 定义对应持久结构。

修改协议时围绕设备隔离、游标分页、重复回执、失效连接、前台状态过期与配对撤销建立回归；服务端模拟不能代替移动端对系统后台存活和通知权限的验证。故障定位依次检查持久通知、目标设备、补收游标和 received/displayed/read 回执，不能将服务端已生成当作手机已展示。
