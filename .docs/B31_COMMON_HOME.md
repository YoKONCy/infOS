# 共同的家

Home 把文件交接、修改保护、操作确认、活动记录和桌面卡片消息组织成主程序服务。文件通道按执行进程可访问的文件系统解释路径，桌面窗口与原生回收站由 Electron 提供能力。

## 权威数据

`HomeService` 由应用容器创建。SQLite 的 `home_records` 按种类保存快照、授权、待确认、声明、活动、所属文件、置物架、位置用途和卡片消息等记录，正文资源存放在数据目录的 `home/`。

作用域为 `agentId + sessionId + taskId`。普通主线执行使用逻辑执行编号作为任务身份，后台任务使用自己的任务编号。Agent 工具从受信任运行上下文取得身份，HTTP 入口校验角色及会话归属。

## 工具入口

| 工具 | 职责 |
| --- | --- |
| `home_declare` | 声明本次要操作的路径与应用 |
| `home_files` | 读取、搜索、写入、移动及可恢复删除 |
| `home_shelf` | 交接文件、图片、文字和网址 |
| `home_map` | 记录程序、文件夹与窗口的位置和用途 |
| `home_card` | 接收卡片消息、确认收取及按 revision 更新数据 |

文件修改前由快照服务记录内容，恢复时核对当前状态。批量变化、路径越界、敏感操作和授权收紧共同影响操作判定。文件锁内尝试失败并进入待确认后释放锁，获准时重新读取文件并检查条件。

既有 `write_file`、`edit_file` 和 `delete_file` 在桌面通道复用 Home 的确认与修改保护。拒绝、取消、超时和冲突各自保留稳定错误码，前端显示本地化结果。

## 设置与生命周期

默认批量变化门槛为一分钟十次，快照保留七天。默认快照容量为 1 GiB，单文件为 32 MiB，置物架为 128 MiB、最多一百项。设置通过 `home.settings.v1` 管理，实际限制由 `homeSettingsSchema` 校验。

会话清空或删除后结束该会话的待确认、临时授权和执行许可，永久授权继续按设置管理。清空全部聊天关闭各会话操作现场，恢复出厂清理 Home 业务记录。工作区和用户文件的保留范围由对应操作的合同决定。

卡片消息持久化后进入会话队列，消息编号提供投递幂等身份。数据更新检查 revision，来源中的角色和会话由宿主绑定。桌面卡片的内容与窗口状态由客户端保存，服务端负责交互记录。

## API 与客户端

`/api/home` 要求管理身份，涵盖设置、授权、确认、活动、快照、恢复区、置物架、位置用途与卡片交互。SSE 提供活动和确认变化，原生通知由 Electron 的 `main/home/` 处理。

桌面操作经服务端工具门禁和客户端护栏，再按 Home 的文件或应用授权执行。分布式使用时，文件路径和原生能力分别服从实际执行节点。

## 源码入口

- `services/home/homeService.ts` 与 `homeWiring.ts` 负责装配和生命周期。
- `homeAuthorization.ts`、`homeConfirmWait.ts` 负责确认与许可。
- `homeFiles.ts`、`homeCheckpoints.ts`、`homeStorage.ts` 负责文件和恢复。
- `repositories/home.repo.ts` 与 `database/homeSchema.ts` 负责权威记录。
- `tools/home/` 与 `routers/home.router.ts` 提供入口。
- `electron/main/home/` 和前端 `components/desktop/home/`、`HomeShelfPanel.vue`、`HomeMapPanel.vue` 提供客户端。
