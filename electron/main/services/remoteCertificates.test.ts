import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import {
  configureCertificateConfirmation,
  fetchWithServerCertificate,
  pinnedTlsOptions,
  prepareServerCertificate,
  trustedCertificateFor,
  type CertificateConfirmation,
} from './remoteCertificates'
import { ClientConnectionStore } from './clientConnection'

// 此处私钥为仓库公开的测试夹具，禁止用于真实部署。
const fixture = path.resolve('electron/main/services/fixtures/remote-certificates')
const certA = fs.readFileSync(path.join(fixture, 'server-a.crt'), 'utf8')
const keyA = fs.readFileSync(path.join(fixture, 'server-a.key'), 'utf8')
const certB = fs.readFileSync(path.join(fixture, 'server-b.crt'), 'utf8')
const keyB = fs.readFileSync(path.join(fixture, 'server-b.key'), 'utf8')
const fingerprintA = new X509Certificate(certA).fingerprint256
const fingerprintB = new X509Certificate(certB).fingerprint256
let server: https.Server
let origin: string
let received: Array<{ path?: string; authorization?: string }>
let root: string | undefined
const codec = {
  encrypt: (value: string) => Buffer.from(value).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString(),
}

beforeEach(async () => {
  received = []
  server = https.createServer({ key: keyA, cert: certA }, (request, response) => {
    received.push({ path: request.url, authorization: request.headers.authorization })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: { serverId: 'fixture-server' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  configureCertificateConfirmation(async () => false)
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (root) {
    if (path.dirname(root) !== path.resolve('TEMP')) throw new Error('测试目录越界')
    fs.rmSync(root, { recursive: true, force: true })
    root = undefined
  }
  configureCertificateConfirmation(async () => false)
})

describe('远程服务器证书信任', () => {
  it('已取消的连接不会探测证书或弹出信任窗口', async () => {
    const confirm = vi.fn(async (_certificate: CertificateConfirmation) => true)
    configureCertificateConfirmation(confirm)
    await expect(
      prepareServerCertificate(origin, [], true, AbortSignal.abort(new Error('测试取消'))),
    ).rejects.toThrow('测试取消')
    expect(confirm).not.toHaveBeenCalled()
    expect(received).toEqual([])
  })
  it('取消首次确认前后均不发送访问令牌，已有本地选择保持不变', async () => {
    root = fs.mkdtempSync(path.resolve('TEMP/remote-certificates-'))
    const store = new ClientConnectionStore(root, codec)
    await store.save({ mode: 'local' })
    const confirm = vi.fn(async (_certificate: CertificateConfirmation) => false)
    configureCertificateConfirmation(confirm)
    await expect(store.save({ mode: 'remote', origin, token: 'test-secret' })).rejects.toThrow(
      'REMOTE_CERTIFICATE_REJECTED',
    )
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ origin, fingerprint: fingerprintA })
    expect(received).toEqual([])
    expect(store.load()).toEqual({ mode: 'local' })
    expect(fs.readFileSync(path.join(root, 'client-connection.json'), 'utf8')).not.toContain(
      'test-secret',
    )
  })

  it('确认后读取真实 HTTPS 身份接口，模式切换和重开保留信任', async () => {
    root = fs.mkdtempSync(path.resolve('TEMP/remote-certificates-'))
    const store = new ClientConnectionStore(root, codec)
    const confirm = vi.fn(async (_certificate: CertificateConfirmation) => true)
    configureCertificateConfirmation(confirm)
    await store.save({ mode: 'remote', origin, token: 'test-secret' })
    expect(received).toEqual([
      { path: '/api/distributed/identity', authorization: 'Bearer test-secret' },
    ])
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'client-connection.json'), 'utf8'))
    expect(saved.trustedCertificates).toEqual([
      { origin, pem: new X509Certificate(certA).toString(), fingerprint: fingerprintA },
    ])
    await store.save({ mode: 'local' })
    const restarted = new ClientConnectionStore(root, codec)
    restarted.load()
    configureCertificateConfirmation(async () => {
      throw new Error('相同证书不应再次弹窗')
    })
    await restarted.save({ mode: 'remote', origin, token: 'test-secret' })
    expect(restarted.current?.serverId).toBe('fixture-server')
    expect(restarted.current?.certificates?.[0]?.fingerprint).toBe(fingerprintA)
  })

  it('证书变化先阻断带令牌请求，重新确认展示新旧指纹', async () => {
    const pin = { origin, pem: certA, fingerprint: fingerprintA }
    server.setSecureContext({ key: keyB, cert: certB })
    await expect(
      fetchWithServerCertificate(
        `${origin}/identity`,
        {
          headers: { authorization: 'Bearer must-not-leak' },
          signal: AbortSignal.timeout(5000),
        },
        [pin],
      ),
    ).rejects.toThrow('REMOTE_CERTIFICATE_CHANGED')
    expect(received).toEqual([])
    await expect(prepareServerCertificate(origin, [pin], false)).rejects.toThrow(
      'REMOTE_CERTIFICATE_CHANGED',
    )
    const confirm = vi.fn(async (_certificate: CertificateConfirmation) => true)
    configureCertificateConfirmation(confirm)
    const replacement = await prepareServerCertificate(origin, [pin], true)
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      previousFingerprint: fingerprintA,
      fingerprint: fingerprintB,
    })
    expect(replacement?.fingerprint).toBe(fingerprintB)
    expect(received).toEqual([])
  })

  it('同主机 WSS 使用已确认的证书，其他主机不能继承信任', async () => {
    const pin = { origin, pem: certA, fingerprint: fingerprintA }
    const endpoint = origin.replace('https:', 'wss:')
    expect(trustedCertificateFor('https://other.invalid', [pin])).toBeUndefined()
    const wss = new WebSocketServer({ server })
    wss.on('connection', (socket) => socket.send('已认证的 TLS 通道'))
    const agent = new https.Agent({
      ...pinnedTlsOptions(trustedCertificateFor(endpoint, [pin])),
      maxCachedSessions: 0,
    })
    const socket = new WebSocket(endpoint, { agent, followRedirects: false })
    try {
      const message = await new Promise<string>((resolve, reject) => {
        socket.once('message', (data) => resolve(data.toString()))
        socket.once('error', reject)
      })
      expect(message).toBe('已认证的 TLS 通道')
    } finally {
      socket.terminate()
      agent.destroy()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})
