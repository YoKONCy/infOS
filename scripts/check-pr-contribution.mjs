import { t } from './i18n.mjs'

const scope = 'scripts.contribution-check'
const fields = new Map([
  ['problem', '问题与关联 Issue'],
  ['changes', '改动范围'],
  ['architecture', '架构依据'],
  ['verification', '实际验证'],
  ['screenshots', '运行截图或不涉及前端的说明'],
  ['compatibility', '兼容与升级影响'],
])

/** 只读取填写内容；提示注释、小标题和空清单不算回答。 */
function answers(body) {
  const markers = [...body.matchAll(/^<!--[ \t]*infos-pr:([a-z]+)[ \t]*-->[ \t]*\r?$/gm)]
  const sections = new Map()
  for (const [index, marker] of markers.entries()) {
    const key = marker[1]
    if (!fields.has(key) || sections.has(key)) continue
    const content = body
      .slice(marker.index + marker[0].length, markers[index + 1]?.index)
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/^\s{0,3}#{1,6}\s.*$/gm, '')
      .replace(/^\s*[-*+]\s*(?:\[[ xX]\])?\s*$/gm, '')
      .trim()
    sections.set(key, content)
  }
  return sections
}

/** 文件范围是截图证据的最低要求；改名和删除也可能改变界面。 */
function isFrontend(file) {
  const name = file.replaceAll('\\', '/')
  if (/\.(?:md|mdx|txt)$/i.test(name)) return false
  return (
    /\.(?:vue|jsx|tsx|css|scss|sass|less|html)$/i.test(name) ||
    /^(?:packages\/frontend|packages\/apps\/[^/]+\/client|packages\/avatar-assets|packages\/browser-extension|packages\/wiki\/\.vitepress|electron\/(?:splash|renderer|main\/windows)|build\/installer|public)\//.test(
      name,
    ) ||
    /^packages\/shared\/src\/i18n\/locales\/[^/]+\/(?:ui|electron\/ui|apps\/[^/]+\/ui)\//.test(
      name,
    ) ||
    /^resources\/.*\.(?:svg|png|jpe?g|webp|gif|ico)$/i.test(name)
  )
}

/** 仅识别正文里实际内嵌的图片引用，不请求图片地址或判断图片内容。 */
function hasEmbeddedImage(content, body) {
  const visible = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '')
  if (
    /!\[[^\]\r\n]*\]\(\s*(?:<[^>\r\n]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.test(visible) ||
    /<img\b[^>]*\ssrc\s*=\s*(?:"[^"\s]+"|'[^'\s]+')[^>]*>/i.test(visible)
  )
    return true
  // 也接受引用式 Markdown 图片，引用定义可以放在正文末尾。
  const normalize = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase()
  const imageReferences = new Set(
    [...visible.matchAll(/!\[([^\]\r\n]+)\](?:\[([^\]\r\n]*)\])?/g)].map((match) =>
      normalize(match[2] || match[1]),
    ),
  )
  const definitions = body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
  return [...definitions.matchAll(/^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*\S+/gm)].some((match) =>
    imageReferences.has(normalize(match[1])),
  )
}

export function contributionReport(body, files, expectedFiles) {
  const description = typeof body === 'string' ? body : ''
  const sections = answers(description)
  const errors = []
  for (const [key, label] of fields) {
    if (!sections.get(key)) errors.push(t(scope, '请补充：{0}', [t(scope, label)]))
  }
  if (files.length !== expectedFiles)
    errors.push(t(scope, '未能取得完整变更文件列表，请重试检查或联系维护者。'))
  const frontendChanged = files.some((file) =>
    [file.filename, file.previous_filename].some(
      (name) => typeof name === 'string' && isFrontend(name),
    ),
  )
  if (
    frontendChanged &&
    sections.get('screenshots') &&
    !hasEmbeddedImage(sections.get('screenshots'), description)
  )
    errors.push(
      t(scope, '这次涉及前端，请在截图栏直接附上实际运行截图；页面链接或文字说明不能代替截图。'),
    )
  return {
    errors,
    summary: errors.length
      ? t(scope, '还差几条 PR 信息，请补充后更新说明：')
      : t(scope, 'PR 必填信息与截图引用已齐全；架构和证据内容仍需人工审阅。'),
  }
}
