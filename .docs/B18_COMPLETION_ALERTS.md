# 完成提醒

入口：系统设定 → 完成提醒。两个开关默认开启、即时保存，互不依赖：

- 完成提示音：本地合成约半秒的柔和双音，支持试听；关闭后停止当前提示音并禁用试听。
- Windows 完成通知：桌宠隐藏、关闭或最小化时发送静音通知；点击定位到对应对话消息或后台任务结果。

提示音不依赖聊天页面或桌宠渲染进程，也不跟随原有界面交互音效开关。偏好保存在当前客户端的 `completion-alerts.json`，去重记录保存在 `completion-alerts-seen.json`，均位于客户端用户数据目录。

## 完成来源

普通桌面对话在整轮 ReAct、消息持久化和执行结算完成后提醒。后台任务在状态实际进入 `completed` 后提醒。失败、取消、应用内部临时调用及常驻维护不播放完成音，后台任务的各个执行段不会分别提醒。

后端通过 `client.completion-alert/notify` 系统 Capability 投递到在线 Electron 客户端，不要求 Input Seat，不经过主 Agent 工具库。主进程判断真实桌宠窗口状态，统一播放声音和展示通知，避免页面隐藏、窗口关闭或角色切换造成提醒丢失。

## 去重与恢复

对话使用 Thread + 持久消息 ID，后台任务使用任务 ID + 修订作为去重键。主进程在异步操作前占位，并保留最多 1024 条记录；同一事件并发抵达或重连后不重复提醒。超过五分钟的旧事件不补播；两个开关关闭时也结算事件，重新开启不会补响旧任务。未连接客户端时不会排队重放历史完成提醒，应用内持久通知和任务历史照常保留。

声音与通知失败相互独立，提醒失败不会改变任务结果。Windows 通知本身静音，因此关闭完成提示音后不会通过系统完成通知再响一次。

## 手机后台接收

PeroperoChat 使用独立的通知专用 Gateway 连接，回复完成时通知先持久化，离线恢复后按设备补收。接收、展示与实际已读分别确认；手机不依赖 Electron 完成提醒能力。协议与移动端对接顺序见 [设备通知接入](./B23_DEVICE_NOTIFICATIONS.md)。

## 维护与排障

后端完成事件入口为 `packages/backend/src/services/conversation/completionAlertService.ts`；Electron 的 `electron/main/services/completionAlertController.ts` 决定可见性、去重和声音，`completionAlerts.ts` 执行原生提醒。设置位于 `packages/frontend/src/components/notification/CompletionAlertSettings.vue`。

排查漏提醒时分别核对业务终态、事件持久化、设备连接、客户端可见性与本机开关；声音失败不能阻断业务完成。桌面提醒的模拟用例不能证明实际听感或 OS 通知权限，移动端补收契约见 B23。
