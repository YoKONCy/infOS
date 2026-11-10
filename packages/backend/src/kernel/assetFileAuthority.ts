/**
 * assetFileAuthority — 内核基础设施
 *
 * 负责定义该模块的稳定入口、数据边界与错误语义。
 * 调用方通过这里访问领域能力，避免绕过校验直接耦合内部状态。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type {
  KernelAssetId,
  KernelAssetObject,
  KernelExecutionId,
  KernelFileHandle,
  KernelFileHandleId,
  KernelFileOperation,
  KernelObjectRef,
} from '@infos/shared'
import { createResourceObjectRef } from '@infos/shared'
import type { LifecycleScope } from './lifecycleScope'

interface AssetRecord {
  asset: KernelAssetObject
  storagePath: string
}

export interface RegisterFileAssetInput {
  ownerPrincipalId: string
  filePath: string
  kind: string
  mimeType: string
  source: KernelAssetObject['source']
  retention?: KernelAssetObject['retention']
}

export interface IssueFileHandleInput {
  subjectId: string
  assetRef: KernelObjectRef
  operations: readonly KernelFileOperation[]
  expiresAt?: string
  maxUses?: number
  mimeScope?: readonly string[]
  sizeLimit?: number
  executionId?: KernelExecutionId
}

/** 文件资产元数据与限次 Handle 的进程内权威。 */
export class AssetFileAuthority {
  forgetTemporary(ref: KernelObjectRef): void {
    const record = this.assets.get(this.key(ref))
    if (record?.asset.retention !== 'temporary') return
    this.assets.delete(this.key(ref))
    for (const [id, handle] of this.handles) if (handle.assetRef.objectId === ref.objectId) this.revoke(id)
  }
  private readonly assets = new Map<string, AssetRecord>()
  private readonly handles = new Map<KernelFileHandleId, KernelFileHandle>()

  registerFile(input: RegisterFileAssetInput): KernelAssetObject {
    const storagePath = path.resolve(input.filePath)
    const stat = statSync(storagePath)
    if (!stat.isFile()) throw new Error('ASSET_NOT_FILE: 资产来源不是文件')
    const assetId = randomUUID() as KernelAssetId
    const asset: KernelAssetObject = Object.freeze({
      assetId,
      ref: createResourceObjectRef('asset', assetId, input.ownerPrincipalId),
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: stat.size,
      sha256: createHash('sha256').update(readFileSync(storagePath)).digest('hex'),
      source: input.source,
      createdAt: new Date().toISOString(),
      retention: input.retention ?? 'persistent',
    })
    this.assets.set(this.key(asset.ref), { asset, storagePath })
    return asset
  }

  getAsset(ref: KernelObjectRef): KernelAssetObject | null {
    return this.assets.get(this.key(ref))?.asset ?? null
  }

  issueHandle(input: IssueFileHandleInput, scope?: LifecycleScope): KernelFileHandle {
    const record = this.assets.get(this.key(input.assetRef))
    if (!record) throw new Error('ASSET_NOT_FOUND: 文件资产不存在或 generation 已失效')
    if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses <= 0)) {
      throw new Error('FILE_HANDLE_INVALID_USES: maxUses 必须是正整数')
    }
    if (input.mimeScope?.length && !input.mimeScope.includes(record.asset.mimeType)) {
      throw new Error('FILE_HANDLE_MIME_DENIED: 资产 MIME 不在允许范围')
    }
    if (input.sizeLimit !== undefined && record.asset.sizeBytes > input.sizeLimit) {
      throw new Error('FILE_HANDLE_SIZE_DENIED: 资产大小超过限制')
    }
    const handleId = randomUUID() as KernelFileHandleId
    const handle: KernelFileHandle = {
      handleId,
      subjectId: input.subjectId,
      assetRef: { ...input.assetRef },
      operations: Object.freeze([...new Set(input.operations)]),
      issuedAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      remainingUses: input.maxUses,
      mimeScope: input.mimeScope ? Object.freeze([...input.mimeScope]) : undefined,
      sizeLimit: input.sizeLimit,
      executionId: input.executionId,
    }
    this.handles.set(handleId, handle)
    scope?.defer(() => {
      this.revoke(handleId)
    })
    return structuredClone(handle)
  }

  consume(
    handleId: KernelFileHandleId,
    subjectId: string,
    operation: KernelFileOperation,
    executionId?: KernelExecutionId,
  ): { asset: KernelAssetObject; storagePath: string } {
    const handle = this.handles.get(handleId)
    if (!handle) throw new Error('FILE_HANDLE_NOT_FOUND: 文件 Handle 不存在')
    if (handle.revokedAt) throw new Error('FILE_HANDLE_REVOKED: 文件 Handle 已撤销')
    if (handle.expiresAt && Date.parse(handle.expiresAt) <= Date.now()) {
      throw new Error('FILE_HANDLE_EXPIRED: 文件 Handle 已过期')
    }
    if (handle.subjectId !== subjectId) throw new Error('FILE_HANDLE_SUBJECT_DENIED: 主体不匹配')
    if (handle.executionId && handle.executionId !== executionId) {
      throw new Error('FILE_HANDLE_EXECUTION_DENIED: Execution 不匹配')
    }
    if (!handle.operations.includes(operation)) {
      throw new Error(`FILE_HANDLE_OPERATION_DENIED: 不允许 ${operation}`)
    }
    if (handle.remainingUses !== undefined && handle.remainingUses <= 0) {
      throw new Error('FILE_HANDLE_EXHAUSTED: 文件 Handle 使用次数已耗尽')
    }
    const record = this.assets.get(this.key(handle.assetRef))
    if (!record) throw new Error('ASSET_STALE: 资产 generation 已失效')
    const stat = statSync(record.storagePath)
    if (!stat.isFile() || stat.size !== record.asset.sizeBytes) {
      throw new Error('ASSET_CHANGED: 文件资产已发生变化')
    }
    const digest = createHash('sha256').update(readFileSync(record.storagePath)).digest('hex')
    if (digest !== record.asset.sha256) throw new Error('ASSET_CHANGED: 文件资产校验失败')
    if (handle.remainingUses !== undefined) handle.remainingUses -= 1
    return { asset: record.asset, storagePath: record.storagePath }
  }

  consumeBytes(
    handleId: KernelFileHandleId,
    subjectId: string,
    operation: KernelFileOperation,
    executionId?: KernelExecutionId,
  ): { asset: KernelAssetObject; bytes: Buffer } {
    const { asset, storagePath } = this.consume(handleId, subjectId, operation, executionId)
    return { asset, bytes: readFileSync(storagePath) }
  }

  revoke(handleId: KernelFileHandleId): boolean {
    const handle = this.handles.get(handleId)
    if (!handle || handle.revokedAt) return false
    handle.revokedAt = new Date().toISOString()
    return true
  }

  private key(ref: KernelObjectRef): string {
    return `${ref.objectType}:${ref.objectId}:${ref.generation}`
  }
}
