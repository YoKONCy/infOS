import { t as __t } from '../i18n/index'
import type { CodeSearchNavigation } from '@infos/shared'
export interface ToolSearchRow {
  file: string
  kind: 'file' | 'directory'
  line?: number
  column?: number
  content?: string
}

export interface ToolSearchResult {
  rows: ToolSearchRow[]
  fileCount: number
  directoryCount: number
  matchCount?: number
  truncated: boolean
  previewTruncated: boolean
  auditOnly: boolean
  searchRoot?: string
  respectGitIgnore?: boolean
  navigation?: CodeSearchNavigation
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function paths(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))]
    : []
}

/** 兼容旧路径数组、文件搜索结果、正文匹配及只保留数量的历史审计。 */
export function parseToolSearchResult(raw?: string): ToolSearchResult | undefined {
  if (raw === undefined) return
  try {
    const value: unknown = JSON.parse(raw)
    const data: Record<string, unknown> = Array.isArray(value)
      ? { files: value }
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
    const base = {
      truncated: data.truncated === true,
      previewTruncated: data.previewTruncated === true,
      auditOnly: false,
      searchRoot: typeof data.searchRoot === 'string' ? data.searchRoot : undefined,
      respectGitIgnore:
        typeof data.respectGitIgnore === 'boolean' ? data.respectGitIgnore : undefined,
      navigation: navigation(data.navigation),
    }
    if (Array.isArray(data.files)) {
      const files = paths(data.files)
      const directories = paths(data.directories)
      return {
        ...base,
        rows: [
          ...files.map((file): ToolSearchRow => ({ file, kind: 'file' })),
          ...directories.map((file): ToolSearchRow => ({ file, kind: 'directory' })),
        ],
        fileCount: count(data.count) ?? files.length,
        directoryCount: count(data.directoryCount) ?? directories.length,
      }
    }
    if (Array.isArray(data.matches)) {
      const rows: ToolSearchRow[] = []
      for (const entry of data.matches) {
        if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') continue
        rows.push({
          file: entry.file,
          kind: 'file',
          line: count(entry.line),
          column: count(entry.column),
          content: typeof entry.content === 'string' ? entry.content : undefined,
        })
      }
      return {
        ...base,
        rows,
        fileCount: count(data.fileCount) ?? new Set(rows.map((row) => row.file)).size,
        directoryCount: 0,
        matchCount: count(data.total) ?? rows.length,
      }
    }
    if (
      data.kind === 'tool_result_audit' &&
      data.toolName === 'code_search' &&
      count(data.fileCount) !== undefined
    ) {
      return {
        ...base,
        rows: [],
        fileCount: count(data.fileCount)!,
        directoryCount: 0,
        matchCount: count(data.total),
        auditOnly: true,
      }
    }
  } catch {
    // 旧的截断文本无法可靠计数，保持未知，不能误报为零。
  }
}

function navigation(value: unknown): CodeSearchNavigation | undefined {
  if (!value || typeof value !== 'object') return
  const source = value as Record<string, unknown>
  if (
    typeof source.resultRef !== 'string' ||
    typeof source.agentId !== 'string' ||
    typeof source.threadId !== 'string'
  )
    return
  return {
    resultRef: source.resultRef,
    agentId: source.agentId,
    threadId: source.threadId,
    taskId: typeof source.taskId === 'string' ? source.taskId : undefined,
  }
}

export function toolSearchSummary(result: ToolSearchResult): string {
  const counts = [__t('ui.toolSearchResult', '{0} 个文件', [result.fileCount])]
  if (result.directoryCount)
    counts.push(__t('ui.toolSearchResult', '{0} 个目录', [result.directoryCount]))
  if (result.matchCount !== undefined)
    counts.push(__t('ui.toolSearchResult', '{0} 处匹配', [result.matchCount]))
  return __t('ui.toolSearchResult', '找到{0}{1}', [
    result.truncated ? __t('ui.toolSearchResult', '至少 ') : ' ',
    counts.join(' · '),
  ])
}
