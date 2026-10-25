import type { WorkspacePreviewKind } from '@infos/shared'

/** 每个文件保留自己的阅读位置；预览组件关闭后不占用解码器或 PDF Worker。 */
export interface WorkspacePreviewState {
  zoom: number
  panX?: number
  panY?: number
  page: number
  position: number
  volume: number
  muted: boolean
  pdfLayout?: 'continuous' | 'single'
  pdfScrollTop?: number
}

export function createPreviewState(): WorkspacePreviewState {
  return { zoom: 0, page: 1, position: 0, volume: 1, muted: false, pdfLayout: 'continuous' }
}

export function workspaceFileIconKind(name: string): WorkspacePreviewKind {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'svg') return 'svg'
  if (extension === 'pdf') return 'pdf'
  if (/^(?:png|jpe?g|gif|webp|avif|bmp|ico)$/.test(extension ?? '')) return 'image'
  if (/^(?:mp4|m4v|webm|mov|ogv|mkv)$/.test(extension ?? '')) return 'video'
  if (/^(?:mp3|wav|ogg|oga|opus|m4a|aac|flac)$/.test(extension ?? '')) return 'audio'
  return 'text'
}
