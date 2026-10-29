/** Application Host公开ABI；自治Application不得导入Backend其他源码路径。 */
export type {
  AgentAppRuntime,
  AppRuntimeContext,
  HostDiaryReaderPort,
} from './applications/appRuntime'
export type {
  AppCheckpoint,
  AppCommandRequest,
  AppCommandResult,
  AppEvent,
  ResourceRef,
} from './applications/types'
export type { GrantRegistry } from './applications/grantRegistry'
export type { LlmService, ModelConfig } from './services/llm/llmService'
export type {
  ChatMessage,
  ContentPart,
  ToolCall,
  ToolDefinition,
  ChatOptions,
  ChatCompletion,
} from './services/llm/types'
export { modelOutputReservation } from './services/llm/requestPolicy'
export { appendNativeReasoning } from './services/llm/reasoning'
export { safeModelDiagnostic, modelNetworkDetails } from './services/llm/diagnostics'
export { retryableLlmError } from './services/llm/retryPolicy'
export { ToolLoopGuard, ToolLoopError } from './services/agent/toolLoopGuard'
export { desktopCheckpointMessages as promptMessagesForPersistence } from './services/agent/reactLoop'
export { compileModelRequest } from './services/prompt/requestCompiler'
export { completePrefilledContent } from './services/prompt/prefillContinuation'
export {
  canonicalTools,
  preparePromptReplay,
  promptFingerprint,
  historyKey,
  stableHistoryWindow,
  trimOldestPromptRound,
  invalidatePromptReplay,
} from './services/llm/promptCache'
export type { MdpEngine } from './services/prompt/mdpEngine'
export type { AgentManager } from './services/agent/agentManager'
export type { MemoryStoreRegistry } from './repositories/storeRegistry'
export type { InboundRouteRepository } from './repositories/inboundRoute.repo'
export type { BuiltinTool } from './tools/index'
export { createLogger } from './lib/logger'
export { AppError } from './lib/appError'
export { parseLlmJson } from './shared/llmJsonParser'
export { tokenCounter } from './services/tokenizer/tokenCounter'
