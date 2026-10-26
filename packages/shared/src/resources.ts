export type ResourceKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'file' | 'web'

/** 系统关联打开仅用于常见文档与媒体；脚本、快捷方式和未知类型只定位。 */
export function systemFileOpenAction(name: string): 'open' | 'reveal' {
  const extension = name.split(/[\\/]/).pop()?.match(/\.[^.]+$/)?.[0]?.toLowerCase()
  return extension &&
    [
      '.txt',
      '.md',
      '.json',
      '.csv',
      '.log',
      '.yaml',
      '.yml',
      '.toml',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
      '.bmp',
      '.avif',
      '.ico',
      '.mp3',
      '.wav',
      '.flac',
      '.ogg',
      '.m4a',
      '.aac',
      '.mp4',
      '.webm',
      '.mov',
      '.pdf',
      '.zip',
      '.7z',
      '.rar',
      '.tar',
      '.gz',
    ].includes(extension)
    ? 'open'
    : 'reveal'
}

/** 搜索文件的只读打开凭据，归属由后端验证。 */
export interface CodeSearchNavigation {
  resultRef: string
  agentId: string
  threadId: string
  taskId?: string
}

export interface ResourceOrigin {
  type: 'workspace' | 'url' | 'arca' | 'application'
  value: string
  agentId?: string
  threadId?: string
  taskId?: string
  line?: number
}

/** 持久化资源有附件 ID；来源引用打开时读取当前版本。 */
export interface MessageResource {
  id?: string
  kind: string
  name: string
  mimeType: string
  sizeBytes: number
  caption?: string
  origin?: ResourceOrigin
}

export const MAX_READ_IMAGE_COUNT = 8
export const MAX_READ_IMAGE_BATCH_BYTES = 40 * 1024 * 1024

export const SCREENSHOT_TOOLS = [
  'take_screenshot',
  'screen_capture',
  'browser_screenshot',
  'browser_page_image',
  'automation_execute',
] as const
export const IMAGE_PREVIEW_TOOLS = ['read_image', 'document', ...SCREENSHOT_TOOLS] as const

/** 读图与截图均只解析附件引用，不把外部地址当作界面图片加载。 */
export function imagePreviewsFromToolResult(name: string, result?: string): MessageResource[] {
  if (!IMAGE_PREVIEW_TOOLS.some((tool) => tool === name) || !result) return []
  try {
    const value = JSON.parse(result) as {
      imagePreview?: Partial<MessageResource>
      images?: Array<{ imagePreview?: Partial<MessageResource> }>
      screenshots?: Array<{ imagePreview?: Partial<MessageResource> }>
    }
    const items = value?.imagePreview
      ? [value.imagePreview]
      : Array.isArray(value?.images)
        ? value.images.slice(0, MAX_READ_IMAGE_COUNT).map((entry) => entry?.imagePreview)
        : Array.isArray(value?.screenshots)
          ? value.screenshots.slice(0, MAX_READ_IMAGE_COUNT).map((entry) => entry?.imagePreview)
          : []
    const previews: MessageResource[] = []
    for (const item of items) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[\w-]{1,128}$/.test(item.id) ||
        item.kind !== 'image' ||
        typeof item.name !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mimeType ?? '') ||
        typeof item.sizeBytes !== 'number' ||
        !Number.isFinite(item.sizeBytes) ||
        item.sizeBytes < 0
      )
        continue
      if (previews.some((preview) => preview.id === item.id)) continue
      previews.push({
        id: item.id,
        kind: 'image',
        name: item.name,
        mimeType: item.mimeType!,
        sizeBytes: item.sizeBytes,
      })
    }
    return previews
  } catch {
    return []
  }
}

/** 单图历史记录与只需要首图的调用方沿用同一套引用校验。 */
export function imagePreviewFromToolResult(name: string, result?: string): MessageResource | null {
  return imagePreviewsFromToolResult(name, result)[0] ?? null
}

/** 仅签发给内置社交应用的资源交付口，不暴露通用文件系统。 */
export interface SocialResourcePort {
  prepare(input: {
    agentId: string
    threadId: string
    source: string
    caption?: string
    allowLocal: boolean
    callId: string
  }): Promise<{ resource: MessageResource & { id: string }; filePath: string }>
  markDelivered(id: string, agentId: string): Promise<void>
}

/** 仅签发给受信任社交适配器的自治创作入口。 */
export interface ApplicationCreativePort {
  describe(
    origin: import('./types/task-lifecycle.types').TaskOrigin,
  ): Promise<{ name: string; description: string; parameters: Record<string, unknown> } | undefined>
  invoke(
    origin: import('./types/task-lifecycle.types').TaskOrigin,
    input: Record<string, unknown>,
    requestKey: string,
  ): Promise<unknown>
}

export function resourceFromToolResult(name: string, result?: string): MessageResource | null {
  if (name !== 'send_file' || !result) return null
  try {
    const value = JSON.parse(result) as { resource?: MessageResource; success?: boolean }
    const item = value.resource
    if (
      value.success !== true ||
      !item ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.kind !== 'string' ||
      typeof item.mimeType !== 'string' ||
      !Number.isFinite(item.sizeBytes)
    )
      return null
    return item
  } catch {
    return null
  }
}
