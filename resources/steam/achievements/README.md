# Steam 首个成就配置

客户端已经内置以下成就，但 Steamworks 后台须创建并发布对应定义，才会接受解锁。此目录不含 Steam 密钥或自动发布凭据。

| 字段 | 值 |
| --- | --- |
| API Name | `ACH_FRESH_START`，大小写必须一致 |
| 简体中文名称 | 崭新启程 |
| 简体中文描述 | 完成与角色的首次有效对话。 |
| 繁体中文名称 | 嶄新啟程 |
| 繁体中文描述 | 完成與角色的首次有效對話。 |
| 英文名称 | A Fresh Start |
| 英文描述 | Complete your first successful conversation with a character. |
| Set By | 客户端 |
| 隐藏 | 否 |
| Progress Stat | 不绑定累计统计 |
| 成就组 | 默认基础组即可 |

图标均为 256 × 256 PNG：

- `ACH_FRESH_START_ACHIEVED.png`：彩色已达成图标。
- `ACH_FRESH_START_UNACHIEVED.png`：灰度未达成图标。
- 同源矢量稿：`packages/frontend/src/assets/achievements/fresh-start.svg`。

在当前应用的 Steamworks“统计与成就”管理页配置名称、描述、图标与客户端权限，保存后发布变更。应用必须以正确 AppID 连接 Steam。未发布定义时，产品内成就仍保留，客户端会继续尝试提交。

解锁条件和达成时间由服务端决定；不配置 Steam 统计进度条，也不上传对话内容。用于开发的重置成就操作不开放给用户或 Agent。

参考：[Steam 官方成就配置指南](https://partner.steamgames.com/doc/features/achievements/ach_guide)。
