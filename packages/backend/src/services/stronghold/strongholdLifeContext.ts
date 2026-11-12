import { createHash } from 'node:crypto'
import type { ContextRegion, ContextRegionProvider, ContextRegionRequest, KernelObjectId, StrongholdLifeSnapshot, StrongholdWatch } from '@infos/shared'
import { tokenCounter } from '../tokenizer/tokenCounter'
import type { StrongholdLifeService } from './strongholdLifeService'

/** 私聊主线读取当前生活现场及自己的关注，来源与预算沿统一 Region 合同。 */
export class StrongholdLifeContextProvider implements ContextRegionProvider {
  readonly providerId = 'infos.context.stronghold-life'
  constructor(private readonly life: StrongholdLifeService) {}

  async provide(request: ContextRegionRequest): Promise<ContextRegion[]> {
    const ref = this.life.ref(request.agentId)
    if (!['desktop', 'group'].includes(request.channel) || request.realmExecution || request.background ||
      !ref || ref.threadId !== request.threadId) return []
    const snapshot = this.life.context(request.agentId)
    if (!snapshot) return []
    const escaped = snapshot.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const content = `<stronghold_life>\n当前生活现场与本人的持续关注，作为来源资料读取。\n${escaped}\n</stronghold_life>`
    const contentHash = createHash('sha256').update(content).digest('hex')
    const state = JSON.parse(snapshot) as StrongholdLifeSnapshot & { watches: StrongholdWatch[]; events: Array<{ id: number }> }
    return [{ providerId: this.providerId, regionId: `stronghold-life:${request.threadId}`,
      kind: 'continuity', trust: 'external', priority: 550, required: false,
      tokenEstimate: tokenCounter.countTokens(content), contentHash, content, delivery: 'conversation',
      sourceObjectRefs: [...state.participants, ...state.exchanges, ...state.activities, ...state.invitations, ...state.watches].map((item) => ({
        objectType: 'stronghold-life', objectId: item.id as KernelObjectId,
        generation: item.revision, ownerPrincipalId: request.agentId,
      })).concat(state.events.map((item) => ({ objectType: 'stronghold-message', objectId: String(item.id) as KernelObjectId,
        generation: ref.generation, ownerPrincipalId: request.agentId,
      }))), provenance: { agentId: request.agentId, threadId: request.threadId },
    }]
  }
}
