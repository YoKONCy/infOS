import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: { id: number } }, request: unknown) => Promise<unknown>
const state = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  allowed: true,
  fetch: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler) },
}))
vi.mock('../windows/desktopTabs', () => ({
  desktopTabs: { isApplication: () => state.allowed, assertHost: vi.fn() },
}))
vi.mock('../utils/clientCredential', () => ({ getClientCredential: () => 'host-token' }))
vi.mock('./clientConnection', () => ({ getBackendOrigin: () => 'http://127.0.0.1:3000' }))
vi.mock('./pictoriaLifetime', () => ({ startDesktopPictoria: vi.fn() }))
import { registerPictoriaSurface } from './pictoriaSurface'
import { getLocale, setLocale } from '../utils/i18n'

let previousLocale: ReturnType<typeof getLocale>
beforeEach(() => {
  previousLocale = getLocale()
  setLocale('zh-CN')
  state.handlers.clear()
  state.allowed = true
  state.fetch.mockReset()
  state.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ code: 'OK', data: { accepted: true } }), {
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', state.fetch)
  registerPictoriaSurface()
})
afterEach(() => {
  setLocale(previousLocale)
  vi.unstubAllGlobals()
})
function request(operation: unknown, input: Record<string, unknown> = {}) {
  const handler = state.handlers.get('pictoria:request')
  if (!handler) throw new Error('画布桥接处理器未注册')
  return handler(
    { sender: { id: 7 } },
    { action: 'operation', operation, agentId: 'artist', input },
  )
}

describe('Pictoria 桌面画布操作桥接', () => {
  it.each([
    ['canvas.conversation.get', { projectId: 'canvas' }],
    ['canvas.conversation.save', { projectId: 'canvas', expectedRevision: 1, messages: [] }],
    [
      'canvas.context.set',
      { projectId: 'canvas', sessionId: 'window', sequence: 1, snapshot: { selected: [] } },
    ],
    ['canvas.context.get', { projectId: 'canvas' }],
    ['canvas.context.close', { projectId: 'canvas', sessionId: 'window' }],
    ['canvas.assistant.prepare', { projectId: 'canvas', vision: true }],
    ['canvas.assistant.settings.get', { projectId: 'canvas' }],
    ['canvas.assistant.settings.save', { projectId: 'canvas', expectedRevision: 0, settings: {} }],
    [
      'canvas.propose',
      { projectId: 'canvas', sequence: 1, proposal: { message: '整理画布', operations: [] } },
    ],
    ['canvas.proposal.list', { projectId: 'canvas' }],
    [
      'canvas.proposal.resolve',
      { projectId: 'canvas', id: 'proposal', expectedRevision: 1, state: 'applied' },
    ],
    ['project.rename', { id: 'canvas', title: '新名称', expectedRevision: 1 }],
  ] as Array<[string, Record<string, unknown>]>)(
    '将 %s 的角色和输入原样转发，并返回控制面回执',
    async (operation, input) => {
      await expect(request(operation, input)).resolves.toEqual({ accepted: true })
      expect(state.fetch.mock.calls[0]?.[0]).toBe(
        `http://127.0.0.1:3000/api/applications/pictoria/operations/${operation}`,
      )
      const options = state.fetch.mock.calls[0]?.[1] as RequestInit
      expect(options.method).toBe('POST')
      expect(JSON.parse(options.body as string)).toEqual({ agentId: 'artist', input })
      expect(new Headers(options.headers).get('authorization')).toBe('Bearer host-token')
    },
  )

  it.each(['canvas.unknown', 'tool.execute'])(
    '拒绝未开放的 %s，并在错误中标明操作名',
    async (operation) => {
      await expect(request(operation)).rejects.toThrow(operation)
      expect(state.fetch).not.toHaveBeenCalled()
    },
  )

  it('其他应用无法借用已开放的画布接口', async () => {
    state.allowed = false
    await expect(request('canvas.conversation.get', { projectId: 'canvas' })).rejects.toThrow(
      '仅 Pictoria',
    )
    expect(state.fetch).not.toHaveBeenCalled()
  })
})
