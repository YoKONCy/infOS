/** @platform WINDOWS Electron 的材质接口要求 Windows 11 22H2。 */
export function supportsHomeCardMaterial(platform: string, version: string): boolean {
  const [major = 0, minor = 0, build = 0] = version.split('.').map(Number)
  return platform === 'win32' && major === 10 && minor === 0 && build >= 22621
}

/** 原生加载失败时的最小可读页面，外部错误文本必须转义。 */
export function homeCardFailureHtml(title: string, reason: string): string {
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!,
    )
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;padding:46px 18px 20px;font:14px/1.6 system-ui;background:#f4f3fa;color:#292735;overflow-wrap:anywhere}h1{font-size:17px}pre{white-space:pre-wrap;font:inherit}</style><h1>${escape(title)}</h1><pre>${escape(reason.slice(0, 1200))}</pre>`
}
