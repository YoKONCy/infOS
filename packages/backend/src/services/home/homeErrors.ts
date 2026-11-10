import { t } from '../../lib/i18n'
import '@infos/shared/i18n/catalogs/home'

export class HomeError extends Error {
  constructor(
    readonly code: string,
    readonly data?: unknown,
  ) {
    super(code)
  }
}
/** 错误详情里的路径或应用，拼进给模型的那句话。 */
const objectsOf = (data: unknown) => {
  const { paths, path, app } = (data ?? {}) as { paths?: unknown; path?: unknown; app?: unknown }
  const list =
    Array.isArray(paths) && paths.length
      ? paths.map(String)
      : path
        ? [String(path)]
        : app
          ? [String(app)]
          : []
  return list.length > 3 ? `${list.slice(0, 3).join(', ')}…` : list.join(', ')
}
/** 给模型的一句话：只说结果和下一步，不带确认细节；带操作标识，能区分重复调用。 */
const OUTCOMES: Record<string, string> = {
  HOME_DENIED: '用户拒绝了这次修改（{0}）。不要换路径或换工具重试，先问用户怎么办。操作号 {1}',
  HOME_CONFIRMATION_TIMEOUT:
    '没等到用户确认（{0}），文件没动。告诉用户这件事，等用户回应后再试。操作号 {1}',
  HOME_CANCELLED: '这次操作已停止（{0}），文件没动。操作号 {1}',
  HOME_CONFLICT: '文件在等确认时变了（{0}），没有覆盖。先重新读一下，再决定怎么改。操作号 {1}',
  HOME_NO_CONFIRM_SURFACE:
    '这次修改要用户确认（{0}），但现在没有能确认的地方，文件没动。告诉用户打开 infOS 后再试。操作号 {1}',
}
export function homeOutcomeMessage(code: string, data: unknown): string | undefined {
  const objects = objectsOf(data),
    template = OUTCOMES[code],
    operationId = (data as { operationId?: unknown } | undefined)?.operationId
  if (!template || !objects || typeof operationId !== 'string') return undefined
  return t('server.home', template, [objects, operationId])
}
export function homeMessage(code: string): string {
  const messages: Record<string, string> = {
    HOME_CONFIRMATION_REQUIRED: '需要用户确认后才能继续',
    HOME_DENIED: '用户已拒绝本次操作',
    HOME_PATH_INVALID: '路径无效或包含不安全的链接',
    HOME_CONFLICT: '文件已变化，不能覆盖，请先查看冲突',
    HOME_LIMIT: '存储空间、文件大小或数量已达到上限',
    HOME_NOT_FOUND: '记录或文件不存在',
    HOME_INVALID: '请求参数无效',
    HOME_UNAVAILABLE: '家的服务尚未就绪',
    HOME_EXPIRED: '确认或检查点已过期，请重新请求',
    HOME_PRIVATE: '不能记录密码或隐私内容',
    HOME_IO: '文件操作失败，已保留可用的恢复信息',
    HOME_CONFIRMATION_TIMEOUT: '没等到用户确认，文件没动',
    HOME_CANCELLED: '操作已停止，文件没动',
    HOME_NO_CONFIRM_SURFACE: '现在没有能确认的地方，文件没动',
    HOME_CREATE_RACE: '文件已变化，不能覆盖，请先查看冲突',
  }
  return t('server.home', messages[code] ?? '请求参数无效')
}
