import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArcaUiRouter } from '@infos/backend/routers/arcaUi.router'
import { StaticAssetService } from '@infos/backend/services/system/staticAssetService'

describe('createArcaUiRouter', () => {
  let root: string
  let app: Hono

  beforeEach(() => {
    root = join(tmpdir(), `infos-arca-ui-${Date.now()}-${Math.random()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'host.mjs'), '不能泄漏的宿主源码')
    mkdirSync(join(root, 'ui', 'assets'), { recursive: true })
    writeFileSync(join(root, 'ui', 'index.html'), '<!doctype html><title>Arca</title>')
    writeFileSync(join(root, 'ui', 'assets', 'app-Abc12345.js'), 'console.log("Arca")')
    writeFileSync(join(root, 'ui', 'manifest.json'), '{"version":1}')
    app = new Hono()
    app.route('/applications/arca', createArcaUiRouter(new StaticAssetService(join(root, 'ui'))))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('应提供入口与带长期缓存的静态资源', async () => {
    const index = await app.request('/applications/arca/')
    const asset = await app.request('/applications/arca/assets/app-Abc12345.js')

    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.headers.get('cache-control')).toBe('no-cache')
    expect(await index.text()).toContain('Arca')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
  })

  it('未变化的模块返回 304，固定名称更新后重新发送正文', async () => {
    const first = await app.request('/applications/arca/manifest.json')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(first.headers.get('cache-control')).toBe('no-cache')
    const cached = await app.request('/applications/arca/manifest.json', {
      headers: { 'if-none-match': etag! },
    })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
    writeFileSync(join(root, 'ui', 'manifest.json'), '{"version":200}')
    const updated = await app.request('/applications/arca/manifest.json', {
      headers: { 'if-none-match': etag! },
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ version: 200 })
  })

  it('不得暴露UI目录以外的文件', async () => {
    const response = await app.request('/applications/arca/%2e%2e%2fhost.mjs')
    expect([403, 404]).toContain(response.status)
    expect(await response.text()).not.toContain('不能泄漏的宿主源码')
  })

  it('资源不存在时应返回404', async () => {
    const response = await app.request('/applications/arca/assets/missing.js')
    expect(response.status).toBe(404)
  })
})
