# 角色状态与桌宠表现

## 职责与权威数据

角色状态表达 `mood`（情感底色）、`vibe`（外在表现）、`mind`（简短角色心声）。它们与执行中、等待回答、录音、播报等运行状态分属不同模型；不能从任务忙闲反推角色心情，也不能用 mind 存储计划或推理过程。

权威记录是 `thread_character_state_events`，作用域为 **Thread × Agent**。`PetStateService.get(agentId, threadId)` 核验会话归属后按事件顺序重放，未记录的字段使用 `DEFAULT_CHARACTER_STATE`。无 Thread 不返回全局状态；删除的 Thread 返回默认状态。旧 `pet_states` 不能作为当前会话的权威来源，ConfigRepo 中旧 mood/vibe/mind 也不参与提示词状态读取。

## 写入、撤回与清理

`update_state` 与 `finish_task` 的状态写入携带 `threadId`、`pairId` 及工具调用关联。缺少会话或轮次时拒绝写入，不能留下无法撤回的全局副作用。字段独立可选，规范化时忽略空白；没有有效补丁时返回 `updated:false`。显式提交与前一轮相同的值仍保留本轮来源，确保撤回前一轮后，后一轮的同值状态继续有效。

事件包含 update、retract 与 clear。读取时跳过已撤回轮次以及最后一次 clear 之前的更新，再重放剩余补丁；撤回中间轮次不会覆盖后续有效字段。修改该流程须同时审阅会话删除、历史撤回与执行取消，避免旧调用迟到后重新写回状态。

临时点击、待机和返回台词同样随事件补丁保存，合并去重，每池最多 12 条，有效期六小时。读取时过滤过期台词；临时台词到期不等于 mood/vibe/mind 清空。

## 上下文与界面投影

主 ContextCompiler 只读取当前 Thread 的状态，并通过状态模板形成动态字段。社交应用拥有独立 Compiler，不读取桌面角色三状态；共用 `turn_context` 模板不代表社交自动获得这些字段。社交心流与记忆另见 [B21](./B21_SOCIAL_CAPABILITIES.md)。

`Pet3DView` 把心情与外在表现交给 `BedrockAvatar`，以明确词语选择自然、明快、低落、担心、认真、害羞等表现；不读取心声推断情绪。未知、否定或混合描述回退自然待机，原始文字保持原值。

- 表现切换去抖 650ms，最短停留 2.2 秒，逐帧过渡；文字投影不等待动画。
- 仅在已有骨骼上叠加小幅眼皮、眉毛与头部姿态，保留模型眨眼和动画。
- 拖拽、触摸和手动动画优先。角色/模型切换重置缓存，卸载清理计时器，缺失骨骼时跳过。
- 表现层不会回写状态，也不会为情绪判断追加模型请求。

## 维护入口

- 事件类型与持久结构：`packages/backend/src/database/schema.ts`。
- 重放、更新与撤回：`packages/backend/src/services/agent/petStateService.ts`。
- 主会话注入：`packages/backend/src/services/context/contextCompiler.ts` 与 `services/mdp/prompts/slots/800_pet_state.md`。
- 表现层：`packages/frontend/src/views/Pet3DView.vue`。
- 回归入口：`packages/backend/tests/unit/services/agent/petStateService.test.ts`。重点保护跨 Thread 隔离、中间轮次撤回、删除和迟到写入边界。
