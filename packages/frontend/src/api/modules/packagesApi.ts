import type {
  ManagedPackageInfo,
  PackagePanel,
  PackagePermission,
  PackageUiSlot,
} from '@infos/shared'
import { apiClient } from '../client'

const endpoint = (id: string) => `/packages/${encodeURIComponent(id)}`
export const packagesApi = {
  list: () => apiClient.get<ManagedPackageInfo[]>('/packages'),
  install: (file: File) => {
    const data = new FormData()
    data.append('package', file)
    return apiClient.post<ManagedPackageInfo[]>('/packages/install', data)
  },
  authorize: (id: string, digest: string, permissions: PackagePermission[]) =>
    apiClient.post(`${endpoint(id)}/authorize`, { digest, permissions }),
  enabled: (id: string, enabled: boolean) => apiClient.put(`${endpoint(id)}/enabled`, { enabled }),
  reload: (id: string) => apiClient.post(`${endpoint(id)}/reload`),
  review: (id: string) => apiClient.post(`${endpoint(id)}/review`),
  rollback: (id: string) => apiClient.post(`${endpoint(id)}/rollback`),
  uninstall: (id: string) => apiClient.delete(endpoint(id)),
  panels: (slot: PackageUiSlot) => apiClient.get<PackagePanel[]>(`/packages/panels/${slot}`),
  action: (panelId: string, actionId: string) =>
    apiClient.post('/packages/panel-actions', { panelId, actionId }),
}
