// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackupImportProgress } from '@infos/shared'
import { backupApi } from '@infos/frontend/api/modules/backupApi'
import { inspectBackupFile } from '@infos/frontend/api/modules/backupFile'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@infos/frontend/api/client', () => ({ apiClient: api }))
vi.mock('@infos/frontend/api/transport', () => ({
  getWebServerOrigin: () => 'https://backup.example',
  getClientToken: () => '',
  clientFetch: vi.fn(),
}))

const chunk = 1024 ** 2
function setup(options: { loseFirstAck?: boolean; reject?: boolean } = {}) {
  const total = 2 * chunk + 3
  let confirmed = 0
  const requests: Array<{ range?: string; size: number }> = []
  const state = (): BackupImportProgress => ({
    id: 'upload',
    phase: confirmed === total ? 'extracting' : 'uploading',
    receivedBytes: confirmed,
    uploadBytes: total,
    unpackedBytes: 0,
    unpackedTotal: 0,
    completedFiles: 0,
    totalFiles: 0,
  })
  api.get.mockImplementation(async () => ({ code: 'OK', data: state() }))
  class FakeXHR {
    status = 202
    responseText = ''
    withCredentials = false
    timeout = 0
    upload = { onprogress: null as ((event: { loaded: number }) => void) | null }
    onload?: () => void
    onerror?: () => void
    ontimeout?: () => void
    onabort?: () => void
    headers = new Map<string, string>()
    open() {}
    setRequestHeader(key: string, value: string) {
      this.headers.set(key, value)
    }
    abort() {
      this.onabort?.()
    }
    send(body: Blob) {
      const range = this.headers.get('Content-Range')
      requests.push({ range, size: body.size })
      queueMicrotask(() => {
        if (options.reject) {
          this.status = 413
          this.responseText = '<html>Request too large</html>'
          this.onload?.()
          return
        }
        confirmed += body.size
        this.upload.onprogress?.({ loaded: body.size })
        if (options.loseFirstAck && requests.length === 1) {
          this.onerror?.()
          return
        }
        this.responseText = JSON.stringify({ code: 'OK', data: state() })
        this.onload?.()
      })
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  const file = new File([new Uint8Array(total)], 'full.infos-backup')
  return { file, requests, total }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('大备份分片上传', () => {
  function headerFile(encrypted: boolean) {
    const header = new TextEncoder().encode(JSON.stringify({ encrypted }))
    const prefix = new Uint8Array(12 + header.length + 10)
    prefix.set([73, 78, 70, 79, 83, 66, 49, 10])
    new DataView(prefix.buffer).setUint32(8, header.length)
    prefix.set(header, 12)
    prefix.set([31, 139, 8, 0, 0, 0, 0, 0, 0, 3], 12 + header.length)
    const slice = vi.fn(() => ({ arrayBuffer: async () => prefix.buffer }))
    // 用文件边界替身表达 1 GiB 原件，禁止读取整个文件。
    const file = { size: 1024 ** 3, slice } as unknown as File
    return { file, slice, prefix }
  }

  it('大文件只读取有界头部识别加密，不因选择文件而发送整包', async () => {
    const { file, slice, prefix } = headerFile(true)
    const result = await inspectBackupFile(file)
    expect(result.encrypted).toBe(true)
    expect(Uint8Array.from(atob(result.prefix), (char) => char.charCodeAt(0))).toEqual(prefix)
    expect(slice).toHaveBeenCalledWith(0, 4118)
    expect(api.post).not.toHaveBeenCalled()
  })

  it('加密原件缺口令时不预约也不上传，未加密原件不携带导出口令', async () => {
    const encrypted = headerFile(true)
    await expect(backupApi.beginImport(encrypted.file, '')).rejects.toThrow('这份备份已加密')
    expect(api.post).not.toHaveBeenCalled()
    api.post.mockResolvedValue({ code: 'OK', data: { id: 'reserved', receivedBytes: 0 } })
    const plain = headerFile(false)
    await backupApi.beginImport(plain.file, '另一份导出备份的口令')
    expect(api.post).toHaveBeenCalledWith('/backups/imports', {
      size: 1024 ** 3,
      password: '',
      prefix: btoa(String.fromCharCode(...plain.prefix)),
    })
  })

  it('伪造或截断的备份头在上传前明确拒绝', async () => {
    const file = new Blob([new Uint8Array(32)])
    await expect(inspectBackupFile(file)).rejects.toThrow('此文件不是完整的 infOS 备份')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('按服务端上限发送原始二进制片，最后一片只发送剩余字节', async () => {
    const { file, requests, total } = setup()
    const progress = vi.fn()
    await backupApi.uploadImport(file, 'upload', new AbortController().signal, progress, chunk)
    expect(requests).toEqual([
      { range: `bytes 0-1048575/${total}`, size: chunk },
      { range: `bytes 1048576-2097151/${total}`, size: chunk },
      { range: `bytes 2097152-2097154/${total}`, size: 3 },
    ])
    expect(progress).toHaveBeenLastCalledWith(total)
  })

  it('首片已接收但确认响应丢失时，从服务端位置继续发送第二片', async () => {
    vi.useFakeTimers()
    const { file, requests } = setup({ loseFirstAck: true })
    const upload = backupApi.uploadImport(
      file,
      'upload',
      new AbortController().signal,
      () => {},
      chunk,
    )
    await vi.runAllTimersAsync()
    await upload
    expect(api.get).toHaveBeenCalledWith('/backups/imports/upload')
    expect(requests.map((request) => request.size)).toEqual([chunk, chunk, 3])
    expect(requests[1]!.range).toContain('bytes 1048576-')
  })

  it('代理明确拒绝请求时保留HTTP状态，不自动重复上传', async () => {
    const { file, requests } = setup({ reject: true })
    await expect(
      backupApi.uploadImport(file, 'upload', new AbortController().signal, () => {}, chunk),
    ).rejects.toMatchObject({ httpStatus: 413 })
    expect(requests).toHaveLength(1)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('旧服务端未协商分片时保留整包上传兼容', async () => {
    const { file, requests } = setup()
    await backupApi.uploadImport(file, 'upload', new AbortController().signal, () => {})
    expect(requests).toEqual([{ range: undefined, size: file.size }])
  })
})
