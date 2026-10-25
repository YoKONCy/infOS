import type { AppLocale } from '@infos/shared/i18n'

export interface RichTextSegment {
  type: 'rich-text' | 'web-preview' | 'resource-reference'
  source: string
  label?: string
  html?: string
}

export interface RichTextSnapshotInput {
  content: string
  webPreview: boolean
  locale: AppLocale
}

export interface RichTextSnapshot extends RichTextSnapshotInput {
  segments: readonly RichTextSegment[]
}

const snapshots = new Map<string, { snapshot: RichTextSnapshot; size: number }>()
const SNAPSHOT_LIMIT = 200
const SNAPSHOT_CHAR_BUDGET = 2_000_000
let cachedChars = 0

export function matchesRichTextSnapshot(
  snapshot: RichTextSnapshot | undefined,
  input: RichTextSnapshotInput,
): boolean {
  return (
    snapshot !== undefined &&
    snapshot.content === input.content &&
    snapshot.webPreview === input.webPreview &&
    snapshot.locale === input.locale
  )
}

function snapshotKey(input: RichTextSnapshotInput): string {
  return JSON.stringify([input.locale, input.webPreview, input.content])
}

/** 页面重挂载时复用完整分段结果；可见组件另持引用，不受共享缓存淘汰影响。 */
export function readRichTextSnapshot(input: RichTextSnapshotInput): RichTextSnapshot | undefined {
  if (input.content.length > SNAPSHOT_CHAR_BUDGET) return undefined
  const key = snapshotKey(input)
  const cached = snapshots.get(key)
  if (!cached) return undefined
  snapshots.delete(key)
  snapshots.set(key, cached)
  return cached.snapshot
}

export function writeRichTextSnapshot(snapshot: RichTextSnapshot): void {
  if (snapshot.content.length > SNAPSHOT_CHAR_BUDGET) return
  const key = snapshotKey(snapshot)
  const size =
    key.length +
    snapshot.content.length +
    snapshot.segments.reduce(
      (total, segment) =>
        total + segment.source.length + (segment.html?.length ?? 0) + (segment.label?.length ?? 0),
      0,
    )
  // 超大消息只驻留在所属组件，避免单条内容挤掉整个共享缓存。
  if (size > SNAPSHOT_CHAR_BUDGET) return
  const previous = snapshots.get(key)
  if (previous) cachedChars -= previous.size
  snapshots.delete(key)
  snapshots.set(key, { snapshot, size })
  cachedChars += size
  while (snapshots.size > SNAPSHOT_LIMIT || cachedChars > SNAPSHOT_CHAR_BUDGET) {
    const oldest = snapshots.keys().next().value!
    cachedChars -= snapshots.get(oldest)!.size
    snapshots.delete(oldest)
  }
}
