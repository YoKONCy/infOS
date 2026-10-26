import { t as __t } from '../../lib/i18n'
import { WEB_PAGE_OPERATIONS } from '@infos/shared'
import { AsyncLocalStorage } from 'node:async_hooks'
import { BrowserActionCoordinator } from '../../applications/browserActionCoordinator'
import { BrowserInteractionRuntime } from '../../applications/browserInteractionRuntime'
import type { BoundCapabilityPort } from '../../kernel/capabilityDirectory'
import type { ToolContext, ToolHandler } from '../../services/agent/toolRegistry'
import type { ToolDefinition } from '../../services/pipeline/types'
import manifest from './manifest.json'
import { browserNavigationTarget, type BrowserPreviewResolver } from './navigationTarget'

interface BrowserToolContribution {
  definition: ToolDefinition
  handler: ToolHandler
}

export interface BrowserToolObservation {
  operation: string
  result: unknown
  context: ToolContext
}

/** Browser Package 拥有的 Tool ABI 工厂，不使用模块级全局 Port。 */
export function createBrowserToolContributions(
  port: BoundCapabilityPort,
  operationsOrObserver:
    | readonly string[]
    | ((observation: BrowserToolObservation) => void | Promise<void>) = port.offer?.operations ??
    WEB_PAGE_OPERATIONS,
  observer?: (observation: BrowserToolObservation) => void | Promise<void>,
  preview?: BrowserPreviewResolver,
): BrowserToolContribution[] {
  const availableOperations =
    typeof operationsOrObserver === 'function' ? WEB_PAGE_OPERATIONS : operationsOrObserver
  const onObservation = typeof operationsOrObserver === 'function' ? operationsOrObserver : observer
  const calling = new AsyncLocalStorage<ToolContext>()
  const scopedPort: BoundCapabilityPort = {
    bindingId: port.bindingId,
    get offer() {
      return port.offer
    },
    dispose: () => port.dispose(),
    invoke(operation, input, context, signal) {
      const caller = calling.getStore()
      const {
        __browserScope: _untrusted,
        __screenshotCaller: _untrustedCaller,
        ...parameters
      } = input as Record<string, unknown>
      const screenshotCall =
        ['screenshot', 'elementScreenshot'].includes(operation) ||
        (['nativeClick', 'hover', 'click'].includes(operation) &&
          parameters.screenshotId !== undefined)
      const scopedInput = {
        ...parameters,
        ...(caller && screenshotCall
          ? {
              __screenshotCaller: JSON.stringify([
                caller.agentId,
                caller.taskId ?? caller.threadId,
              ]),
            }
          : {}),
      }
      return port.invoke(
        operation,
        caller?.browserScope
          ? {
              ...scopedInput,
              __browserScope: { ...caller.browserScope, principalId: caller.agentId },
            }
          : scopedInput,
        context,
        signal,
      )
    },
  }
  const actions = new BrowserActionCoordinator(scopedPort)
  const interactions = new BrowserInteractionRuntime(
    scopedPort,
    port.offer?.placement?.providerNodeId,
  )
  const invoke = async (
    operation: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> => {
    try {
      const callContext = {
        principalId: context.agentId,
        correlationId: context.toolCallId ?? `${operation}:${Date.now()}`,
        executionId: context.executionId,
        processId: context.processId,
        deadline: context.deadline,
      }
      const observed = await interactions.invoke(operation, args, callContext, context.signal)
      const result = observed.result
      await onObservation?.({ operation, result, context })
      if (operation === 'screenshot' || operation === 'elementScreenshot') {
        type ScreenshotOutput = {
          base64?: string
          mimeType?: string
          screenshotId?: string
          referenceScreenshotId?: string
          coordinateContext?: Record<string, unknown>
          target?: string
        }
        const runtime = result as ScreenshotOutput & { output?: { result?: ScreenshotOutput } }
        const image = runtime.base64 ? runtime : runtime.output?.result
        if (image?.base64) {
          return JSON.stringify({
            success: true,
            screenshotId: image.screenshotId,
            referenceScreenshotId: image.referenceScreenshotId,
            target: image.target,
            message: __t('server.tools', '已截取当前网页'),
            screenshots: [
              {
                index: 0,
                dataUri: `data:${image.mimeType ?? 'image/png'};base64,${image.base64}`,
                coordinateContext: image.coordinateContext,
              },
            ],
          })
        }
      }
      return JSON.stringify({
        success: true,
        result,
        scene: observed.scene,
        receipt: observed.receipt,
      })
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  const handlers: Record<string, ToolHandler> = {
    browser_open_url: async (args, context) => {
      const url = await browserNavigationTarget(String(args.url ?? ''), context, preview)
      return invoke('open', { url }, context)
    },
    browser_click: async (args, context) => {
      const target = String(args.handle ?? args.target ?? '').trim()
      if (!target) return JSON.stringify({ error: '请提供元素句柄或目标' })
      return invoke('click', { ...args, target }, context)
    },
    browser_type: async (args, context) => {
      const target = String(args.handle ?? args.target ?? '').trim()
      if (!target || typeof args.text !== 'string') {
        return JSON.stringify({ error: '请提供元素句柄和输入文本' })
      }
      return invoke('type', { ...args, target }, context)
    },
    browser_scroll: (args, context) => invoke('scroll', args, context),
    browser_back: (args, context) => invoke('back', args, context),
    browser_get_content: (args, context) => invoke('extract', args, context),
    browser_search: (args, context) => {
      const query = String(args.query ?? '').trim()
      if (!query && !Array.isArray(args.queries)) {
        return Promise.resolve(JSON.stringify({ error: '请提供搜索关键词或queries数组' }))
      }
      return invoke('search', args, context)
    },
    browser_screenshot: (args, context) => invoke('screenshot', args, context),
    browser_page_image: (args, context) => invoke('elementScreenshot', args, context),
    browser_wait: (args, context) => invoke('wait', args, context),
    browser_tabs: (args, context) => {
      const action = String(args.action ?? 'list')
      const operations: Record<string, string> = {
        list: 'listTargets',
        create: 'createTarget',
        switch: 'switchTarget',
        close: 'closeTarget',
      }
      return invoke(operations[action] ?? 'listTargets', args, context)
    },
    browser_interact: async (args, context) => {
      const action = String(args.action ?? '')
      const operations: Record<string, string> = {
        hover: 'hover',
        click: 'nativeClick',
        send_keys: 'sendKeys',
        set_value: 'setValue',
        select: 'selectOption',
        check: 'check',
      }
      if (!operations[action])
        return Promise.resolve(JSON.stringify({ error: '不支持的浏览器交互动作' }))
      if (action === 'hover' || action === 'click') {
        try {
          const result = await actions.execute(
            {
              action,
              target: typeof args.target === 'string' ? args.target : undefined,
              handle: typeof args.handle === 'string' ? args.handle : undefined,
              allowOccluded: args.allowOccluded === true,
              ...(args.screenshotId !== undefined || args.x !== undefined || args.y !== undefined
                ? {
                    screenshotId: args.screenshotId as string,
                    x: args.x as number,
                    y: args.y as number,
                  }
                : {}),
            },
            {
              principalId: context.agentId,
              correlationId: context.toolCallId ?? `browser:${operations[action]}:${Date.now()}`,
              executionId: context.executionId,
              processId: context.processId,
              deadline: context.deadline,
            },
            context.signal,
          )
          await onObservation?.({ operation: operations[action], result, context })
          return JSON.stringify({ success: true, result })
        } catch (error) {
          return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        }
      }
      return invoke(operations[action], args, context)
    },
    browser_query_dom: (args, context) => {
      const operation =
        args.action === 'source'
          ? 'sourceSearch'
          : args.action === 'frame'
            ? 'frameQuery'
            : 'domQuery'
      return invoke(operation, args, context)
    },
    browser_dialog: (args, context) => invoke('handleDialog', args, context),
    browser_network: (args, context) => {
      const operation =
        args.action === 'body'
          ? 'networkBody'
          : args.action === 'configure'
            ? 'networkConfigure'
            : 'networkQuery'
      return invoke(operation, args, context)
    },
    browser_upload: (args, context) => invoke('uploadFile', args, context),
    browser_download: (args, context) => invoke('downloadConfigure', args, context),
    browser_storage: (args, context) => invoke('storage', args, context),
    browser_emulate: (args, context) => invoke('emulate', args, context),
    browser_evaluate: (args, context) => invoke('evaluate', args, context),
    browser_status: (args, context) => invoke('runtimeStatus', args, context),
  }

  const requiredOperations: Record<string, string[]> = {
    browser_open_url: ['open'],
    browser_click: ['click'],
    browser_type: ['type'],
    browser_scroll: ['scroll'],
    browser_back: ['back'],
    browser_get_content: ['extract'],
    browser_search: ['search'],
    browser_screenshot: ['screenshot'],
    browser_page_image: ['elementScreenshot'],
    browser_wait: ['wait'],
    browser_tabs: ['listTargets', 'createTarget', 'switchTarget', 'closeTarget'],
    browser_interact: ['hover', 'nativeClick', 'sendKeys', 'setValue', 'selectOption', 'check'],
    browser_query_dom: ['domQuery', 'sourceSearch', 'frameQuery'],
    browser_dialog: ['handleDialog'],
    browser_network: ['networkQuery', 'networkBody', 'networkConfigure'],
    browser_upload: ['uploadFile'],
    browser_download: ['downloadConfigure'],
    browser_storage: ['storage'],
    browser_emulate: ['emulate'],
    browser_evaluate: ['evaluate'],
    browser_status: ['runtimeStatus'],
  }

  return manifest.tools
    .map((definition) => ({
      ...definition,
      display: {
        ...definition.display,
        ...(manifest.userCopy as Record<string, { label: string; description: string }>)[
          definition.name
        ],
      },
    }))
    .filter((definition) => handlers[definition.name])
    .filter((definition) =>
      (requiredOperations[definition.name] ?? []).every((operation) =>
        availableOperations.includes(operation),
      ),
    )
    .map((definition) => ({
      definition: definition as ToolDefinition,
      handler: (args, context) =>
        calling.run(context, () => handlers[definition.name]!(args, context)),
    }))
}
