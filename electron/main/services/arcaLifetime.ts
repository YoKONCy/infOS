import { getClientCredential } from '../utils/clientCredential'
import { getBackendOrigin, isRemoteConnection } from './clientConnection'
import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'

let server: Server | undefined
let guard: { pipe: string; token: string } | undefined
let starting: Promise<{ pipe: string; token: string }> | undefined
let closing = false
const sockets = new Set<Socket>()

/** 桌面存活凭据只在主进程、Daemon 与子应用后台之间传递。 */
async function desktopGuard() {
  if (closing) throw new Error('桌面正在退出')
  if (guard) return guard
  starting ??= Promise.resolve()
    .then(async () => {
      const suffix = randomBytes(8).toString('hex'),
        token = randomBytes(32).toString('hex')
      const pipe =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\infos-arca-${process.pid}-${suffix}`
          : path.join(tmpdir(), `infos-arca-${process.pid}-${suffix}.sock`)
      const listener = createServer((socket) => {
        sockets.add(socket)
        socket.unref()
        let buffer = '',
          ready = false
        const timeout = setTimeout(() => socket.destroy(), 3000)
        timeout.unref()
        socket.on('data', (chunk) => {
          if (ready) return
          buffer += chunk.toString('utf8')
          if (buffer.length > 1024) {
            socket.destroy()
            return
          }
          if (!buffer.includes('\n')) return
          try {
            const value = JSON.parse(buffer.split('\n')[0]!) as { token?: unknown }
            if (
              typeof value.token !== 'string' ||
              Buffer.byteLength(value.token) !== Buffer.byteLength(token) ||
              !timingSafeEqual(Buffer.from(value.token), Buffer.from(token))
            ) {
              socket.destroy()
              return
            }
            ready = true
            buffer = ''
            clearTimeout(timeout)
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
      try {
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject)
          listener.listen(pipe, resolve)
        })
        listener.on('error', () => {
          for (const socket of sockets) socket.destroy()
        })
        listener.unref()
        if (closing) throw new Error('桌面正在退出')
        guard = { pipe, token }
        return guard
      } catch (error) {
        if (listener.listening) listener.close()
        throw error
      }
    })
    .finally(() => {
      starting = undefined
    })
  return starting
}

export async function closeArcaDesktopGuard(): Promise<void> {
  closing = true
  await starting?.catch(() => undefined)
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  const listener = server,
    value = guard
  server = undefined
  guard = undefined
  if (listener?.listening) await new Promise<void>((resolve) => listener.close(() => resolve()))
  if (value && process.platform !== 'win32') await rm(value.pipe, { force: true })
}

export async function startDesktopArca(): Promise<unknown> {
  const value = isRemoteConnection() ? undefined : await desktopGuard(),
    token = getClientCredential()
  const response = await fetch(`${getBackendOrigin()}/api/applications/arca/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value ? { desktopGuard: value } : {}),
    signal: AbortSignal.timeout(25000),
    redirect: 'error',
  })
  const result = (await response.json()) as { code: string; data?: unknown; message?: string }
  if (!response.ok || result.code !== 'OK') throw new Error(result.message ?? 'Arca 后台启动失败')
  return result.data
}
