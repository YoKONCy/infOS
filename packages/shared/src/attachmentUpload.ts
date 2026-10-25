import { nativeAudioMime } from './nativeAudio'

/** 上传原件与模型上下文预算独立；只有支持且足够小的内容才自动装配。 */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_INLINE_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_INLINE_ATTACHMENT_TEXT_BYTES = 2 * 1024 * 1024
export type UploadAttachmentKind = 'image' | 'text' | 'pdf' | 'audio' | 'file'
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const textMimes = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/sql',
])
const textExtensions =
  /\.(?:txt|md|markdown|csv|json|jsonl|ndjson|xml|yaml|yml|js|mjs|cjs|ts|tsx|jsx|vue|py|css|c|h|cpp|java|sql|rs|go|sh|ps1|log|toml|ini)$/i

export function classifyAttachmentUpload(
  name: string,
  mime: string,
  size: number,
): UploadAttachmentKind {
  const type = mime.toLowerCase().split(';')[0]?.trim() ?? ''
  if (nativeAudioMime(type, name)) return 'audio'
  if (
    (type === 'application/pdf' || /\.pdf$/i.test(name)) &&
    size <= MAX_INLINE_ATTACHMENT_IMAGE_BYTES
  )
    return 'pdf'
  if (
    (imageMimes.has(type) || /\.(?:png|jpe?g|webp|gif)$/i.test(name)) &&
    size <= MAX_INLINE_ATTACHMENT_IMAGE_BYTES
  )
    return 'image'
  if (
    (type.startsWith('text/') || textMimes.has(type) || textExtensions.test(name)) &&
    size <= MAX_INLINE_ATTACHMENT_TEXT_BYTES
  )
    return 'text'
  return 'file'
}
