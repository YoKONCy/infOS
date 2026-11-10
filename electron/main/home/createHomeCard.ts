import { getBackendOrigin } from '../services/clientConnection'
import { normalizeHomeCardBinding } from '../../../packages/shared/src/homeCardChannel'
import type { DesktopCards } from '../windows/desktopCardManager'
import { homeRequest } from './homeRequest'
import { notifyHomePetCard } from './homePetCards'

/** 创建结果返回工具前完成绑定，Agent 紧接着 patch 时已有权威卡片记录。 */
export async function createHomeCard(
  cards: Pick<DesktopCards, 'create' | 'remove'>,
  args: Record<string, unknown>,
) {
  const homeBinding = normalizeHomeCardBinding({
    origin: getBackendOrigin(),
    scope: args.__homeScope,
  })
  const card = cards.create({ ...args, homeBinding })
  try {
    if (homeBinding) {
      await homeRequest('/cards/bind', homeBinding.scope, card.id)
      if (homeBinding.origin !== getBackendOrigin()) throw new Error('HOME_CARD_UNBOUND')
    }
  } catch (error) {
    // 仅回滚本次刚创建的窗口，避免重试留下重复的未就绪卡片。
    cards.remove(card.id)
    throw error
  }
  notifyHomePetCard(card.id, 'greeting')
  return card
}
