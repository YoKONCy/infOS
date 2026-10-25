/**
 * 世界书与提示词装配的衔接
 *
 * 从装配变量中取出扫描用消息、频道与名字，交给 WorldbookService 激活，
 * 结果作为 `world_info` 变量由本轮动态上下文（turn_context）渲染；
 * 酒馆框架没有该区块，由 sillyTavernFramework 放在当前输入之前。
 * 两种方式都位于系统提示词与历史之后，不影响提示词缓存。
 *
 * @module packages/backend/src/services/worldbook/worldbookPrompt
 */

import type { WorldbookActivation } from '@infos/shared'
import {
  emptyWorldbookActivation,
  worldbookChannelOf,
  type WorldbookScanMessage,
} from './worldbookEngine'
import type { WorldbookService } from './worldbookService'

/** 装配变量中的世界书正文。 */
export const WORLDBOOK_VAR = 'world_info'

/**
 * 蓝灯触发概率的种子：取自最近两条扫描消息。
 * 同一轮内多次装配（ReAct 循环、带当前输入的重新编译）结果一致；
 * 不使用 prompt_seed，它在部分编译路径上每次随机生成，社交装配也没有它。
 */
function scanSeed(scene: string, agentId: string, scan: readonly WorldbookScanMessage[]): string {
  const tail = scan
    .slice(-2)
    .map((message) => JSON.stringify(message.content ?? '').slice(0, 2000))
    .join('\n')
  return `${scene}:${agentId}:${tail}`
}

export function activateWorldbookForPrompt(
  service: WorldbookService | undefined,
  channel: string,
  agentId: string,
  vars: Record<string, unknown>,
): WorldbookActivation {
  // 据点执行与后台任务不注入角色世界书。
  const scene = worldbookChannelOf(channel, Boolean(vars.is_group))
  if (!service || !scene || !agentId || vars.realm_execution) return emptyWorldbookActivation()
  const history = Array.isArray(vars.native_history)
    ? (vars.native_history as WorldbookScanMessage[])
    : []
  const current =
    vars.current_message && typeof vars.current_message === 'object'
      ? (vars.current_message as WorldbookScanMessage)
      : undefined
  // 桌面与社交编译器提供只含对话正文的扫描列表；其余装配（群聊、预览）退回历史与当前输入。
  const scan = Array.isArray(vars.worldbook_scan)
    ? (vars.worldbook_scan as WorldbookScanMessage[])
    : current
      ? [...history, current]
      : history
  return service.activate({
    agentId,
    channel: scene,
    messages: scan,
    charName: String(vars.agent_name ?? agentId),
    userName: String(vars.owner_name ?? ''),
    seed: scanSeed(scene, agentId, scan),
  })
}
