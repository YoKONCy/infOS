import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'

/** 随 NOT_FOUND 错误返回给前端的失效标记；前端据此把引用显示为失效。 */
export interface ReferenceNotFoundData {
  reason: 'reference_not_found'
  source: string
}

export function isReferenceNotFound(data: unknown): data is ReferenceNotFoundData {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { reason?: unknown }).reason === 'reference_not_found'
  )
}

/**
 * 工作区补全查找后仍找不到文件时，把“文件不存在”换成写明查找范围的错误。
 * 越界、歧义、占用等其他错误原样返回。
 */
export function referenceNotFound(source: string, error: unknown): unknown {
  if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') return error
  const data: ReferenceNotFoundData = { reason: 'reference_not_found', source }
  return new AppError('NOT_FOUND', {
    message: t(
      'server.resources',
      '找不到文件：{0}。已在当前工作区（含子目录）中查找，文件可能已被删除、改名或不在工作区内',
      [source],
    ),
    data,
    cause: error,
  })
}
