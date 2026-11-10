/**
 * @file 预制件页面：宿主内置的空白文档，不含任何脚本（CSP 也禁止脚本），界面由预制件 preload 绘制。
 * @platform ELECTRON
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { DesktopCardMeta } from '../../../packages/shared/src/desktopCards'

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )

export function prefabDocument(card: DesktopCardMeta): string {
  const kind = card.prefab?.kind ?? 'unknown'
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(card.name)}</title>`,
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style>',
    '</head>',
    `<body data-prefab="${escapeHtml(kind)}"></body>`,
    '</html>',
  ].join('')
}
