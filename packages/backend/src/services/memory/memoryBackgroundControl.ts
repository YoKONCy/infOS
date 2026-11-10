import { MEMORY_BACKGROUND_ENABLED_KEY, memoryBackgroundAgentId, type MemoryBackgroundPolicy } from '@infos/shared'

/** 关闭时中止在途任务；重新开启使用新信号，旧任务不能因开关恢复而继续写入。 */
export class MemoryBackgroundControl implements MemoryBackgroundPolicy {
  private active = true
  private controller = new AbortController()
  private disabledAgents = new Set<string>()
  private agentControllers = new Map<string, AbortController>()

  get enabled(): boolean {
    return this.active
  }
  get signal(): AbortSignal {
    return this.controller.signal
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.active) return
    this.active = enabled
    if (enabled) this.controller = new AbortController()
    else this.controller.abort(new Error('长记忆后台任务已关闭'))
  }

  get disabledAgentIds(): readonly string[] {
    return [...this.disabledAgents]
  }

  isAgentEnabled(agentId: string): boolean {
    return this.active && !this.disabledAgents.has(agentId)
  }

  agentSignal(agentId: string): AbortSignal {
    if (!this.isAgentEnabled(agentId)) return AbortSignal.abort(new Error('角色后台记忆已关闭'))
    let controller = this.agentControllers.get(agentId)
    if (!controller) {
      controller = new AbortController()
      this.agentControllers.set(agentId, controller)
    }
    return AbortSignal.any([this.signal, controller.signal])
  }

  setAgentEnabled(agentId: string, enabled: boolean): void {
    if (enabled) this.disabledAgents.delete(agentId)
    else {
      this.disabledAgents.add(agentId)
      this.agentControllers.get(agentId)?.abort(new Error('角色后台记忆已关闭'))
      this.agentControllers.delete(agentId)
    }
  }

  /** 单项保存、批量导入和删除覆盖配置均从持久化状态重新装配。 */
  configure(entries: readonly { key: string; value: string }[]): void {
    this.setEnabled(entries.find((entry) => entry.key === MEMORY_BACKGROUND_ENABLED_KEY)?.value !== 'false')
    const disabled = new Set(entries.flatMap(({ key, value }) => {
      const id = memoryBackgroundAgentId(key)
      return id && value === 'false' ? [id] : []
    }))
    for (const id of new Set([...this.disabledAgents, ...disabled])) this.setAgentEnabled(id, !disabled.has(id))
  }
}
