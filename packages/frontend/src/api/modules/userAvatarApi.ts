import { apiClient } from '../client'
import { getApiResourceUrl } from '../transport'

export interface UserAvatarProfile {
  version: string | null
  name: string
}

export const userAvatarApi = {
  profile: () => apiClient.get<UserAvatarProfile>('/system/user-avatar'),
  upload: (avatar: Blob) => {
    const data = new FormData()
    data.append('avatar', avatar, 'avatar.png')
    return apiClient.put<UserAvatarProfile>('/system/user-avatar', data)
  },
  remove: () => apiClient.delete<UserAvatarProfile>('/system/user-avatar'),
  contentUrl: (version: string) =>
    getApiResourceUrl('/system/user-avatar/content', new URLSearchParams({ v: version })),
}
