import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { PackageManifest, PackageWebUiModule } from '@infos/shared'
import { PackageWebUi } from '@infos/backend/packages/packageWebUi'
import { PackageSecurityAuthority } from '@infos/backend/packages/packageSecurityAuthority'
import type { PackageActivationContext } from '@infos/backend/packages/types'
import { apiContractMiddleware } from '@infos/backend/middleware/apiContract'
import {
  createPackageWebUiRouter,
  isPackageWebUiFileRequest,
} from '@infos/backend/routers/packageWebUi.router'

const owner = { id: 'local', token: 'fixture-owner' }
const roots: string[] = []
const services: PackageWebUi[] = []
const temp = path.resolve(process.env.INFOS_TEST_TEMP_ROOT ?? 'TEMP')
const manifest: PackageManifest = {
  manifestVersion: 2,
  packageId: 'example.page',
  name: '示例页面',
  version: '1.0.0',
  trust: 'user',
  contributions: [{ id: 'settings', kind: 'web-ui', webUi: { root: 'web' } }],
}
async function fixture(module?: PackageWebUiModule) {
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(path.join(temp, 'package-ui-'))
  roots.push(root)
  await mkdir(path.join(root, 'web'))
  await writeFile(
    path.join(root, 'web/index.html'),
    '<!doctype html><html><head><script type="module" src="./app.js"></script></head><body>设置</body></html>',
  )
  await writeFile(path.join(root, 'web/app.js'), 'document.body.textContent = "界面已加载"')
  await writeFile(
    path.join(root, 'web/data.json'),
    JSON.stringify({ code: 'plugin-data', selectedTheme: 'sky' }),
  )
  let valid = true
  let writes = 0
  const ui = new PackageWebUi(
    (identity) => valid && identity.token === owner.token,
    () => true,
    () => {
      writes++
      return () => {
        writes--
      }
    },
  )
  services.push(ui)
  const context: PackageActivationContext = {
    rootDir: root,
    manifest,
    contribution: {
      ...manifest.contributions[0]!,
      webUi: {
        root: 'web',
        actions: module ? ['echo'] : [],
      },
    },
  }
  const remove = await ui.register(context, module)
  const session = ui.open(manifest.packageId, 'settings', owner)
  return {
    ui,
    root,
    context,
    remove,
    session,
    activeWrites: () => writes,
    revoke() {
      valid = false
      ui.revalidate()
    },
  }
}
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose())
  for (const root of roots.splice(0)) {
    const relative = path.relative(temp, root)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('测试目录越界')
    await rm(root, { recursive: true, force: true })
  }
})

describe('Package 完整 WebUI', () => {
  it('资源票据支持真实模块文件，业务交互仍需当前身份', async () => {
    const { ui, session } = await fixture()
    const app = new Hono()
    app.use('*', cors({ origin: (origin) => origin, credentials: true }))
    app.use('*', async (c, next) => {
      if (
        !isPackageWebUiFileRequest(c.req.method, c.req.path) &&
        c.req.header('authorization') !== `Bearer ${owner.token}`
      )
        return c.json({ code: 'UNAUTHORIZED' }, 401)
      await next()
    })
    app.route(
      '/api/packages/web-ui',
      createPackageWebUiRouter(ui, () => owner),
    )
    const scriptPath = `/api${session.documentPath.replace(/index\.html$/, 'app.js')}`
    const response = await app.request(scriptPath, { headers: { Origin: 'null' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.has('access-control-allow-credentials')).toBe(false)
    expect(await response.text()).toBe('document.body.textContent = "界面已加载"')
    expect((await app.request(`/api/packages/web-ui/sessions/${session.id}`)).status).toBe(401)
  })

  it('静态 JSON 保持插件数据，不能被 REST 信封守卫重写', async () => {
    const { ui, session } = await fixture()
    const app = new Hono()
    app.use('*', apiContractMiddleware)
    app.route(
      '/api/packages/web-ui',
      createPackageWebUiRouter(ui, () => owner),
    )
    const response = await app.request(
      `/api${session.documentPath.replace(/index\.html$/, 'data.json')}`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ code: 'plugin-data', selectedTheme: 'sky' })
  })

  it('页面请求只能调用本贡献列出的动作，并返回真实进度与结果', async () => {
    const { ui, session } = await fixture({
      actions: {
        echo: (input, context) => {
          context.report({ completed: 1 })
          return { echoed: input }
        },
        undeclared: () => '不能通过页面调用',
      },
    })
    const progress: unknown[] = []
    const report = async (value: unknown) => {
      progress.push(value)
    }
    const signal = new AbortController().signal
    expect(await ui.invoke(session.id, owner, 'echo', '你好', report, signal)).toEqual({
      echoed: '你好',
    })
    expect(progress).toEqual([{ completed: 1 }])
    await expect(ui.invoke(session.id, owner, 'undeclared', null, report, signal)).rejects.toThrow(
      'PACKAGE_WEB_UI_ACTION_INVALID',
    )
    await expect(
      ui.invoke(session.id, { id: 'other', token: 'other' }, 'echo', null, report, signal),
    ).rejects.toThrow('PACKAGE_WEB_UI_UNAVAILABLE')
  })

  it('激活后的文件修改和路径逃逸不能通过资源票据读取', async () => {
    const { ui, root, session } = await fixture()
    const ticket = session.documentPath.split('/')[4]!
    await writeFile(path.join(root, 'web/app.js'), '修改后的脚本')
    await expect(ui.read(ticket, 'app.js', 'http://localhost')).rejects.toThrow(
      'PACKAGE_SOURCE_CHANGED',
    )
    await expect(ui.read(ticket, '../manifest.json', 'http://localhost')).rejects.toThrow(
      'PACKAGE_WEB_UI_FILE_UNAVAILABLE',
    )
  })

  it('停用再激活不会恢复旧页面会话', async () => {
    const { ui, context, remove, session } = await fixture()
    remove()
    await ui.register(context)
    const next = ui.open(manifest.packageId, 'settings', owner)
    remove()
    expect(() => ui.touch(session.id, owner)).toThrow('PACKAGE_WEB_UI_UNAVAILABLE')
    expect(() => ui.touch(next.id, owner)).not.toThrow()
  })

  it('身份撤销取消页面观察，底层处理器结束后才释放快照保护', async () => {
    let started!: () => void
    let finish!: () => void
    let actionSignal: AbortSignal | undefined
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const { ui, session, revoke, activeWrites } = await fixture({
      actions: {
        echo: async (_input, context) => {
          actionSignal = context.signal
          started()
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return '迟到结果'
        },
      },
    })
    const operation = ui.invoke(
      session.id,
      owner,
      'echo',
      null,
      async () => undefined,
      new AbortController().signal,
    )
    const rejected = expect(operation).rejects.toThrow('PACKAGE_WEB_UI_')
    await entered
    expect(activeWrites()).toBe(1)
    revoke()
    await rejected
    expect(actionSignal?.aborted).toBe(true)
    expect(activeWrites()).toBe(1)
    finish()
    await vi.waitFor(() => expect(activeWrites()).toBe(0))
  })

  it('WebUI 后端入口同样需要代码信任授权，纯静态页面不获得执行权限', () => {
    const security = new PackageSecurityAuthority()
    expect(() => security.assertActivationAllowed(manifest)).not.toThrow()
    const executable = structuredClone(manifest)
    executable.contributions[0]!.entry = 'settings.mjs'
    expect(() => security.assertActivationAllowed(executable)).toThrow('PACKAGE_ISOLATION_REQUIRED')
  })
})
