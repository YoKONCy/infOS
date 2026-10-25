# 社交状态卡片

## 流程

QQ 主人私聊 → `social_act` 的 `call` 步骤 → `social.status_card_send` → 宿主状态卡片输出口 → Electron `desktop.environment/statusCard` → PNG 附件 → 当前私聊。

不注册到主 Agent 工具库，不调用主 Agent，不使用桌面截图，也不占用浏览器标签页。

## 设计

社交设置的「状态卡片」提供标题、深浅主题、配色、单列/双列布局、展示项目及顺序调整。按社交角色保存到现有配置仓库的 `social.status-card.{agentId}`；无需数据库迁移。

模型通过 `social_act` 调用 `social` 能力的 `status_card_send`、`status_card_get_design`、`status_card_save_design`、`status_card_reset_design`。发送参数 design 只覆盖当前卡片，保存操作才更新持久配置。内部兼容执行器 `social_status_card` 不作为独立模型工具暴露；发送成功后的终结行为由社交编排处理，不能再次发送重复正文。

设计是受控字段，不接受任意 HTML、JavaScript、CSS 或外部资源。共享文档生成器转义动态文本；设置页沙盒预览与 Electron 使用同一生成器。字体使用项目 Zpix，图片宽度 720 像素，按实际内容裁剪。

## 数据来源

- CPU：Electron 设备的系统 CPU 时间增量，采样至少 300ms，不是后端进程占用。
- 内存：设备系统总量与空闲量。
- GPU：固定的 NVIDIA 只读查询提供第一块 GPU 的使用率与显存；其他设备尝试提供 GPU 名称。读不到的指标标为未提供。
- 磁盘：Windows 系统卷或 Unix 根卷；不读取目录内容。
- 助手任务：宿主角色的未结束任务，读取后端任务记录，最多展示五条。它们是 infOS 任务状态，不能据此认定都在采集设备上执行。
- 时间与在线时长：采集设备自身的时间与系统 uptime。

设备指标来自当前桌面能力绑定的 Electron 客户端；客户端离线或版本不支持时返回不可用，不以后端主机指标冒充。当前不提供历史曲线、自动告警或多设备选择。

## 生命周期与权限

工具只向绑定主人的当前私聊发送；角色切换、主人配置变化或应用停止后不继续投递。工具参数不接受目标 QQ、文件路径或自定义采集命令。

渲染使用专用隐藏沙盒窗口，同一设备同时处理一个任务，禁止权限请求与弹出窗口；请求仅允许本次 HTML 和内置字体。渲染结束、取消或超时后销毁窗口并清理临时 HTML。只把 PNG 发给 NapCat，不传设备本地路径。

本地设计预览使用明确标识的示例；「实时预览」重新采集并返回真实 PNG，不自动发送 QQ。保存和预览接口沿用现有 API 鉴权。

## 维护入口

`packages/apps/social/adapters/napcat/napcatActions.ts` 定义操作与权限，`runtime/statusCardService.ts` 维护设计和宿主请求，`electron/main/services/statusCard.ts` 负责实际设备采样与 PNG 渲染。排查指标缺失时检查 Electron 提供者与设备支持，不能改用服务端机器的指标填充客户端卡片。编排及账号边界见 [B21](./B21_SOCIAL_CAPABILITIES.md)。
