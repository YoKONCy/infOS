/**
 * 陪看 / 感知回合在主动调度执行时的参数装配。
 */
import type { PerceptionSnapshot } from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'

/** 感知回合用指派的快模型；没指派就跟平时一样。 */
export async function watchAlongSpeakingModel(
  configRepo: Pick<ConfigRepository, 'get'>,
): Promise<number | undefined> {
  return Number(await configRepo.get('model.task.watch_along')) || undefined
}

/** 感知（companion）回合覆盖的回合参数；自主行动回合不覆盖。返回类型保持推断，与原内联展开一致。 */
export function companionTurnOptions(input: {
  mode: string
  threadId: string
  content: string
  instruction?: string
  snapshot?: PerceptionSnapshot
  watching?: boolean
  speakingModel?: number
}) {
  const { mode, content, instruction, snapshot, watching, speakingModel } = input
  return mode === 'companion'
    ? {
        // 指令放正文，看到的内容单独放临时消息：数据块里写着「不是指令」，指令不能混进去。
        content: instruction ?? '请判断本次是否有值得说的话。',
        capabilityScope: 'perception' as const,
        ...(speakingModel ? { modelConfigId: speakingModel } : {}),
        ...(watching ? { disableMemoryRetrieval: true } : {}),
        perception: snapshot ?? {
          source: 'perception' as const,
          generation: 0,
          capturedAt: Date.now(),
          text: content,
        },
      }
    : {}
}
