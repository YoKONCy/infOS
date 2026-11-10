/**
 * 自定义主题 API 模块
 *
 * 主题存放在服务端数据目录 `themes/`，前端读取 theme.css 后注入页面。
 */

import type { CustomThemeLibrary, CustomThemeSummary } from '@infos/shared'
import { apiClient } from '../client'
import { getApiResourceUrl, requestApiResource } from '../transport'

const themePath = (themeId: string) => `/themes/${encodeURIComponent(themeId)}`
const filePath = (themeId: string, path: string) =>
  `${themePath(themeId)}/files/${path.split('/').map(encodeURIComponent).join('/')}`

export const themeApi = {
  list: () => apiClient.get<CustomThemeLibrary>('/themes'),

  /** 导入主题 ZIP；同名主题已存在时返回 ALREADY_EXISTS，`replace` 为真则覆盖。 */
  import: (file: File, replace = false) => {
    const form = new FormData()
    form.append('theme', file)
    return apiClient.post<CustomThemeSummary>(`/themes/import${replace ? '?replace=1' : ''}`, form)
  },

  remove: (themeId: string) => apiClient.delete<null>(themePath(themeId)),

  /** 读取 theme.css 正文。 */
  stylesheet: async (themeId: string, signal?: AbortSignal) =>
    (
      await requestApiResource(filePath(themeId, 'theme.css'), new URLSearchParams(), signal)
    ).text(),

  /** 主题内图片、字体的地址，由浏览器直接请求，因此带查询参数鉴权。 */
  fileUrl: (themeId: string, path: string) =>
    getApiResourceUrl(filePath(themeId, path), new URLSearchParams()),
}
