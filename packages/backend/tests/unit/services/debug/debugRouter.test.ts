import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createRuntimeDebugRouter } from '@infos/backend/routers/runtimeDebug.router'
import { AppError } from '@infos/backend/lib/appError'
import type { RuntimeDebugService } from '@infos/backend/services/debug/runtimeDebugService'
describe('调试模式控制 API', () => {
  it('仅接受当前 Thread 的显式布尔开关，不暴露任意代码执行路由', async () => {
    const service = {
      getStatus: vi.fn(async () => ({ enabled: false })),
      setEnabled: vi.fn(async () => ({ enabled: true })),
    }
    const router = createRuntimeDebugRouter(service as unknown as RuntimeDebugService)
    expect((await router.request('/thread-a')).status).toBe(200)
    const put = (body: unknown) =>
      router.request('/thread-a', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await put({ enabled: 'true' })).status).toBe(400)
    expect((await put({ enabled: true })).status).toBe(200)
    expect(service.setEnabled).toHaveBeenCalledExactlyOnceWith('thread-a', true)
    expect((await router.request('/thread-a/execute', { method: 'POST' })).status).toBe(404)
  })
  it('错误在展示边界本地化，不把路径和堆栈直接糊进界面', async () => {
    const app = new Hono()
    app.onError((error, c) =>
      c.json({ code: (error as AppError).code, message: error.message }, 400),
    )
    app.route(
      '/',
      createRuntimeDebugRouter({
        setEnabled: async () => {
          throw new Error('DEBUG_PRIVATE C:/fixture/private')
        },
      } as unknown as RuntimeDebugService),
    )
    const response = await app.request('/thread-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"enabled":true}',
    })
    expect(await response.json()).toEqual({
      code: 'INVALID_PARAMETER',
      message: '调试模式切换失败，请确认当前为普通桌面工作会话。',
    })
  })
})
