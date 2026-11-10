/**
 * 角色卡安装事务：在同盘暂存资源并保留原目录，回调失败时恢复磁盘和内存。
 *
 * 由 AgentManager.installCard 调用；本模块只操作传入的角色表与启用集合，
 * 不触发角色目录重载，因此不会让旧包的自动导书逻辑介入。
 *
 * @module packages/backend/src/services/agent/agentCardInstall
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { AgentProfile } from './agentManager'

/** AgentManager 暴露给安装事务的最小状态。 */
export interface AgentCardInstallState {
  /** 用户角色目录（@data/agents）。 */
  agentsRoot: string
  /** 数据根目录（@data），事务暂存目录放在其下，保证与角色目录同盘。 */
  dataRoot: string
  agents: Map<string, AgentProfile>
  /** 启用集合可能被整体替换，按调用时读取。 */
  enabledAgents: () => Set<string>
  loadAgentConfig: (agentId: string, agentDir: string, configPath: string) => AgentProfile
}

/** 在同盘暂存资源并保留原目录；同步回调失败时恢复磁盘和内存，不触发旧包自动导书。 */
export function installAgentCard<T>(
  state: AgentCardInstallState,
  id: string,
  files: Map<string, Buffer>,
  complete: () => T,
): T {
  const root = state.agentsRoot
  const target = path.join(root, id)
  const transaction = path.join(state.dataRoot, 'agent-card-transactions', randomUUID())
  const staged = path.join(transaction, 'staged')
  const backup = path.join(transaction, 'backup')
  const original = state.agents.get(id)
  const enabled = state.enabledAgents().has(id)
  let moved = false
  let installed = false
  let workspaceMoved = false
  let restored = false
  let committed = false
  mkdirSync(staged, { recursive: true })
  try {
    for (const [name, bytes] of files) {
      const file = path.join(staged, name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, bytes)
    }
    mkdirSync(root, { recursive: true })
    if (existsSync(target)) {
      renameSync(target, backup)
      moved = true
    }
    renameSync(staged, target)
    installed = true
    // 兼容旧版放在角色目录中的工作区，覆盖档案不删除运行时资料。
    if (moved && existsSync(path.join(backup, 'workspace'))) {
      renameSync(path.join(backup, 'workspace'), path.join(target, 'workspace'))
      workspaceMoved = true
    }
    const config = path.join(target, files.has('agent.json') ? 'agent.json' : 'config.json')
    state.agents.set(id, state.loadAgentConfig(id, target, config))
    state.enabledAgents().add(id)
    const result = complete()
    committed = true
    return result
  } catch (error) {
    if (workspaceMoved) renameSync(path.join(target, 'workspace'), path.join(backup, 'workspace'))
    if (installed) rmSync(target, { recursive: true, force: true })
    if (moved) renameSync(backup, target)
    if (original) state.agents.set(id, original)
    else state.agents.delete(id)
    if (!enabled) state.enabledAgents().delete(id)
    restored = true
    throw error
  } finally {
    // 文件系统恢复失败时保留备份供恢复，清理失败不能把已提交事务报告为导入失败。
    if (restored || committed) {
      try {
        rmSync(transaction, { recursive: true, force: true })
      } catch {
        /* 保留事务目录，不影响已完成的数据。 */
      }
    }
  }
}
