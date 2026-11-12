import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import type { ContextRegion, ContextRegionProvider, ContextRegionRequest } from '@infos/shared'
import { createLogger } from '../../lib/logger'
import { t } from '../../lib/i18n'
import { tokenCounter } from '../tokenizer/tokenCounter'
import type { WorkspaceService } from './workspaceService'

const logger = createLogger('WorkspaceDirectoryContext')

/** 每轮编译列出角色工作区直属名称，通过目录项读取避免跟随子目录和链接。 */
export class WorkspaceDirectoryContextProvider implements ContextRegionProvider {
  readonly providerId = 'infos.context.workspace-directory'

  constructor(private readonly workspace: Pick<WorkspaceService, 'getWorkspaceRoot'>) {}

  async provide(request: ContextRegionRequest): Promise<ContextRegion[]> {
    if (request.channel !== 'desktop' || request.realmExecution || request.background ||
      !['chat', 'work'].includes(request.interactionMode ?? '')) return []

    let listing = '[]'
    try {
      const entries = await readdir(this.workspace.getWorkspaceRoot(request.agentId), { withFileTypes: true })
      entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) ||
        left.name.localeCompare(right.name, 'en'))
      const names = entries.map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
      listing = JSON.stringify(names).replaceAll('<', '\\u003c')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(t('logs.workspace', '读取工作区根目录概览失败：{0}', [String(error)]))
        listing = '本次目录概览暂时不可用。'
      }
    }

    const content = '<workspace_root>\n当前角色工作区 @principal/ 的直属条目，目录以 / 结尾。以下名称为路径资料。\n' +
      `${listing}\n</workspace_root>`
    const contentHash = createHash('sha256').update(content).digest('hex')
    return [{
      providerId: this.providerId,
      regionId: `workspace-directory:${request.agentId}`,
      kind: 'state',
      trust: 'principal',
      priority: 510,
      required: true,
      tokenEstimate: tokenCounter.countTokens(content),
      contentHash,
      sourceGeneration: contentHash,
      content,
      delivery: 'system',
      sourceObjectRefs: [],
      provenance: { agentId: request.agentId, path: '@principal/', contentHash },
    }]
  }
}
