/** 模型资产仅向主应用来源开放；外部浏览器使用独立 Session。 */
export function assetRequestHeaders(request: Request, rendererUrl?: string): Headers | null {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null
  const origin = request.headers.get('origin')
  let developmentOrigin: string | undefined
  try {
    if (rendererUrl) developmentOrigin = new URL(rendererUrl).origin
  } catch {
    // 开发地址无效时不额外放行任何网络来源。
  }
  // 正式主应用由 file:// 加载，其跨协议请求使用不透明来源 null。
  if (origin && origin !== 'null' && origin !== developmentOrigin) return null
  const headers = new Headers({ Vary: 'Origin' })
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  return headers
}
