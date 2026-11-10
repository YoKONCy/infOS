import { t as __t } from '../../i18n/index'
import { threadsApi } from '../../api/modules/threadsApi'
import { useNotificationStore } from '../../stores'

/** 发送前确认本会话能解析到模型；查询失败时不拦截，交给服务端判断。 */
async function hasUsableModel(threadId: string): Promise<boolean> {
  try {
    const response = await threadsApi.getModelSettings(threadId)
    return !response.data || Boolean(response.data.effective.modelId)
  } catch {
    return true
  }
}

/**
 * 没有可用模型时发出去只会让队列失败并暂停，什么也看不到；
 * 这里直接提示并返回 false，调用方把文字留在输入框。
 */
export async function ensureUsableModel(threadId: string): Promise<boolean> {
  if (await hasUsableModel(threadId)) return true
  useNotificationStore().toast(
    __t('ui.chat', '还没有可用的模型：请先在「模型」设置里指定主模型，或在输入框下方为本会话选择模型'),
    { type: 'warning' },
  )
  return false
}
