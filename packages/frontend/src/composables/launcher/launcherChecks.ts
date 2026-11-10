import { t } from '../../i18n'
import { systemApi } from '../../api/modules/systemApi'
import { configApi } from '../../api/modules/configApi'
import { modelApi } from '../../api/modules/modelApi'
import { memoryApi } from '../../api/modules/memoryApi'
import { agentApi } from '../../api/modules/agentApi'

export interface CheckItem {
  id: string
  label: string
  status: 'pending' | 'running' | 'ok' | 'warn' | 'error'
  reason?: 'model-missing' | 'model-check-failed'
  message?: string
}

/** 未配置与无法检查分开提示；两种情况都只警告，不拦住进入应用。 */
async function checkModel(item: CheckItem): Promise<void> {
  try {
    const models = (await modelApi.list()).data ?? []
    item.status = models.length ? 'ok' : 'warn'
    item.reason = models.length ? undefined : 'model-missing'
    item.message = models.length
      ? t('ui.launcher', '{0} 个模型', [models.length])
      : t('ui.launcher', '未配置模型')
  } catch {
    item.status = 'warn'
    item.reason = 'model-check-failed'
    item.message = t('ui.launcher', '模型检查未完成')
  }
}

export async function runLauncherCheck(item: CheckItem): Promise<void> {
  item.reason = undefined
  if (item.id === 'model') return checkModel(item)
  try {
    switch (item.id) {
      case 'backend':
        await systemApi.health()
        break
      case 'database':
        await configApi.batch(['system.initialized'])
        break
      case 'memory':
        await memoryApi.archive({ pageSize: 1 })
        break
      case 'extension': {
        const agents = (await agentApi.list()).data ?? []
        item.status = 'ok'
        item.message = agents.length
          ? t('ui.launcher', '{0} 个 Agent', [agents.length])
          : t('ui.launcher', '待初始化')
        return
      }
    }
    item.status = 'ok'
    item.message = t('ui.launcher', '正常')
  } catch {
    item.status = ['backend', 'database'].includes(item.id)
      ? 'error'
      : item.id === 'memory'
        ? 'warn'
        : 'ok'
    item.message = t(
      'ui.launcher',
      item.id === 'backend'
        ? '无法连接后端服务'
        : item.id === 'database'
          ? '数据库连接失败'
          : item.id === 'memory'
            ? '记忆系统未就绪'
            : '待初始化',
    )
  }
}

/** 仅将固定状态文案放入检测卡片；异常文本仍留在诊断面板。 */
export function launcherCheckLabel(item: CheckItem): string {
  if (item.status === 'warn' && item.reason === 'model-missing')
    return t('ui.launcher', '未配置模型')
  if (item.status === 'warn' && item.reason === 'model-check-failed')
    return t('ui.launcher', '模型检查未完成')
  return t(
    'ui.launcher',
    { pending: '等待检测', running: '检测中', ok: '已通过', warn: '待确认', error: '未就绪' }[
      item.status
    ],
  )
}
