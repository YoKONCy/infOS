import { createHash } from 'node:crypto'

export interface BrowserInvocationScope {
  key: string
  partition: string
}

/** 账号隔离登录态，会话隔离活动页面；身份必须与 Capability 信封一致。 */
export function browserInvocationScope(
  value: unknown,
  principalId: string,
): BrowserInvocationScope {
  if (value === undefined) return { key: 'legacy', partition: 'persist:infos-browser' }
  const scope = value as Record<string, unknown> | null
  if (
    !scope ||
    scope.principalId !== principalId ||
    typeof scope.profileId !== 'string' ||
    !scope.profileId ||
    scope.profileId.length > 1024 ||
    typeof scope.sessionId !== 'string' ||
    !scope.sessionId ||
    scope.sessionId.length > 1024
  )
    throw new Error('WEB_SCOPE_INVALID')
  const hash = (input: string) => createHash('sha256').update(input).digest('hex')
  return {
    key: hash(JSON.stringify([principalId, scope.profileId, scope.sessionId])),
    partition: `persist:infos-browser-${hash(JSON.stringify([principalId, scope.profileId]))}`,
  }
}

export function assertBrowserTargetScope(ownerKey: string, callerKey: string): void {
  if (ownerKey !== callerKey) throw new Error('WEB_TARGET_SCOPE_DENIED')
}
