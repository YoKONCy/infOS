import path from 'node:path'
import { existsSync } from 'node:fs'
import { StaticAssetService } from './staticAssetService'

/** 主应用网页入口只发布 renderer；源码模式代理现有 Vite，不另起业务后端。 */
export class WebFrontendService {
  private assets?: StaticAssetService
  private readonly sourceRoots: string[]
  readonly developmentOrigin?: string
  constructor(
    root: string,
    developmentOrigin?: string,
    private authorize?: (request: Request) => boolean,
  ) {
    this.sourceRoots = [
      path.dirname(root),
      path.resolve(root, '..', '..', 'shared', 'src'),
      path.resolve(root, '..', '..', 'avatar-assets', 'src'),
      path.resolve(root, '..', '..', 'apps', 'arca', 'src'),
      path.resolve(root, '..', '..', '..', 'node_modules'),
      path.resolve(root, '..', '..', '..', 'public'),
    ].map((directory) => path.resolve(directory))
    if (developmentOrigin) this.developmentOrigin = new URL(developmentOrigin).origin
    else if (existsSync(path.join(root, 'index.html'))) this.assets = new StaticAssetService(root)
  }
  async response(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      /^\/(api|ws|metrics|applications|html-previews)(\/|$)/.test(url.pathname)
    )
      return
    if (this.developmentOrigin) {
      // 登录页需要前端模块，后台源码与 TEMP 等文件不向未配对设备开放。
      if (url.pathname.startsWith('/@fs/') && !this.authorize?.(request)) {
        let requested: string
        try {
          requested = path.resolve(decodeURIComponent(url.pathname.slice('/@fs/'.length)))
        } catch {
          return new Response('禁止访问', { status: 403 })
        }
        if (
          !this.sourceRoots.some(
            (directory) =>
              requested === directory || requested.startsWith(`${directory}${path.sep}`),
          )
        )
          return new Response('请先配对此设备', { status: 403 })
      }
      const target = new URL(url.pathname + url.search, this.developmentOrigin)
      const headers = new Headers()
      for (const key of ['accept', 'if-none-match']) {
        const value = request.headers.get(key)
        if (value) headers.set(key, value)
      }
      try {
        const upstream = await fetch(target, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        const outgoing = new Headers(upstream.headers)
        outgoing.delete('content-encoding')
        outgoing.delete('content-length')
        outgoing.set('Cache-Control', 'no-store')
        return new Response(upstream.body, { status: upstream.status, headers: outgoing })
      } catch {
        return new Response('主应用开发页面尚未启动，请先启动 Vite 前端服务', { status: 503 })
      }
    }
    if (!this.assets) return new Response('主应用网页资源尚未安装', { status: 503 })
    try {
      const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
      const response =
        this.assets.response(name, request) ||
        (!path.extname(name) ? this.assets.response('index.html', request) : null)
      return response ?? new Response('网页资源不存在', { status: 404 })
    } catch {
      return new Response('禁止访问', { status: 403 })
    }
  }
}
