/** 任务来源由可信入口填写，模型不能自行声明操作者身份。 */
export interface TaskOrigin {
  platform: string
  accountId: string
  channelType: 'private'
  channelId: string
  senderId: string
  messageId: string
}

export interface TaskLifecycle {
  goal: string
  successCriteria: string
  plan: Array<{ title: string; done: boolean }>
  continuation: string
  wait?: { kind: 'time' | 'task' | 'input' | 'approval'; key: string }
  origin?: TaskOrigin
  recovery: 'read_only' | 'confirm'
  deadline?: string
  segments: number
  maxSegments: number
  usage: { llmCalls: number; toolCalls: number }
  maxLlmCalls: number
  maxToolCalls: number
  verification: 'unverified' | 'reported' | 'evidence_available'
  evidence: Array<{ toolCallId: string; description: string }>
  artifacts: string[]
  pendingEffect?: { executionId: string; toolName: string; callId: string }
  liveTerminalIds?: string[]
}

/** 一段执行的交接结果；证据引用需要服务端与实际工具记录核对。 */
export interface TaskSegmentResult {
  outcome: 'continue' | 'wait' | 'deliver' | 'blocked' | 'failed'
  summary: string
  wakeAt?: string
  waitForTaskId?: string
  plan?: TaskLifecycle['plan']
  artifacts?: string[]
  evidence?: TaskLifecycle['evidence']
}

export interface TaskControlInput {
  action:
    | 'create'
    | 'list'
    | 'get'
    | 'update'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'answer'
    | 'approve'
    | 'resolve_delivery'
  taskId?: string
  resultOffset?: number
  resultLimit?: number
  planId?: string
  planStepId?: string
  expectedRevision?: number
  instruction?: string
  title?: string
  successCriteria?: string
  message?: string
  inputId?: string
  answers?: import('../agentInput').AgentInputAnswer[]
  selectedOptionIds?: string[]
  decision?: 'allow_once' | 'deny_once'
  recovery?: 'read_only' | 'confirm'
  confirmUncertain?: boolean
  deadline?: string
  maxSegments?: number
  maxLlmCalls?: number
  maxToolCalls?: number
  deliveryId?: string
  deliveryDecision?: 'sent' | 'retry'
}

/** 内置社交应用的任务领域接口，不暴露后端 Service。 */
export interface SocialTaskControlPort {
  execute(origin: TaskOrigin, input: TaskControlInput, callId?: string): Promise<unknown>
}

/** 执行身份只能由工具运行时填写，不能从模型参数接收。 */
export interface TaskControlContext {
  requestedBy?: 'user' | 'agent'
  taskId?: string
  executionId?: string
  callId?: string
}

export interface TaskDeliveryContext {
  agentId: string
  deliveryId: string
  taskId: string
  revision: number
  status: string
}

export interface TaskDeliveryPort {
  /** 身份由社交应用按所属平台核验，宿主不解释平台配置。 */
  authorizeOrigin?(origin: TaskOrigin): Promise<string | undefined>
  ready(origin: TaskOrigin): Promise<boolean>
  send(origin: TaskOrigin, content: string, context?: TaskDeliveryContext): Promise<void>
  sendResources?(
    origin: TaskOrigin,
    content: string,
    resources: Array<{
      type: 'image' | 'video' | 'audio' | 'file'
      localPath: string
      name: string
    }>,
  ): Promise<void>
}
