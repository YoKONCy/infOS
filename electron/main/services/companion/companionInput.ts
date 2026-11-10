/** @platform ELECTRON 只转发输入在场信号，不接触用户草稿。 */
import { ipcMain, type WebContents } from 'electron'
import { getBackendOrigin } from '../clientConnection'
import { getClientCredential } from '../../utils/clientCredential'

export function registerCompanionInput(assertTrusted: (sender: WebContents) => void): void {
  const pending = new WeakMap<WebContents, Promise<unknown>>()
  ipcMain.handle('desktop-home:input-activity', (event, value: unknown) => {
    assertTrusted(event.sender)
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
      throw new Error('HOME_INPUT_FORBIDDEN')
    const input = value as { agentId?: unknown; threadId?: unknown; active?: unknown }
    if (
      !input ||
      ![input.agentId, input.threadId].every(
        (id) => typeof id === 'string' && /^[\w-]{1,200}$/.test(id),
      ) ||
      typeof input.active !== 'boolean'
    )
      throw new Error('HOME_INPUT_INVALID')
    const origin = getBackendOrigin()
    const run = (pending.get(event.sender) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (origin !== getBackendOrigin()) return
        const response = await fetch(`${origin}/api/scheduler/proactive/watch-along/input`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getClientCredential()}`,
          },
          body: JSON.stringify({
            agentId: input.agentId,
            threadId: input.threadId,
            active: input.active,
          }),
        })
        if (!response.ok) throw new Error('HOME_INPUT_UNAVAILABLE')
        await response.body?.cancel()
      })
    pending.set(event.sender, run)
    return run
  })
}
