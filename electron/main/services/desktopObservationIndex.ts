/**
 * @file 「手」查观察用的小索引：按 observationId 取回观察（元素图、窗口、画面指纹）。
 *
 * desktopControl 自己的观察表是私有的，并在动作发出时清空；「手」需要在动作前把编号换成控件或坐标、
 * 在动作后比对前后画面，所以 desktopObserve 每登记一次观察也在这里记一份（最多 32 份）。
 * 这里只做查找；能不能拿来操作（归属、有效期、控制权）仍由 desktopControl 按 observationId 核对。
 *
 * @platform ELECTRON
 */

import type { Observation } from './desktopObserve'

const LIMIT = 32
const observations = new Map<string, Observation>()

export function rememberObservation(observation: Observation): void {
  observations.set(observation.id, observation)
  while (observations.size > LIMIT) observations.delete(observations.keys().next().value!)
}

/** 与 desktopControl 的归属规则一致：同一个角色的同一个任务（或对话）。 */
export function observationOwner(caller: {
  agentId?: string
  threadId?: string
  taskId?: string
}): string {
  return `${caller.agentId ?? 'system'}:${caller.taskId ?? caller.threadId ?? 'desktop'}`
}

/** 按编号取回属于这个调用方的观察；不存在或不属于它时返回 undefined。 */
export function findObservation(
  id: unknown,
  caller: { agentId?: string; threadId?: string; taskId?: string },
): Observation | undefined {
  const observation = observations.get(String(id ?? ''))
  return observation && observation.owner === observationOwner(caller) ? observation : undefined
}

/** 测试用。 */
export function clearObservationIndex(): void {
  observations.clear()
}
