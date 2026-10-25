import { getClientCredential } from '../utils/clientCredential'
import { getBackendOrigin, isRemoteConnection } from './clientConnection'
import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'

interface DesktopGuard {
  pipe: string
  token: string
}
let server: Server | undefined,
  descriptor: DesktopGuard | undefined,
  starting: Promise<DesktopGuard> | undefined
let closing = false
const sockets = new Set<Socket>()

/** 桌面进程退出或崩溃时，系统关闭连接，托管后台据此停止。 */
export function pictoriaDesktopGuard(): Promise<DesktopGuard> {
  if (closing) return Promise.reject(new Error('桌面正在退出，不能启动 Pictoria'))
  if (descriptor) return Promise.resolve(descriptor)
  if (starting) return starting
  starting = (async () => {
    const suffix = randomBytes(8).toString('hex'),
      token = randomBytes(32).toString('hex')
    const pipe =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\infos-pictoria-${process.pid}-${suffix}`
        : path.join(tmpdir(), `infos-pcl-${process.pid}-${suffix}.sock`)
    const value = { pipe, token }
    const listener = createServer((socket) => {
      sockets.add(socket)
      socket.unref()
      let buffer = '',
        authenticated = false
      const timeout = setTimeout(() => socket.destroy(), 3000)
      timeout.unref()
      socket.on('data', (chunk) => {
        if (authenticated) return
        buffer += chunk.toString('utf8')
        if (buffer.length > 1024) {
          socket.destroy()
          return
        }
        if (!buffer.includes('\n')) return
        try {
          const input = JSON.parse(buffer.split('\n')[0]!) as { token?: unknown }
          if (
            typeof input.token !== 'string' ||
            input.token.length !== token.length ||
            !timingSafeEqual(Buffer.from(input.token), Buffer.from(token))
          ) {
            socket.destroy()
            return
          }
          authenticated = true
          clearTimeout(timeout)
          buffer = ''
          socket.write(JSON.stringify({ ready: true }) + '\n')
        } catch {
          socket.destroy()
        }
      })
      socket.on('error', () => socket.destroy())
      socket.once('close', () => {
        clearTimeout(timeout)
        sockets.delete(socket)
      })
    })
    server = listener
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(pipe, () => {
        listener.removeListener('error', reject)
        resolve()
      })
    })
    listener.on('error', () => {
      for (const socket of sockets) socket.destroy()
    })
    listener.unref()
    if (closing) {
      listener.close()
      throw new Error('桌面正在退出')
    }
    descriptor = value
    return value
  })().finally(() => {
    starting = undefined
  })
  return starting
}

export async function closePictoriaDesktopGuard(): Promise<void> {
  closing = true
  await starting?.catch(() => undefined)
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  const listener = server,
    value = descriptor
  server = undefined
  descriptor = undefined
  if (listener?.listening) await new Promise<void>((resolve) => listener.close(() => resolve()))
  if (value && process.platform !== 'win32')
    await rm(value.pipe, { force: true }).catch(() => undefined)
}

/** 宿主令牌与桌面存活凭据始终留在主进程。 */
export async function startDesktopPictoria(): Promise<unknown> {
  const desktopGuard = isRemoteConnection() ? undefined : await pictoriaDesktopGuard(),
    token = getClientCredential()
  const response = await fetch(`${getBackendOrigin()}/api/applications/pictoria/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(desktopGuard ? { desktopGuard } : {}),
    signal: AbortSignal.timeout(25000),
    redirect: 'error',
  })
  const result = (await response.json()) as { code: string; data?: unknown; message?: string }
  if (!response.ok || result.code !== 'OK')
    throw new Error(result.message || 'Pictoria 后台启动失败')
  return result.data
}
