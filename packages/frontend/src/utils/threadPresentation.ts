import { t } from '../i18n'

/** 主会话使用固定类型标识，侧会话展示用户标题。 */
export function threadDisplayName(thread: { threadKind?: 'main' | 'side' | null; title?: string | null }): string {
  return thread.threadKind === 'main'
    ? t('ui.chat', '主会话')
    : thread.title || t('ui.navigation', '未命名会话')
}
