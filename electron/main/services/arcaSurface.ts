import { getClientCredential } from '../utils/clientCredential'
import { getBackendOrigin } from './clientConnection'
import { ipcMain } from 'electron'
import { desktopTabs } from '../windows/desktopTabs'

/** 仅代理 Arca 自己的协作接口；任意 URL、系统令牌与宿主文件均不向页面开放。 */
export function registerArcaSurface(): void {
  ipcMain.handle('arca-host:request', async (event, raw: unknown) => {
    if (!desktopTabs.isApplication(event.sender, 'infos.arca'))
      throw new Error('仅 Arca 可以访问自身协作接口')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('协作请求无效')
    const value = raw as { action?: unknown; input?: Record<string, unknown> }
    const input = value.input ?? {}
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('协作参数无效')
    let route: string,
      method = 'GET',
      body: string | undefined
    if (value.action === 'collaboration.status') route = '/status'
    else if (value.action === 'collaboration.list' && typeof input.documentId === 'string')
      route = `?documentId=${encodeURIComponent(input.documentId)}`
    else if (value.action === 'collaboration.create') {
      route = ''
      method = 'POST'
      body = JSON.stringify(input)
    } else if (value.action === 'collaboration.cancel' && typeof input.taskId === 'string') {
      route = `/${encodeURIComponent(input.taskId)}/cancel`
      method = 'POST'
    } else throw new Error('协作操作未开放')
    if (body && body.length > 32000) throw new Error('协作请求过大')
    const origin = getBackendOrigin()
    const token = getClientCredential()
    const headers = {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
    const response = await fetch(`${origin}/api/applications/arca/collaboration${route}`, {
      method,
      body,
      headers,
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    })
    const result = (await response.json()) as { code: string; data?: unknown; message?: string }
    if (!response.ok || !['OK', 'CREATED'].includes(result.code))
      throw new Error(result.message ?? '协作请求失败')
    if (value.action === 'collaboration.status' && result.data && typeof result.data === 'object') {
      const status = result.data as { agents?: Array<{ id: string; avatarUrl?: string }> }
      await Promise.all(
        (status.agents ?? []).map(async (agent) => {
          if (!agent.avatarUrl) return
          try {
            const avatar = await fetch(
              `${origin}/api/agents/${encodeURIComponent(agent.id)}/avatar`,
              { headers, signal: AbortSignal.timeout(8000), redirect: 'error' },
            )
            const type = avatar.headers.get('content-type')?.split(';')[0] ?? ''
            if (
              !avatar.ok ||
              !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)
            )
              return
            const bytes = Buffer.from(await avatar.arrayBuffer())
            if (bytes.length <= 2 * 1024 * 1024)
              agent.avatarUrl = `data:${type};base64,${bytes.toString('base64')}`
          } catch {
            /* 单个角色头像不可用不影响协作列表。 */
          }
        }),
      )
    }
    return result.data
  })
}
