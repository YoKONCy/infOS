import type {AppContext} from '../../container'
import {speechControllers, speechGenerations} from '../voice/speechPriority'

/** 语音服务卡住时不能占着通道。 */
const SYNTHESIZE_MS=15_000
/** 手动陪看插话的语音：文字已经发了，这里只管念，失败也不影响消息。复用同一个 TTS 与音频播放通道。 */
export async function speakPerceptionLine(ctx: AppContext, text: string, agentId: string, threadId: string, allowed: () => boolean, signal: AbortSignal): Promise<boolean> {
  if (!allowed() || signal.aborted || speechControllers.has(agentId) || ctx.audioDeliveryService.isPlaying(agentId)) return false
  if (!ctx.ttsService.availableFor(agentId)) return false
  const seat=ctx.nodeRegistry.getInputSeat(agentId,'audio-output')
  if(!seat || !ctx.audioDeliveryService.canDeliverTo(seat.nodeId)) return false
  const generation=(speechGenerations.get(agentId)??0)+1
  speechGenerations.set(agentId,generation)
  const controller=new AbortController(); speechControllers.set(agentId,controller)
  const abort=()=>{controller.abort(); void ctx.audioDeliveryService.cancel(agentId).catch(()=>{})}
  signal.addEventListener('abort',abort,{once:true})
  const current=()=>allowed()&&!signal.aborted&&!controller.signal.aborted&&speechGenerations.get(agentId)===generation
  try {
    if(!current()) return false
    const audio=await ctx.ttsService.synthesize({text,agentId,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(SYNTHESIZE_MS)])})
    if(!current()) return false
    const receipt=await ctx.audioDeliveryService.deliver(audio,{principalId:agentId,correlationId:threadId,targetNodeId:seat.nodeId,idempotencyKey:`perception:${generation}`},seat.nodeId,{caption:text,threadId,isCurrent:current,ephemeral:true})
    return receipt.state==='completed'
  } catch {return false}
  finally {signal.removeEventListener('abort',abort); if(speechControllers.get(agentId)===controller) speechControllers.delete(agentId)}
}
