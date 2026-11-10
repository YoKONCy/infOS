import { packagesApi } from '../../api/modules/packagesApi'
import { t } from '../../i18n'
import { isElectron } from '../../utils/ipcAdapter'

/** 浏览器先保留用户点击产生的窗口，桌面版交给现有链接处理入口。 */
export async function openPackageLocalPage(panelId: string): Promise<void> {
  const desktop = isElectron()
  const popup = desktop ? null : window.open('about:blank', '_blank')
  if (!desktop && !popup)
    throw new Error(t('ui.packages', '请允许弹出窗口后重试。'))
  if (popup) popup.opener = null
  try {
    const url = (await packagesApi.action<{ url: string }>(panelId, 'page.url')).data?.url
    if (!url) throw new Error(t('ui.packages', '插件页面没有启动，请启用或重载插件后重试。'))
    if (popup?.closed) return
    if (popup) popup.location.replace(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    popup?.close()
    throw error
  }
}
