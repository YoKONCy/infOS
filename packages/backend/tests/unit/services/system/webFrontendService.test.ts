import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebFrontendService } from '@infos/backend/services/system/webFrontendService'

let directory: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

describe('主应用网页资源', () => {
  it('生产资源支持模块 Worker，业务路由不回退为 HTML', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'infos-web-'))
    writeFileSync(path.join(directory, 'index.html'), '<main>infOS</main>')
    writeFileSync(path.join(directory, 'pdf.worker.mjs'), 'export {}')
    const service = new WebFrontendService(directory)
    expect(await service.response(new Request('http://host/api/missing'))).toBeUndefined()
    const worker = await service.response(new Request('http://host/pdf.worker.mjs'))
    expect(worker?.headers.get('content-type')).toContain('javascript')
    expect(await (await service.response(new Request('http://host/')))?.text()).toContain('infOS')
  })

  it('开发时优先当前 Vite，禁止未配对设备读取后台绝对路径', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'infos-web-'))
    const root = path.join(directory, 'packages', 'frontend', 'dist')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'index.html'), '旧构建')
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('当前开发页面'))
    const service = new WebFrontendService(root, 'http://127.0.0.1:7359', () => false)
    const forbidden = path
      .join(directory, 'packages', 'backend', 'src', 'container.ts')
      .replaceAll('\\', '/')
    expect((await service.response(new Request(`http://host/@fs/${forbidden}`)))?.status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await (await service.response(new Request('http://host/')))?.text()).toBe('当前开发页面')
  })

  it('字体支持条件缓存，HEAD 和 304 不返回资源正文', async () => {
    directory = mkdtempSync(path.resolve('TEMP/infos-web-cache-'))
    mkdirSync(path.join(directory, 'assets'))
    writeFileSync(path.join(directory, 'index.html'), '<main>infOS</main>')
    writeFileSync(path.join(directory, 'assets', 'font-Abc12345.ttf'), '字体夹具正文')
    const service = new WebFrontendService(directory)
    const address = 'http://host/assets/font-Abc12345.ttf'
    const first = (await service.response(new Request(address)))!
    expect(first.headers.get('cache-control')).toContain('immutable')
    expect(first.headers.get('content-type')).toBe('font/ttf')
    expect(await first.text()).toBe('字体夹具正文')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const cached = (await service.response(
      new Request(address, { headers: { 'if-none-match': etag! } }),
    ))!
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
    const head = (await service.response(new Request(address, { method: 'HEAD' })))!
    expect(head.status).toBe(200)
    expect(head.headers.get('etag')).toBe(etag)
    expect(await head.text()).toBe('')
  })
})
