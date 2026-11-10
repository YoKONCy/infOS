import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ContextRegion, ContextRegionProvider, ContextRegionRequest } from '@infos/shared'
import type { WorkspaceService } from '../workspace/workspaceService'
import { tokenCounter } from '../tokenizer/tokenCounter'
import { resolveSafetyFilePaths } from '../execution/safetyPath'
import { createLogger } from '../../lib/logger'
import { t } from '../../lib/i18n'

const logger = createLogger('Notebook')

export const NOTEBOOK_MAIN_FILE = 'notes/MEMORY.md'
export const NOTEBOOK_FILE_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'get_file_info', 'list_directory',
])

/** 受限模式只操作个人工作区 notes 下的直接 Markdown 文件，目录入口供列举使用。 */
export async function isNotebookPath(root: string, requested: unknown, directory = false): Promise<boolean> {
  if (typeof requested !== 'string' || !requested.trim()) return false
  const input = requested.startsWith('@principal/') ? requested.slice('@principal/'.length) : requested
  const target = path.resolve(root, input)
  const notes = path.resolve(root, 'notes')
  const relative = path.relative(notes, target)
  const expectedLocation = directory
    ? relative === ''
    : Boolean(relative) && path.dirname(relative) === '.' && path.extname(relative).toLowerCase() === '.md'
  if (!expectedLocation) return false
  const [base, file] = await Promise.all([resolveSafetyFilePaths(root), resolveSafetyFilePaths(target)])
  if (base.unresolved || file.unresolved) return false
  const realNotes = path.join(base.paths.at(-1)!, 'notes')
  const realTarget = file.paths.at(-1)!
  return directory
    ? realTarget === realNotes
    : path.dirname(realTarget) === realNotes && path.extname(realTarget).toLowerCase() === '.md'
}

/** 每次编译固定主文件内容，附页沿正常文件工具按需读取。 */
export class NotebookContextProvider implements ContextRegionProvider {
  readonly providerId = 'infos.context.notebook'

  constructor(private readonly workspace: WorkspaceService) {}

  async provide(request: ContextRegionRequest): Promise<ContextRegion[]> {
    if (request.realmExecution || request.background || !['desktop', 'group'].includes(request.channel))
      return []
    const root = this.workspace.getWorkspaceRoot(request.agentId)
    let body = ''
    try {
      if (await isNotebookPath(root, NOTEBOOK_MAIN_FILE)) {
        const info = await this.workspace.stat(request.agentId, NOTEBOOK_MAIN_FILE, 'group')
        if (info.isFile)
          body = await this.workspace.read(request.agentId, NOTEBOOK_MAIN_FILE, 'group', { maxLength: 16_000 })
      }
    } catch (error) {
      logger.warn(t('logs.memory', '读取角色记事本失败，已使用位置提示：{0}', [String(error)]))
    }
    const guidance = request.interactionMode === 'minimal'
      ? '【个人记事本】以下为工作区 notes/MEMORY.md 中已保存的要点，作为本次交流的参考。'
      : '【个人记事本】工作区 notes/MEMORY.md 保存简短要点及附页索引，其他 Markdown 附页与它同级。使用文件工具记录和整理非事件要点，附页按需读取。据点模式的文件工具仅开放此目录及直接 Markdown 文件。事件记忆由后台整理，主动查询使用 query_event_notes。共享事实由主会话按权限修改。'
    const emptyContent = request.interactionMode === 'minimal' ? '主文件为空。' : '主文件为空，可在需要记录时创建。'
    const content = `${guidance}\n\n${body || emptyContent}`
    const contentHash = createHash('sha256').update(content).digest('hex')
    return [{
      providerId: this.providerId,
      regionId: `notebook:${request.agentId}`,
      kind: 'memory',
      trust: 'principal',
      priority: 320,
      required: false,
      tokenEstimate: tokenCounter.countTokens(content),
      contentHash,
      content,
      fallbackContent: guidance,
      delivery: 'system',
      sourceObjectRefs: [],
      sourceGeneration: contentHash,
      provenance: { agentId: request.agentId, path: NOTEBOOK_MAIN_FILE, contentHash },
    }]
  }
}
