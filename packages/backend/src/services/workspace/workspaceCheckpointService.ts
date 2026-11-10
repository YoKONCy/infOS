import { t as __t } from '../../lib/i18n'
/**
 * workspaceCheckpointService — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import type {
  FileSnapshotRepository,
  FileChangeOperation,
} from '../../repositories/fileSnapshot.repo'
import type { ToolContext } from '../agent/toolRegistry'
import type { LocalWorkspaceService } from '../workspace/workspaceService'
import { createLogger } from '../../lib/logger'
import { AppError } from '../../lib/appError'

const logger = createLogger('WorkspaceCheckpoint')

export interface SnapshotContext {
  agentId: string
  threadId?: string
  pairId?: string
  callId?: string
  channel?: string
  taskId?: string
}

export interface RewindFilePreview {
  path: string
  preservedReason?: 'content_changed' | 'history_gap' | 'incomplete_snapshot' | 'unavailable'
  action:
    | 'delete_created'
    | 'restore_edited'
    | 'restore_deleted'
    | 'restore_renamed'
    | 'preserve_changed'
}

export interface RewindPreview {
  scope?: 'message' | 'execution'
  messageIds?: number[]
  threadId: string
  agentId?: string
  wholeThread: boolean
  targetMessageId?: number
  pairIds: string[]
  pairCount: number
  createdCount: number
  editedCount: number
  preservedCount: number
  files: RewindFilePreview[]
  forceWarning: boolean
}

export interface RewindRollbackResult {
  files: RewindFilePreview[]
  rolledBackCount: number
  preservedCount: number
}

interface FileState {
  content: Buffer | null
  hash: string | null
  mode?: number
}

interface FileRewindPlan {
  path: string
  action: RewindFilePreview['action']
  expectedHash: string | null
  target: FileState
  preservedReason?: RewindFilePreview['preservedReason']
}

interface AppliedFile {
  plan: FileRewindPlan
  before: FileState
}

/**
 * 对话轮次级工作区检查点服务。
 * 首期捕获文本创建/编辑/覆盖；数据模型预留删除与重命名回滚。
 */
export class WorkspaceCheckpointService {
  private readonly rewindQueues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly repo: FileSnapshotRepository,
    private readonly workspace: LocalWorkspaceService,
  ) {}

  /** 将工具执行上下文转换为快照上下文，显式映射 toolCallId → callId。 */
  async captureToolMutation(context: ToolContext, filePath: string) {
    return this.captureBefore(
      {
        agentId: context.agentId,
        threadId: context.threadId,
        pairId: context.pairId,
        callId: context.toolCallId,
        channel: context.channel,
        taskId: context.taskId,
      },
      filePath,
    )
  }

  /** 在文件工具写入前读取原状态；无轮次上下文的调用不创建伪快照。 */
  async captureBefore(context: SnapshotContext, filePath: string) {
    if (!context.threadId || !context.pairId || !context.callId || context.taskId) {
      if (!context.taskId) {
        logger.warn(
          __t('logs.workspace', '跳过文件快照：缺少轮次上下文 (thread={0}, pair={1}, call={2})', [
            context.threadId ?? '-',
            context.pairId ?? '-',
            context.callId ?? '-',
          ]),
        )
      }
      return null
    }
    const check = this.workspace.validatePath(
      context.agentId,
      filePath,
      'write',
      context.channel ?? 'desktop',
    )
    if (!check.allowed) throw new Error(check.reason ?? `文件路径不允许写入: ${filePath}`)
    const resolved = check.resolvedPath
    const info = await stat(resolved).catch(() => null)
    if (!info) {
      return {
        context,
        filePath: this.normalizeRelative(context.agentId, resolved),
        operation: 'create' as const,
        originalContent: undefined,
        originalSha256: undefined,
      }
    }
    if (!info.isFile()) throw new Error(`快照目标不是普通文件: ${filePath}`)
    const originalContent = await readFile(resolved, 'utf8')
    return {
      context,
      filePath: this.normalizeRelative(context.agentId, resolved),
      operation: 'modify' as const,
      originalContent,
      originalSha256: this.sha256(originalContent),
    }
  }

  /** 写入成功后持久化快照；失败的工具调用不产生记录。 */
  async commit(
    captured: Awaited<ReturnType<WorkspaceCheckpointService['captureBefore']>>,
    finalContent: string | Buffer,
    historyContinuous = true,
  ): Promise<void> {
    if (!captured) return
    await this.repo.upsert({
      id: `fs_${randomUUID()}`,
      threadId: captured.context.threadId!,
      pairId: captured.context.pairId!,
      callId: captured.context.callId!,
      filePath: captured.filePath,
      operation: captured.operation,
      originalContent: captured.originalContent,
      originalSha256: captured.originalSha256,
      finalSha256: this.sha256(finalContent),
      historyContinuous,
    })
  }

  /** 写入成功后从磁盘读取最终内容并提交，适用于 edit/append 等无法直接获得完整新文本的工具。 */
  async commitFromDisk(
    captured: Awaited<ReturnType<WorkspaceCheckpointService['captureBefore']>>,
    written: { oldHash?: string; newHash: string },
  ): Promise<void> {
    if (!captured) return
    const resolved = this.workspace.resolve(captured.context.agentId, captured.filePath)
    const finalContent = await readFile(resolved, 'utf8')
    // 核对工具实际写入的前后版本，避免把读盘前夹入的人工修改归给 Agent。
    await this.commit(
      captured,
      finalContent,
      captured.originalSha256 === written.oldHash && this.sha256(finalContent) === written.newHash,
    )
  }

  /** 为删除/重命名工具预留统一登记入口。 */
  async recordReserved(input: {
    context: Required<Pick<SnapshotContext, 'threadId' | 'pairId' | 'callId'>>
    filePath: string
    operation: Extract<FileChangeOperation, 'delete' | 'rename'>
    renameTargetPath?: string
    originalContent: string
  }): Promise<void> {
    await this.repo.upsert({
      id: `fs_${randomUUID()}`,
      threadId: input.context.threadId,
      pairId: input.context.pairId,
      callId: input.context.callId,
      filePath: input.filePath,
      operation: input.operation,
      renameTargetPath: input.renameTargetPath,
      originalContent: input.originalContent,
      originalSha256: this.sha256(input.originalContent),
    })
  }

  async previewPair(threadId: string, messageId: number): Promise<RewindPreview | null> {
    const target = await this.repo.getRewindTarget(threadId, messageId)
    if (!target?.timestamp) return null
    const pairIds = await this.repo.listPairIdsFrom(threadId, {
      timestamp: target.timestamp,
      id: target.id,
    })
    const pairCount = await this.repo.countPairsFrom(threadId, {
      timestamp: target.timestamp,
      id: target.id,
    })
    return this.buildPreview(threadId, pairIds, false, target.id, pairCount)
  }

  async previewExecutions(threadId: string, messageId: number, executionIds: string[]): Promise<RewindPreview> {
    return this.buildPreview(threadId, executionIds, false, messageId)
  }

  async previewThread(threadId: string): Promise<RewindPreview | null> {
    const agentId = await this.repo.getThreadAgent(threadId)
    if (!agentId) return null
    const pairIds = await this.repo.listAllPairIds(threadId)
    return this.buildPreview(threadId, pairIds, true)
  }

  /** 同一工作区的撤回串行执行，避免不同会话同时恢复同一个文件。 */
  async rollback(
    preview: RewindPreview,
    finalize?: () => Promise<void>,
  ): Promise<RewindRollbackResult> {
    const agentId = await this.repo.getThreadAgent(preview.threadId)
    if (!agentId) throw new Error('会话不存在或已删除')
    const previous = this.rewindQueues.get(agentId) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (!(await this.repo.getThreadAgent(preview.threadId)))
          throw new Error('会话不存在或已删除')
        return this.applyRollback(agentId, preview, finalize)
      })
    this.rewindQueues.set(agentId, operation)
    void operation
      .finally(() => {
        if (this.rewindQueues.get(agentId) === operation) this.rewindQueues.delete(agentId)
      })
      .catch(() => undefined)
    return operation
  }

  async deletePairs(preview: RewindPreview, deletedBy = 'user') {
    if (!preview.targetMessageId) throw new Error('轮次回滚缺少目标消息 ID')
    return this.repo.softDeleteFromMessage(preview.threadId, preview.targetMessageId, deletedBy)
  }

  private async buildPreview(
    threadId: string,
    pairIds: string[],
    wholeThread: boolean,
    targetMessageId?: number,
    pairCountOverride?: number,
  ): Promise<RewindPreview> {
    const agentId = await this.repo.getThreadAgent(threadId)
    if (!agentId) throw new Error('会话不存在或已删除')
    const list = this.describePlans(await this.planFiles(agentId, pairIds))
    return {
      threadId,
      agentId,
      wholeThread,
      targetMessageId,
      pairIds,
      pairCount: pairCountOverride ?? pairIds.length,
      createdCount: list.filter((file) => file.action === 'delete_created').length,
      editedCount: list.filter(
        (file) => file.action !== 'delete_created' && file.action !== 'preserve_changed',
      ).length,
      preservedCount: list.filter((file) => file.action === 'preserve_changed').length,
      files: list,
      forceWarning: list.some((file) => file.action !== 'preserve_changed'),
    }
  }

  /** 按真实对话顺序合并变更；任意相邻版本断开时，整条路径均不恢复。 */
  private async planFiles(agentId: string, pairIds: string[]): Promise<FileRewindPlan[]> {
    const snapshots = await this.repo.listSnapshots(pairIds)
    const order = new Map(pairIds.map((id, index) => [id, index]))
    snapshots.sort((left, right) => (order.get(left.pairId) ?? 0) - (order.get(right.pairId) ?? 0))
    const plans = new Map<string, FileRewindPlan>()
    for (const snapshot of snapshots) {
      const key = this.pathKey(snapshot.filePath)
      const content =
        snapshot.operation === 'create' || snapshot.originalContent == null
          ? null
          : Buffer.from(snapshot.originalContent, 'utf8')
      const beforeHash = content === null ? null : this.sha256(content)
      const afterHash = snapshot.operation === 'delete' ? null : snapshot.finalSha256
      let plan = plans.get(key)
      if (!plan) {
        plan = {
          path: snapshot.filePath,
          action:
            snapshot.operation === 'create'
              ? 'delete_created'
              : snapshot.operation === 'delete'
                ? 'restore_deleted'
                : 'restore_edited',
          expectedHash: afterHash,
          target: { content, hash: beforeHash },
        }
        plans.set(key, plan)
      } else if (plan.expectedHash !== beforeHash) {
        plan.preservedReason = 'history_gap'
      }
      if (snapshot.historyContinuous === false) plan.preservedReason = 'history_gap'
      if (snapshot.historyContinuous === null) plan.preservedReason = 'incomplete_snapshot'
      if (
        !['create', 'modify', 'delete'].includes(snapshot.operation) ||
        (snapshot.operation !== 'create' && content === null) ||
        (snapshot.originalSha256 && snapshot.originalSha256 !== beforeHash) ||
        (snapshot.operation !== 'delete' && !afterHash)
      )
        plan.preservedReason = 'incomplete_snapshot'
      plan.expectedHash = afterHash
    }
    for (const plan of plans.values()) {
      if (plan.preservedReason) continue
      try {
        if ((await this.readState(agentId, plan.path)).hash !== plan.expectedHash)
          plan.preservedReason = 'content_changed'
      } catch {
        plan.preservedReason = 'unavailable'
      }
    }
    return [...plans.values()]
  }

  private describePlans(plans: FileRewindPlan[]): RewindFilePreview[] {
    return plans.map((plan) =>
      plan.preservedReason
        ? { path: plan.path, action: 'preserve_changed', preservedReason: plan.preservedReason }
        : { path: plan.path, action: plan.action },
    )
  }

  private async applyRollback(
    agentId: string,
    preview: RewindPreview,
    finalize?: () => Promise<void>,
  ): Promise<RewindRollbackResult> {
    const plans = await this.planFiles(agentId, preview.pairIds)
    const attempted: AppliedFile[] = []
    try {
      for (const plan of plans) {
        if (plan.preservedReason) continue
        const before = await this.readState(agentId, plan.path)
        if (before.hash !== plan.expectedHash) {
          plan.preservedReason = 'content_changed'
          continue
        }
        attempted.push({ plan, before })
        if (!(await this.applyState(agentId, plan.path, before.hash, plan.target, before.mode))) {
          attempted.pop()
          plan.preservedReason = 'content_changed'
        }
      }
      // 消息软删除失败时，文件也恢复到撤回前，避免只完成一半。
      await finalize?.()
    } catch (cause) {
      const unrecovered: AppliedFile[] = []
      for (const entry of [...attempted].reverse()) {
        try {
          const current = await this.readState(agentId, entry.plan.path)
          if (current.hash === entry.before.hash) continue
          if (
            current.hash !== entry.plan.target.hash ||
            !(await this.applyState(agentId, entry.plan.path, current.hash, entry.before))
          )
            unrecovered.push(entry)
        } catch {
          unrecovered.push(entry)
        }
      }
      if (unrecovered.length) {
        const recoveryPath = await this.saveRecovery(agentId, preview.threadId, unrecovered)
        logger.error(__t('logs.workspace', '回滚未完成，恢复材料已保留：{0}', [recoveryPath]))
        throw new AppError('CONFLICT', {
          message: '回滚未完成；部分文件再次变化，已保留当前内容及撤回前备份',
          data: { recoveryPath },
        })
      }
      logger.warn(
        __t('logs.workspace', '回滚未完成，已恢复本次修改的文件：{0}', [
          cause instanceof Error ? cause.message : String(cause),
        ]),
      )
      throw new AppError('CONFLICT', { message: '回滚未完成，已恢复本次修改的文件，请稍后重试' })
    }
    const files = this.describePlans(plans)
    return {
      files,
      rolledBackCount: files.filter((file) => file.action !== 'preserve_changed').length,
      preservedCount: files.filter((file) => file.action === 'preserve_changed').length,
    }
  }

  /** 只读普通文件；拒绝通过链接或父目录跳出原工作区。 */
  private async readState(agentId: string, filePath: string): Promise<FileState> {
    const resolved = await this.resolveSafePath(agentId, filePath)
    const info = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return { content: null, hash: null }
    if (!info.isFile()) throw new Error(`回滚目标不是普通文件：${filePath}`)
    const content = await readFile(resolved)
    return { content, hash: this.sha256(content), mode: info.mode }
  }

  private async resolveSafePath(agentId: string, filePath: string): Promise<string> {
    const root = path.resolve(this.workspace.getWorkspaceRoot(agentId))
    const resolved = this.workspace.resolve(agentId, filePath)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('回滚路径超出工作区')
    const realRoot = await realpath(root)
    let parent = path.dirname(resolved)
    for (;;) {
      try {
        parent = await realpath(parent)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const next = path.dirname(parent)
        if (next === parent) throw error
        parent = next
      }
    }
    const realRelative = path.relative(realRoot, parent)
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative))
      throw new Error('回滚路径的父目录超出工作区')
    return resolved
  }

  /** 写入采用临时文件替换，并在替换前再次检查当前版本。 */
  private async applyState(
    agentId: string,
    filePath: string,
    expectedHash: string | null,
    target: FileState,
    mode?: number,
  ): Promise<boolean> {
    const resolved = await this.resolveSafePath(agentId, filePath)
    if ((await this.readState(agentId, filePath)).hash !== expectedHash) return false
    if (target.content === null) {
      await rm(resolved, { force: true })
      return true
    }
    await mkdir(path.dirname(resolved), { recursive: true })
    const temporary = path.join(
      path.dirname(resolved),
      `.${path.basename(resolved)}.${randomUUID()}.rewind`,
    )
    try {
      const handle = await open(temporary, 'wx', target.mode ?? mode)
      try {
        await handle.writeFile(target.content)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if ((await this.readState(agentId, filePath)).hash !== expectedHash) return false
      await rename(temporary, resolved)
      return true
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async saveRecovery(
    agentId: string,
    threadId: string,
    entries: AppliedFile[],
  ): Promise<string> {
    const directory = path.join(
      path.dirname(this.workspace.getWorkspaceRoot(agentId)),
      'rewind-recovery',
      randomUUID(),
    )
    await mkdir(directory, { recursive: true })
    const files = []
    for (const [index, entry] of entries.entries()) {
      const backup = entry.before.content === null ? null : `${index}.bin`
      if (backup) await writeFile(path.join(directory, backup), entry.before.content!)
      files.push({ path: entry.plan.path, backup, sha256: entry.before.hash })
    }
    await writeFile(
      path.join(directory, 'recovery.json'),
      JSON.stringify({ threadId, files }, null, 2),
      'utf8',
    )
    return directory
  }

  private pathKey(filePath: string): string {
    const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'))
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  private normalizeRelative(agentId: string, resolved: string): string {
    return path.relative(this.workspace.getWorkspaceRoot(agentId), resolved).replaceAll('\\', '/')
  }

  private sha256(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex')
  }
}
