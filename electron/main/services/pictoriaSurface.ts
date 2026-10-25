import { getClientCredential } from '../utils/clientCredential'
import { getBackendOrigin } from './clientConnection'
import { ipcMain } from 'electron'
import { desktopTabs } from '../windows/desktopTabs'
import { startDesktopPictoria } from './pictoriaLifetime'

const operations = new Set([
  'collection.list',
  'collection.save',
  'collection.delete',
  'project.move',
  'prompt.search',
  'provider.settings',
  'provider.configure',
  'library.list',
  'library.update',
  'provider.list',
  'provider.save',
  'provider.models',
  'project.list',
  'project.get',
  'project.save',
  'project.delete',
  'catalog.get',
  'asset.list',
  'asset.get',
  'task.get',
  'task.list',
  'task.cancel',
  'task.resume',
  'prompt.list',
  'prompt.save',
  'prompt.delete',
  'templates.list',
  'step.list',
  'step.get',
  'step.save',
  'step.set_enabled',
  'service.list',
  'service.save',
  'service.get',
  'step.version',
  'workflow.draft.list',
  'workflow.draft.get',
  'workflow.draft.save',
  'workflow.draft.delete',
  'workflow.draft.publish',
  'workflow.draft.restore',
  'workflow.validate',
  'workflow.history',
])

/** 子应用只访问自身控制面，系统令牌和应用桥接密钥都留在宿主。 */
export function registerPictoriaSurface(): void {
  ipcMain.handle('pictoria:host-start', async (event) => {
    desktopTabs.assertHost(event.sender)
    return startDesktopPictoria()
  })
  ipcMain.handle('pictoria:request', async (event, raw: unknown) => {
    if (!desktopTabs.isApplication(event.sender, 'infos.pictoria'))
      throw new Error('仅 Pictoria 可以访问自己的画布接口')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('画布请求无效')
    const input = raw as Record<string, unknown>
    let endpoint: string
    let method = 'POST'
    let body: unknown
    if (input.action === 'bootstrap') {
      endpoint = '/canvas/bootstrap'
      method = 'GET'
    } else if (input.action === 'start') return startDesktopPictoria()
    else if (input.action === 'stop') endpoint = '/stop'
    else if (input.action === 'operation') {
      if (typeof input.operation !== 'string' || !operations.has(input.operation))
        throw new Error('此画布操作未开放')
      endpoint = `/operations/${encodeURIComponent(input.operation)}`
      body = { agentId: input.agentId, input: input.input ?? {} }
    } else if (input.action === 'upload') {
      endpoint = '/canvas/assets'
      body = input.input
    } else if (input.action === 'run') {
      endpoint = '/canvas/run'
      body = input.input
    } else if (input.action === 'asset') {
      if (typeof input.id !== 'string' || typeof input.agentId !== 'string')
        throw new Error('素材参数无效')
      endpoint = `/canvas/assets/${encodeURIComponent(input.id)}?agentId=${encodeURIComponent(input.agentId)}`
      method = 'GET'
    } else throw new Error('未知画布请求')
    const serialized = body === undefined ? undefined : JSON.stringify(body)
    if (serialized && serialized.length > 28_100_000) throw new Error('画布请求超过大小限制')
    const token = getClientCredential()
    const response = await fetch(`${getBackendOrigin()}/api/applications/pictoria${endpoint}`, {
      method,
      body: serialized,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(90_000),
      redirect: 'error',
    })
    const result = (await response.json()) as { code: string; data?: unknown; message?: string }
    if (!response.ok || result.code !== 'OK') throw new Error(result.message || '画布请求失败')
    return result.data
  })
}
