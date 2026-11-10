import { t as __t } from '../lib/i18n'
import { resourceFromToolResult } from '@infos/shared'
import { splitSpokenReply } from '../nit/spokenReplyFilter'
import type {
  ConversationMessageProjection,
  ConversationSurfaceDescriptor,
  ErrorSurfaceProps,
  MarkdownSurfaceProps,
  SurfaceId,
  SurfaceNode,
  SurfaceNodeId,
  ToolCallSurfaceProps,
  ToolResultSurfaceProps,
} from '@infos/shared'

/** 将 Conversation 领域读模型确定性映射为 committed Surface。 */
export class ConversationSurfaceProjector {
  projectMessage(
    message: ConversationMessageProjection,
    principalId: string,
  ): ConversationSurfaceDescriptor {
    const surfaceId = `conversation-message:${message.messageId}` as SurfaceId
    const nodes: SurfaceNode[] = []
    const messageContent =
      message.role === 'assistant' ? splitSpokenReply(message.content).content : message.content
    const contentBlocks = message.contentBlocks ?? []
    const auditCalls = message.toolCalls ?? []
    const knownCalls = new Set(
      contentBlocks.filter((block) => block.kind === 'tool').map((block) => block.callId),
    )
    const inferredParents = new Map<string, string>()
    let pendingLegacyCalls: string[] = []
    // 旧 NIT 已有真实内部审计记录，但缺少父调用关联；其完成记录紧邻外层脚本记录之前。
    for (const call of auditCalls) {
      if (call.callId?.startsWith('nit-') && !call.parentCallId)
        pendingLegacyCalls.push(call.callId)
      if (call.name === 'run_script' && call.callId) {
        for (const id of pendingLegacyCalls) inferredParents.set(id, call.callId)
        pendingLegacyCalls = []
      }
    }
    const supplementalCalls = new Map<string, ConversationMessageProjection['toolCalls']>()
    for (const call of auditCalls) {
      if (!call.callId || knownCalls.has(call.callId)) continue
      const parentCallId = call.parentCallId ?? inferredParents.get(call.callId)
      if (!parentCallId || !knownCalls.has(parentCallId)) continue
      const list = supplementalCalls.get(parentCallId) ?? []
      if (!list.some((item) => item.callId === call.callId)) list.push({ ...call, parentCallId })
      supplementalCalls.set(parentCallId, list)
    }
    if (contentBlocks.length > 0) {
      for (const block of contentBlocks) {
        if (block.kind === 'model_retry') {
          nodes.push(
            this.node(surfaceId, 'model-retry', 'stable', message.revision, block.blockId, {
              ...block.retry,
              turn: block.turn,
            }),
          )
          continue
        }
        if (block.kind === 'thinking') {
          nodes.push(
            this.node(
              surfaceId,
              'thinking',
              'stable',
              message.revision,
              `${block.blockId}:turn:${block.turn}`,
              {
                source: block.content,
                phase: 'committed',
                durationMs: block.durationMs,
                turn: block.turn,
              },
            ),
          )
          continue
        }
        if (block.kind === 'native_reasoning') {
          nodes.push(
            this.node(
              surfaceId,
              'native-reasoning',
              'stable',
              message.revision,
              `${block.blockId}:turn:${block.turn}`,
              {
                source: block.content,
                phase: 'committed',
                mode: block.mode,
                durationMs: block.durationMs,
                turn: block.turn,
              },
            ),
          )
          continue
        }
        if (block.kind === 'narration') {
          // 旧正文块中的控制标签只在展示层兼容清理，不改写审计原文。
          const content =
            message.role === 'assistant' ? splitSpokenReply(block.content).content : block.content
          if (!content) continue
          nodes.push(
            this.node<MarkdownSurfaceProps>(
              surfaceId,
              'markdown',
              'stable',
              message.revision,
              block.blockId,
              {
                source: content,
                phase: 'committed',
                final: block.phase === 'final',
              },
            ),
          )
          continue
        }
        nodes.push(...this.projectToolBlock(surfaceId, message.revision, block))
        for (const call of supplementalCalls.get(block.callId) ?? []) {
          nodes.push(
            ...this.projectToolBlock(surfaceId, message.revision, {
              ...call,
              blockId: `tool:${call.callId}`,
              callId: call.callId!,
              kind: 'tool',
              sequence: block.sequence,
              turn: block.turn,
            }),
          )
        }
      }
    } else {
      const failureOnly =
        (message.status === 'failed' || message.status === 'interrupted') &&
        (!message.content || message.content.replace(/^⚠️\s*/, '') === message.failureMessage)
      if (messageContent && !failureOnly) {
        nodes.push(
          this.node<MarkdownSurfaceProps>(
            surfaceId,
            'markdown',
            'stable',
            message.revision,
            'markdown',
            {
              source: messageContent,
              phase: 'committed',
              final: true,
            },
          ),
        )
      }
      for (const [index, call] of auditCalls.entries()) {
        const callId = call.callId ?? `tool-${index}`
        nodes.push(
          ...this.projectToolBlock(surfaceId, message.revision, {
            blockId: `tool:${callId}`,
            sequence: index,
            kind: 'tool',
            turn: 0,
            callId,
            ...call,
            parentCallId: call.parentCallId ?? inferredParents.get(callId),
          }),
        )
      }
    }
    if (messageContent && !message.executionRecord && !nodes.some((node) => node.kind === 'markdown' &&
      (node.props as MarkdownSurfaceProps).final === true)) {
      nodes.push(this.node(surfaceId, 'markdown', 'stable', message.revision, 'published', {
        source: messageContent, phase: 'committed', final: true,
      } satisfies MarkdownSurfaceProps))
    }
    for (const attachment of message.attachments) {
      if (
        nodes.some(
          (node) =>
            node.kind === 'attachment' && (node.props as { id: string }).id === attachment.id,
        )
      )
        continue
      nodes.push(
        this.node(
          surfaceId,
          'attachment',
          'interactive',
          message.revision,
          `attachment:${attachment.id}`,
          attachment,
        ),
      )
    }
    if (message.executionPause) {
      nodes.push(
        this.node(surfaceId, 'status', 'stable', message.revision, 'status', {
          state: 'paused',
          message: __t('server.projections', '桌面操作已暂停：{0}', [
            message.executionPause.message,
          ]),
        } satisfies import('@infos/shared').StatusSurfaceProps),
      )
    } else if (message.status === 'failed' || message.status === 'interrupted') {
      const props: ErrorSurfaceProps = {
        code: message.status === 'interrupted' ? 'INTERRUPTED' : 'EXECUTION_FAILED',
        message: message.failureMessage ?? message.content,
      }
      nodes.push(
        this.node<ErrorSurfaceProps>(
          surfaceId,
          'error',
          'stable',
          message.revision,
          'error',
          props,
        ),
      )
    }
    return {
      surfaceId,
      generation: `message:${message.messageId}:revision:${message.revision}`,
      messageId: message.messageId,
      generationStats: message.generationStats,
      threadId: message.threadId,
      principalId,
      revision: message.revision,
      sequence: 0,
      state:
        !message.executionPause && (message.status === 'failed' || message.status === 'interrupted')
          ? 'failed'
          : 'committed',
      nodes,
    }
  }

  private projectToolBlock(
    surfaceId: SurfaceId,
    revision: number,
    block: Extract<import('@infos/shared').ConversationContentBlock, { kind: 'tool' }>,
  ): SurfaceNode[] {
    const resource = block.isError ? null : resourceFromToolResult(block.name, block.result)
    if (resource && !block.parentCallId)
      return [
        this.node(
          surfaceId,
          'attachment',
          'interactive',
          revision,
          `attachment:${resource.id}`,
          resource,
        ),
      ]
    const nodes: SurfaceNode[] = [
      this.node<ToolCallSurfaceProps>(
        surfaceId,
        'tool-call',
        'interactive',
        revision,
        block.blockId,
        {
          callId: block.callId,
          parentCallId: block.parentCallId,
          name: block.name,
          args: block.args,
          state: block.result === undefined ? 'calling' : block.isError ? 'failed' : 'completed',
        },
      ),
    ]
    if (block.result !== undefined) {
      nodes.push(
        this.node<ToolResultSurfaceProps>(
          surfaceId,
          'tool-result',
          'stable',
          revision,
          `tool-result:${block.callId}`,
          {
            callId: block.callId,
            result: block.result,
            isError: block.isError ?? false,
            durationMs: block.durationMs,
            automaticApproval: block.automaticApproval,
          },
        ),
      )
    }
    return nodes
  }

  private node<T extends object>(
    surfaceId: SurfaceId,
    kind: SurfaceNode['kind'],
    lifecycle: SurfaceNode['lifecycle'],
    revision: number,
    suffix: string,
    props: T,
  ): SurfaceNode<T> {
    return {
      nodeId: `${surfaceId}:${suffix}` as SurfaceNodeId,
      kind,
      lifecycle,
      revision,
      props,
    }
  }
}
