import { app, dialog, shell } from 'electron'
import { ResourceVersions } from '@infos/shared/resource-versions'
import { paths, isDev } from '../utils/env'
import { t } from '../utils/i18n'
import { ownsPortableDaemon, probeBusinessHealth } from './portableDaemon'
import { isRemoteConnection } from './clientConnection'

let showing = false
export async function restartForResources() {
  if (isRemoteConnection() || isDev || (!ownsPortableDaemon() && (await probeBusinessHealth()))) {
    await dialog.showMessageBox({
      type: 'info',
      message: t(
        'electron.ui.resource-recovery',
        '请手动重启外部或开发后端，资源将在下次启动时切换。',
      ),
    })
    return
  }
  app.relaunch()
  app.quit()
}

/** 原生恢复菜单不访问后端；后端未启动或崩溃时仍可登记恢复操作。 */
export async function showResourceRecovery() {
  if (showing) return
  showing = true
  try {
    const resources = new ResourceVersions(paths.data)
    const view = await resources.view()
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: t('electron.ui.resource-recovery', '拓展恢复'),
      message: t('electron.ui.resource-recovery', '选择下次启动的恢复方式'),
      detail: t(
        'electron.ui.resource-recovery',
        '安全启动会暂停第三方拓展。回退会恢复各类资源最近一次修改前的备份，并保持恢复模式。业务数据库和对话不会被替换。',
      ),
      buttons: [
        t('electron.ui.resource-recovery', '安全启动'),
        t('electron.ui.resource-recovery', '回退最近资源'),
        t('electron.ui.resource-recovery', '打开备份目录'),
        t('electron.ui.resource-recovery', '取消'),
      ],
      cancelId: 3,
      defaultId: 0,
    })
    if (choice.response === 3) return
    if (choice.response === 2) {
      await shell.openPath(resources.root)
      return
    }
    await resources.setSafeMode(true)
    // 清除未执行的应用请求，避免恢复启动时先加载故障候选。
    for (const pending of view.pending) await resources.cancel(pending.id)
    if (choice.response === 1) {
      const latest = new Map<string, string>()
      for (const revision of [...view.revisions].sort((a, b) =>
        (a.appliedAt ?? a.createdAt).localeCompare(b.appliedAt ?? b.createdAt),
      ))
        if (revision.state === 'applied') latest.set(revision.kind, revision.id)
      for (const id of latest.values()) await resources.schedule(id, 'rollback')
    }
    await restartForResources()
  } catch (error) {
    dialog.showErrorBox(
      t('electron.ui.resource-recovery', '拓展恢复'),
      t('electron.ui.resource-recovery', '恢复操作未完成：{0}', [String(error)]),
    )
  } finally {
    showing = false
  }
}
