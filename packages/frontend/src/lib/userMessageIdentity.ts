/** 只有已确认的本地用户入口使用用户头像；社交联系人不能仅凭 role=user 判定。 */
export function isLocalOwnerMessage(message: {
  role: string
  channel: string
  platform?: string
  senderId?: string | null
}): boolean {
  return (
    message.role === 'user' &&
    (message.channel === 'desktop' ||
      (message.channel === 'group' &&
        message.platform === 'stronghold' &&
        message.senderId === 'user'))
  )
}
