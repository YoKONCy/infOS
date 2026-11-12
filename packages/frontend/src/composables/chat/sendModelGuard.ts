import { t as __t } from '../../i18n/index'
import { threadsApi } from '../../api/modules/threadsApi'
import { useNotificationStore } from '../../stores'

/** 会话模型可用性内存缓存：避免每次点击发送都串行阻塞一趟 HTTP 请求。 */
const usableModelCache = new Map<string, boolean>()

if (typeof window !== 'undefined') {
  window.addEventListener('infos:model-capabilities-changed', () => {
    usableModelCache.clear()
  })
}

export function cacheThreadUsableModel(threadId: string, usable: boolean): void {
  if (!threadId) return
  usableModelCache.set(threadId, usable)
  if (usableModelCache.size > 64) {
    const oldest = usableModelCache.keys().next().value
    if (oldest !== undefined) usableModelCache.delete(oldest)
  }
}

export function invalidateUsableModelCache(threadId?: string): void {
  if (threadId) usableModelCache.delete(threadId)
  else usableModelCache.clear()
}

/** 发送前确认本会话能解析到模型；已缓存结果直接同步返回，查询失败时不拦截，交给服务端判断。 */
async function hasUsableModel(threadId: string): Promise<boolean> {
  const cached = usableModelCache.get(threadId)
  if (cached !== undefined) return cached
  try {
    const response = await threadsApi.getModelSettings(threadId)
    const usable = !response.data || Boolean(response.data.effective.modelId)
    if (response.data) cacheThreadUsableModel(threadId, usable)
    return usable
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
