import type { Assets } from './assets'
import { bounded } from './assets'
import type { NodeRun, ServiceProfile, Run } from './domain'
import type { Store } from './store'
import { normalizeAtlas, submitAtlas, atlasUploadUrl } from './atlascloud'
import { normalizeApiModels, submitApiModels } from './apimodels'
import { videoModels, submitVideo } from './videoModels'
import { assertCredentialScope } from './providers'
import { recordArtwork } from './library'
import { createHash } from 'node:crypto'
import { payloadFingerprint, SubmissionJournal } from './submissionJournal'
import {
  backoff,
  connectionNotSent,
  pause,
  requestError,
  retryAfter,
  ServiceRequestError,
  transient,
} from './requestSafety'

interface RequestOptions {
  safety?: 'read' | 'upload' | 'submit'
  receiptKey?: string
  cacheForMs?: number
}

export function field(value: unknown, name: string): unknown {
  if (!name) return value
  return name.split('.').reduce<unknown>((current, key) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('字段路径无效')
    return current && typeof current === 'object'
      ? (current as Record<string, unknown>)[key]
      : undefined
  }, value)
}
function assign(value: Record<string, unknown>, name: string, data: unknown): void {
  const keys = name.split('.')
  if (keys.length > 16 || keys.some((key) => !key || key.length > 128))
    throw new Error('请求字段路径无效')
  let target = value
  for (const [index, key] of keys.slice(0, -1).entries()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('字段路径无效')
    if (Array.isArray(target) && (!/^\d+$/.test(key) || Number(key) > 1024))
      throw new Error('请求数组下标无效')
    if (target[key] === undefined) target[key] = /^\d+$/.test(keys[index + 1] || '') ? [] : {}
    if (!target[key] || typeof target[key] !== 'object') throw new Error('请求字段路径冲突')
    target = target[key] as Record<string, unknown>
  }
  const last = keys.at(-1)!
  if (Array.isArray(target) && (!/^\d+$/.test(last) || Number(last) > 1024))
    throw new Error('请求数组下标无效')
  if (['__proto__', 'constructor', 'prototype'].includes(last)) throw new Error('字段路径无效')
  target[last] = data
}

export class ServiceClient {
  private readonly journal: SubmissionJournal
  constructor(
    private readonly store: Store,
    private readonly assets: Assets,
  ) {
    this.journal = new SubmissionJournal(store)
  }
  submission(owner: string, key: string) {
    return this.journal.get(owner, key)
  }
  canReplay(owner: string, service: ServiceProfile, key: string) {
    return this.journal.canReplay(service, this.journal.get(owner, key))
  }
  validateAssistantImages(owner: string, value: unknown): Array<{ assetId: string }> {
    const images = value === undefined ? [] : value
    if (!Array.isArray(images) || images.length > 4) throw new Error('ASSISTANT_IMAGE_LIMIT')
    let bytes = 0
    for (const reference of images) {
      if (!reference || typeof reference.assetId !== 'string')
        throw new Error('ASSISTANT_IMAGE_LIMIT')
      const asset = this.store.asset(reference.assetId, owner)
      bytes += asset.sizeBytes
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) ||
        bytes > 20 * 1024 * 1024
      )
        throw new Error('ASSISTANT_IMAGE_LIMIT')
    }
    return images
  }
  async request(
    owner: string,
    service: ServiceProfile,
    requestPath: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
    key?: string,
    beforeSend?: () => void,
    options: RequestOptions = {},
  ): Promise<unknown> {
    assertCredentialScope(this.store, owner, service)
    const base = new URL(service.baseUrl)
    const url = new URL(
      requestPath,
      service.baseUrl.endsWith('/') ? service.baseUrl : `${service.baseUrl}/`,
    )
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== base.origin ||
      url.username ||
      url.password
    )
      throw new Error('请求地址必须属于已配置的服务')
    const headers = new Headers(service.headers)
    const secret = this.store.secret(owner, service.credentialId ?? service.id)
    if (secret) headers.set(service.authHeader, `${service.authPrefix}${secret}`)
    if (key && service.idempotencyHeader) headers.set(service.idempotencyHeader, key)
    if (body instanceof FormData) headers.delete('content-type')
    else if (body !== undefined) headers.set('content-type', 'application/json')
    const payload =
      body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
    const fingerprint = await payloadFingerprint(url.toString(), method, payload)
    const credentialHash = createHash('sha256')
      .update(secret || '')
      .digest('hex')
    let receipt = options.receiptKey ? this.journal.get(owner, options.receiptKey) : undefined
    if (receipt) {
      this.journal.verify(receipt, fingerprint, credentialHash)
      if (
        receipt.state === 'received' &&
        (!options.cacheForMs ||
          Date.now() - Date.parse(receipt.receivedAt || '') < options.cacheForMs)
      )
        return receipt.response
      if (
        receipt.state === 'sending' &&
        options.safety !== 'upload' &&
        !this.journal.canReplay(service, receipt)
      )
        throw new ServiceRequestError(
          '原请求可能已提交，尚未取得回执；未自动重发，请核验远程任务',
          { ambiguousSubmission: true },
        )
    }
    if (service.requiresCredential && !secret) throw new Error('服务凭据不可用')
    if (
      options.receiptKey &&
      (!receipt ||
        receipt.state === 'received' ||
        receipt.state === 'prepared' ||
        receipt.state === 'rejected')
    )
      receipt = this.journal.save(owner, options.receiptKey, {
        state: 'prepared',
        fingerprint,
        credentialHash,
      })
    const safe =
      options.safety === 'read' ||
      options.safety === 'upload' ||
      (options.safety !== 'submit' && !beforeSend && method === 'GET')
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(
          service.requestTimeoutMs ??
            (options.safety === 'submit' ? service.timeoutMs : Math.min(service.timeoutMs, 120000)),
        ),
      ])
      try {
        if (options.receiptKey)
          this.store.transaction(() => {
            beforeSend?.()
            receipt = this.journal.save(owner, options.receiptKey!, {
              ...receipt!,
              fingerprint,
              credentialHash,
              state: 'sending',
              sentAt: receipt?.sentAt || new Date().toISOString(),
              response: undefined,
            })
          })
        else beforeSend?.()
        const response = await fetch(url, {
          method,
          headers,
          body: payload,
          signal: requestSignal,
          redirect: 'error',
        })
        if (!response.ok) {
          const bytes = await bounded(response, 256 * 1024).catch(() => Buffer.alloc(0))
          let detail = ''
          try {
            const data = JSON.parse(bytes.toString('utf8'))
            // 视觉接口的错误可能回显图片；此类请求只保留 HTTP 状态，不持久化错误正文。
            if (
              !Object.values(service.submit.fields).some(
                (mapping) => mapping.format === 'openai_content',
              )
            )
              detail = String(data.message ?? data.error?.message ?? data.error ?? '').slice(0, 300)
          } catch {
            /* 非 JSON 错误只显示状态码。 */
          }
          throw new ServiceRequestError(
            `服务返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
            {
              status: response.status,
              retryable:
                [408, 425, 429, 500, 502, 503, 504].includes(response.status) ||
                (safe && method === 'GET' && [404, 409].includes(response.status)),
              definitiveRejection:
                response.status >= 400 &&
                response.status < 500 &&
                ![408, 409, 425].includes(response.status),
              retryAfterMs: retryAfter(response.headers.get('retry-after')),
            },
          )
        }
        const atlasUpload =
          service.adapter === 'atlascloud' &&
          url.pathname.replace(/\/+$/, '').endsWith('/uploadMedia')
        const json =
          response.headers.get('content-type')?.includes('json') ||
          atlasUpload ||
          service.adapter === 'apimodels'
        const bytes = await bounded(response, json ? 24 * 1024 * 1024 : 100 * 1024 * 1024)
        let value: unknown
        if (json) {
          value = JSON.parse(bytes.toString('utf8')) as unknown
          if (service.adapter === 'apimodels' && !url.pathname.endsWith('/files'))
            value = normalizeApiModels(value)
          if (service.adapter === 'atlascloud' && !atlasUpload) {
            const normalized = normalizeAtlas(value)
            value =
              url.pathname.includes('/prediction/') &&
              normalized.data.status === 'completed' &&
              !normalized.data.outputs.length
                ? await this.request(
                    owner,
                    service,
                    `/api/v1/model/getResult?predictionId=${encodeURIComponent(url.pathname.split('/').at(-1)!)}`,
                    'GET',
                    undefined,
                    signal,
                    undefined,
                    undefined,
                    { safety: 'read' },
                  )
                : normalized
          }
        } else {
          const asset = await this.assets.save(
            owner,
            '作品',
            response.headers.get('content-type') ?? 'application/octet-stream',
            bytes,
            options.receiptKey ? `response:${options.receiptKey}` : undefined,
          )
          value = { assetId: asset.id }
        }
        if (options.receiptKey)
          receipt = this.journal.save(owner, options.receiptKey, {
            ...receipt!,
            fingerprint,
            credentialHash,
            state: 'received',
            receivedAt: new Date().toISOString(),
            response: value,
            error: undefined,
            retryable: undefined,
          })
        return value
      } catch (failure) {
        if (requestError(failure)?.persistenceFailure) throw failure
        const known = failure instanceof ServiceRequestError
        const notSent = connectionNotSent(failure)
        const error = known
          ? failure
          : new ServiceRequestError(failure instanceof Error ? failure.message : '服务连接中断', {
              retryable:
                failure instanceof TypeError ||
                requestSignal.aborted ||
                (safe && failure instanceof SyntaxError),
              notSent,
            })
        const detail = requestError(error)
        if (options.receiptKey && (detail.definitiveRejection || notSent))
          receipt = this.journal.save(owner, options.receiptKey, {
            ...receipt!,
            fingerprint,
            credentialHash,
            state: notSent ? 'prepared' : 'rejected',
            error: error.message,
            retryable: transient(error),
          })
        const replayable =
          safe || notSent || detail.definitiveRejection || this.journal.canReplay(service, receipt)
        if (signal.aborted || !transient(error) || !replayable || attempt >= 2) throw error
        await pause(Math.max(detail.retryAfterMs || 0, backoff(attempt, 750, 8000)), signal)
      }
    }
  }
  /** 签名上传只向 R2 发送文件，不转发供应商认证；完成回执可跨进程恢复。 */
  private async uploadApiModels(
    owner: string,
    service: ServiceProfile,
    source: unknown,
    signal: AbortSignal,
    key: string,
  ): Promise<string> {
    const file = await this.assets.file(owner, source, 10 * 1024 * 1024)
    const fingerprint = createHash('sha256')
        .update(await this.assets.dataUrl(owner, source))
        .digest('hex'),
      credentialHash = createHash('sha256')
        .update(this.store.secret(owner, service.credentialId || service.id) || '')
        .digest('hex')
    const receipt = this.journal.get(owner, `${key}:ready`)
    if (receipt?.state === 'received' && receipt.fingerprint !== fingerprint)
      throw new ServiceRequestError('原视频参考图已变化，请核验原任务后使用新的提交记录', {
        ambiguousSubmission: true,
      })
    if (
      receipt?.state === 'received' &&
      receipt.fingerprint === fingerprint &&
      receipt.credentialHash === credentialHash &&
      Date.now() - Date.parse(receipt.receivedAt || '') < 29 * 86400000 &&
      typeof receipt.response === 'string'
    )
      return receipt.response
    const grant = (await this.request(
      owner,
      service,
      'files',
      'POST',
      { filename: file.name, contentType: file.blob.type, fileSize: file.blob.size },
      signal,
      undefined,
      undefined,
      { safety: 'upload', receiptKey: `${key}:grant`, cacheForMs: 300000 },
    )) as { code?: number; data?: { uploadUrl?: string; publicUrl?: string } }
    if (grant.code !== 200 || !grant.data?.uploadUrl || !grant.data.publicUrl)
      throw new Error('APIModels 未返回有效上传地址')
    const uploadUrl = new URL(grant.data.uploadUrl),
      publicUrl = new URL(grant.data.publicUrl)
    if (
      uploadUrl.protocol !== 'https:' ||
      !uploadUrl.hostname.endsWith('.r2.cloudflarestorage.com') ||
      uploadUrl.username ||
      uploadUrl.password ||
      publicUrl.protocol !== 'https:' ||
      publicUrl.hostname !== 'r2.apimodels.app' ||
      publicUrl.username ||
      publicUrl.password
    )
      throw new Error('APIModels 上传地址不属于受信任的存储服务')
    for (let attempt = 0; ; attempt++) {
      const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(90000)])
      try {
        const response = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.blob.type },
          body: file.blob,
          signal: uploadSignal,
          redirect: 'error',
        })
        await response.body?.cancel()
        if (!response.ok)
          throw new ServiceRequestError(`参考图上传失败（HTTP ${response.status}）`, {
            status: response.status,
            retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
          })
        this.journal.save(owner, `${key}:ready`, {
          fingerprint,
          credentialHash,
          state: 'received',
          receivedAt: new Date().toISOString(),
          response: publicUrl.href,
        })
        return publicUrl.href
      } catch (failure) {
        if (requestError(failure)?.persistenceFailure) throw failure
        if (
          signal.aborted ||
          attempt >= 2 ||
          !(transient(failure) || failure instanceof TypeError || uploadSignal.aborted)
        )
          throw failure
        await pause(backoff(attempt, 1000, 8000), signal)
      }
    }
  }
  async submit(
    owner: string,
    service: ServiceProfile,
    inputs: Record<string, unknown>,
    signal: AbortSignal,
    key: string,
    beforeSend?: () => void,
  ): Promise<unknown> {
    if (
      videoModels.some(
        (model) => model.adapter === service.adapter && model.id === service.submit.body.model,
      )
    ) {
      const request = (
        path: string,
        method: string,
        body: unknown,
        submitted?: () => void,
        uploadKey?: string,
      ) =>
        this.request(
          owner,
          service,
          path,
          method,
          body,
          signal,
          uploadKey ? `${key}:upload:${uploadKey}` : key,
          submitted,
          uploadKey
            ? { safety: 'upload', receiptKey: `${key}:upload:${uploadKey}` }
            : { safety: 'submit', receiptKey: key },
        )
      return submitVideo(
        owner,
        service,
        inputs,
        this.assets,
        request,
        async (source, index) => {
          if (service.adapter === 'apimodels')
            return this.uploadApiModels(owner, service, source, signal, `${key}:reference:${index}`)
          const file = await this.assets.file(owner, source, 10 * 1024 * 1024),
            form = new FormData()
          form.append('file', file.blob, file.name)
          const value = await request(
              '/api/v1/model/uploadMedia',
              'POST',
              form,
              undefined,
              `${index}`,
            ),
            url = atlasUploadUrl(value)
          if (!url) throw new Error('参考图上传未返回有效地址')
          return url
        },
        beforeSend,
      )
    }
    if (service.adapter === 'apimodels')
      return submitApiModels(owner, service, inputs, this.assets, (body) =>
        this.request(owner, service, service.submit.path, 'POST', body, signal, key, beforeSend, {
          safety: 'submit',
          receiptKey: key,
        }),
      )
    if (service.adapter === 'atlascloud')
      return submitAtlas(
        owner,
        service,
        inputs,
        this.assets,
        (requestPath, method, body, submitted, uploadKey) =>
          this.request(
            owner,
            service,
            requestPath,
            method,
            body,
            signal,
            uploadKey ? `${key}:upload:${uploadKey}` : key,
            submitted,
            uploadKey
              ? { safety: 'upload', receiptKey: `${key}:upload:${uploadKey}`, cacheForMs: 300000 }
              : { safety: 'submit', receiptKey: key },
          ),
        beforeSend,
      )
    const body = structuredClone(service.submit.body)
    const form = service.submit.bodyFormat === 'multipart' ? new FormData() : undefined
    let uploadBytes = 0,
      dataBytes = 0
    if (form && service.submit.method === 'GET') throw new Error('multipart 请求不支持 GET')
    if (form)
      for (const [name, value] of Object.entries(body))
        form.append(name, typeof value === 'string' ? value : JSON.stringify(value))
    for (const [destination, mapping] of Object.entries(service.submit.fields)) {
      const raw = field(inputs, mapping.from)
      if (raw === undefined) throw new Error(`服务输入不存在：${mapping.from}`)
      if (mapping.format === 'file') {
        if (!form) throw new Error('文件字段需要 multipart 请求')
        const sources = Array.isArray(raw) ? raw : [raw]
        if (sources.length > 20) throw new Error('单次上传最多 20 份素材')
        for (const source of sources) {
          const file = await this.assets.file(owner, source, 100 * 1024 * 1024 - uploadBytes)
          uploadBytes += file.blob.size
          form.append(destination, file.blob, file.name)
        }
        continue
      }
      const dataUrl = async (source: unknown) => {
        if (
          !source ||
          typeof source !== 'object' ||
          typeof (source as { assetId?: string }).assetId !== 'string'
        )
          throw new Error('需要有效的素材引用')
        const asset = this.store.asset((source as { assetId: string }).assetId, owner)
        dataBytes += Math.ceil(asset.sizeBytes / 3) * 4
        if (dataBytes > 96 * 1024 * 1024) throw new Error('素材编码超过请求大小限制')
        return this.assets.dataUrl(owner, source)
      }
      let value: unknown
      if (mapping.format === 'openai_content') {
        const images = this.validateAssistantImages(owner, inputs.images)
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: String(raw) }]
        for (const reference of images) {
          content.push({
            type: 'image_url',
            image_url: { url: await this.assets.dataUrl(owner, reference) },
          })
        }
        value = content
      } else if (mapping.format === 'data_url') {
        if (Array.isArray(raw)) {
          if (raw.length > 20) throw new Error('单次最多引用 20 份素材')
          const values: string[] = []
          for (const source of raw) values.push(await dataUrl(source))
          value = values
        } else value = await dataUrl(raw)
      } else value = mapping.format === 'text' ? String(raw) : raw
      if (form) form.append(destination, typeof value === 'string' ? value : JSON.stringify(value))
      else assign(body, destination, value)
    }
    if (service.submit.method === 'GET') {
      const url = new URL(
        service.submit.path,
        service.baseUrl.endsWith('/') ? service.baseUrl : `${service.baseUrl}/`,
      )
      for (const [key, value] of Object.entries(body))
        url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      return this.request(
        owner,
        service,
        url.toString(),
        'GET',
        undefined,
        signal,
        key,
        beforeSend,
        { safety: 'submit', receiptKey: key },
      )
    }
    return this.request(
      owner,
      service,
      service.submit.path,
      service.submit.method,
      form ?? body,
      signal,
      key,
      beforeSend,
      { safety: 'submit', receiptKey: key },
    )
  }
  async outputs(
    owner: string,
    node: NodeRun,
    signal: AbortSignal,
    run?: Run,
    inputs: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const mappings = node.service!.submit.outputs
    const result: Record<string, unknown> = {}
    for (const [name, mapping] of Object.entries(mappings)) {
      const value = field(node.response, mapping.path)
      if (value === undefined) throw new Error(`服务结果缺少字段：${mapping.path}`)
      if (Array.isArray(value) && value.length > 20) throw new Error('单个输出最多包含 20 份资源')
      if (mapping.kind === 'value' || mapping.kind === 'text') {
        result[name] = value
        continue
      }
      const importOne = async (source: unknown, index = 0) => {
        signal.throwIfAborted()
        const slot = `${name}:${index}`
        const cached = node.savedOutputs?.[slot]
        if (cached && (await this.assets.available(owner, cached))) return cached
        let reference: unknown
        if (
          source &&
          typeof source === 'object' &&
          typeof (source as { assetId?: string }).assetId === 'string'
        ) {
          const asset = this.store.asset((source as { assetId: string }).assetId, owner)
          if (run)
            recordArtwork(
              this.store,
              owner,
              asset.id,
              run,
              node.step.id,
              node.service?.submit.body.model,
              inputs,
            )
          reference = source
        } else {
          if (typeof source !== 'string') throw new Error('资源输出必须是地址、数据 URL 或素材引用')
          const asset = await this.assets.import(
            owner,
            source,
            name,
            undefined,
            signal,
            run ? `output:${run.id}:${node.id}:${node.attempt ?? 0}:${slot}` : undefined,
          )
          if (run)
            recordArtwork(
              this.store,
              owner,
              asset.id,
              run,
              node.step.id,
              node.service?.submit.body.model,
              inputs,
            )
          reference = { assetId: asset.id }
        }
        node.savedOutputs ||= {}
        node.savedOutputs[slot] = reference
        if (run) this.store.saveRun(run)
        return reference
      }
      if (Array.isArray(value)) {
        const values: unknown[] = []
        for (let index = 0; index < value.length; index++)
          values.push(await importOne(value[index], index))
        result[name] = values
      } else result[name] = await importOne(value)
    }
    return result
  }
}
