# Pictoria 开发与接入说明

> 本文承接 Pictoria 的工程细节（原 README 的后端接入部分）。用户向概览与快速上手见 [README](./README.md)。

**更新记录**
- 2026-10-14：自由画布与工作流编辑器均已接入源码。
- 2026-10-15：新增每节点 API 配置、通用供应商 HUD 与独立浏览器运行入口。

---

## 1. 职责与入口

| 层           | 位置                                                                              | 职责                                                                     |
| ------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| infOS 兼容层 | `packages/backend/src/applications/pictoriaIntegration.ts`、`pictoriaDelivery.ts` | 在线工具投影、调用归属、受限模型桥接、素材输入、结果回到原会话／社交通道 |
| 子应用兼容层 | `src/manifest.ts`、`src/host.ts`                                                  | 声明 Endpoint／Offer／Requirement／Tool、Node 协议与本地鉴权 HTTP        |
| 子应用主体   | `src/application.ts`、`workflows.ts`、`execution.ts`、`store.ts`、`assets.ts`     | 项目、步骤、工作流、执行、素材、提示词和独立数据迁移                     |

子应用不导入 infOS 私有后端，不直接修改主 Thread。infOS 不打开 Pictoria 的数据库；交互经过公开端点和资源桥接。Arca 和 Pictoria 共用声明驱动的 `ApplicationController`、`ApplicationCapabilityRuntime`、`ApplicationFederationConnector`。

Manifest 已声明 `main.tab` 画布 Surface。客户端位于 `client/`：挂载模式通过 infOS 兼容层访问业务，独立模式直接访问 Pictoria 的本地浏览器接口，两者共用同一后端执行引擎。Electron 入口位于新建标签页的 Pictoria 卡片；独立入口由 Pictoria 自己提供。

## 2. 独立运行与开发

画布图像工作室、候选图、助手增量协议、节点编组和完整项目包的当前数据契约与失败恢复见 [画布工作室](../../../.docs/B30_PICTORIA_STUDIO.md)。

`pnpm start` 会同时启动 Arca 与 Pictoria 客户端，并在 Pictoria 的 7363 端口就绪后启动 Electron。单独开发客户端可用 `pnpm --filter @infos/pictoria dev:client`。7363 被占用时明确退出，不自动换端口。开发后台直接通过 `--import` 注册 tsx 加载器，发现记录中的 PID 与托管进程一致。发行构建脚本已包含客户端资源。启动命令与发行构建本轮均未执行。

独立开发使用 `pnpm --filter @infos/pictoria dev:standalone` 和 `pnpm --filter @infos/pictoria dev:client`，按后台输出的画布链接连接，不需要启动 infOS。

## 3. 宿主控制 API

以下路径位于 infOS 已有鉴权之下，基路径为 `/api/applications/pictoria`：

| 方法与路径                           | 作用                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| `GET /status`                        | 托管／外部实例、连接、发行资源、错误状态                         |
| `POST /start`、`/stop`、`/reconnect` | 管理 Host；只能停止当前 infOS 启动的托管进程                     |
| `GET /settings`、`PUT /settings`     | `{enabled, chatEnabled}`，默认启用能力、聊天模式不开放           |
| `POST /operations/:operation`        | 按角色调用下表业务操作                                           |
| `GET /tasks?agentId=...`             | 宿主调用与交付记录，最近 100 条                                  |
| `POST /deliveries/:callId/resolve`   | 外部交付待核验时提交 `{decision:"sent"}` 或 `{decision:"retry"}` |

业务请求信封：

```json
{
  "agentId": "pero",
  "threadId": "原会话ID",
  "input": {}
}
```

`task.submit` 必须带原会话 ID 和 `idempotency-key` 请求头。其他操作通常只需 `agentId` 和 `input`。宿主校验角色存在，创作提交额外校验 Thread 归属；调用者不能通过 DSL 指定别的角色或投递目标。

### 业务操作

| 对象   | 操作                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| 服务   | `service.list`、`service.save`                                                            |
| 步骤   | `templates.list`、`catalog.get`、`step.list`、`step.get`、`step.save`、`step.set_enabled` |
| 工作流 | `workflow.list`、`workflow.get`、`workflow.save`、`workflow.publish`、`workflow.delete`   |
| 项目   | `project.list`、`project.get`、`project.save`、`project.delete`                           |
| 提示词 | `prompt.list`、`prompt.save`、`prompt.delete`                                             |
| 素材   | `asset.list`、`asset.get`、`asset.import`                                                 |
| 执行   | `task.submit`、`task.get`、`task.list`、`task.cancel`、`task.resume`                      |

创建对象使用 `definition`；更新时提交前次返回的 `expectedRevision`。删除也需要版本号。版本冲突不会覆盖新数据。`step.set_enabled` 使用 `{id, enabled, expectedRevision}`。`workflow.publish` 使用 `{id, expectedRevision}`。

`catalog.get` 返回启用步骤及可用性；`step.list` 还包含停用步骤，供后续配置客户端管理。六种通用模板均默认停用，只是可编辑起点，不假装任何提供商已配置好。

## 4. 最小服务与步骤

以下使用示例域名，仅展示契约，不指向已联调的提供商。先调用 `service.save`：

```json
{
  "definition": {
    "id": "image-service",
    "name": "我的图片服务",
    "baseUrl": "https://provider.example/v1/",
    "requiresCredential": true,
    "credential": "由用户填写",
    "submit": {
      "path": "images/edit",
      "method": "POST",
      "fields": {
        "prompt": { "from": "prompt" },
        "image": { "from": "image", "format": "data_url" }
      },
      "outputs": { "image": { "path": "data.0.url", "kind": "image" } }
    }
  }
}
```

认证默认使用 `Authorization: Bearer ...`，可设置 `authHeader`／`authPrefix`。凭据加密存储，查询只返回 `hasCredential`；认证值不能夹在普通 `headers` 配置里。更新时不提交 `credential` 表示保留，`clearCredential:true` 表示清除。

`submit.body` 提供固定请求字段，`submit.fields` 把步骤输入映射到请求字段，支持点路径。`format` 可为 `value`、`text`、`data_url`、`file`；文件上传使用 `bodyFormat:"multipart"`，由 Fetch 生成 multipart boundary。返回原始媒体字节的服务可用 `outputs:{image:{path:"",kind:"image"}}`，把整个响应生成的素材引用映射为 `image` 输出。

再调用 `step.save`：

```json
{
  "definition": {
    "id": "edit-image",
    "name": "编辑图片",
    "usageDescription": "这是自然语言 Edit 模型。image 为原图；prompt 用中文说明要修改的部分及应保留的内容。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "image": {
          "type": "object",
          "properties": { "assetId": { "type": "string" } },
          "required": ["assetId"],
          "additionalProperties": false
        },
        "prompt": { "type": "string", "minLength": 1 }
      },
      "required": ["image", "prompt"],
      "additionalProperties": false
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "image": {
          "type": "object",
          "properties": { "assetId": { "type": "string" } },
          "required": ["assetId"],
          "additionalProperties": false
        }
      },
      "required": ["image"],
      "additionalProperties": false
    },
    "implementation": { "kind": "service", "serviceId": "image-service" }
  }
}
```

`usageDescription` 是作者编写的实际输入要求，按当前 Agent 动态加入工具说明。SDXL 等服务可以自行定义正／负 tag 字段及对应说明；系统不做提示词转换。JSON Schema 只检查字段正确性，关闭自动类型转换与默认值填充，不访问外部 `$ref`。

异步服务另外配置 `submit.taskIdField` 和 `poll`：

```json
{
  "submit": { "taskIdField": "id" },
  "poll": {
    "path": "tasks/{id}",
    "stateField": "status",
    "success": ["completed"],
    "failed": ["failed", "cancelled"],
    "intervalMs": 3000
  },
  "cancel": { "path": "tasks/{id}/cancel", "method": "POST" },
  "timeoutMs": 600000,
  "concurrency": 2,
  "requestTimeoutMs": 90000,
  "recoveryWindowMs": 21600000,
  "idempotencyHeader": "Idempotency-Key",
  "idempotencyWindowMs": 86400000
}
```

上面的 `submit` 片段须与完整提交配置合并。任务 ID 当前要求非空字符串；状态名、字段路径、输出格式均由服务作者填写。通用服务使用作者配置，AtlasCloud 另有内置适配；尚无模型下载安装或 GPU 进程管理。

`idempotencyHeader` 和 `idempotencyWindowMs` 仅在供应商确实提供相应保证时设置，不能直接照抄示例作为支持证明。缺少幂等保证时，提交回执不明的请求保留待核验，不自动重发。

## 5. 单个 Agent 工具与工作流 DSL

主 Agent 只有 `pictoria` 一个工具；目录只在应用在线、功能启用时投影，聊天模式另由 `chatEnabled` 控制。

```json
{
  "action": "run",
  "stepId": "edit-image",
  "stepRevision": 1,
  "inputs": { "image": { "resourceId": "附件ID" }, "prompt": "把背景改成傍晚，保留人物。" }
}
```

素材可使用已有 `{assetId}`、infOS `{resourceId}` 或 `{resourceSource:"https://..."}`。宿主将授权附件／在线资源导入子应用并替换为素材引用，再校验步骤 schema。Agent 不能把设备文件路径伪装成在线素材；工作区文件先走已有授权附件机制。

其他 action 为 `catalog`、`get`、`list`、`cancel`、`resume`、`canvas`。`canvas` 保存画布数据。提交返回 `{accepted,taskId,projectId,acceptedAt}`，不会等待图片生成完成。

`run.definition` 可一次提交一张 DAG。工作流与步骤依靠 `stepRevision`／发布 revision 固定定义，协议版本为 Manifest Endpoint 的 `1.0`；当前 definition 不接收额外的 `version` 字段。

```json
{
  "action": "run",
  "definition": {
    "id": "edit-flow",
    "name": "双版本创作",
    "usageDescription": "并行生成两个编辑版本。",
    "inputSchema": {
      "type": "object",
      "properties": { "image": { "type": "object" } },
      "required": ["image"],
      "additionalProperties": false
    },
    "outputSchema": {
      "type": "object",
      "properties": { "first": { "type": "object" }, "second": { "type": "object" } },
      "required": ["first", "second"],
      "additionalProperties": false
    },
    "nodes": [
      {
        "id": "first",
        "stepId": "edit-image",
        "stepRevision": 1,
        "inputs": { "image": { "input": "image" }, "prompt": { "literal": "改为傍晚，保留人物。" } }
      },
      {
        "id": "second",
        "stepId": "edit-image",
        "stepRevision": 1,
        "inputs": { "image": { "input": "image" }, "prompt": { "literal": "改为清晨，保留人物。" } }
      }
    ],
    "outputs": {
      "first": { "node": "first", "output": "image" },
      "second": { "node": "second", "output": "image" }
    }
  },
  "inputs": { "image": { "resourceId": "附件ID" } }
}
```

引用支持 `{input:字段}`、`{node:节点ID,output:字段}`、`{literal:值}`，以及声明式数组组装与字段路径。字符串不会被当作表达式执行。单工作流最多 64 节点，子工作流嵌套最多 8 层，另有限制遍历与展开规模的预算；不支持循环、任意脚本或提示词自动转换。

`workflow.save` 保存草稿，`workflow.publish` 验证并生成同 ID 的可调用步骤。发布快照、历史步骤定义独立保存，后续编辑不改写已接受任务或旧工作流。当前步骤停用后拒绝新执行。发布 ID 不能覆盖同名独立步骤。

结构错误在接受前拒绝；依赖上游实际生成的输入，则在对应节点请求前校验，不能承诺在上游生成前预测所有输出值。

## 6. LLM 节点

画布视觉助手、`update_draft`、参考图用途与视频起始帧接续契约统一见 [.docs/B30_PICTORIA_STUDIO.md](../../../.docs/B30_PICTORIA_STUDIO.md)。`x-pictoria-video.startFrameField` 只表达 API 已有能力；接续 JPEG 仍是普通素材。`openai_content` 服务字段格式以 `prompt` 为文本、`images` 为显式素材引用，发送时编码多模态消息，不能用于推断任意供应商的协议。

助手设置的范围、持久化和调用契约同见上述权威说明。`canvas.assistant.settings.get/save` 按画布保存独立设置；`HostPort.generate.options` 只承载经过校验的采样、输出、思考与超时参数，挂载主模型的协议与授权仍由 infOS 管理。新增画布操作必须同步 manifest 和 Electron 显式白名单。

步骤 implementation 使用 `{kind:"llm",system:"作者提示词",modelId:"5",outputMode:"text"}`，其中 modelId 是 infOS 模型配置的数字 ID 字符串，不是供应商模型名。省略时使用角色模型。

默认输出 `{text:"..."}`；`outputMode:"json"` 时按作者的输出 schema 要求返回 JSON，并再次校验。没有模型提示词风格转换。

LLM 节点需要托管 Host 的模型回调、有效创作调用关联，以及通过现有 `/api/applications/infos.pictoria/grants` 发放的 `infos.model`、`resource:{kind:"model",modelConfigId:5}`、`permissions:["derive"]` 授权。使用省略 modelId 的角色默认模型时，需要不限定具体配置 ID 的模型授权。授权按现有 Application 实例机制管理，应用换实例后须重新授权。

模型凭据留在 infOS，调用计入既有 Token 统计；图片输入校验所有权、模型视觉能力和 20 MB 限制。LLM 已发出后失败会保守标记为提交不确定，不把它误判成可以自动重新计费的字段校验失败。

## 7. 执行与交付规则

| 场景                      | 行为                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| 相同幂等键与相同内容      | 返回同一已接受任务，即使随后步骤停用／修改；不同内容拒绝                           |
| 接受后页面关闭            | 执行由独立 Host 管理；未来标签页关闭不能取消任务                                   |
| 已有远程 ID，Host 重启    | 继续查询，不重新提交生成                                                           |
| 请求中断／异步返回缺少 ID | `waiting`＋节点 `uncertain`，不自动重发                                            |
| 手动核验已有远程任务      | `resume` 携带 `id,nodeId,remoteId`，只查询该远程任务                               |
| 明确重新生成              | `resume` 携带 `id,nodeId,confirmRetry:true`，增加尝试编号与新的提供商幂等键        |
| 仅下载／保存作品失败      | 普通 `resume` 复用已保存响应，只重新保存作品                                       |
| 无依赖分支失败            | 其他分支继续；保留成功输出，最终区分 `partial` 和 `failed`                         |
| 本地取消                  | 停止本地等待，可配置远程取消；不承诺远程服务已停止或免计费                         |
| 原聊天存在且归属正确      | 资源导入、助手消息、附件绑定、交付标记及 durable outbox 同事务提交，并推送会话更新 |
| 社交通道断线              | 结果留待连接恢复；生成任务不因此失败                                               |
| 外部消息发送中断          | `deliveryStatus:uncertain`，等待人工核验，避免盲目重复发送                         |

`task.get/list/cancel/resume` 返回 `RunSnapshot`：包含步骤、节点状态／错误／输出、最终结果，不包含提供商原始响应、服务配置或宿主 callId。原始响应只留在执行库用于恢复。原会话已删除／归属改变时不会改投其他聊天。

主应用每约 3 秒同步持久调用与结果。交付和生成独立：恢复下载、恢复回传、处理社交发送不确定，都不会自动重新生成。工作流页提供节点运行详情，主应用任务中心尚未接入完整创作详情。

## 8. 数据、资源与发行

默认数据位置为 infOS 数据目录的 `applications/pictoria`，包含独立 `pictoria.sqlite`、内容寻址 `assets/`、`credentials.key`、`bridge.key`、Node identity 与发现记录。素材上限 100 MB，数据 URL 输入上限 20 MB；输出资源按所有权查询，宿主下载核验 SHA-256。

主应用 `0011_application_calls.sql` 记录调用和交付；子应用由 `src/database/migrations/0001_pictoria.sql` 独立迁移。迁移失败不发布 ready，未来版本或迁移校验变化拒绝打开。此轮没有实际运行迁移。

备份须保留 SQLite 及其一致性快照、素材和加密密钥。尚未制作在线备份／导入导出接口、自动素材清理或配额 UI；社交导出临时作品也保留在 `host-deliveries/` 待后续定义清理策略。infOS 恢复出厂会清理主应用调用表，独立 Pictoria 数据不会被顺带删除。

本地 HTTP 只监听 `127.0.0.1`、使用独立 Bearer key，并要求 `x-application-owner`。Node 调用同样验证 bridge key；HTTP 素材支持范围读取和 sandbox 响应头。它是受信任宿主通道，不能把密钥直接发给网页或当公网服务暴露。

发行脚本已声明 Pictoria Host、客户端、SQL 迁移及依赖收集。没有生成发行产物或确认原生 SQLite 二进制在成包中可运行。

## 9. 验证状态与后续

- 本轮画布、资源库和 AtlasCloud 增量只做人工源码审阅，未执行构建、测试、类型／模板检查、应用启动或实际绘图请求。
- 业务用例覆盖 schema 拒绝、提示词原样传递、幂等重启、历史版本、提交不确定、远程 ID 核验、部分结果、凭据与所有权、循环、必填输出、查询脱敏、下载恢复。用例没有执行。
- 真实服务鉴权、multipart、模型授权、跨进程停止／重连、数据库迁移、聊天／社交回传和发行包都尚未运行验证。
- 创作画布、三种资源库、AtlasCloud 配置页与工作流编辑器已加入源码；工作流提供节点级运行详情，主应用完整任务中心仍独立推进。
- 可选项目分组、自定义选择浮层、深浅色过渡和手形平移接管已加入源码；旧画布接口继续兼容，移除项目保留全部画布与素材。仍未执行运行验证。
