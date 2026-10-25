import { ResourceVersions } from '@infos/shared/resource-versions'
import { getDataDir } from './lib/env'
import { t } from './lib/i18n'

/** 独立于数据库、HTTP 和插件运行时的发行版恢复命令。 */
const resources = new ResourceVersions(getDataDir())
try {
  const [command = '--list', id] = process.argv.slice(2)
  if (command === '--safe') await resources.setSafeMode(true)
  else if (command === '--resume') await resources.setSafeMode(false)
  else if (command === '--rollback' && id) await resources.schedule(id, 'rollback')
  else if (command === '--cancel' && id) await resources.cancel(id)
  else if (command !== '--list') throw new Error('RESOURCE_COMMAND_INVALID')
  console.log(JSON.stringify(await resources.view(), null, 2))
} catch (error) {
  console.error(t('server.resource-versions', '资源恢复操作失败：{0}', [String(error)]))
  process.exitCode = 1
}
