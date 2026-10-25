# Thread 交互模式与工具准入

## 持久化与切换

- `threads.interaction_mode` 保存交互模式（`chat` / `work` / `minimal`），独立于 Channel、用途和自动执行设置。
- 新普通桌面 Thread 默认聊天模式；后台任务和应用内部 Thread 使用工作模式。
- 标准迁移 `0007_thread_interaction_mode` 将已有 Thread 标记为工作模式，保留原有能力。
- 对话栏切换通过 `PUT /api/chat/threads/:id/interaction-mode` 保存；普通桌面会话空闲时才能切换。
- 切换不新建会话、不清空历史、不改写 `disabled_tools_json`，也不改变已派发任务的独立 Thread。

## 能力门控

模式是 Channel / 角色能力之上的减法层。工具定义、能力描述、Skill 菜单和实际执行使用同一模式策略。

聊天允许列表维护于 `packages/backend/src/tools/interactionMode.ts`：

- 对话状态、事件记忆、事实查询与记录更新、文档知识库检索。
- 配置完成的联网搜索与网页读取；天气由状态上下文注入，不提供专用查询工具。
- 提醒、一次性跟进和待采纳建议。
- 文件读取、目录与文本搜索、代码搜索、写入和编辑。
- `manage_task` 提供任务查询、派发与控制；各操作仍受调用身份、任务所有权和执行模式约束。

文件删除、终端、桌面操作、工作控制工具与高级工具展开只在相应工作范围开放。`run_script` 在聊天允许列表中，但脚本内调用继续受当前模式与权限约束，不能借脚本扩大能力。`document`、`runtime_debug` 和 runtime-scoped 工具仅工作模式可用。
模式门控不继承“系统协议工具始终可用”的豁免。执行器从 Thread 读取权威策略，脚本嵌套调用仍受会话限制。
审批、路径范围、设备能力和后台任务受限作用域继续独立生效。

## 扩展

扩展配置保存 `chatEnabled`，默认 `false`；官方扩展配置页提供“聊天模式可用”开关。
注册工具时通过 `ToolRegistry.register(..., { chatEnabled })` 声明，聊天允许列表不包含扩展名称。
扩展仍需启用、配置完整并满足角色能力和会话逐项设置；修改聊天开关不自动授予这些条件。

## 前端与提示词

- 输入栏使用像素字体和主题变量展示模式，适配深浅主题与紧凑布局。极简模式只保留陪伴及记忆类允许项，完整集合以 `MINIMAL_TOOLS` 为准。
- 工具接口分别返回 `enabled`、`userEnabled`、`modeAllowed`，区分有效状态、手动设置和模式限制。
- 工具计数只计算当前模式可用范围；受模式限制的项目标记“模式未开放”。
- 能力说明注入 `components/abilities/interaction_mode.md`，用户名使用既有 `owner_name`；关闭工具的完整定义不注入模型。
- 模式提示词只解释当前可用范围；授权以执行器校验为准，不能依赖模型遵守文案。

## 修改时的约束

`packages/backend/src/tools/interactionMode.ts` 是模式准入入口，注册元数据决定扩展是否可在聊天使用。修改模式时同时检查工具菜单、能力说明和实际执行，避免“看得见但调用不了”或隐藏工具仍可被脚本调用。交互模式决定工具集合；[B19 执行模式](./B19_THREAD_EXECUTION_MODES.md) 决定如何审批，两者独立。
