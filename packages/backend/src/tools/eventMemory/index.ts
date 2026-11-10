import type { EventNoteRelation } from '@infos/shared'
import type { BuiltinTool } from '../index'
import type { EventMemoryService } from '../../services/memory/eventMemoryService'

let eventMemoryService: EventMemoryService | null = null

export function setEventMemoryToolDeps(service: EventMemoryService): void {
  eventMemoryService = service
}

export const queryEventNotesTool: BuiltinTool = {
  name: 'query_event_notes',
  async execute(args, ctx) {
    if (!eventMemoryService) return JSON.stringify({ error: '事件记忆服务未初始化' })
    const edgeLabels = Array.isArray(args.edgeLabels)
      ? args.edgeLabels.filter(
          (label): label is EventNoteRelation =>
            typeof label === 'string' &&
            [
              'temporal_next',
              'temporal_prev',
              'caused_by',
              'same_event',
              'same_topic',
              'involves_person',
              'involves_place',
              'involves_object',
            ].includes(label),
        )
      : undefined
    const result = await eventMemoryService.queryDetailed({
      agentId: ctx.agentId,
      query: typeof args.query === 'string' ? args.query : undefined,
      mode: typeof args.mode === 'string' ? (args.mode as never) : 'mixed',
      from: typeof args.from === 'string' ? args.from : undefined,
      to: typeof args.to === 'string' ? args.to : undefined,
      includeArchived: args.includeArchived === true,
      limit: typeof args.limit === 'number' ? args.limit : 10,
      maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
      maxNodes: typeof args.maxNodes === 'number' ? args.maxNodes : undefined,
      maxReturnTokens: typeof args.maxReturnTokens === 'number' ? args.maxReturnTokens : undefined,
      edgeLabels,
      direction:
        args.direction === 'incoming' || args.direction === 'outgoing' || args.direction === 'both'
          ? args.direction
          : undefined,
    })
    return JSON.stringify({ total: result.notes.length, ...result })
  },
}
