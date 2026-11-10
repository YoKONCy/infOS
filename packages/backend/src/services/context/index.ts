/**
 * Context 模块导出
 *
 * @module packages/backend/src/services/context
 */

export { ContextRegionRegistry, ContextRegionSelector } from './contextRegionRuntime'
export { ContextCompiler, DEFAULT_POLICIES } from './contextCompiler'
export type { LlmMessage, ChannelPolicy, CompiledContext, ContextManifest } from './contextCompiler'
