import type { StartupFailureKind, StartupPhase } from '../../shared/startupSplash'

export interface StartupFlowSteps {
  phase: (phase: StartupPhase) => void
  open: () => Promise<void>
  prepare: () => Promise<void>
  backend: () => Promise<boolean>
  launcher: (signal: AbortSignal) => Promise<void>
  verifyBackend: () => Promise<boolean>
  finish: (signal: AbortSignal) => Promise<void>
  reveal: () => void
  close: () => void
  failed: (kind: StartupFailureKind, error: unknown) => void
}

/** 首次启动与用户重试共用同一条链；退出后迟到的异步结果不能重新显示窗口。 */
export class StartupFlow {
  private pending: Promise<void> | null = null
  private readonly controller = new AbortController()
  public completed = false

  constructor(private readonly steps: StartupFlowSteps) {}

  get running(): boolean {
    return this.pending !== null
  }

  start(): Promise<void> {
    if (this.controller.signal.aborted || this.completed) return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = this.run().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  cancel(): void {
    this.controller.abort()
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal
    let failure: StartupFailureKind = 'shell'
    try {
      this.steps.phase('opening')
      await this.steps.open()
      signal.throwIfAborted()
      await this.steps.prepare()
      signal.throwIfAborted()
      failure = 'backend'
      this.steps.phase('backend')
      if (!(await this.steps.backend())) throw new Error('startup-backend-not-ready')
      signal.throwIfAborted()
      failure = 'launcher'
      this.steps.phase('launcher')
      await this.steps.launcher(signal)
      signal.throwIfAborted()
      failure = 'backend'
      if (!(await this.steps.verifyBackend())) throw new Error('startup-backend-lost')
      signal.throwIfAborted()
      failure = 'launcher'
      this.steps.phase('ready')
      await this.steps.finish(signal)
      signal.throwIfAborted()
      this.steps.reveal()
      this.completed = true
      this.steps.close()
    } catch (error) {
      if (!signal.aborted) this.steps.failed(failure, error)
    }
  }
}
