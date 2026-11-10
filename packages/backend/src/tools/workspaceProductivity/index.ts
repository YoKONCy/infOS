import { t as __t } from '../../lib/i18n'
import type { BuiltinTool } from '../index'
import { getProductivityRuntime, resolveExecutionSession } from '../productivityRuntimeHolder'
import { toolFailure, toolSuccess } from '../../services/execution/toolResult'
import { WorkspaceError } from '../../services/execution/virtualWorkspace'
import type { WorkspaceCheckpointService } from '../../services/workspace/workspaceCheckpointService'
import { createLogger } from '../../lib/logger'
import { buildToolDiff } from '../fileOps'
import {
  applyFileEdits,
  createReadReference,
  fileEditOwner,
} from '../../services/execution/fileEditing'
import { readToolObservation } from '../../services/execution/toolObservation'
import { codeSymbols, type CodeSymbol } from '../../services/execution/codeSymbols'
import {
  abandonLegacyHomeWrite,
  beginLegacyHomeWrite,
  finishLegacyHomeWrite,
  homeToolFailure,
  withLegacyHomeConfirmation,
} from '../home'
import { HomeError } from '../../services/home/homeErrors'

const logger = createLogger('WorkspaceProductivity')
let checkpointService: WorkspaceCheckpointService | null = null

/** 注入对话轮次文件检查点服务。 */
export function setWorkspaceProductivityCheckpointService(
  service: WorkspaceCheckpointService,
): void {
  checkpointService = service
}

export const readFileRangeTool: BuiltinTool = {
  name: 'read_file_range',
  async execute(args, ctx) {
    if (String(args.path).startsWith('tool-result:')) {
      return toolSuccess(
        JSON.stringify(
          readToolObservation(
            String(args.path),
            ctx,
            args.offset === undefined ? 0 : Number(args.offset),
            args.limit === undefined ? 16_000 : Number(args.limit),
          ),
        ),
      )
    }
    const session = await resolveExecutionSession(ctx)
    const workspace = getProductivityRuntime().virtualWorkspace
    const sourceRef = await workspace.resolveReadablePath(
      session,
      String(args.path),
      ctx.deviceReadScope,
    )
    if (args.outline === true || args.symbol !== undefined) {
      if (
        ['line_start', 'line_end', 'offset', 'limit', 'tail_lines'].some(
          (key) => args[key] !== undefined,
        )
      )
        return toolFailure('READ_MODE_CONFLICT', '符号/大纲模式不能与行、字符范围参数混用')
      const full = await workspace.read(session, String(args.path), {
        deviceScope: ctx.deviceReadScope,
        limit: 128_000,
      })
      const sourceFallback = (reason: string, declaration?: CodeSymbol) => {
        ctx.signal?.throwIfAborted()
        // 复用刚读取的同一版本，字符引用只覆盖实际返回的源码，不把声明候选当作完整函数体。
        const anchor = declaration?.start ?? 0
        let offset = anchor
        if (offset > 0) {
          offset = full.content.lastIndexOf('\n', offset - 1) + 1
          for (let count = 0; count < 3 && offset > 0; count++)
            offset = full.content.lastIndexOf('\n', offset - 2) + 1
          // 前置超长行不能把声明挤出有限的读取窗口。
          offset = Math.max(offset, anchor - 2_000)
          if (offset > 0 && /[\uDC00-\uDFFF]/.test(full.content[offset]!)) offset--
        }
        let end = Math.min(full.content.length, offset + 16_000)
        if (end < full.content.length) {
          const lineEnd = full.content.lastIndexOf('\n', end - 1)
          if (lineEnd >= Math.max(offset, anchor)) end = lineEnd + 1
          else if (/[\uD800-\uDBFF]/.test(full.content[end - 1]!)) end--
          else if (full.content[end - 1] === '\r' && full.content[end] === '\n') end--
        }
        const content = full.content.slice(offset, end)
        const lineStart = full.content.slice(0, offset).split('\n').length
        const lineEnd =
          lineStart + (content.match(/\n/g)?.length ?? 0) - (content.endsWith('\n') ? 1 : 0)
        const result = {
          ...full,
          content,
          offset,
          lineStart,
          lineEnd: Math.max(lineStart, lineEnd),
          truncated: full.truncated || offset > 0 || end < full.content.length,
          nextOffset: full.truncated || end < full.content.length ? end : undefined,
        }
        const readRef = createReadReference(
          fileEditOwner(session, ctx.realmId),
          sourceRef,
          { hash: full.hash, content },
          offset,
        )
        const symbolFallback = {
          reason,
          requestedSymbol: args.symbol,
          declaration,
          notice:
            '已自动返回普通源码窗口；read_ref 仅覆盖本次可见内容，不代表完整符号。可用 nextOffset 续读，再按读取引用或版本化行范围编辑。',
        }
        return toolSuccess(
          JSON.stringify({ ...result, sourceRef, read_ref: readRef, symbolFallback }),
          {
            sourceRef,
            hash: full.hash,
            lineStart,
            lineEnd: result.lineEnd,
            truncated: result.truncated,
            readRef,
            symbolFallback,
          },
        )
      }
      ctx.signal?.throwIfAborted()
      if (full.truncated) return sourceFallback('文件超过符号解析预算')
      let symbols: CodeSymbol[]
      try {
        symbols = await codeSymbols(sourceRef, full.content, ctx.signal)
      } catch (error) {
        ctx.signal?.throwIfAborted()
        return sourceFallback(error instanceof Error ? error.message : '符号解析不可用')
      }
      if (!symbols.length) return sourceFallback('未识别到可用的符号声明')
      if (args.symbol === undefined)
        return toolSuccess(
          JSON.stringify({
            sourceRef,
            hash: full.hash,
            symbols,
            ...(symbols.some((symbol) => symbol.locationOnly)
              ? {
                  notice:
                    '轻量大纲仅提供声明位置；读取 symbol 时自动返回附近源码，不提供推测的函数体替换范围。',
                }
              : {}),
          }),
        )
      const matches = symbols.filter((symbol) => symbol.name === args.symbol)
      const picked = args.symbol_pick === undefined ? undefined : Number(args.symbol_pick)
      if (!matches.length) return sourceFallback('未找到请求的符号名称')
      if (matches.length > 1 && picked === undefined)
        return toolSuccess(
          JSON.stringify({
            needsSelection: true,
            notice: '符号名称存在歧义，请用 symbol_pick 选择后重新读取',
            candidates: matches.map((symbol, index) => ({ ...symbol, pick: index + 1 })),
          }),
        )
      if (
        picked !== undefined &&
        (!Number.isSafeInteger(picked) || picked < 1 || picked > matches.length)
      )
        return toolFailure('SYMBOL_PICK_INVALID', 'symbol_pick 不在候选范围内')
      const symbol = matches[(picked ?? 1) - 1]!
      if (symbol.locationOnly)
        return sourceFallback('轻量扫描只确定声明位置，已返回附近源码', symbol)
      const verify = await workspace.read(session, String(args.path), {
        deviceScope: ctx.deviceReadScope,
        limit: 1,
      })
      if (verify.hash !== full.hash)
        return toolFailure('SYMBOL_VERSION_CHANGED', '解析期间文件发生变化，请重新读取')
      const result = {
        hash: full.hash,
        content: full.content.slice(symbol.start, symbol.end),
        lineStart: symbol.lineStart,
        lineEnd: symbol.lineEnd,
      }
      const readRef = createReadReference(
        fileEditOwner(session, ctx.realmId),
        sourceRef,
        { hash: result.hash, content: result.content },
        symbol.start,
      )
      return toolSuccess(JSON.stringify({ ...result, sourceRef, symbol, read_ref: readRef }), {
        sourceRef,
        hash: result.hash,
        lineStart: result.lineStart,
        lineEnd: result.lineEnd,
        readRef,
      })
    }
    const result = await workspace.read(session, String(args.path), {
      deviceScope: ctx.deviceReadScope,
      offset: args.offset === undefined ? undefined : Number(args.offset),
      limit: args.limit === undefined ? undefined : Number(args.limit),
      lineStart: args.line_start === undefined ? undefined : Number(args.line_start),
      lineEnd: args.line_end === undefined ? undefined : Number(args.line_end),
      tailLines: args.tail_lines === undefined ? undefined : Number(args.tail_lines),
    })
    const readRef = createReadReference(
      fileEditOwner(session, ctx.realmId),
      sourceRef,
      result,
      Number(args.offset ?? 0),
    )
    return toolSuccess(JSON.stringify({ ...result, read_ref: readRef }), {
      hash: result.hash,
      sourceRef,
      truncated: result.truncated,
      lineStart: result.lineStart,
      lineEnd: result.lineEnd,
      readRef,
    })
  },
}

export const globFilesTool: BuiltinTool = {
  name: 'glob_files',
  async execute(args, ctx) {
    const session = await resolveExecutionSession(ctx)
    const files = await getProductivityRuntime().virtualWorkspace.glob(session, {
      pattern: String(args.pattern),
      deviceScope: ctx.deviceReadScope,
      cwd: args.cwd ? String(args.cwd) : undefined,
      maxDepth: args.max_depth === undefined ? undefined : Number(args.max_depth),
      limit: args.limit === undefined ? undefined : Number(args.limit),
      includeHidden: Boolean(args.include_hidden),
    })
    return toolSuccess(JSON.stringify({ files, count: files.length }))
  },
}

export const editFileTool: BuiltinTool = {
  name: 'edit_file',
  async execute(args, ctx) {
    const session = await resolveExecutionSession(ctx)
    try {
      let operationId: string | undefined
      // 整段放进去：要确认时锁已释放才开始等，批准后重新读文件、重新算一遍。
      const result = await withLegacyHomeConfirmation(ctx, async () => {
        let pending: import('@infos/shared').HomeCheckpoint | undefined
        try {
          return await applyFileEdits(
            getProductivityRuntime().virtualWorkspace,
            session,
            args,
            {
              owner: fileEditOwner(session, ctx.realmId),
              approved: ctx.approvedOutsideWorkspace,
              signal: ctx.signal,
              afterWrite: async (captured, written) => {
                const value = captured as {
                  homeCheckpoint?: import('@infos/shared').HomeCheckpoint
                  legacyCheckpoint: Awaited<ReturnType<WorkspaceCheckpointService['captureBefore']>>
                }
                pending = undefined
                finishLegacyHomeWrite(ctx, value.homeCheckpoint)
                await checkpointService?.commitFromDisk(value.legacyCheckpoint, written)
              },
            },
            async (filePath, next) => {
              const homeCheckpoint = await beginLegacyHomeWrite(ctx, filePath, next)
              pending = homeCheckpoint
              operationId = homeCheckpoint?.id
              const legacyCheckpoint = ctx.approvedOutsideWorkspace
                ? null
                : await checkpointService?.captureToolMutation(ctx, filePath)
              return { homeCheckpoint, legacyCheckpoint }
            },
          )
        } catch (error) {
          abandonLegacyHomeWrite(ctx, pending)
          throw error
        }
      })
      if (!result.success) return toolSuccess(JSON.stringify(result), { needsSelection: true })
      const { beforeText, afterText, ...receipt } = result
      const preview = buildToolDiff(beforeText, afterText)
      const output = {
        ...receipt,
        ...(operationId ? { operationId } : {}),
        diffPreview: preview.diffPreview,
        diffTruncated: preview.diffTruncated,
      }
      return toolSuccess(JSON.stringify(output), receipt)
    } catch (err) {
      if (err instanceof HomeError) return homeToolFailure(err)
      if (ctx.signal?.aborted) return homeToolFailure(new HomeError('HOME_CANCELLED'))
      // 失败原因：既打印到后端日志，也结构化返回给 Agent 供其自我修正
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        __t('logs.tools', '编辑文件失败 [{0}/{1}] {2}: {3}', [
          ctx.agentId,
          ctx.threadId,
          String(args.path),
          message,
        ]),
      )
      if (err instanceof WorkspaceError) {
        return toolFailure(err.code, message)
      }
      return toolFailure('EDIT_UNKNOWN', `编辑失败: ${message}`)
    }
  },
}
