# 开发者技术文档

本目录供开发者、贡献者和内部维护者理解系统、定位实现、修改契约与排查故障。文档描述当前实现及其约束；尚未实现的方案须单独标为设计提案，不能与现有能力混写。版本变更、临时验证结果和发布过程分别留在提交、Release 与 CI 记录中。

## 阅读入口与文档职责

| 要解决的问题 | 阅读入口 |
| --- | --- |
| 项目有哪些包、如何组织依赖 | [A01 项目结构](./A01_PROJECT_STRUCTURE.md) |
| 服务装配、持久化、Gateway、错误处理 | [A02 后端架构](./A02_BACKEND_ARCHITECTURE.md) |
| 界面状态、Surface 与组件组织 | [A03 前端架构](./A03_FRONTEND_ARCHITECTURE.md) |
| 源码、Docker、Electron、远程节点如何部署 | [A04 部署](./A04_DEPLOYMENT.md) |
| 事件记忆、检索与来源追溯 | [A05 记忆引擎](./A05_MEMORY_ENGINE.md) |
| 扩展、应用装配和跨包接口 | [A06 扩展系统](./A06_EXTENSION_SYSTEM.md)、[A10 应用集成](./A10_APPLICATION_INTEGRATION.md) |
| 平台差异与客户端能力边界 | [A07 跨平台](./A07_CROSS_PLATFORM.md) |
| CI、发行与数据兼容 | [A08 开发运维](./A08_DEVOPS.md) |
| Realm、Principal、Execution、Capability 等核心模型 | [A09 AIOS 架构](./A09_AIOS_ARCHITECTURE.md) |

A 类维护跨领域架构，B 类维护具体子系统的调用链和运行契约，M 类维护模式与机制，S 类维护协作标准。同一事实由一个主题文档负责，其他位置引用；源码入口帮助读者核对实现，不能用大段接口拷贝替代解释。

## 子系统参考

| 领域 | 技术文档 |
| --- | --- |
| 文件、终端、审批、工作区 | [B01 生产力运行时](./B01_PRODUCTIVITY_RUNTIME.md)、[B08 撤回](./B08_WORKSPACE_REWIND.md)、[B14 文件预览](./B14_WORKSPACE_FILE_PREVIEW.md) |
| 客户端桌面能力 | [B02 桌面自动化](./B02_DESKTOP_AUTOMATION.md)、[B11 桌宠 HUD](./B11_PET_HUD.md) |
| 知识与状态 | [B03 文档知识库](./B03_DOCUMENT_KNOWLEDGE.md)、[B06 天气](./B06_WEATHER.md)、[B10 角色状态](./B10_CHARACTER_STATE.md) |
| 社交应用 | [B21 社交能力](./B21_SOCIAL_CAPABILITIES.md)、[B04 状态卡片](./B04_SOCIAL_STATUS_CARDS.md)、[B05 NapCat 管理页](./B05_NAPCAT_WEBUI.md) |
| 工具、资源与文档 | [B07 工具扩展](./B07_TOOLS_AND_EXTENSIONS.md)、[B12 消息资源](./B12_MESSAGE_RESOURCES.md)、[B24 文档工具](./B24_DOCUMENT_TOOLS.md) |
| 会话与任务 | [B09 交互模式](./B09_THREAD_INTERACTION_MODE.md)、[B13 任务计划](./B13_TASK_PLANS.md)、[B19 执行模式](./B19_THREAD_EXECUTION_MODES.md)、[B20 主动工作](./B20_PROACTIVE_WORK.md)、[B26 对话队列](./B26_CONVERSATION_QUEUE.md) |
| 模型与上下文 | [B17 提示词工作区](./B17_PROMPT_WORKSPACE.md)、[B22 服务商连接](./B22_PROVIDER_CONNECTIONS.md)、[B16 用量账本](./B16_TOKEN_USAGE.md) |
| 界面与通知 | [B15 背景](./B15_APP_BACKGROUND.md)、[B18 完成提醒](./B18_COMPLETION_ALERTS.md)、[B23 设备通知](./B23_DEVICE_NOTIFICATIONS.md)、[B25 国际化](./B25_I18N.md)、[B30 成就](./B30_ACHIEVEMENTS.md) |
| 安全与诊断 | [B27 运行时安全](./B27_RUNTIME_SECURITY.md)、[B28 运行时调试](./B28_RUNTIME_DEBUG.md)、[B29 索引维护与诊断](./B29_INDEX_MAINTENANCE.md) |

模式机制见 [M01](./M01_MODE_SYSTEM.md)、[M02 能力门控](./M02_CAPABILITY_GATE.md)、[M03 NIT](./M03_NIT_ENGINE.md)、[M04 Steam](./M04_STEAM_INTEGRATION.md)。修改前同时阅读相应的 [命名](./S01_NAMING_CONVENTIONS.md)、[API](./S02_API_SPEC.md)、[日志](./S03_LOGGING_SPEC.md)、[测试](./S04_TESTING_STANDARDS.md)、[代码](./S05_CODE_STANDARDS.md) 和 [UI/UX](./S06_UI_UX_DESIGN_SPEC.md) 规范。

## 原生依赖的维护边界

infOS 的应用逻辑与编排使用 TypeScript。TriviumDB 等原生能力通过上游 npm 包接入；仓库不维护其 Rust 源码、Cargo 工程或 Rust 编译链。维护工作集中在适配层、数据格式、依赖版本、Node/Electron ABI 兼容与发行资源完整性。

`scripts/rebuild-daemon-deps.mjs` 处理需要匹配 Electron ABI 的依赖，`scripts/collect-daemon-deps.mjs` 收集生产依赖和原生运行文件。不能把 npm 依赖带来的原生二进制写成仓库自有 Rust 模块，也不能以升级宿主 Node 代替检查 Electron 内嵌运行时。细节见 [A05](./A05_MEMORY_ENGINE.md)、[A08](./A08_DEVOPS.md)、[B27](./B27_RUNTIME_SECURITY.md)。

## 如何维护文档

修改行为时，从入口、权威数据来源、状态转换、权限/作用域、失败恢复和客户端投影逐项核对受影响的契约。必要的参数、设计原因、限制与排障步骤应留在主题文档；测试数量、一次性授权经过和“本次未构建”不属于长期技术参考。

新增领域文档时说明职责和源码入口；只有存在实际状态机、持久化或故障边界时再展开对应章节，不机械填充统一模板。测试链接用于解释应保护的行为，不能表示某个版本已经通过验证。运行检查仍遵循根目录 `AGENTS.md` 的授权约定。

`archived/` 与 `TODO-LIST/` 是本地历史/规划资料，不作为当前实现依据；仅有计划的能力不能因文档归档而被认为已经实现。Git 忽略规则只影响未跟踪文件，不能自动停止跟踪已入库内容。
