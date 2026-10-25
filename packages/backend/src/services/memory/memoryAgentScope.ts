/** 将记忆后台工作的取消边界绑定到角色，删除一个角色不会中断其他角色。 */
export class MemoryAgentScope {
  private controllers = new Map<string, AbortController>()

  constructor(private readonly exists: (agentId: string) => boolean = () => true) {}

  isAvailable(agentId: string): boolean {
    return this.exists(agentId)
  }

  signal(agentId: string): AbortSignal {
    if (!this.isAvailable(agentId))
      return AbortSignal.abort(new Error('角色已删除，停止记忆后台工作'))
    let controller = this.controllers.get(agentId)
    if (!controller) {
      controller = new AbortController()
      this.controllers.set(agentId, controller)
    }
    return controller.signal
  }

  invalidate(agentId: string): void {
    this.controllers.get(agentId)?.abort(new Error('角色已删除，停止记忆后台工作'))
    this.controllers.delete(agentId)
  }
}
