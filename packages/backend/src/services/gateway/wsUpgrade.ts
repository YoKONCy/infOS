import { t as __t } from '../../lib/i18n'
/**
 * WebSocket 升级处理器 (Gateway + 社交适配器)
 *
 * 在 Node.js HTTP Server 上监听 upgrade 事件，
 * 分路由处理两种 WebSocket 端点:
 * 1. /ws/gateway     — 前端 Dashboard 实时通信 (GatewayHub)
 * 2. /api/social/ws  — 平台声明的 WebSocket 传输
 *
 * 符合 A02 §7: Gateway 与 HTTP 共用 :9120 端口
 *
 * @platform ELECTRON | DOCKER
 * @module packages/backend/src/services/gateway/wsUpgrade
 */

import type { Server, IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { GatewayHub } from './gatewayHub'
import { getSocialTransport, createWsSender } from '../../applications/socialWsBridge'
import { createLogger } from '../../lib/logger'
import { createArcaBrowserSocket } from '../../applications/arcaBrowserSocket'
import type { AppContext } from '../../container'
import type { ClientIdentity } from '../system/clientAccessService'

const logger = createLogger('WebSocketUpgrade')

/** WS 升级路径 */
const WS_GATEWAY_PATH = '/ws/gateway'
const WS_SOCIAL_PATH = '/api/social/ws'

/** 节点 ID 计数器 */
let nodeCounter = 0

/**
 * 在已有 HTTP Server 上挂载 WebSocket 升级
 *
 * @param server - @hono/node-server 的 serve() 返回的 HTTP Server
 * @param hub - GatewayHub 实例 (DI 注入)
 * @param _ctx - 已废弃（社交适配器现在通过 socialWsBridge 全局注册表获取）
 */
export function setupGatewayWebSocket(
  server: Server,
  hub: GatewayHub,
  ctx?: Pick<AppContext, 'arcaApplication'> &
    Partial<Pick<AppContext, 'clientAccess' | 'webFrontend'>>,
  allowNativeAdapters = true,
): () => void {
  const gatewayWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  const socialWss = new WebSocketServer({ noServer: true })
  const developmentWss = new WebSocketServer({ noServer: true })
  const arca = createArcaBrowserSocket(() => ctx?.arcaApplication.status())
  const credentials = new WeakMap<IncomingMessage, ClientIdentity>()

  // 监听 HTTP upgrade 事件 → 按路径分派到对应 WSS
  server.on('upgrade', (request, socket, head) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    } catch {
      socket.destroy()
      return
    }
    const access = ctx?.clientAccess
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers))
      if (value) headers.set(key, Array.isArray(value) ? value.join('; ') : value)
    const identity = access?.authenticate(new Request(url, { headers }))

    if (url.pathname === '/api/applications/arca/transport') {
      if (access && !identity) {
        socket.destroy()
        return
      }
      arca.upgrade(request, socket, head, !!identity)
      return
    }

    if (url.pathname === '/__infos_hmr' && ctx?.webFrontend?.developmentOrigin) {
      if (!identity) {
        socket.destroy()
        return
      }
      const origin = ctx.webFrontend.developmentOrigin
      const target = new URL(url.pathname + url.search, origin)
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
      developmentWss.handleUpgrade(request, socket, head, (client) => {
        // HMR 只代理到配置的本机开发服务，不转发业务凭据与 Cookie。
        const upstream = new WebSocket(target, 'vite-hmr', {
          headers: { Origin: origin },
          handshakeTimeout: 8000,
        })
        client.pause()
        const abort = () => {
          client.terminate()
          upstream.terminate()
        }
        client.on('error', abort)
        upstream.on('error', abort)
        client.on('close', () => {
          if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
          else upstream.close()
        })
        upstream.on('close', () => client.close())
        upstream.on('open', () => {
          if (client.readyState !== WebSocket.OPEN) {
            upstream.close()
            return
          }
          client.resume()
        })
        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
        })
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
        })
      })
      return
    }

    if (url.pathname === WS_GATEWAY_PATH) {
      // 原生客户端使用 Bearer，浏览器使用查询凭据；升级和 hello 共用同一鉴权策略。
      const authorization = request.headers.authorization
      const token = authorization
        ? authorization.replace(/^Bearer\s+/i, '')
        : (url.searchParams.get('token') ?? '')
      if (access ? !identity : !hub.acceptsToken(token)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (identity) credentials.set(request, identity)
      gatewayWss.handleUpgrade(request, socket, head, (ws) => {
        gatewayWss.emit('connection', ws, request)
      })
      return
    }

    if (url.pathname === WS_SOCIAL_PATH) {
      if (!allowNativeAdapters) {
        socket.destroy()
        return
      }
      // 适配器属于独立原生通道，未授权网页不能冒充平台客户端 建立反向连接。
      if (request.headers.origin && access && !identity) {
        socket.destroy()
        return
      }
      socialWss.handleUpgrade(request, socket, head, (ws) => {
        socialWss.emit('connection', ws, request)
      })
      return
    }

    // 未知路径，销毁连接
    socket.destroy()
  })

  // ── Gateway WS 连接 ──
  gatewayWss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const nodeId = `node-${++nodeCounter}-${Date.now()}`
    logger.info(__t('logs.gateway', 'Gateway WS 连接建立: {0}', [nodeId]))

    hub.registerNode(
      nodeId,
      (data: string) => ws.send(data),
      () => ws.close(1001, '会话已过期，请重新连接'),
      !!ctx?.clientAccess || !!hub.authToken,
      credentials.get(request)?.id,
    )
    const access = ctx?.clientAccess
    const credential = credentials.get(request)?.token
    const validate = () => {
      if (access && !access.identify(credential || '')) ws.close(1008, '设备授权已撤销或过期')
    }
    const unsubscribe = access?.onRevoke(validate)
    const sessionCheck = setInterval(validate, 30_000)
    sessionCheck.unref()
    const handshakeDeadline = setTimeout(() => {
      if (!hub.isAuthenticated(nodeId)) ws.close(1008, '握手超时')
    }, 10_000)
    handshakeDeadline.unref()

    ws.on('message', (data: Buffer | string) => {
      if (access && !access.identify(credential || '')) {
        ws.close(1008, '设备授权已撤销或过期')
        return
      }
      const text = typeof data === 'string' ? data : data.toString('utf-8')
      hub.handleMessage(text, nodeId).catch((err) => {
        logger.warn(__t('logs.gateway', 'Gateway 消息处理失败: {0}', [err]))
      })
    })

    ws.on('close', () => {
      clearInterval(sessionCheck)
      unsubscribe?.()
      clearTimeout(handshakeDeadline)
      hub.unregisterNode(nodeId)
      logger.info(__t('logs.gateway', 'Gateway WS 连接断开: {0}', [nodeId]))
    })

    ws.on('error', (err) => {
      logger.warn(__t('logs.gateway', 'Gateway WS 错误 ({0}): {1}', [nodeId, err.message]))
    })
  })

  // ── 社交适配器 WS 连接 ──
  // 由宿主注册表选择平台，协议身份字段由平台端口声明。
  socialWss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const platform =
      new URL(request.url ?? '/', 'http://localhost').searchParams.get('platform') ?? undefined
    const adapter = getSocialTransport(platform)
    if (!adapter) {
      logger.warn(__t('logs.gateway', '社交 WS 未找到唯一可用的平台传输，关闭连接'))
      ws.close(1013, '社交服务尚未就绪，请稍后重连')
      return
    }

    const header = adapter.accountHeader
      ? request.headers[adapter.accountHeader.toLowerCase()]
      : undefined
    const selfId = typeof header === 'string' ? header : undefined
    logger.info(__t('logs.gateway', '社交 WS 连接建立: accountId={0}', [selfId ?? '未知']))

    // 注册连接到适配器
    const sender = createWsSender({
      send: (data: string) => ws.send(data),
      close: () => ws.close(),
    })
    adapter.registerConnection(selfId, sender)

    // 转发消息到适配器处理
    ws.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf-8')
      adapter.handleRawEvent(text).catch((err) => {
        logger.warn(__t('logs.gateway', '社交平台事件处理失败: {0}', [err]))
      })
    })

    ws.on('close', () => {
      adapter.unregisterConnection(selfId, sender)
      logger.info(__t('logs.gateway', '社交 WS 连接断开: accountId={0}', [selfId ?? '未知']))
    })

    ws.on('error', (err) => {
      logger.warn(__t('logs.gateway', '社交 WS 错误: {0}', [err.message]))
    })
  })

  logger.info(__t('logs.gateway', '社交 WS 端点已挂载: {0}', [WS_SOCIAL_PATH]))
  logger.info(__t('logs.gateway', 'Gateway WS 端点已挂载: {0}', [WS_GATEWAY_PATH]))
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    arca.close()
    for (const client of gatewayWss.clients) client.terminate()
    for (const client of socialWss.clients) client.terminate()
    for (const client of developmentWss.clients) client.terminate()
    gatewayWss.close()
    socialWss.close()
    developmentWss.close()
  }
  server.once('close', dispose)
  return dispose
}
