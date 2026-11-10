import { t as __t } from '../i18n/index'

interface NapCatGuardDeps {
  /** 主进程的 check-napcat。 */
  isInstalled: () => Promise<unknown>
  /** 打开有「一键安装」按钮的社交页面。 */
  openInstallPage: () => Promise<void>
  warn: (message: string) => void
}

/**
 * 打开 NapCat 标签前先确认装过。没装时不启动也不自动下载，只提示并带用户到社交页面，
 * 由用户自己点「一键安装」。查询本身失败时放行，由主进程给出真实错误。
 */
export async function ensureNapCatInstalled(deps: NapCatGuardDeps): Promise<boolean> {
  let installed: unknown
  try {
    installed = await deps.isInstalled()
  } catch {
    return true
  }
  if (installed) return true
  deps.warn(
    __t(
      'ui.navigation',
      'NapCat 还没有安装。已为你打开「社交」页面：在 QQ 平台的进程管理里点「一键安装」（如果还没启用 QQ，先点「启用 QQ」）。',
    ),
  )
  await deps.openInstallPage()
  return false
}
