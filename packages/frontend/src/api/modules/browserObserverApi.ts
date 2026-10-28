import type { BrowserObserverFrame, BrowserObserverSession } from '@infos/shared'
import { apiClient } from '../client'

const query = (agentId: string, threadId: string) => new URLSearchParams({ agentId, threadId })

export const browserObserverApi = {
  sessions(agentId: string, threadId: string, signal: AbortSignal) {
    return apiClient.request<BrowserObserverSession[]>(
      `/browser-observer/sessions?${query(agentId, threadId)}`,
      { signal },
    )
  },
  frame(id: string, agentId: string, threadId: string, signal: AbortSignal) {
    return apiClient.request<BrowserObserverFrame>(
      `/browser-observer/sessions/${encodeURIComponent(id)}/frame?${query(agentId, threadId)}`,
      { signal },
    )
  },
}
