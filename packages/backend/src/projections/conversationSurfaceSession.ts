import { randomUUID } from 'node:crypto'
import { ipcPayloadBytes, performanceEventsTotal, performanceLatencySeconds } from '../lib/metrics'
import type { FileWritePreviewBaseline } from '@infos/shared'
import type {
  SurfaceFrame,
  SurfaceId,
  SurfaceNode,
  SurfaceNodeId,
  ToolCallSurfaceProps,
  ToolResultSurfaceProps,
  ModelRetrySurfaceProps,
  LiveContextBudget,
} from '@infos/shared'

/** 单次 Conversation Execution 的实时 Surface 帧构造器。 */
export class ConversationSurfaceSession {
  readonly surfaceId: SurfaceId
  readonly generation = randomUUID()
  private readonly markdownNodeIds = new Map<string, SurfaceNodeId>()
  private readonly reasoningNodeIds = new Map<string, SurfaceNodeId>()
  private readonly thinkingNodeIds = new Map<string, SurfaceNodeId>()
  private readonly toolDrafts = new Map<string, ToolCallSurfaceProps>()
  private sequence = 0
  private revision = 0
  private readonly toolArgumentPreviewLimit = 2048
  private readonly createdAt = performance.now()
  private firstFrameRecorded = false
  private latestContextBudget?: LiveContextBudget
  private readonly liveNodes = new Map<SurfaceNodeId, SurfaceNode>()
  private liveState: import('@infos/shared').SurfaceDescriptor['state'] = 'open'

  constructor(
    readonly threadId: string,
    readonly principalId: string,
    public executionId?: string,
    private readonly retainLiveSnapshot = false,
    private readonly processCollapsed = false,
    private readonly threadGeneration?: number,
  ) {
    this.surfaceId = `conversation:${threadId}:${executionId ?? this.generation}` as SurfaceId
  }

  /** 准备阶段提前开流后，在正式 Execution 创建完成时补齐因果身份，保持 surfaceId 恒定不变。 */
  bindExecution(executionId: string): void {
    this.executionId = executionId
  }

  /** 队列回合在页面刷新或切换后，可恢复当前画面而无需重放模型请求。 */
  liveSnapshot(): import('@infos/shared').SurfaceDescriptor {
    return {
      surfaceId: this.surfaceId,
      processCollapsed: this.processCollapsed,
      threadGeneration: this.threadGeneration,
      generation: this.generation,
      threadId: this.threadId,
      principalId: this.principalId,
      executionId: this.executionId,
      revision: this.revision,
      sequence: this.sequence,
      state: this.liveState,
      nodes: [...this.liveNodes.values()],
    }
  }

  open(initialMessage?: string): SurfaceFrame {
    return this.frame({
      type: 'surface.open',
      processCollapsed: this.processCollapsed,
      threadId: this.threadId,
      principalId: this.principalId,
      nodes: [this.statusNode('thinking', initialMessage)],
    })
  }

  startThinking(blockId: string, turn?: number): SurfaceFrame {
    const nodeId = `${this.surfaceId}:${blockId}` as SurfaceNodeId
    this.thinkingNodeIds.set(blockId, nodeId)
    return this.frame({
      type: 'surface.upsert-node',
      node: this.node(nodeId, 'thinking', 'stable', { source: '', phase: 'preview', turn }),
    })
  }

  appendThinking(blockId: string, delta: string): SurfaceFrame {
    const nodeId = this.thinkingNodeIds.get(blockId)
    if (!nodeId) throw new Error(`碎碎念块尚未开始: ${blockId}`)
    return this.frame({ type: 'surface.append-text', nodeId, delta })
  }

  completeThinking(blockId: string, durationMs: number): SurfaceFrame {
    const nodeId = this.thinkingNodeIds.get(blockId)
    if (!nodeId) throw new Error(`碎碎念块尚未开始: ${blockId}`)
    return this.frame({
      type: 'surface.patch-node',
      nodeId,
      patch: { phase: 'committed', durationMs },
    })
  }

  startNativeReasoning(
    blockId: string,
    mode: 'stream' | 'non_stream',
    turn?: number,
  ): SurfaceFrame {
    const nodeId = `${this.surfaceId}:${blockId}` as SurfaceNodeId
    this.reasoningNodeIds.set(blockId, nodeId)
    return this.frame({
      type: 'surface.upsert-node',
      node: this.node(nodeId, 'native-reasoning', 'stable', {
        source: '',
        phase: 'preview',
        mode,
        turn,
      }),
    })
  }

  appendNativeReasoning(blockId: string, delta: string): SurfaceFrame {
    const nodeId = this.reasoningNodeIds.get(blockId)
    if (!nodeId) throw new Error(`原生思考块尚未开始: ${blockId}`)
    return this.frame({ type: 'surface.append-text', nodeId, delta })
  }

  completeNativeReasoning(blockId: string, durationMs: number): SurfaceFrame {
    const nodeId = this.reasoningNodeIds.get(blockId)
    if (!nodeId) throw new Error(`原生思考块尚未开始: ${blockId}`)
    return this.frame({
      type: 'surface.patch-node',
      nodeId,
      patch: { phase: 'committed', durationMs },
    })
  }

  startNarration(blockId: string): SurfaceFrame {
    const nodeId = `${this.surfaceId}:${blockId}` as SurfaceNodeId
    this.markdownNodeIds.set(blockId, nodeId)
    return this.frame({
      type: 'surface.upsert-node',
      node: this.node(nodeId, 'markdown', 'stable', { source: '', phase: 'preview' }),
    })
  }

  appendText(blockId: string, delta: string): SurfaceFrame {
    const nodeId = this.markdownNodeIds.get(blockId)
    if (!nodeId) throw new Error(`Narration块尚未开始: ${blockId}`)
    return this.frame({ type: 'surface.append-text', nodeId, delta })
  }

  completeNarration(blockId: string, final = false): SurfaceFrame {
    const nodeId = this.markdownNodeIds.get(blockId)
    if (!nodeId) throw new Error(`正文块尚未开始: ${blockId}`)
    return this.frame({ type: 'surface.patch-node', nodeId, patch: { phase: 'committed', final } })
  }

  contextBudget(budget: LiveContextBudget): SurfaceFrame {
    this.latestContextBudget = budget
    return this.frame({
      type: 'surface.patch-node',
      nodeId: `${this.surfaceId}:status` as SurfaceNodeId,
      patch: { contextBudget: budget },
    })
  }

  status(
    state:
      | 'thinking'
      | 'assembling'
      | 'calling'
      | 'generating'
      | 'tool_failed'
      | 'paused'
      | 'completed',
    message?: string,
    telemetry?: Pick<
      import('@infos/shared').StatusSurfaceProps,
      'mode' | 'firstTokenMs' | 'outputDurationMs' | 'totalDurationMs'
    >,
  ) {
    return this.frame({
      type: 'surface.upsert-node',
      node: this.statusNode(state, message, telemetry),
    })
  }

  startToolDraft(draftId: string): SurfaceFrame {
    const nodeId = `${this.surfaceId}:tool:${draftId}` as SurfaceNodeId
    const props: ToolCallSurfaceProps = {
      callId: draftId,
      draftId,
      name: '',
      args: '',
      argsPreview: '',
      receivedChars: 0,
      state: 'assembling',
    }
    this.toolDrafts.set(draftId, props)
    return this.frame({
      type: 'surface.upsert-node',
      node: this.node<ToolCallSurfaceProps>(nodeId, 'tool-call', 'interactive', props),
    })
  }

  appendToolDraft(
    draftId: string,
    nameDelta?: string,
    argumentsDelta?: string,
    receivedChars?: number,
  ): SurfaceFrame | null {
    const nodeId = `${this.surfaceId}:tool:${draftId}` as SurfaceNodeId
    const current = this.toolDrafts.get(draftId)
    if (!current) throw new Error(`工具草稿尚未开始: ${draftId}`)
    const name = current.name + (nameDelta ?? '')
    const fileMutation = ['write_file', 'edit_file'].includes(name)
    const delta = fileMutation
      ? (argumentsDelta ?? '')
      : (argumentsDelta ?? '').slice(
          0,
          Math.max(0, this.toolArgumentPreviewLimit - current.args.length),
        )
    const argsPreview = current.args + delta
    const props: ToolCallSurfaceProps = {
      ...current,
      name,
      args: argsPreview,
      argsPreview,
      receivedChars: receivedChars ?? current.receivedChars,
      previewTruncated: fileMutation ? false : (receivedChars ?? 0) > this.toolArgumentPreviewLimit,
    }
    this.toolDrafts.set(draftId, props)
    const nameChanged = props.name !== current.name
    const previewChanged = props.argsPreview !== current.argsPreview
    const previousChars = current.receivedChars ?? 0
    const nextChars = props.receivedChars ?? previousChars
    const progressChanged = Math.floor(previousChars / 4096) !== Math.floor(nextChars / 4096)
    if (!nameChanged && !previewChanged && !progressChanged) return null
    if (fileMutation) {
      return this.frame({
        type: 'surface.append-tool-arguments',
        nodeId,
        nameDelta,
        argumentsDelta: delta || undefined,
        receivedChars: props.receivedChars ?? 0,
        previewTruncated: props.previewTruncated ?? false,
      })
    }
    return this.frame({
      type: 'surface.upsert-node',
      node: this.node<ToolCallSurfaceProps>(nodeId, 'tool-call', 'interactive', props),
    })
  }

  fileBaseline(draftId: string, baseline: FileWritePreviewBaseline): SurfaceFrame {
    const current = this.toolDrafts.get(draftId)
    if (current) this.toolDrafts.set(draftId, { ...current, fileBaseline: baseline })
    return this.frame({
      type: 'surface.patch-node',
      nodeId: `${this.surfaceId}:tool:${draftId}` as SurfaceNodeId,
      patch: { fileBaseline: baseline },
    })
  }

  finalizeToolDraft(input: {
    draftId: string
    callId: string
    name: string
    args: unknown
  }): SurfaceFrame {
    const nodeId = `${this.surfaceId}:tool:${input.draftId}` as SurfaceNodeId
    const props: ToolCallSurfaceProps = {
      ...(this.toolDrafts.get(input.draftId) ?? {
        draftId: input.draftId,
        argsPreview: '',
        receivedChars: 0,
      }),
      callId: input.callId,
      name: input.name,
      args: this.fileArgsOrPreview(
        input.name,
        input.args,
        this.toolDrafts.get(input.draftId)?.args,
      ),
      previewTruncated: ['write_file', 'edit_file'].includes(input.name) ? false : undefined,
      state: 'calling',
    }
    this.toolDrafts.set(input.draftId, props)
    return this.frame({
      type: 'surface.upsert-node',
      node: this.node<ToolCallSurfaceProps>(nodeId, 'tool-call', 'interactive', props),
    })
  }

  toolCall(input: {
    callId: string
    parentCallId?: string
    name: string
    args: unknown
  }): SurfaceFrame {
    const nodeId = `${this.surfaceId}:tool:${input.callId}` as SurfaceNodeId
    return this.frame({
      type: 'surface.upsert-node',
      node: this.node<ToolCallSurfaceProps>(nodeId, 'tool-call', 'interactive', {
        callId: input.callId,
        parentCallId: input.parentCallId,
        name: input.name,
        args: this.fileArgsOrPreview(input.name, input.args),
        state: 'calling',
      }),
    })
  }

  modelRetry(input: {
    retry: import('@infos/shared').ModelRetryInfo
    turn: number
    abandonedDraftIds: string[]
  }): SurfaceFrame[] {
    const frames: SurfaceFrame[] = []
    for (const draftId of input.abandonedDraftIds) {
      const draft = this.toolDrafts.get(draftId)
      if (!draft) continue
      this.toolDrafts.delete(draftId)
      frames.push(
        this.frame({
          type: 'surface.upsert-node',
          node: this.node<ToolCallSurfaceProps>(
            `${this.surfaceId}:tool:${draftId}` as SurfaceNodeId,
            'tool-call',
            'interactive',
            { callId: draftId, name: draft.name, args: '{}', argsPreview: '', state: 'failed' },
          ),
        }),
      )
      frames.push(
        ...this.toolResult({
          callId: draftId,
          result: '模型响应中断，此工具调用未执行，参数草稿已丢弃。',
          isError: true,
          durationMs: 0,
        }),
      )
    }
    frames.push(
      this.frame({
        type: 'surface.upsert-node',
        node: this.node<ModelRetrySurfaceProps>(
          `${this.surfaceId}:model-retry:${input.retry.retryId}` as SurfaceNodeId,
          'model-retry',
          'stable',
          { ...input.retry, turn: input.turn },
        ),
      }),
    )
    return frames
  }

  toolResult(input: {
    automaticApproval?: import('@infos/shared').AutomaticApprovalRecord
    callId: string
    result: string
    isError: boolean
    durationMs?: number
  }): SurfaceFrame[] {
    return [
      this.frame({
        type: 'surface.upsert-node',
        node: this.node<ToolResultSurfaceProps>(
          `${this.surfaceId}:tool-result:${input.callId}` as SurfaceNodeId,
          'tool-result',
          'stable',
          input,
        ),
      }),
    ]
  }

  publish(snapshot: import('@infos/shared').ConversationProjectionSnapshot): SurfaceFrame {
    return this.frame({ type: 'surface.publish', snapshot })
  }

  settle(snapshot: import('@infos/shared').ConversationProjectionSnapshot): SurfaceFrame {
    return this.frame({ type: 'surface.settled', snapshot })
  }

  commit(
    snapshot: import('@infos/shared').ConversationProjectionSnapshot,
    message: import('@infos/shared').ConversationMessageProjection,
    surface: import('@infos/shared').ConversationSurfaceDescriptor,
    telemetry?: Pick<
      import('@infos/shared').StatusSurfaceProps,
      'mode' | 'firstTokenMs' | 'outputDurationMs' | 'totalDurationMs'
    >,
  ): SurfaceFrame {
    const committedSurface = telemetry
      ? {
          ...surface,
          nodes: [
            ...surface.nodes.filter((node) => node.kind !== 'status'),
            this.statusNode(
              message.executionPause ? 'paused' : 'completed',
              message.executionPause
                ? `桌面操作已暂停：${message.executionPause.message}`
                : '输出完成',
              telemetry,
            ),
          ],
        }
      : surface
    const committedSnapshot = telemetry
      ? {
          ...snapshot,
          surfaces: snapshot.surfaces.map((item) =>
            item.surfaceId === surface.surfaceId ? committedSurface : item,
          ),
        }
      : snapshot
    return this.frame({
      type: 'surface.commit',
      snapshot: committedSnapshot,
      message,
      surface: committedSurface,
    })
  }

  fail(code: string, message: string, content?: string): SurfaceFrame {
    return this.frame({ type: 'surface.fail', code, message, content })
  }

  private toolArgsPreview(args: unknown): string {
    if (!args || typeof args !== 'object') {
      return String(args ?? '').slice(0, this.toolArgumentPreviewLimit)
    }
    const record = args as Record<string, unknown>
    const preview: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (['content', 'new_text', 'old_text'].includes(key) && typeof value === 'string') {
        preview[key] = `[正文 ${value.length} 字符]`
      } else if (typeof value === 'string' && value.length > 512) {
        preview[key] = `${value.slice(0, 512)}…[共 ${value.length} 字符]`
      } else {
        preview[key] = value
      }
    }
    return JSON.stringify(preview).slice(0, this.toolArgumentPreviewLimit)
  }

  private fileArgsOrPreview(name: string, args: unknown, draft?: string): string {
    if (!['write_file', 'edit_file'].includes(name)) return this.toolArgsPreview(args)
    const serialized = JSON.stringify(args ?? {})
    return serialized === '{}' && draft ? draft : serialized
  }

  private statusNode(
    state: import('@infos/shared').StatusSurfaceProps['state'],
    message?: string,
    telemetry?: Pick<
      import('@infos/shared').StatusSurfaceProps,
      'mode' | 'firstTokenMs' | 'outputDurationMs' | 'totalDurationMs'
    >,
  ): SurfaceNode {
    return this.node(`${this.surfaceId}:status` as SurfaceNodeId, 'status', 'transient', {
      contextBudget: this.latestContextBudget,
      state,
      message,
      ...telemetry,
    })
  }

  private node<T extends object>(
    nodeId: SurfaceNodeId,
    kind: SurfaceNode['kind'],
    lifecycle: SurfaceNode['lifecycle'],
    props: T,
  ): SurfaceNode<T> {
    return { nodeId, kind, lifecycle, revision: ++this.revision, props }
  }

  private frame(operation: SurfaceFrame['operation']): SurfaceFrame {
    if (this.retainLiveSnapshot) {
      if (operation.type === 'surface.open') {
        this.liveNodes.clear()
        for (const node of operation.nodes ?? []) this.liveNodes.set(node.nodeId, node)
      } else if (operation.type === 'surface.upsert-node') {
        this.liveNodes.set(operation.node.nodeId, operation.node)
      } else if (
        operation.type === 'surface.patch-node' ||
        operation.type === 'surface.append-text' ||
        operation.type === 'surface.append-tool-arguments'
      ) {
        const node = this.liveNodes.get(operation.nodeId)
        if (node) {
          const props = { ...node.props } as Record<string, unknown>
          if (operation.type === 'surface.patch-node') Object.assign(props, operation.patch)
          else if (operation.type === 'surface.append-text')
            props.source = String(props.source ?? '') + operation.delta
          else {
            props.name = String(props.name ?? '') + (operation.nameDelta ?? '')
            props.argsPreview = String(props.argsPreview ?? '') + (operation.argumentsDelta ?? '')
            props.args = props.argsPreview
            props.receivedChars = operation.receivedChars
            props.previewTruncated = operation.previewTruncated
          }
          this.liveNodes.set(node.nodeId, { ...node, props, revision: this.revision + 1 })
        }
      } else if (operation.type === 'surface.commit' || operation.type === 'surface.settled') this.liveState = 'committed'
      else if (operation.type === 'surface.fail') this.liveState = 'failed'
      else if (operation.type === 'surface.dispose') this.liveState = 'disposed'
    }
    const frame: SurfaceFrame = {
      threadId: this.threadId,
      threadGeneration: this.threadGeneration,
      protocolVersion: 1,
      surfaceId: this.surfaceId,
      generation: this.generation,
      revision: ++this.revision,
      sequence: ++this.sequence,
      executionId: this.executionId,
      operationId: randomUUID(),
      operation,
    }
    if (!this.firstFrameRecorded) {
      this.firstFrameRecorded = true
      performanceLatencySeconds.observe(
        { metric: 'surface_first_frame', provider: 'conversation' },
        (performance.now() - this.createdAt) / 1000,
      )
    }
    performanceEventsTotal.inc({ metric: 'surface_frame', outcome: operation.type })
    ipcPayloadBytes.observe(
      { carrier: 'surface', direction: 'outbound' },
      Buffer.byteLength(JSON.stringify(frame)),
    )
    return frame
  }
}
