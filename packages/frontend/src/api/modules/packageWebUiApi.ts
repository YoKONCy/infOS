import type { PackageWebUiSession } from '@infos/shared'
import { apiClient } from '../client'
import { clientFetch, getApiBaseUrl } from '../transport'
import { t } from '../../i18n'

const endpoint = '/packages/web-ui'
const sessionPath = (id: string) => `${endpoint}/sessions/${encodeURIComponent(id)}`

export const packageWebUiApi = {
  open: (packageId: string, contributionId: string, signal: AbortSignal) =>
    apiClient.request<PackageWebUiSession>(`${endpoint}/open`, {
      method: 'POST',
      body: JSON.stringify({ packageId, contributionId }),
      signal,
    }),
  touch: (id: string) => apiClient.get(sessionPath(id)),
  close: (id: string) => apiClient.delete(sessionPath(id)),
  async call(
    id: string,
    action: string,
    input: unknown,
    progress: (value: unknown) => void,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await clientFetch(`${getApiBaseUrl()}${sessionPath(id)}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, input: input ?? null }),
      signal,
    })
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    )
      throw new Error(t('ui.packages', '插件操作未完成，请重试。'))
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(t('ui.packages', '插件操作连接已中断，请重试。'))
        buffer += decoder.decode(chunk.value, { stream: true })
        if (buffer.length > 1024 * 1024) throw new Error(t('ui.packages', '插件返回的数据过大。'))
        buffer = buffer.replaceAll('\r\n', '\n')
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const type = /^event:\s*(\S+)/m.exec(frame)?.[1]
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          const value: unknown = JSON.parse(data)
          if (type === 'progress') progress(value)
          else if (type === 'result') return value
          else if (type === 'error')
            throw new Error(
              value &&
                typeof value === 'object' &&
                'message' in value &&
                typeof value.message === 'string'
                ? value.message
                : t('ui.packages', '插件操作未完成，请重试。'),
            )
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  },
}
