import type { HomeScope } from './home'

/** 可信宿主持久化的归属；绝不接受卡片脚本传入此结构。 */
export interface HomeCardBinding {
  origin: string
  scope: HomeScope
}
export interface HomeCardData {
  cardId: string
  revision: number
  data: Record<string, unknown>
}

export function normalizeHomeCardBinding(value: unknown): HomeCardBinding | undefined {
  const row = value as HomeCardBinding | undefined
  if (!row || typeof row.origin !== 'string' || !row.scope) return
  const { agentId, sessionId } = row.scope
  if (
    ![agentId, sessionId].every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(id))
  )
    return
  try {
    const url = new URL(row.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    return { origin: url.origin, scope: { agentId, sessionId } }
  } catch {
    return
  }
}

/** 所有更新均是完整数据快照；旧 revision 和非法事件一律丢弃。 */
export function isNewHomeCardData(
  value: unknown,
  cardId: string,
  revision: number,
): value is HomeCardData {
  const row = value as HomeCardData | undefined
  return Boolean(
    row &&
    row.cardId === cardId &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 0 &&
    row.revision > revision &&
    row.data &&
    typeof row.data === 'object' &&
    !Array.isArray(row.data),
  )
}
