import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import type { ClientConnection } from './clientConnection'

const state = vi.hoisted(() => ({
  current: null as ClientConnection | null,
  verifier: vi.fn(),
  sessionCreated: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { on: state.sessionCreated },
  session: { defaultSession: { setCertificateVerifyProc: state.verifier } },
  dialog: { showMessageBox: vi.fn() },
}))
vi.mock('./clientConnection', () => ({ clientConnection: () => state }))
import { connectionErrorSource, installRemoteCertificateTrust } from './remoteCertificateUi'

const fixture = path.resolve('electron/main/services/fixtures/remote-certificates')
const certA = fs.readFileSync(path.join(fixture, 'server-a.crt'), 'utf8')
const certB = fs.readFileSync(path.join(fixture, 'server-b.crt'), 'utf8')
beforeEach(() => {
  vi.clearAllMocks()
  state.current = {
    mode: 'remote',
    origin: 'https://127.0.0.1:3000',
    capabilityEndpoint: 'wss://127.0.0.1:9121',
    certificates: [
      {
        origin: 'https://127.0.0.1:3000',
        pem: certA,
        fingerprint: new X509Certificate(certA).fingerprint256,
      },
      {
        origin: 'https://127.0.0.1:9121',
        pem: certB,
        fingerprint: new X509Certificate(certB).fingerprint256,
      },
    ],
  }
})
afterEach(() => vi.restoreAllMocks())

function verify(hostname: string, data: string): number {
  installRemoteCertificateTrust()
  const check = state.verifier.mock.calls.at(-1)![0] as (
    request: { hostname: string; certificate: { data: string } },
    callback: (result: number) => void,
  ) => void
  let result: number | undefined
  check({ hostname, certificate: { data } }, (value) => {
    result = value
  })
  if (result === undefined) throw new Error('证书回调未返回验证结论')
  return result
}

describe('Chromium 的远程证书边界', () => {
  it('业务主机只接受业务叶证书，不接受独立能力端口的其他证书', () => {
    expect(verify('127.0.0.1', certA)).toBe(0)
    expect(verify('127.0.0.1', certB)).toBe(-2)
    expect(verify('other.invalid', certA)).toBe(-3)
  })
  it('本地模式沿用系统验证；过期的已确认业务证书仍拒绝', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2050-01-01T00:00:00Z'))
    expect(verify('127.0.0.1', certA)).toBe(-2)
    state.current = { mode: 'local' }
    expect(verify('127.0.0.1', certA)).toBe(-3)
  })
  it('将网络底层错误和鉴权错误分别显示，不展示完整请求或令牌', () => {
    expect(
      connectionErrorSource(
        new Error('fetch failed', { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }),
      ),
    ).toBe('服务器证书未受信任，请打开连接设置并确认指纹。')
    expect(connectionErrorSource(new Error('REMOTE_AUTH_FAILED'))).toBe(
      '服务器拒绝访问，请检查访问令牌及权限。',
    )
    expect(connectionErrorSource(new Error('REMOTE_CERTIFICATE_CHANGED'))).toBe(
      '服务器证书已变化，请重新打开连接设置并核对新指纹。',
    )
  })
})
