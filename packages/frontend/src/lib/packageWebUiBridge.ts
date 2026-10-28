export type PackageWebUiMessage =
  | { type: 'ready' }
  | { type: 'failed' }
  | { type: 'cancel'; id: string }
  | { type: 'call'; id: string; action: string; input?: unknown }

/** 窗口来源由宿主组件核验，这里只处理有界的 JSON 协议。 */
export function parsePackageWebUiMessage(
  value: unknown,
  channel: string,
): PackageWebUiMessage | undefined {
  if (!value || typeof value !== 'object') return
  const message = value as Record<string, unknown>
  if (message.protocol !== 'infos.package-ui.v1' || message.channel !== channel) return
  try {
    if (JSON.stringify(value).length > 256 * 1024) return
  } catch {
    return
  }
  if (message.type === 'ready') return { type: 'ready' }
  if (message.type === 'failed') return { type: 'failed' }
  if (typeof message.id !== 'string' || !/^\d{1,12}$/.test(message.id)) return
  if (message.type === 'cancel') return { type: 'cancel', id: message.id }
  if (
    message.type === 'call' &&
    typeof message.action === 'string' &&
    /^[a-z][a-z0-9._-]{0,63}$/i.test(message.action)
  )
    return { type: 'call', id: message.id, action: message.action, input: message.input }
}
