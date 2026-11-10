# 角色状态与桌宠表现

## 职责与权威数据

角色表达状态包括 `mood`（情感底色）、`vibe`（外在表现）、`mind`（简短角色心声），持续字段包括 `ongoingGoals`、`commitments` 和 `relationships`。执行中、等待回答、录音和播报由运行时单独投影。心流表达当前关注、理解和行动意图，任务进度由任务领域持有，主动记下的要点写入记事本。

权威记录是角色级 `agent_character_state_events`。`PetStateService.get(agentId, threadId)` 核验来源后重放该角色的有效事件，主侧会话与据点执行读取同一权威。省略 Thread 时使用主线。新事件流为空，表达使用 `DEFAULT_CHARACTER_STATE`，持续字段为空。旧 `thread_character_state_events` 和 `pet_states` 保留兼容资料。迁移和生命周期见 [主侧会话](./B26_MAIN_SIDE_THREADS.md)。

## 写入、撤回与清理

`update_state` 与 `finish_task` 共用状态入口，写入携带角色、Thread、代次、轮次与工具调用关联。表达字段独立可选，忽略空白。持续文本字段最多 8000 字符，空字符串清除。显式重复设置相同值仍记录本轮来源，支持独立撤回。

新共享事件包含 update 与 retract，读取时按来源撤销贡献并重放后续有效补丁。编译器提供角色版本，执行与 NIT 子调用共用版本引用，遇到跨场景并发更新时返回冲突和当前状态。消息来源与代次在写入事务内核验，重试按完整来源幂等。主线清空重置保留角色共享状态。

临时点击、待机和返回台词同样随事件补丁保存，合并去重，每池最多 12 条，有效期六小时。读取时过滤过期台词；临时台词到期不等于 mood/vibe/mind 清空。

## 上下文与界面投影

主 ContextCompiler 读取角色共享状态，通过状态模板与 `character_continuity` 提供动态字段。角色主会话与据点读取同一份 MainThread 心流，侧会话持有自己的心流。心流字段沿用 `currentGoal / privateFacts` 协议，可以简短引用文件路径、工具与已有操作标识。Social 延续独立 Compiler、Realm、心流和记忆边界，详见 [B21](./B21_SOCIAL_CAPABILITIES.md)。

心流补丁在持久事务内合并，`flow_state_revisions.patch_fields_json` 保存实际更新字段，含显式重复设置。撤回某个来源时重放后续有效补丁，保留其他场景之后的贡献。迁移 `0035_flow_patch_fields.sql` 为已有修订增加可选字段，旧记录依据前后值推导变化。

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
- 回归入口为 `packages/backend/tests/unit/services/agent/petStateService.test.ts` 与 `mainSideLifecycle.test.ts`，覆盖角色共享、来源补偿、版本冲突与重置代次。
