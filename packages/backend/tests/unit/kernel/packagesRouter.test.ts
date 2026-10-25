import { describe, expect, it, vi } from 'vitest'
import { createPackagesRouter } from '@infos/backend/routers/packages.router'
import { PackageUiRegistry } from '@infos/backend/packages/packageUiRegistry'
import { PackageAssets } from '@infos/backend/packages/packageAssets'
import type { PackageManagementService } from '@infos/backend/packages/packageManagementService'

describe('插件管理 API 边界', () => {
  it('客户端上传字节交给服务端，不接受客户端本地路径', async () => {
    const install = vi.fn(async () => [])
    const router = createPackagesRouter(
      { install } as unknown as PackageManagementService,
      new PackageUiRegistry(),
      new PackageAssets(),
    )
    const form = new FormData()
    form.append('package', new Blob(['模拟插件字节']), 'fixture.zip')
    const response = await router.request('/install', { method: 'POST', body: form })
    expect(response.status).toBe(200)
    expect(install).toHaveBeenCalledWith(new TextEncoder().encode('模拟插件字节'))
    const invalid = new FormData()
    invalid.append('path', 'C:/client-only/plugin.zip')
    expect((await router.request('/install', { method: 'POST', body: invalid })).status).toBe(400)
    expect(install).toHaveBeenCalledOnce()
  })
  it('权限失败返回本地化信封和稳定原因码，不泄漏内部异常堆栈', async () => {
    const manager = {
      setEnabled: vi.fn(async () => {
        throw new Error('PACKAGE_SOURCE_CHANGED: C:/private/hidden')
      }),
    }
    const router = createPackagesRouter(
      manager as unknown as PackageManagementService,
      new PackageUiRegistry(),
      new PackageAssets(),
    )
    const response = await router.request('/fixture/enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'INVALID_PARAMETER',
      message: '插件内容已修改，请先读取本地修改并重新审核。',
      data: { reason: 'PACKAGE_SOURCE_CHANGED' },
    })
  })
  it('任意 UI 动作和未知插槽不会触发插件代码', async () => {
    const router = createPackagesRouter(
      {} as PackageManagementService,
      new PackageUiRegistry(),
      new PackageAssets(),
    )
    expect((await router.request('/panels/unknown')).status).toBe(400)
    expect(
      (
        await router.request('/panel-actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ panelId: 'missing', actionId: 'run' }),
        })
      ).status,
    ).toBe(400)
  })
})
