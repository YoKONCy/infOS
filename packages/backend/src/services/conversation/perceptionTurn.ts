import type { ThreadService } from '../thread/threadService'
import type { CompiledContext } from '../context/contextCompiler'
import { perceptionSnapshots } from '../perception/perceptionSnapshotStore'
import {
  perceptionFailure,
  perceptionMessage,
  redactPerception,
  withPerception,
} from './perceptionContext'
import type { PrepareTurnParams } from './conversationTurnService'

/** 桌面普通回合带上客户端最近的感知快照；主动、任务、领域回合与已带快照的回合不变。 */
export async function withDesktopPerception(
  params: PrepareTurnParams,
  threads: Pick<ThreadService, 'getThread'>,
): Promise<PrepareTurnParams> {
  if (params.proactive || params.perception || params.taskId || params.realmId || params.internalScene)
    return params
  const thread = await threads.getThread(params.threadId)
  return thread?.channel === 'desktop'
    ? { ...params, perception: perceptionSnapshots.take(thread.agentId) }
    : params
}

/** 回合失败时对外抛出的错误：主动感知回合只给概括，其他回合去掉感知内容。 */
export function perceptionTurnError(params: PrepareTurnParams, error: unknown): unknown {
  if (params.perception && params.proactive) return params.signal?.aborted ? new Error('PERCEPTION_CANCELLED') : perceptionFailure(error, params.perception.text)
  return withPerception(params.perception, !!params.proactive, () => redactPerception(error))
}

/** 把感知快照（含按需补拍的屏幕图）作为临时消息放进本轮模型消息，不入库。 */
export async function attachPerceptionToTurn(
  params: PrepareTurnParams,
  perception: NonNullable<PrepareTurnParams['perception']>,
  compiled: Pick<CompiledContext, 'messages' | 'manifest'>,
  modelConfig: { enableVision?: boolean } | null | undefined,
): Promise<void> {
  // 主动回合只有陪看时带图：跟看插话没有工具可用，不带图她就是瞎的。
  if ((perception.watching || (compiled.manifest.perceptionImage && !params.proactive)) && (perception.images?.length ?? 0) < 2 && modelConfig?.enableVision) {
    const image = await perceptionSnapshots.requestImage(perception.generation, params.signal)
    // 已有的是这段时间的拼图，当前画面放在它后面。
    if (image) perception.images = [...(perception.images ?? []), image]
    else if (compiled.manifest.perceptionImage) perception.text += '\n本轮屏幕图不可用。'
  }
  if (perception.watching && !perception.images?.length)
    perception.text += '\n这一轮你看不到画面，不要说画面里的内容。'
  if (params.proactive || perceptionSnapshots.take()?.generation === perception.generation) {
    const transient = perceptionMessage(perception)
    // 什么都没有时不发空消息，有的模型接口会拒收。
    if (Array.isArray(transient.content) && transient.content.length) compiled.messages.push(transient)
  }
}
