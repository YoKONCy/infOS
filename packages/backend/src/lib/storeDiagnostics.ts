import { AppError } from './appError'
import type { IndexMaintenanceDiagnostic } from '@infos/shared'

export type StoreDiagnostic = IndexMaintenanceDiagnostic

/** 数据库维护的结构化错误，供 API 与进度详情保留阶段、路径和原始原因。 */
export class StoreOperationError extends AppError {
  constructor(readonly diagnostic: StoreDiagnostic, cause?: unknown) {
    super(['STORE_MAINTENANCE', 'STORE_STALE_HANDLE', 'STORE_DRAIN_TIMEOUT'].includes(diagnostic.code)
      ? 'RESOURCE_BUSY' : 'PRECONDITION_FAILED',
    { message: diagnostic.message, data: { diagnostic }, cause })
  }
}

/** 有界展开原始错误链，保留系统错误码与 AggregateError 的各个失败原因。 */
export function storeDiagnostic(error: unknown, phase = 'rebuild', depth = 0): StoreDiagnostic {
  if (error instanceof StoreOperationError) return error.diagnostic
  const value = error as NodeJS.ErrnoException & { cause?: unknown; errors?: unknown[] }
  const children = depth < 4
    ? [...(Array.isArray(value?.errors) ? value.errors : []), ...(value?.cause ? [value.cause] : [])]
        .slice(0, 8).map((cause) => storeDiagnostic(cause, phase, depth + 1))
    : []
  return {
    code: typeof value?.code === 'string' ? value.code : 'STORE_OPERATION_FAILED',
    phase,
    path: typeof value?.path === 'string' ? value.path : undefined,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
    ...(children.length ? { causes: children } : {}),
  }
}
