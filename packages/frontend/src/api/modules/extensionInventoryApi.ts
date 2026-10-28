import type { InstalledExtensionsView } from '@infos/shared'
import { apiClient } from '../client'

export const extensionInventoryApi = {
  list: (signal?: AbortSignal) =>
    apiClient.request<InstalledExtensionsView>('/integrations/installed', { signal }),
  rescanAssets: (signal?: AbortSignal) =>
    apiClient.request('/assets/rescan', {
      method: 'POST',
      signal,
    }),
}
