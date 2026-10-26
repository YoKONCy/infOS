import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { MessageResource, ResourceOrigin, SocialResourcePort } from '@infos/shared'
import type { AttachmentService } from './attachmentService'
import type { ThreadService } from '../thread/threadService'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'
import { resolveWorkspaceReference } from '../workspace/workspaceReference'
import {
  getProductivityRuntime,
  resolveExecutionSession,
} from '../../tools/productivityRuntimeHolder'
import {
  boundedResourceBytes,
  downloadResource,
  MAX_RESOURCE_BYTES,
  inspectResource,
  resourceKind,
  resourceMime,
  resourceName,
} from './resourceSource'

export interface ResourceContext {
  agentId: string
  threadId: string
  taskId?: string
  pairId?: string
  toolCallId?: string
  signal?: AbortSignal
  deviceReadScope?: boolean
  /** 用户点击引用才允许有限补全；文件交付始终使用精确路径。 */
  lookupWorkspace?: boolean
}

const MAX_IMAGE_READ_BYTES = 20 * 1024 * 1024

export class ResourceService {
  private preparing = 0
  /** 仅由受信任应用集成层导入已完成资源，不开放任意本地路径。 */
  async importApplicationOutput(
    context: ResourceContext,
    input: {
      appId: string
      runId: string
      assetId: string
      bytes: Buffer
      name: string
      mimeType: string
    },
  ) {
    await this.scope(context)
    if (input.bytes.length > MAX_RESOURCE_BYTES) throw new Error('应用资源超过大小限制')
    const callId = `application:${input.appId}:${input.runId}:${input.assetId}`
    const existing = await this.attachments.outgoingCall(context.threadId, callId)
    const row =
      existing ??
      (await this.attachments.saveOutgoing({
        ...context,
        callId,
        bytes: input.bytes,
        name: input.name,
        mimeType: input.mimeType,
        kind: resourceKind(
          input.mimeType,
        ) as import('../../repositories/attachment.repo').AttachmentKind,
        origin: {
          type: 'application',
          value: `${input.appId}/${input.runId}/${input.assetId}`,
          agentId: context.agentId,
          threadId: context.threadId,
          taskId: input.runId,
        },
      }))
    return this.describe(row)
  }
  constructor(
    private attachments: AttachmentService,
    private threads: ThreadService,
  ) {}

  private async scope(context: ResourceContext) {
    if (context.taskId && !/^[\w-]{1,128}$/.test(context.taskId))
      throw new AppError('BAD_REQUEST', { message: t('server.resources', '任务资源引用无效') })
    const thread = await this.threads.getThread(context.threadId)
    if (!thread || thread.agentId !== context.agentId)
      throw new AppError('FORBIDDEN', { message: t('server.resources', '资源会话与角色不匹配') })
    return resolveExecutionSession({ ...context, channel: thread.channel })
  }

  private async localFile(context: ResourceContext, input: string, fallback = false) {
    const session = await this.scope(context)
    const { filePath, info, relative } = await resolveWorkspaceReference(
      getProductivityRuntime().virtualWorkspace,
      session,
      input,
      { fallback, signal: context.signal },
    )
    return {
      filePath,
      info,
      origin: {
        type: 'workspace',
        value: relative.replaceAll('\\', '/'),
        agentId: context.agentId,
        threadId: context.threadId,
        taskId: context.taskId,
      } satisfies ResourceOrigin,
    }
  }

  private async existing(id: string, context: ResourceContext) {
    const row = await this.attachments.getActive(id)
    const thread = await this.threads.getThread(row.threadId)
    if (!thread || thread.agentId !== context.agentId) throw new Error('附件不属于当前角色')
    return row
  }

  private describe(
    row: Awaited<ReturnType<AttachmentService['getActive']>>,
  ): MessageResource & { id: string } {
    const dto = this.attachments.toDto(row)
    return {
      id: row.id,
      kind: row.kind,
      name: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      caption: dto.caption,
      origin: dto.origin,
    }
  }

  async prepare(context: ResourceContext, source: string, caption?: string, allowLocal = true) {
    if (this.preparing >= 4) throw new Error('正在处理的资源较多，请稍后重试')
    this.preparing++
    try {
      return await this.prepareResource(context, source, caption, allowLocal)
    } finally {
      this.preparing--
    }
  }

  private async prepareResource(
    context: ResourceContext,
    source: string,
    caption?: string,
    allowLocal = true,
  ) {
    context.signal?.throwIfAborted()
    await this.scope(context)
    const fingerprint = createHash('sha256')
      .update(`${source}\n${caption || ''}`)
      .digest('hex')
      .slice(0, 16)
    const callId = `${context.pairId || ''}:${context.toolCallId || randomUUID()}:${fingerprint}`
    const existing = await this.attachments.outgoingCall(context.threadId, callId)
    if (existing) {
      await this.existing(existing.id, context)
      return {
        resource: this.describe(existing),
        filePath: this.attachments.resolveStoragePath(existing.storageKey),
      }
    }
    const value = source.replace(/^resource:/i, '').trim()
    let bytes: Buffer
    let name: string
    let mimeType: string
    let origin: ResourceOrigin | undefined
    if (/^https?:\/\//i.test(value)) {
      const downloaded = await downloadResource(value, context.signal)
      ;({ bytes, name, mimeType } = downloaded)
      origin = { type: 'url', value }
    } else if (value.startsWith('attachment:')) {
      const row = await this.existing(value.slice(11), context)
      if (!allowLocal && row.threadId !== context.threadId)
        throw new Error('当前会话不能读取其他会话的附件')
      ;({ bytes } = await this.attachments.readContent(row.id))
      name = row.originalName
      mimeType = row.mimeType
      origin = this.attachments.toDto(row).origin
    } else {
      if (!allowLocal) throw new Error('工作区文件仅能发送给已绑定主人的私聊')
      let fileSource = value.replace(/^workspace:/i, '')
      if (/^workspace:/i.test(value)) {
        try {
          fileSource = decodeURIComponent(fileSource)
        } catch {
          /* 保留普通文件名。 */
        }
      }
      const local = await this.localFile(context, fileSource)
      if (local.info.size > MAX_RESOURCE_BYTES) throw new Error('文件超过 100 MB 限制')
      bytes = await boundedResourceBytes(createReadStream(local.filePath), context.signal)
      name = resourceName(local.filePath)
      mimeType = resourceMime(name, '', bytes)
      origin = local.origin
    }
    context.signal?.throwIfAborted()
    if (bytes.length > MAX_RESOURCE_BYTES) throw new Error('文件超过 100 MB 限制')
    const row = await this.attachments.saveOutgoing({
      ...context,
      callId,
      bytes,
      name,
      mimeType,
      kind: resourceKind(mimeType) as import('../../repositories/attachment.repo').AttachmentKind,
      caption: caption?.trim().slice(0, 300) || undefined,
      origin,
    })
    return {
      resource: this.describe(row),
      filePath: this.attachments.resolveStoragePath(row.storageKey),
    }
  }

  async resolveReference(context: ResourceContext, source: string): Promise<MessageResource> {
    await this.scope(context)
    const value = source.replace(/^resource:/i, '').trim()
    if (value.startsWith('attachment:'))
      return this.describe(await this.existing(value.slice(11), context))
    if (value.startsWith('arca:')) {
      const id = decodeURIComponent(value.slice(5))
      if (!/^[\w:-]{1,200}$/.test(id)) throw new Error('文档引用无效')
      return {
        kind: 'file',
        name: '文档',
        mimeType: 'application/x-arca',
        sizeBytes: 0,
        origin: { type: 'arca', value: id },
      }
    }
    if (/^https?:\/\//i.test(value)) {
      const { name, mimeType, sizeBytes } = await inspectResource(value, context.signal)
      const kind = resourceKind(mimeType)
      return {
        kind: ['text/html', 'application/xhtml+xml'].includes(mimeType) ? 'web' : kind,
        name,
        mimeType,
        sizeBytes,
        origin: { type: 'url', value },
      }
    }
    const match = value.match(/#L(\d+)(?:-L?\d+)?$/i)
    let target = match ? value.slice(0, match.index) : value
    try {
      if (/^file:/i.test(target)) target = fileURLToPath(target)
      else if (/^workspace:/i.test(target)) target = decodeURIComponent(target.slice(10))
    } catch (error) {
      throw new AppError('BAD_REQUEST', {
        message: t('server.resources', '请提供当前服务器上的有效文件路径'),
        cause: error,
      })
    }
    const local = await this.localFile(context, target, context.lookupWorkspace === true)
    const name = resourceName(local.filePath)
    const mimeType = resourceMime(name)
    return {
      kind: resourceKind(mimeType),
      name,
      mimeType,
      sizeBytes: local.info.size,
      origin: {
        ...local.origin,
        line: match ? Math.min(1_000_000, Math.max(1, Number(match[1]))) : undefined,
      },
    }
  }

  async referenceFile(context: ResourceContext, source: string) {
    const resource = await this.resolveReference(context, source)
    if (resource.origin?.type !== 'workspace') throw new Error('引用不是工作区文件')
    return { resource, filePath: (await this.localFile(context, resource.origin.value)).filePath }
  }

  /** 文档只读取受控工作区或当前会话附件，不接受服务端任意路径与远程 URL。 */
  async readDocumentSource(context: ResourceContext, source: string, maxBytes: number) {
    context.signal?.throwIfAborted()
    const session = await this.scope(context)
    let filePath: string
    let name: string
    let mimeType: string
    if (source.startsWith('attachment:')) {
      const row = await this.existing(source.slice(11), context)
      if (row.threadId !== context.threadId) throw new Error('文档附件不属于当前会话')
      filePath = this.attachments.resolveStoragePath(row.storageKey)
      name = row.originalName
      mimeType = row.mimeType
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source))
        throw new Error('文档 source 请使用工作区路径或 attachment:附件ID')
      filePath = await getProductivityRuntime().virtualWorkspace.resolveReadablePath(
        session,
        source,
      )
      const root = await realpath(session.workspaceRoot)
      const actual = await realpath(filePath)
      const relative = path.relative(root, actual)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('文档 source 必须位于当前工作区内')
      name = path.basename(filePath)
      mimeType = resourceMime(name)
    }
    const info = await stat(filePath)
    if (!info.isFile() || info.size > maxBytes)
      throw new Error(`文档必须是 ${maxBytes / 1024 / 1024}MB 以内的普通文件`)
    const bytes = await boundedResourceBytes(createReadStream(filePath), context.signal, maxBytes)
    if (source.startsWith('attachment:')) await this.existing(source.slice(11), context)
    return { name, mimeType, bytes }
  }

  /** 按需读取原图；不创建发送记录，也不复制附件。 */
  async readImage(context: ResourceContext, source: string) {
    context.signal?.throwIfAborted()
    const session = await this.scope(context)
    const value = source.replace(/^resource:/i, '').trim()
    let bytes: Buffer
    let name: string
    let sourceRef: string
    if (/^https?:\/\//i.test(value)) {
      const downloaded = await downloadResource(value, context.signal, MAX_IMAGE_READ_BYTES)
      ;({ bytes, name } = downloaded)
      sourceRef = downloaded.url
    } else if (value.startsWith('attachment:')) {
      const row = await this.existing(value.slice(11), context)
      if (
        row.threadId !== context.threadId &&
        (session.channel !== 'desktop' || row.status !== 'bound')
      )
        throw new Error('当前会话不能读取该附件')
      if (row.kind !== 'image') throw new Error('附件不是图片')
      if (row.sizeBytes > MAX_IMAGE_READ_BYTES) throw new Error('图片超过 20 MB 限制')
      bytes = await boundedResourceBytes(
        createReadStream(this.attachments.resolveStoragePath(row.storageKey)),
        context.signal,
        MAX_IMAGE_READ_BYTES,
      )
      // 读取结束时再次检查撤回状态，避免把已删除的附件送入模型。
      await this.existing(row.id, context)
      name = row.originalName
      sourceRef = `attachment:${row.id}`
    } else {
      let filePath = value.replace(/^workspace:/i, '')
      if (/^workspace:/i.test(value)) {
        try {
          filePath = decodeURIComponent(filePath)
        } catch {
          /* 保留普通文件名。 */
        }
      }
      sourceRef = await getProductivityRuntime().virtualWorkspace.resolveReadablePath(
        session,
        filePath,
        context.deviceReadScope,
      )
      const info = await stat(sourceRef)
      if (!info.isFile()) throw new Error('目标不是图片文件')
      if (info.size > MAX_IMAGE_READ_BYTES) throw new Error('图片超过 20 MB 限制')
      bytes = await boundedResourceBytes(
        createReadStream(sourceRef),
        context.signal,
        MAX_IMAGE_READ_BYTES,
      )
      name = resourceName(sourceRef)
    }
    context.signal?.throwIfAborted()
    // 只根据文件签名识别，不信任扩展名和网络声明的 MIME。
    const mimeType = resourceMime('', '', bytes)
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType))
      throw new Error('仅支持 PNG、JPEG、WebP、GIF 图片')
    return {
      bytes,
      name,
      sourceRef,
      mimeType,
      sizeBytes: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
    }
  }

  /** 把截图保存为附件快照，原始字节仍交给当前视觉调用处理。 */
  async captureScreenshotPreviews(context: ResourceContext, output: string): Promise<string> {
    if (!output.trimStart().startsWith('{')) return output
    const value = JSON.parse(output) as Record<string, unknown>
    if (!value || !Array.isArray(value.screenshots) || !value.screenshots.length) return output
    const thread = await this.threads.getThread(context.threadId)
    if (!thread || thread.agentId !== context.agentId) throw new Error('截图与会话角色不匹配')
    let totalBytes = 0
    const screenshots: Array<Record<string, unknown>> = []
    for (const [index, item] of value.screenshots.entries()) {
      context.signal?.throwIfAborted()
      if (!item || typeof item !== 'object') continue
      const screenshot = { ...item } as Record<string, unknown>
      delete screenshot.imagePreview
      // 保留原始画面供当前模型识别，界面只持有受控附件引用。
      try {
        if (index >= 8) throw new Error('本次截图预览数量超过限制')
        if (typeof screenshot.dataUri !== 'string') throw new Error('截图缺少图片字节')
        if (screenshot.dataUri.length > Math.ceil(MAX_IMAGE_READ_BYTES / 3) * 4 + 64)
          throw new Error('截图超过 20 MB')
        const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(
          screenshot.dataUri,
        )
        if (!match || match[1]!.length > Math.ceil(MAX_IMAGE_READ_BYTES / 3) * 4)
          throw new Error('截图格式无效或超过 20 MB')
        const bytes = Buffer.from(match[1]!, 'base64')
        totalBytes += bytes.length
        if (totalBytes > 40 * 1024 * 1024) throw new Error('本次截图预览超过 40 MB')
        const mimeType = resourceMime('', '', bytes)
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType))
          throw new Error('截图不是有效图片')
        const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)
        screenshot.imagePreview = await this.captureImagePreview(context, {
          bytes,
          mimeType,
          sizeBytes: bytes.length,
          name: `截图-${index + 1}.${extension}`,
          hash: createHash('sha256').update(bytes).digest('hex'),
          sourceRef: `capture:${context.toolCallId ?? 'screen'}:${index}`,
        })
      } catch (error) {
        context.signal?.throwIfAborted()
        screenshot.previewError = error instanceof Error ? error.message : '截图预览保存失败'
      }
      screenshots.push(screenshot)
    }
    return JSON.stringify({ ...value, screenshots })
  }

  /** 保存模型实际读取的版本，工具卡片浏览不会重新读取已变化的文件或网络地址。 */
  async captureImagePreview(
    context: ResourceContext,
    image: Awaited<ReturnType<ResourceService['readImage']>>,
  ): Promise<MessageResource> {
    context.signal?.throwIfAborted()
    if (image.sourceRef.startsWith('attachment:'))
      return this.describe(await this.existing(image.sourceRef.slice(11), context))
    const row = await this.attachments.saveOutgoing({
      threadId: context.threadId,
      agentId: context.agentId,
      pairId: context.pairId,
      callId: `image-preview:${context.toolCallId ?? randomUUID()}:${image.hash}`,
      toolPreview: true,
      bytes: image.bytes,
      name: image.name,
      mimeType: image.mimeType,
      kind: 'image',
    })
    context.signal?.throwIfAborted()
    return this.describe(row)
  }

  socialPort(): SocialResourcePort {
    return {
      prepare: (input) =>
        this.prepare(
          { ...input, toolCallId: input.callId },
          input.source,
          input.caption,
          input.allowLocal,
        ),
      markDelivered: (id, agentId) => this.attachments.markResourceDelivered(id, agentId),
    }
  }
}
