import { describe, expect, it, vi } from 'vitest'
import type { BoundCapabilityPort } from '@infos/backend/kernel'
import { createBrowserToolContributions } from '@infos/backend/tools/browserControl'

const context = {
  agentId: 'pero',
  sessionId: 'thread-1',
  source: 'desktop',
  threadId: 'thread-1',
  channel: 'desktop',
}
const desktopScope = {
  profileId: 'desktop',
  sessionId: '["thread-1",null]',
  principalId: 'pero',
}

describe('Browser Tool ABI', () => {
  it('账号范围由可信工具现场覆盖，模型不能切换其他账号的浏览器', async () => {
    const invoke = vi.fn(async (_operation: string, _input: unknown) => ({}))
    const tools = createBrowserToolContributions({
      offer: { operations: ['open'] },
      invoke,
    } as unknown as BoundCapabilityPort)
    const open = tools.find((tool) => tool.definition.name === 'browser_open_url')!
    await open.handler(
      { url: 'example.com', __browserScope: { profileId: 'foreign' } },
      {
        ...context,
        browserScope: { profileId: 'qq:owner', sessionId: 'owner-dm' },
      },
    )
    expect(invoke).toHaveBeenCalledWith(
      'open',
      {
        url: 'https://example.com',
        __browserScope: { profileId: 'qq:owner', sessionId: 'owner-dm', principalId: 'pero' },
      },
      expect.any(Object),
      undefined,
    )
    await open.handler({ url: 'example.com', __browserScope: { profileId: 'foreign' } }, context)
    expect(invoke.mock.calls.at(-1)![1]).toEqual({
      url: 'https://example.com',
      __browserScope: desktopScope,
    })
  })
  it('等待工具将取消信号交给能力端，取消观察不会继续打开网页', async () => {
    const parent = new AbortController()
    const invoke = vi.fn(async () => {
      parent.abort(new Error('父任务已停止'))
      throw parent.signal.reason
    })
    const tools = createBrowserToolContributions({
      offer: { operations: ['inspect', 'open'] },
      invoke,
    } as unknown as BoundCapabilityPort)
    const open = tools.find((tool) => tool.definition.name === 'browser_open_url')!
    await expect(
      open.handler({ url: 'example.com' }, { ...context, signal: parent.signal }),
    ).rejects.toThrow('父任务已停止')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]).toEqual([
      'inspect',
      { __browserScope: desktopScope },
      expect.any(Object),
      parent.signal,
    ])
  })

  it('应通过 Bound Port 调用并发布观察结果', async () => {
    const invoke = vi.fn().mockResolvedValue({ generation: 2, output: { content: '页面' } })
    const observe = vi.fn()
    const tools = createBrowserToolContributions(
      { invoke } as unknown as BoundCapabilityPort,
      observe,
    )
    const open = tools.find((tool) => tool.definition.name === 'browser_open_url')!
    const result = await open.handler({ url: 'example.com' }, context)
    expect(invoke).toHaveBeenCalledWith(
      'open',
      { url: 'https://example.com', __browserScope: desktopScope },
      expect.objectContaining({ principalId: 'pero' }),
      undefined,
    )
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ operation: 'open', context }))
    expect(result).toContain('success')
  })

  it('网页截图应转换为统一多模态截图结构', async () => {
    const coordinateContext = {
      screenshotId: 'crop-2',
      targetId: 'tab-1',
      generation: 3,
      coordinateSpace: 'screenshot',
      sourceCoordinateSpace: 'viewport-css',
      screenshotWidth: 800,
      screenshotHeight: 400,
      bounds: { x: 200, y: 100, width: 400, height: 200 },
    }
    const invoke = vi.fn().mockResolvedValue({
      output: {
        result: {
          base64: 'YWJj',
          mimeType: 'image/png',
          screenshotId: 'crop-2',
          referenceScreenshotId: 'full-1',
          coordinateContext,
        },
      },
    })
    const tools = createBrowserToolContributions({
      invoke,
    } as unknown as BoundCapabilityPort)
    const screenshot = tools.find((tool) => tool.definition.name === 'browser_screenshot')!
    const input = { screenshotId: 'full-1', region: { x: 200, y: 100, width: 400, height: 200 } }
    const output = JSON.parse(String(await screenshot.handler(input, context)))
    expect(invoke).toHaveBeenCalledWith(
      'screenshot',
      {
        ...input,
        __browserScope: desktopScope,
        __screenshotCaller: JSON.stringify(['pero', context.threadId]),
      },
      expect.any(Object),
      undefined,
    )
    expect(output).toMatchObject({ screenshotId: 'crop-2', referenceScreenshotId: 'full-1' })
    expect(output.screenshots[0].dataUri).toBe('data:image/png;base64,YWJj')
    expect(output.screenshots[0].coordinateContext).toEqual(coordinateContext)
  })

  it('局部截图坐标通过原交互入口传递，不改写为元素定位', async () => {
    const invoke = vi.fn().mockResolvedValue({ dispatched: true })
    const tools = createBrowserToolContributions({
      invoke,
    } as unknown as BoundCapabilityPort)
    const interact = tools.find((tool) => tool.definition.name === 'browser_interact')!
    await interact.handler({ action: 'click', screenshotId: 'crop-2', x: 80, y: 40 }, context)
    expect(invoke).toHaveBeenCalledWith(
      'nativeClick',
      {
        action: 'click',
        screenshotId: 'crop-2',
        x: 80,
        y: 40,
        target: undefined,
        handle: undefined,
        allowOccluded: false,
        __browserScope: desktopScope,
        __screenshotCaller: JSON.stringify(['pero', context.threadId]),
      },
      expect.objectContaining({ principalId: 'pero' }),
      undefined,
    )
  })

  it('网页局部图片应转换为统一多模态截图结构', async () => {
    const tools = createBrowserToolContributions({
      invoke: vi.fn().mockResolvedValue({
        output: { result: { base64: 'aW1hZ2U=', mimeType: 'image/png' } },
      }),
    } as unknown as BoundCapabilityPort)
    const image = tools.find((tool) => tool.definition.name === 'browser_page_image')!
    const output = JSON.parse(String(await image.handler({ imageId: 'IMG1' }, context)))
    expect(output.screenshots[0].dataUri).toBe('data:image/png;base64,aW1hZ2U=')
  })

  it('应只注册原子 Browser Tool ABI', () => {
    const tools = createBrowserToolContributions({
      invoke: vi.fn(),
    } as unknown as BoundCapabilityPort)
    const names = tools.map((tool) => tool.definition.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'browser_search',
        'browser_screenshot',
        'browser_page_image',
        'browser_wait',
        'browser_tabs',
        'browser_interact',
        'browser_query_dom',
      ]),
    )
    for (const name of [
      'browser_scene',
      'browser_plan_form',
      'browser_receipts',
      'browser_site_model',
      'browser_compile_capability',
    ])
      expect(names).not.toContain(name)
  })
})
