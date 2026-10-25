import path from 'node:path'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UserAvatarService,
  USER_AVATAR_MAX_BYTES,
} from '../../../../src/services/system/userAvatarService'
import { createUserAvatarRouter } from '../../../../src/routers/userAvatar.router'
import { errorHandler } from '../../../../src/middleware/errorHandler'

/** 生成真实可解码的方形 PNG 夹具，避免把损坏图片当成上传成功样本。 */
function png(size = 512, tone = 0) {
  function chunk(type: string, data: Buffer) {
    const content = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of content) {
      crc ^= byte
      for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, content, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc((size * 4 + 1) * size, tone)
  for (let row = 0; row < size; row++) pixels[row * (size * 4 + 1)] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const file = (bytes = png()) =>
  new File([new Uint8Array(bytes)], 'avatar.png', { type: 'image/png' })
const key = 'ui.ownerAvatar.resource'
let directory: string
let values: Map<string, string>
let config: {
  get: ReturnType<typeof vi.fn<(name: string) => Promise<string | undefined>>>
  set: ReturnType<typeof vi.fn<(name: string, value: string) => Promise<void>>>
  delete: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>
}
let paths: { resolve: ReturnType<typeof vi.fn<(logicalPath: string) => string>> }
let service: UserAvatarService

beforeEach(async () => {
  directory = await mkdtemp(path.join(process.env.INFOS_TEST_TEMP_ROOT!, 'user-avatar-'))
  values = new Map([['owner.name', '测试用户']])
  config = {
    get: vi.fn(async (name: string) => values.get(name)),
    set: vi.fn(async (name: string, value: string) => {
      values.set(name, value)
    }),
    delete: vi.fn(async (name: string) => {
      values.delete(name)
    }),
  }
  paths = { resolve: vi.fn(() => directory) }
  service = new UserAvatarService(paths, config)
})
afterEach(async () => {
  const root = path.resolve(process.env.INFOS_TEST_TEMP_ROOT!)
  const relative = path.relative(root, path.resolve(directory))
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    await rm(directory, { recursive: true, force: true })
})

describe('用户头像资源', () => {
  it('资源落盘后跨实例恢复，响应只提供版本与名字', async () => {
    const bytes = png()
    const result = await service.save(file(bytes))
    expect(result.name).toBe('测试用户')
    expect(result.version).toMatch(/^[0-9a-f-]{36}$/)
    expect(Object.keys(result).sort()).toEqual(['name', 'version'])
    const resumed = new UserAvatarService(paths, config)
    expect(await resumed.profile()).toEqual(result)
    expect(await resumed.read()).toEqual(bytes)
    expect(paths.resolve).toHaveBeenCalledWith('@data/ui/owner-avatar')
  })
  it('配置写入失败时保留旧图，并清理未提交的新资源', async () => {
    const first = await service.save(file())
    config.set.mockRejectedValueOnce(new Error('配置暂时不可写'))
    await expect(service.save(file(png(512, 1)))).rejects.toThrow('配置暂时不可写')
    expect(await service.profile()).toEqual(first)
    expect(await service.read()).toEqual(png())
    expect(await readdir(directory)).toEqual([`${first.version}.png`])
  })
  it('上传和恢复默认串行执行，删除不能被尚未完成的旧上传覆盖', async () => {
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    config.set.mockImplementationOnce(async (name: string, value: string) => {
      entered()
      await gate
      values.set(name, value)
    })
    const uploading = service.save(file())
    await waiting
    const profile = service.profile()
    const removing = service.remove()
    const reading = service.read()
    release()
    const saved = await uploading
    expect(await profile).toEqual(saved)
    await removing
    await expect(reading).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await service.profile()).version).toBeNull()
    expect(await readdir(directory)).toEqual([])
  })
  it('失败的恢复默认保留原资源，后续操作仍能继续', async () => {
    const first = await service.save(file())
    config.delete.mockRejectedValueOnce(new Error('配置暂时不可写'))
    await expect(service.remove()).rejects.toThrow()
    expect(await service.profile()).toEqual(first)
    await service.remove()
    expect((await service.profile()).version).toBeNull()
  })
  it('拒绝伪造 MIME、未裁切尺寸、空文件和超大文件', async () => {
    await expect(service.save(file(Buffer.from('<svg/>')))).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    })
    await expect(service.save(file(png(256)))).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    })
    await expect(service.save(file(Buffer.alloc(0)))).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    })
    await expect(service.save(file(Buffer.alloc(USER_AVATAR_MAX_BYTES + 1)))).rejects.toMatchObject(
      { code: 'PAYLOAD_TOO_LARGE' },
    )
    expect(config.set).not.toHaveBeenCalled()
  })
  it('配置中的任意路径和 URL 不能变成可读取的资源', async () => {
    for (const value of [
      '../../private.png',
      'https://example.com/avatar.png',
      'C:\\Users\\private.png',
    ]) {
      values.set(key, value)
      expect((await service.profile()).version).toBeNull()
      await expect(service.read()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(paths.resolve).not.toHaveBeenCalled()
  })
})

describe('用户头像 HTTP 边界', () => {
  function router() {
    const gatewayHub = { pushStateUpdate: vi.fn(async () => {}) }
    const app = createUserAvatarRouter({ userAvatarService: service, gatewayHub } as never)
    app.onError(errorHandler)
    return { app, gatewayHub }
  }
  it('只接受上传的文件，不读取请求里的本机路径', async () => {
    const { app } = router()
    const data = new FormData()
    data.append('avatar', 'C:\\Users\\avatar.png')
    const response = await app.request('http://test/', {
      method: 'PUT',
      body: data,
      headers: { 'Accept-Language': 'en-US' },
    })
    expect(response.status).toBe(400)
    expect((await response.json()).message).toBe('Upload the cropped avatar file.')
    expect(config.set).not.toHaveBeenCalled()
  })
  it('上传与删除通知在线 UI，内容端点提供 PNG 且不缓存旧图', async () => {
    const { app, gatewayHub } = router()
    const data = new FormData()
    data.append('avatar', file())
    const uploaded = await app.request('http://test/', { method: 'PUT', body: data })
    expect(uploaded.status).toBe(200)
    const content = await app.request('http://test/content')
    expect(content.headers.get('content-type')).toBe('image/png')
    expect(content.headers.get('cache-control')).toContain('no-store')
    expect(content.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await content.arrayBuffer())).toEqual(png())
    expect((await app.request('http://test/', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('http://test/content')).status).toBe(404)
    expect(gatewayHub.pushStateUpdate).toHaveBeenCalledTimes(2)
  })
  it('更新推送失败不把已经提交的上传误报为保存失败', async () => {
    const { app, gatewayHub } = router()
    gatewayHub.pushStateUpdate.mockRejectedValueOnce(new Error('连接暂时中断'))
    const data = new FormData()
    data.append('avatar', file())
    expect((await app.request('http://test/', { method: 'PUT', body: data })).status).toBe(200)
    expect((await service.profile()).version).toBeTruthy()
  })
})
