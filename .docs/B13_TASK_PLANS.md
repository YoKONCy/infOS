# 行动计划与聊天 Todo

## 归属与工具

`update_plan` 是支持 `create / get / update / clear` 的工作协调工具，可由用户关闭，不属于常驻系统协议。计划绑定可信执行上下文的 Thread 与 Agent；后台执行再绑定 task。主应用只在工作模式开放，极简与聊天不开放。全局智能陪伴和自主行动不改变这个规则，实际执行仍受 Thread 模式、能力与审批限制。

清单是最多二十项的扁平数组，每项有稳定 `id`、简短 `title` 和 `pending / in_progress / completed / blocked` 状态。创建提供标题与步骤；更新提交完整列表，更新和清除必须携带最新 `expectedRevision`。清单的修订独立于任务意图修订，标记进度不会中断执行。未结束的计划需要明确清除后才能创建新计划；完成态可直接替换，旧记录归档。

普通问答无需创建清单。当前计划通过 `components/abilities/task_plan.md` 组件注入 `200_abilities.md` 的 `<abilities>` 中，服务仅提供结构化计划数据。公开计划与私有心流使用独立组件，也不保存内部推理。恢复任务需要重新读取现状；清单完成度不代表产出已经验收。

## 后台与定时联动

- `manage_task.create` 可带 `planId / planStepId`，派发入口核验归属后把关联保存到 task 元数据。使用固定派发去重键，同一步的派发与定时安排串行检查。
- `schedule_follow_up` 可带相同关联，持久化到定时记录；到期创建 task 时继续传递关联。
- 卡片的关联步骤状态实时投影自 task 或定时记录，模型勾选不能覆盖真实执行状态。失败、暂停、取消及等待都不计为已完成。
- task 内部清单也由 `update_plan` 实时维护。`finish_task` 负责结束与交接，不再向模型提供另一套计划更新参数；旧检查点的段末清单仅作兼容导入。
- 改变任务要求时归档原任务内部清单；旧执行仍受任务修订守卫约束。清除清单只移除计划视图，不取消已经授权派发的任务；取消继续使用现有任务控制工具。

## 卡片与动画

主对话和工作区协作栏共用 `ChatContainer`，输入框上方复用同一 `ThreadTodo`。任务详情也显示同一个 `TodoPlanCard`。无计划时不占位，半透明细边框与轻微立体阴影使用现有主题、像素字体和语义色。

- 展开：步骤列表最多显示约五行高度，超出内部滚动；完成项勾选并降低亮度，当前项轻微呼吸，受阻项使用提示色。
- 收起：名称、完成数、细进度条与当前事项。完成度仅按完成项计数。
- 首次生成展开；保存折叠偏好，实时更新不强制展开。全部完成后收起，可手动关闭完成卡片。
- 创建、替换与清除使用淡入淡出和高度收放；折叠、数字变化、勾选、标题变化和列表重排各自过渡。减少动态效果偏好关闭这些动效。
- 关联 task 的步骤可跳转任务详情；普通步骤仅展示，避免界面勾选误报 Agent 已完成工作。
- REST 是权威源，Gateway 仅触发合并刷新；重连刷新，三十秒轮询兜底。切换角色或会话废弃旧响应，KeepAlive 隐藏停止订阅与刷新，权限错误停止自动重试。

## 数据库

标准迁移 `0009_task_plans.sql` 创建 `task_plans`，扩展定时记录关联字段，并将旧 `lifecycle.plan` 搬入统一清单。Schema snapshot 与 journal 由 Drizzle Kit 生成；没有启动时临时建表或独立执行引擎。

## 源码与状态归属

`packages/backend/src/services/task/taskPlanService.ts` 校验计划作用域、修订和步骤关联，`repositories/taskPlan.repo.ts` 持久化，`routers/taskPlan.router.ts` 提供管理接口。调用方提交最新修订，服务生成实际计划投影，前端不能直接把步骤勾选写成后台任务终态。

维护回归入口为 `packages/backend/tests/unit/services/task/taskPlanLifecycle.test.ts`。修改派发或定时时同时审阅 [B20](./B20_PROACTIVE_WORK.md) 的去重与领取规则；修改计划提示词时审阅 [B17](./B17_PROMPT_WORKSPACE.md) 的组件装配，避免同时注入两份计划。
