# 原生角色卡

角色管理支持 PNG 与 ZIP 角色卡。导出保存角色档案、提示词、头像及能力配置等资源，导入先预览再选择创建、覆盖或导入为新角色。格式由后端 `AgentCardCodec` 管理。

## 文件格式与限制

ZIP 根目录保存 `manifest.json`，其余条目为角色资源。清单使用 `infos.agent-card`、版本 1、角色 ID 和名称。附加资料字段预留为空数组，包含当前支持范围之外资料的卡片返回明确错误。

PNG 使用 `infos-agent` 文本块保存 ZIP 的 base64。已有 PNG 封面保留其余图块，JPEG 或 WebP 头像由前端转换为导出封面，原始头像文件继续保存在资源包内。

上传限制为 64 MiB，展开总量为 128 MiB，单个资源为 32 MiB，最多 512 个文件。编解码器校验路径、重复条目、CRC、压缩尺寸、图像结构和配置身份。解压在内存中按单项输出上限执行。

## 导入与角色生命周期

`AgentCardService` 根据导入模式确定目标身份。覆盖写入同一角色，新角色模式分配可用 ID 并改写 JSON 和能力配置中的身份字段。角色目录里的旧工作区在覆盖时保留。

安装使用数据目录的 `agent-card-transactions/<uuid>/` 同盘暂存，原目录保留为备份。配置载入、能力刷新及注册回调全部成功后提交。运行中抛错时恢复目录、角色内存和启用状态，再恢复能力索引。文件系统恢复失败时保留事务目录供恢复。

注册回调确保新角色持有主 Thread。已有角色的主线、长记忆和角色共享状态继续由各自的数据服务管理。

## API 与前端

| 入口 | 参数与结果 |
| --- | --- |
| `POST /api/agents/cards/preview` | multipart `file`，返回头像、名称、ID 与冲突状态 |
| `POST /api/agents/cards/import` | multipart `file`、`mode=create|overwrite|new` |
| `POST /api/agents/:id/card/export` | multipart `format=png|zip` 与可选 `cover`，返回文件名及 base64 |

`AgentCardTransfer.vue` 处理文件选择、拖入、预览与逐项错误。浏览器使用下载入口，Electron 通过 `save-agent-card` 打开本机保存对话框。错误在 API 展示边界使用三语言词条。

## 源码入口

- `services/agent/agentCardCodec.ts` 管理格式和边界。
- `agentCardService.ts` 协调身份、导入与导出。
- `agentCardInstall.ts` 管理资源安装与回滚。
- `routers/agentCard.routes.ts` 管理请求和错误映射。
- `components/dashboard/tabs/AgentCardTransfer.vue` 提供角色管理入口。
