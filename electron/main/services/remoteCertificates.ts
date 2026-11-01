import tls from 'node:tls'
import https from 'node:https'
import { X509Certificate } from 'node:crypto'
import { Readable } from 'node:stream'

export interface TrustedServerCertificate {
  origin: string
  pem: string
  fingerprint: string
}
export interface CertificateConfirmation {
  origin: string
  fingerprint: string
  previousFingerprint?: string
  subject: string
  issuer: string
  validFrom: string
  validTo: string
}
let confirmCertificate:
  | ((certificate: CertificateConfirmation, signal?: AbortSignal) => Promise<boolean>)
  | undefined

export function configureCertificateConfirmation(
  confirm: (certificate: CertificateConfirmation, signal?: AbortSignal) => Promise<boolean>,
): void {
  confirmCertificate = confirm
}

export function certificateFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256
}

/** 证书不含密钥，但落盘内容仍需校验，避免损坏记录扩大信任范围。 */
export function parseTrustedCertificates(value: unknown): TrustedServerCertificate[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    try {
      if (typeof item?.origin !== 'string' || typeof item.pem !== 'string') return []
      const url = new URL(item.origin)
      if (url.protocol !== 'https:' || url.origin !== item.origin) return []
      if (certificateFingerprint(item.pem) !== item.fingerprint) return []
      return [{ origin: url.origin, pem: item.pem, fingerprint: item.fingerprint }]
    } catch {
      return []
    }
  })
}

function httpsOrigin(input: string): string {
  const url = new URL(input)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  return url.origin
}

/** 同主机的能力端口可以使用同一张已确认的证书，仍严格校验叶证书指纹。 */
export function trustedCertificateFor(
  input: string,
  certificates: TrustedServerCertificate[] = [],
): TrustedServerCertificate | undefined {
  const origin = httpsOrigin(input)
  return (
    certificates.find((item) => item.origin === origin) ??
    certificates.find((item) => new URL(item.origin).hostname === new URL(origin).hostname)
  )
}

export function pinnedTlsOptions(certificate?: TrustedServerCertificate): tls.ConnectionOptions {
  if (!certificate) return {}
  return {
    ca: certificate.pem,
    allowPartialTrustChain: true,
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, peer) =>
      peer.fingerprint256 === certificate.fingerprint
        ? undefined
        : Object.assign(new Error('REMOTE_CERTIFICATE_CHANGED'), {
            code: 'REMOTE_CERTIFICATE_CHANGED',
          }),
  }
}

/** 探测阶段仅握手读取公开证书，始终不发送 HTTP、访问令牌或能力配对码。 */
export async function prepareServerCertificate(
  input: string,
  known: TrustedServerCertificate[],
  interactive: boolean,
  signal?: AbortSignal,
): Promise<TrustedServerCertificate | undefined> {
  const url = new URL(input)
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') return undefined
  const certificate = await new Promise<{ pem: string; authorized: boolean }>((resolve, reject) => {
    const handshakeSignal = AbortSignal.any([
      AbortSignal.timeout(8_000),
      ...(signal ? [signal] : []),
    ])
    handshakeSignal.throwIfAborted()
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const socket = tls.connect({
      host: hostname,
      port: Number(url.port || 443),
      servername: /^[\d.]+$/.test(hostname) || hostname.includes(':') ? undefined : hostname,
      // 此连接只读取证书，业务连接继续启用验证并校验用户确认的指纹。
      rejectUnauthorized: false,
    })
    socket.once('error', reject)
    const abort = () =>
      socket.destroy(
        handshakeSignal.reason instanceof Error
          ? handshakeSignal.reason
          : new Error('CONNECTION_CANCELLED'),
      )
    handshakeSignal.addEventListener('abort', abort, { once: true })
    socket.once('close', () => handshakeSignal.removeEventListener('abort', abort))
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate()
        if (!peer.raw) throw new Error('REMOTE_CERTIFICATE_INVALID')
        resolve({ pem: new X509Certificate(peer.raw).toString(), authorized: socket.authorized })
      } catch (error) {
        reject(error)
      } finally {
        socket.destroy()
      }
    })
    if (handshakeSignal.aborted) abort()
  })
  signal?.throwIfAborted()
  const parsed = new X509Certificate(certificate.pem)
  const fingerprint = parsed.fingerprint256
  const previous = trustedCertificateFor(input, known)
  if (Date.now() < Date.parse(parsed.validFrom) || Date.now() > Date.parse(parsed.validTo))
    throw new Error('REMOTE_CERTIFICATE_EXPIRED')
  if (previous?.fingerprint === fingerprint) return { ...previous, origin: httpsOrigin(input) }
  if (!previous && certificate.authorized) return undefined
  if (!interactive || !confirmCertificate)
    throw new Error(previous ? 'REMOTE_CERTIFICATE_CHANGED' : 'REMOTE_CERTIFICATE_UNTRUSTED')
  const accepted = await confirmCertificate(
    {
      origin: httpsOrigin(input),
      fingerprint,
      previousFingerprint: previous?.fingerprint,
      subject: parsed.subject,
      issuer: parsed.issuer,
      validFrom: parsed.validFrom,
      validTo: parsed.validTo,
    },
    signal,
  )
  signal?.throwIfAborted()
  if (!accepted) throw new Error('REMOTE_CERTIFICATE_REJECTED')
  return { origin: httpsOrigin(input), pem: certificate.pem, fingerprint }
}

/** 主进程业务请求使用专属 CA 与叶证书指纹；不改变其他服务的全局 TLS 配置。 */
export async function fetchWithServerCertificate(
  input: string,
  init: RequestInit,
  certificates: TrustedServerCertificate[] = [],
): Promise<Response> {
  const certificate = trustedCertificateFor(input, certificates)
  if (!input.startsWith('https:') || !certificate)
    return fetch(input, { ...init, redirect: 'error' })
  return new Promise<Response>((resolve, reject) => {
    const agent = new https.Agent({ ...pinnedTlsOptions(certificate), maxCachedSessions: 0 })
    const request = https.request(
      input,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        agent,
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500
        if (status >= 300 && status < 400) {
          incoming.destroy()
          reject(new Error('REMOTE_REDIRECT_REJECTED'))
          return
        }
        const headers = new Headers()
        for (const [name, values] of Object.entries(incoming.headers))
          for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values])
            headers.append(name, value)
        const empty = init.method === 'HEAD' || [204, 205, 304].includes(status)
        if (empty) incoming.resume()
        resolve(
          new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
            status,
            headers,
          }),
        )
      },
    )
    request.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '') &&
          !/EXPIRED|NOT_YET_VALID/.test(error.code ?? '')
          ? new Error('REMOTE_CERTIFICATE_CHANGED', { cause: error })
          : error,
      )
    })
    request.once('close', () => agent.destroy())
    if (
      init.body !== undefined &&
      init.body !== null &&
      typeof init.body !== 'string' &&
      !(init.body instanceof Uint8Array)
    ) {
      request.destroy(new Error('REMOTE_REQUEST_BODY_UNSUPPORTED'))
      return
    }
    request.end(init.body ?? undefined)
  })
}
