import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'
import { AutomaticRagStageError } from '../services/memory/eventMemoryService'
import { MemoryForgottenError } from '../services/maintenance/privacyPolicy'

export function throwArchiveRestoreError(error: unknown): never {
  const code = error instanceof Error ? error.message : ''
  if (code === 'ARCHIVE_RESTORE_NOT_FOUND' || error instanceof MemoryForgottenError)
    throw new AppError('NOT_FOUND', {
      message: t('server.archive-edit', '条目不存在或已永久删除，无法还原。'),
    })
  if (code === 'ARCHIVE_RESTORE_CONFLICT')
    throw new AppError('CONFLICT', {
      message: t('server.archive-edit', '条目已被新版本替代或状态已变化，请刷新后重试。'),
    })
  throw error
}

/** 内部冲突与模型异常在接口边界翻译，原样保留用户尚未保存的正文。 */
export function throwArchiveEditError(error: unknown): never {
  const code = error instanceof Error ? error.message : ''
  if (code === 'ARCHIVE_EDIT_CONFLICT')
    throw new AppError('CONFLICT', {
      message: t('server.archive-edit', '条目已被修改、撤回或删除，请重新加载后再编辑。'),
    })
  if (code === 'ARCHIVE_EDIT_NOT_READY')
    throw new AppError('EMBEDDING_ERROR', {
      message: t('server.archive-edit', '原向量暂不可用，请重新加载或选择重新生成向量。'),
    })
  if (code === 'ARCHIVE_EDIT_PENDING')
    throw new AppError('RESOURCE_BUSY', {
      message: t('server.archive-edit', '条目的索引尚未完成，请稍后刷新后重试。'),
    })
  if (code === 'ARCHIVE_EDIT_EMBEDDING_UNAVAILABLE')
    throw new AppError('EMBEDDING_ERROR', {
      message: t('server.archive-edit', '向量模型未配置或不可用，可取消重新生成向量后保存。'),
    })
  if (error instanceof AutomaticRagStageError)
    throw new AppError('EMBEDDING_ERROR', {
      message: t(
        'server.archive-edit',
        '生成向量失败，本次修改尚未保存。可取消重新生成向量后重试。',
      ),
      cause: error,
    })
  throw new AppError('INTERNAL_ERROR', {
    message: t('server.archive-edit', '保存未完成，请保留编辑内容并重试。'),
    cause: error,
  })
}
