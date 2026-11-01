import { t as __t } from './i18n'
import type { HostPort, NodeRun, Run } from './domain'
import { resolve } from './workflows'
import { validate } from './schema'
import { field, type ServiceClient } from './serviceClient'
import type { Store } from './store'
import { backoff, requestError, transient } from './requestSafety'
import { dependencies } from './bindings'
import { CANVAS_ASSISTANT_SYSTEM } from './canvasDocument'

const terminal = new Set(['completed', 'failed', 'cancelled', 'skipped'])
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })

export class ExecutionEngine {
  private readonly active = new Map<
    string,
    { run: Run; controller: AbortController; promise: Promise<void> }
  >()
  private readonly services = new Map<string, number>()
  private stopping = false
  private wakeTimer?: ReturnType<typeof setTimeout>
  private wakeAt = 0
  private storagePauseUntil = 0
  constructor(
    private readonly store: Store,
    private readonly client: ServiceClient,
    private readonly host?: HostPort,
  ) {}

  start(): void {
    this.stopping = false
    for (const run of this.store.recoveryRuns()) {
      const changed = this.restoreSubmission(run)
      if (run.state === 'waiting' && !changed) continue
      run.state = run.nodes.some((n) => n.state === 'uncertain') ? 'waiting' : 'queued'
      run.error = run.nodes.find((node) => node.state === 'uncertain')?.error
      this.store.saveRun(run)
    }
    this.pump()
  }
  private restoreSubmission(run: Run) {
    let changed = false
    for (const node of run.nodes)
      if (['running', 'uncertain'].includes(node.state)) {
        const key = `${run.id}:${node.id}:${node.attempt ?? 0}`,
          receipt = this.client.submission(run.owner, key)
        if (receipt?.state === 'received') node.response = receipt.response
        if (node.remoteId) node.state = 'submitted'
        else if (node.response !== undefined) {
          const id = node.service?.poll
            ? field(node.response, node.service.submit.taskIdField ?? '')
            : undefined
          if (typeof id === 'string' && id) {
            node.remoteId = id
            node.response = undefined
            node.state = 'submitted'
          } else node.state = node.service?.poll ? 'uncertain' : 'saving'
        } else if (
          receipt?.state === 'prepared' ||
          (receipt?.state === 'rejected' && receipt.retryable)
        ) {
          node.state = 'pending'
          node.startedAt = undefined
        } else if (receipt?.state === 'rejected') {
          node.state = 'failed'
          node.error = receipt.error || '服务已明确拒绝请求'
          changed = true
          continue
        } else if (node.service && this.client.canReplay(run.owner, node.service, key))
          node.state = 'pending'
        else node.state = 'uncertain'
        node.error =
          node.state === 'uncertain'
            ? '提交回执未确认；原请求已保留，请核验远程任务后恢复'
            : undefined
        changed = true
      }
    return changed
  }
  pump(): void {
    if (this.stopping) return
    if (Date.now() < this.storagePauseUntil) {
      this.wake(this.storagePauseUntil)
      return
    }
    clearTimeout(this.wakeTimer)
    this.wakeAt = 0
    let runs: Run[]
    try {
      runs = this.store.runs(undefined, true)
    } catch {
      this.storagePauseUntil = Date.now() + 5000
      this.wake(this.storagePauseUntil)
      return
    }
    for (const run of runs) {
      if (this.active.size >= 4) break
      if (this.active.has(run.id)) continue
      try {
        if (run.nodes.some((node) => node.state === 'running')) {
          this.restoreSubmission(run)
          if (run.nodes.some((node) => node.state === 'uncertain')) {
            run.state = 'waiting'
            run.error = run.nodes.find((node) => node.state === 'uncertain')?.error
            this.store.saveRun(run)
            continue
          }
          this.store.saveRun(run)
        }
      } catch {
        this.storagePauseUntil = Date.now() + 5000
        this.wake(this.storagePauseUntil)
        return
      }
      const pending = run.nodes.filter((node) =>
        ['pending', 'submitted', 'saving'].includes(node.state),
      )
      const due = pending.filter(
        (node) =>
          (!node.retry || Date.parse(node.retry.nextAt) <= Date.now()) &&
          dependencies(node.inputs).every(
            (id) => run.nodes.find((entry) => entry.id === id)?.state === 'completed',
          ),
      )
      const deferred = pending.filter(
        (node) => node.retry && Date.parse(node.retry.nextAt) > Date.now(),
      )
      if (pending.length && !due.length && deferred.length) {
        this.wake(Math.min(...deferred.map((node) => Date.parse(node.retry!.nextAt))))
        continue
      }
      const controller = new AbortController()
      const promise = this.process(run, controller.signal)
        .catch((error) => {
          if (requestError(error)?.persistenceFailure) {
            this.storagePauseUntil = Date.now() + 5000
            console.error(
              __t(
                'apps.pictoria.logs',
                '[Pictoria] 执行记录暂时无法保存，已停止发送新请求，稍后恢复',
              ),
            )
          } else if (!this.stopping && run.state !== 'cancelled') {
            run.state = 'failed'
            run.error = message(error)
            try {
              this.store.saveRun(run)
            } catch {
              this.storagePauseUntil = Date.now() + 5000
            }
          }
        })
        .finally(() => {
          this.active.delete(run.id)
          this.pump()
        })
      this.active.set(run.id, { run, controller, promise })
    }
  }
  private wake(at: number) {
    if (this.stopping || (this.wakeAt && this.wakeAt <= at)) return
    clearTimeout(this.wakeTimer)
    this.wakeAt = at
    this.wakeTimer = setTimeout(
      () => {
        this.wakeAt = 0
        this.pump()
      },
      Math.max(100, Math.min(60000, at - Date.now())),
    )
    this.wakeTimer.unref?.()
  }
  async stop(): Promise<void> {
    this.stopping = true
    clearTimeout(this.wakeTimer)
    this.wakeAt = 0
    for (const job of this.active.values())
      job.controller.abort(new Error('应用正在停止，执行状态已保留'))
    await Promise.allSettled([...this.active.values()].map((job) => job.promise))
  }
  async cancel(id: string, owner: string): Promise<Run> {
    const job = this.active.get(id)
    const run = job?.run ?? this.store.run(id, owner)
    if (!run || run.owner !== owner) throw new Error('执行不存在')
    if (['completed', 'partial', 'failed', 'cancelled'].includes(run.state)) return run
    run.state = 'cancelled'
    this.store.saveRun(run)
    job?.controller.abort(new Error('已停止本地执行'))
    for (const node of run.nodes) {
      if (terminal.has(node.state)) continue
      if (node.remoteId && node.service?.cancel) {
        const cancel = node.service.cancel
        try {
          await this.client.request(
            owner,
            node.service,
            cancel.path.replaceAll('{id}', encodeURIComponent(node.remoteId)),
            cancel.method,
            undefined,
            AbortSignal.timeout(10000),
          )
          node.error = '已提交远程取消请求'
        } catch {
          node.error = '远程取消未确认；仅停止本地等待，远程可能继续执行'
        }
      } else node.error = '已停止本地等待；远程执行与计费可能继续'
      node.state = 'cancelled'
    }
    this.store.saveRun(run)
    await job?.promise
    return run
  }
  resume(id: string, owner: string, nodeId?: string, remoteId?: string, confirmRetry = false): Run {
    if (this.active.has(id)) throw new Error('执行仍在运行')
    const run = this.store.run(id, owner)
    if (!run || !['waiting', 'failed', 'partial'].includes(run.state))
      throw new Error('当前执行不可恢复')
    const node = nodeId ? run.nodes.find((n) => n.id === nodeId) : undefined
    if (nodeId && !node) throw new Error('待恢复节点不存在')
    if (node && confirmRetry && ['failed', 'uncertain'].includes(node.state)) {
      node.state = 'pending'
      node.remoteId = undefined
      node.response = undefined
      node.savedOutputs = undefined
      node.retry = undefined
      node.startedAt = undefined
      node.attempt = (node.attempt ?? 0) + 1
    }
    if (node?.state === 'uncertain') {
      if (remoteId && node.service?.poll) {
        node.remoteId = remoteId
        node.response = undefined
        node.startedAt = undefined
        node.error = undefined
        node.retry = undefined
        node.state = 'submitted'
      } else if (confirmRetry) {
        node.state = 'pending'
        node.remoteId = undefined
        node.response = undefined
        node.startedAt = undefined
      } else throw new Error('提交结果不确定，需绑定远程任务 ID 或明确确认重新付费提交')
    }
    if (run.nodes.some((n) => n.state === 'uncertain')) {
      if (!node || !['pending', 'submitted'].includes(node.state))
        throw new Error('仍有提交结果不确定的节点需要处理')
      // 多个分支需要逐个核验；先持久化本次处理，不启动尚未核验的节点。
      node.error = undefined
      run.state = 'waiting'
      run.error = '仍有提交结果不确定的节点需要处理'
      this.store.saveRun(run)
      return run
    }
    if (node?.state === 'pending') node.error = undefined
    for (const entry of run.nodes) entry.retry = undefined
    for (const entry of run.nodes)
      if (entry.state === 'failed' || entry.state === 'skipped') {
        entry.state =
          entry.response !== undefined ? 'saving' : entry.remoteId ? 'submitted' : 'pending'
        entry.error = undefined
        entry.startedAt = undefined
      }
    run.state = 'queued'
    run.error = undefined
    this.store.saveRun(run)
    this.pump()
    return run
  }
  private async process(run: Run, signal: AbortSignal): Promise<void> {
    run.state = 'running'
    this.store.saveRun(run)
    while (!signal.aborted && !this.stopping) {
      const ready = run.nodes.filter(
        (node) =>
          ['pending', 'submitted', 'saving'].includes(node.state) &&
          (!node.retry || Date.parse(node.retry.nextAt) <= Date.now()) &&
          dependencies(node.inputs).every(
            (id) => run.nodes.find((n) => n.id === id)?.state === 'completed',
          ),
      )
      if (!ready.length) break
      const batch = new AbortController(),
        batchSignal = AbortSignal.any([signal, batch.signal])
      const results = await Promise.allSettled(
        ready.slice(0, 4).map(async (node) => {
          try {
            await this.execute(run, node, batchSignal)
          } catch (error) {
            batch.abort(new Error('执行记录保存失败，已暂停同批请求'))
            throw error
          }
        }),
      )
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failed) throw failed.reason
      for (const node of run.nodes)
        if (
          node.state === 'pending' &&
          dependencies(node.inputs).some((id) =>
            ['failed', 'cancelled', 'skipped'].includes(
              run.nodes.find((n) => n.id === id)?.state ?? '',
            ),
          )
        )
          node.state = 'skipped'
      this.store.saveRun(run)
    }
    if (signal.aborted || this.stopping) return
    if (
      run.nodes.some(
        (node) => ['pending', 'submitted', 'saving'].includes(node.state) && node.retry,
      )
    ) {
      run.state = run.nodes.some((node) => node.state === 'uncertain') ? 'waiting' : 'queued'
      run.error = run.nodes.find((node) => node.retry)?.error
      this.store.saveRun(run)
      return
    }
    if (run.nodes.some((n) => n.state === 'uncertain')) run.state = 'waiting'
    else {
      const result: Record<string, unknown> = {}
      for (const [key, binding] of Object.entries(run.outputs)) {
        try {
          result[key] = resolve(binding, run.inputs, run.nodes)
        } catch {
          /* 失败分支的输出保留为缺失。 */
        }
      }
      run.result = result
      run.state = run.nodes.every((n) => n.state === 'completed')
        ? 'completed'
        : Object.keys(result).length
          ? 'partial'
          : 'failed'
      if (run.state === 'completed') validate(run.outputSchema, result)
    }
    run.error = run.nodes.find(
      (node) => node.state === 'failed' || node.state === 'uncertain',
    )?.error
    this.store.saveRun(run)
  }
  private async execute(run: Run, node: NodeRun, signal: AbortSignal): Promise<void> {
    node.finishedAt = undefined
    const serviceKey = `${run.owner}:${node.service?.id ?? 'llm'}`
    const limit = node.service?.concurrency ?? 2
    let acquired = false
    let submitted = node.state !== 'pending'
    let phase: 'submit' | 'poll' | 'save' =
      node.state === 'submitted' ? 'poll' : node.state === 'saving' ? 'save' : 'submit'
    try {
      while ((this.services.get(serviceKey) ?? 0) >= limit) await delay(100, signal)
      this.services.set(serviceKey, (this.services.get(serviceKey) ?? 0) + 1)
      acquired = true
      const inputs = Object.fromEntries(
        Object.entries(node.inputs).map(([key, binding]) => [
          key,
          resolve(binding, run.inputs, run.nodes),
        ]),
      )
      validate(node.step.inputSchema, inputs)
      let expires =
        (node.startedAt ? Date.parse(node.startedAt) : Date.now()) +
        (node.service?.timeoutMs ?? 600000)
      if (node.retry)
        expires = Date.parse(node.retry.firstAt) + (node.service?.recoveryWindowMs ?? 21600000)
      else if (expires <= Date.now() && (node.remoteId || node.response !== undefined)) {
        node.retry = {
          phase,
          count: 0,
          firstAt: new Date().toISOString(),
          nextAt: new Date().toISOString(),
        }
        expires = Date.now() + (node.service?.recoveryWindowMs ?? 21600000)
      }
      if (expires <= Date.now()) throw new Error('节点执行期限已到；可通过恢复入口重新查询')
      const nodeSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, expires - Date.now())),
      ])
      if (node.state === 'pending') {
        if (node.step.implementation.kind === 'llm' && (!this.host || !run.callId))
          throw new Error('LLM 节点需要已授权的 infOS 调用上下文')
        const beforeSend = () => {
          node.state = 'running'
          node.startedAt ||= new Date().toISOString()
          this.store.saveRun(run)
          submitted = true
        }
        if (node.step.implementation.kind === 'llm') {
          if (node.step.implementation.system.startsWith(CANVAS_ASSISTANT_SYSTEM))
            this.client.validateAssistantImages(run.owner, inputs.images)
          beforeSend()
          node.response = await this.host!.generate(
            {
              callId: run.callId!,
              system:
                node.step.implementation.system +
                (node.step.implementation.outputMode === 'json'
                  ? `\n请仅返回符合以下 schema 的 JSON 对象：${JSON.stringify(node.step.outputSchema)}`
                  : ''),
              inputs,
              modelId: node.step.implementation.modelId,
              ...(node.step.implementation.options
                ? { options: node.step.implementation.options }
                : {}),
            },
            node.step.implementation.options?.timeoutMs
              ? AbortSignal.any([
                  nodeSignal,
                  AbortSignal.timeout(node.step.implementation.options.timeoutMs),
                ])
              : nodeSignal,
          )
        } else {
          node.response = await this.client.submit(
            run.owner,
            node.service!,
            inputs,
            nodeSignal,
            `${run.id}:${node.id}:${node.attempt ?? 0}`,
            beforeSend,
          )
          if (node.service?.poll) {
            const id = field(node.response, node.service.submit.taskIdField ?? '')
            if (typeof id !== 'string' || !id)
              throw Object.assign(new Error('提交后未获得任务 ID，请核验服务提交结果'), {
                ambiguousSubmission: true,
              })
            node.remoteId = id
            node.response = undefined
            node.state = 'submitted'
            this.store.saveRun(run)
          }
        }
      }
      if (node.state === 'submitted') {
        phase = 'poll'
        const service = node.service!
        const poll = service.poll!
        while (!nodeSignal.aborted) {
          const response = await this.client.request(
            run.owner,
            service,
            poll.path.replaceAll('{id}', encodeURIComponent(node.remoteId!)),
            'GET',
            undefined,
            nodeSignal,
          )
          const state = String(field(response, poll.stateField))
          if (poll.failed.includes(state))
            throw new Error(String(field(response, 'data.error') || '远程任务失败'))
          if (poll.success.includes(state)) {
            node.response = response
            break
          }
          await delay(poll.intervalMs, nodeSignal)
        }
        if (node.response === undefined) throw nodeSignal.reason || new Error('远程查询尚未完成')
      }
      phase = 'save'
      node.state = 'saving'
      this.store.saveRun(run)
      const result =
        node.step.implementation.kind === 'llm'
          ? node.step.implementation.outputMode === 'json'
            ? (JSON.parse(String((node.response as { text: string }).text)) as Record<
                string,
                unknown
              >)
            : (node.response as Record<string, unknown>)
          : await this.client.outputs(run.owner, node, nodeSignal, run, inputs)
      validate(node.step.outputSchema, result)
      node.outputs = result
      node.response = undefined
      node.state = 'completed'
      node.error = undefined
      node.retry = undefined
    } catch (error) {
      if (run.state === 'cancelled') return
      node.error = message(error)
      const detail = requestError(error)
      if (detail?.receiptResponse !== undefined) {
        node.response = detail.receiptResponse
        const id = node.service?.poll
          ? field(node.response, node.service.submit.taskIdField ?? '')
          : undefined
        if (typeof id === 'string' && id) {
          node.remoteId = id
          node.response = undefined
          phase = 'poll'
        } else phase = 'save'
      }
      if (detail?.persistenceFailure) {
        node.state = node.remoteId
          ? 'submitted'
          : node.response !== undefined
            ? 'saving'
            : submitted
              ? 'uncertain'
              : 'pending'
        throw error
      }
      const safeSubmit =
        !submitted ||
        detail?.notSent ||
        detail?.definitiveRejection ||
        (node.service &&
          this.client.canReplay(
            run.owner,
            node.service,
            `${run.id}:${node.id}:${node.attempt ?? 0}`,
          ))
      if (this.stopping || signal.aborted) {
        node.state = node.remoteId
          ? 'submitted'
          : node.response !== undefined
            ? 'saving'
            : safeSubmit
              ? 'pending'
              : 'uncertain'
        return
      }
      const expiredLink =
        phase === 'save' && node.remoteId && [401, 403, 404, 410].includes(detail?.status || 0)
      if ((phase !== 'submit' || safeSubmit) && (transient(error) || expiredLink)) {
        const firstAt = node.retry?.firstAt || new Date().toISOString()
        if (Date.now() - Date.parse(firstAt) < (node.service?.recoveryWindowMs ?? 21600000)) {
          const count = (node.retry?.count || 0) + 1
          if (expiredLink) {
            node.response = undefined
            phase = 'poll'
          }
          node.retry = {
            phase,
            count,
            firstAt,
            nextAt: new Date(
              Date.now() + Math.max(detail?.retryAfterMs || 0, backoff(count)),
            ).toISOString(),
          }
          node.state = phase === 'submit' ? 'pending' : phase === 'poll' ? 'submitted' : 'saving'
          node.error = '连接暂时中断，任务已保留，稍后自动恢复'
          return
        }
        node.error = '自动恢复窗口已结束；远程任务与已保存结果仍保留，可继续查询'
      }
      node.state =
        (submitted || detail?.ambiguousSubmission) &&
        !node.remoteId &&
        (node.response === undefined ||
          (error && typeof error === 'object' && 'ambiguousSubmission' in error)) &&
        !(
          error &&
          typeof error === 'object' &&
          'definitiveRejection' in error &&
          error.definitiveRejection
        )
          ? 'uncertain'
          : 'failed'
      node.retry = undefined
    } finally {
      if (['completed', 'failed', 'uncertain', 'cancelled', 'skipped'].includes(node.state))
        node.finishedAt = new Date().toISOString()
      if (acquired) this.services.set(serviceKey, (this.services.get(serviceKey) ?? 1) - 1)
      this.store.saveRun(run)
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 600) : '执行失败'
}
