# 索引维护与诊断

索引维护覆盖各角色的主记忆、社交图谱，以及共享事实、文档知识库。入口为 `/api/maintenance/indexes` 与 `/api/maintenance/reindex`，由 `IndexMaintenanceService` 使用 KernelScheduler 调度。

## 模型激活与维度切换

向量表单是候选配置；“保存配置”先真实请求候选模型并校验向量维度，再在同一 SQLite 事务保存模型、维度及关联配置，热更新后复核 Embedding 与 Store 注册表的目标维度。切换失败会恢复原配置并重新加载；恢复失败明确返回错误，不能报告激活成功。配置写入接口互斥，防止激活期间其他客户端修改关联配置。

模型激活与索引重建分开。维度切换检查维护锁和在途调用，成功关闭旧句柄后只修改注册表的目标维度，不删除旧索引文件、不自动调用模型批量重建。旧维度文件显示“待重建”，访问时不得当作新维度索引使用；知识库启动与配置更新允许保留这些文件等待维护。主记忆离线重建只复用维度匹配的向量，否则从完整备份重建文本与零向量；社交重建继续保留旧库的摘要和关系。

维护面板区分表单候选值、已生效模型维度和文件实际维度。表单模型或维度未激活、运行时与注册表不一致时禁用重建；后端重建入口还检查已保存的模型和维度是否与运行时一致。每个目标完成后重新读取实际维度，空索引也必须匹配；主记忆、事实及文档缺少索引文件不能算成功。未建立的社交库可以保持不存在。激活成功会立即刷新维护状态。

TriviumDB beta.4 在打开时严格校验请求维度。描述旧索引、升级前备份和冻结快照统一使用只读打开入口；仅遇到 `TDB_DIMENSION_MISMATCH` 时读取结构化 `details.expected`，以原库维度重新打开，不解析错误文案、不改写维度旁路文件。社交重建的源 Writer 使用已核实的原库维度，新目标仍使用已激活维度；普通写入继续拒绝维度不匹配。

## 存储职责与边界

Store 使用原有标准路径：`agent_<id>/memory.tdb`、`agent_<id>/social.tdb`、`knowledge/facts.tdb`、`knowledge/knowledge.tdb`，以及各自的原生旁路文件。索引重建沿用现有临时文件组与回滚流程，不引入应用层的活动指针或持久化目录版本管理。

主记忆以 SQLite 中的完整备份和事务日志重建；事实与文档资料以各自领域记录重建。社交摘要、特征和关系由 social.tdb 保存，重建须先读取并保留，不能当作可丢弃的派生缓存。参见 [A05](./A05_MEMORY_ENGINE.md)、[B03](./B03_DOCUMENT_KNOWLEDGE.md) 和 [B21](./B21_SOCIAL_CAPABILITIES.md)。

TriviumDB 负责原生句柄、mmap、WAL、Payload 文件和后台任务的生命周期。应用层互斥不能保证 `close()` 完整释放文件资源；Windows 拒绝访问既可能来自原生占用，也可能来自其他进程或访问策略，需结合原始错误和句柄信息定位。

## 维护互斥

Registry 按数据库路径建立进程内维护范围：拒绝新的外部 Store 调用，等待已进入的异步原生调用结束，再执行维护。排空最多等待 5 秒，超时或取消返回错误；不强制关闭仍执行中的操作。

维护方通过 AsyncLocalStorage 识别所有权。旧 Store 引用及预先取得的方法在缓存实例被撤销后返回 `STORE_STALE_HANDLE`，避免迟到代码继续访问已经关闭的实例。普通业务收到 `RESOURCE_BUSY` 后按领域操作的幂等与重放规则处理。

主记忆模型请求在维护范围外准备；既有同步文件构建和替换仍会占用后端执行时间。事实重置、社交重建和知识库物理重置使用维护范围，快照与维度切换也检查维护及在途调用。这里没有实现大库分页构建、独立构建进程或增量追平。

## 失败与恢复来源

主记忆和社交重建沿用 `.index-<UUID>` 临时文件组及其中的 `.previous` 回滚区。发布与回滚均失败时保留原有恢复现场，诊断包含两个独立原因及现场路径；不能自动删除 WAL 或猜测文件组合。

关闭候选库、发布、校验、回滚与清理分别记录阶段。附带关闭或清理失败作为警告保留，避免覆盖最先发生的异常。物理重置失败仍会中止流程；这不是对底层文件占用问题的修复。

备份和同步继续使用标准数据库文件组；临时回滚区不属于正常导出数据。格式升级备份与显式隐私删除沿用既有规则，见 [A08](./A08_DEVOPS.md#23-迁移原则)。

## 状态与错误协议

进度分别记录 `processed`、`completed`、`failed`；`completed` 兼容旧客户端，表示成功数量。每个目标保存状态、结构化错误和附带清理警告，界面区分已处理与成功数量。

诊断保留 `code`、`phase`、`path` 和有界 `causes`。`AggregateError.errors` 与 `cause` 分别展开，不能只保留聚合异常的表层 message。系统错误文案作为原始证据保留，展示层不通过译文判断业务状态。

| 职责 | 源码入口 |
| --- | --- |
| 结构化错误与原因链 | `packages/backend/src/lib/storeDiagnostics.ts` |
| 维护范围、Store 引用与现有换库 | `packages/backend/src/repositories/storeRegistry.ts` |
| 目标调度与结果汇总 | `packages/backend/src/services/maintenance/indexMaintenanceService.ts` |
| 状态界面 | `packages/frontend/src/components/dashboard/IndexMaintenancePanel.vue` |
| 共享协议 | `packages/shared/src/types/indexMaintenance.types.ts` |
