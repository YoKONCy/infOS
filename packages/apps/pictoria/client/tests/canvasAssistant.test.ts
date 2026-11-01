// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, reactive, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useCanvasAssistant, type AssistantMessage } from '../src/composables/useCanvasAssistant'
import type { CanvasStore } from '../src/composables/useCanvas'
import type { Project } from '../src/types'
import { documentKey } from '../../src/canvasDocument'
import { defaultAssistantSettings, type AssistantSettingsRecord } from '../../src/assistantSettings'

const api = vi.hoisted(() => ({ operation: vi.fn(), run: vi.fn(), task: vi.fn() }))
vi.mock('../src/services/transport', () => ({ pictoria: api }))
vi.mock('../src/i18n', () => ({ t: (_scope: string, source: string) => source }))
let wrapper: VueWrapper | undefined
let conversation: { revision: number; messages: AssistantMessage[] }
let preferences: AssistantSettingsRecord
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  conversation = { revision: 0, messages: [] }
  preferences = { revision: 0, settings: defaultAssistantSettings() }
  api.operation.mockReset()
  api.run.mockReset()
  api.task.mockReset()
  api.operation.mockImplementation(async (_owner, operation, input) => {
    if (operation === 'canvas.conversation.get') return structuredClone(conversation)
    if (operation === 'canvas.conversation.save') {
      if (input.expectedRevision !== conversation.revision) throw new Error('版本冲突')
      conversation = {
        revision: conversation.revision + 1,
        messages: JSON.parse(JSON.stringify(input.messages)),
      }
      return structuredClone(conversation)
    }
    if (operation === 'provider.list') return { providers: [] }
    if (operation === 'canvas.assistant.settings.get') return structuredClone(preferences)
    if (operation === 'canvas.assistant.settings.save') {
      if (input.expectedRevision !== preferences.revision) throw new Error('版本冲突')
      preferences = {
        revision: preferences.revision + 1,
        settings: structuredClone(input.settings),
      }
      return structuredClone(preferences)
    }
    if (operation === 'asset.get') return { id: input.id, sizeBytes: 64 }
    if (operation === 'canvas.assistant.prepare') return { id: 'assistant-step', revision: 1 }
    if (operation === 'canvas.proposal.list') return []
    return { accepted: true }
  })
  api.run.mockResolvedValue({ taskId: 'assistant-task', accepted: true })
  api.task.mockResolvedValue({
    state: 'completed',
    result: {
      text: JSON.stringify({
        message: '增加便签',
        operations: [{ type: 'note', id: 'new-note', text: '日落配色', x: 20, y: 30 }],
      }),
    },
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})
async function fixture() {
  const project = reactive<Project>({
    id: 'project',
    title: '画布',
    revision: 1,
    items: [],
    viewport: { x: 0, y: 0, scale: 1 },
  })
  const checkpoint = vi.fn()
  const store = {
    project,
    checkpoint,
    agentId: ref('owner'),
    online: ref(true),
    selected: ref([]),
    steps: ref([]),
  } as unknown as CanvasStore
  store.activeItems = computed(() =>
    project.items.filter((item) => store.selected.value.includes(item.id)),
  )
  let assistant!: ReturnType<typeof useCanvasAssistant>
  wrapper = mount(
    defineComponent({
      setup() {
        assistant = useCanvasAssistant(store)
        return () => h('div')
      },
    }),
  )
  await flushPromises()
  return { assistant, project, checkpoint, store }
}
describe('画布助手确认与恢复', () => {
  it('设置保存后可重新加载，后续请求携带已保存参数', async () => {
    const { assistant } = await fixture()
    await expect(
      assistant.saveSettings({
        ...defaultAssistantSettings(),
        generation: { temperature: 0, maxTokens: 2048 },
        historyMessages: 0,
        instructions: '用简短便签给出建议',
      }),
    ).resolves.toBe(true)
    await assistant.reload()
    expect(assistant.settings.value.generation).toEqual({ temperature: 0, maxTokens: 2048 })
    assistant.input.value = '添加便签'
    await assistant.send()
    const prepared = api.operation.mock.calls.find((call) => call[1] === 'canvas.assistant.prepare')
    expect(prepared?.[2].settings).toMatchObject({
      generation: { temperature: 0, maxTokens: 2048 },
      historyMessages: 0,
      instructions: '用简短便签给出建议',
    })
    expect(JSON.parse(api.run.mock.calls[0]?.[1].inputs.prompt).history).toEqual([])
  })
  it('默认只发送结构，不因选中图片而发送像素引用', async () => {
    const { assistant, project, store } = await fixture()
    project.items.push({
      id: 'selected',
      x: 0,
      y: 0,
      content: {
        version: 1,
        kind: 'asset',
        width: 300,
        height: 200,
        assetId: 'selected-image',
        mimeType: 'image/png',
      },
    })
    store.selected.value = ['selected']
    assistant.input.value = '整理选中素材'
    await assistant.send()
    const inputs = api.run.mock.calls[0]?.[1].inputs
    expect(inputs.images).toBeUndefined()
    expect(JSON.parse(inputs.prompt).context.imagesIncluded).toBe(false)
  })
  it('显式开启后只发送所选图片，并把实际图片顺序绑定到节点', async () => {
    const { assistant, project, store } = await fixture()
    project.items.push(
      {
        id: 'selected',
        x: 0,
        y: 0,
        content: {
          version: 1,
          kind: 'asset',
          width: 300,
          height: 200,
          assetId: 'selected-image',
          mimeType: 'image/png',
          name: '人物参考',
        },
      },
      {
        id: 'other',
        x: 400,
        y: 0,
        content: {
          version: 1,
          kind: 'asset',
          width: 300,
          height: 200,
          assetId: 'other-image',
          mimeType: 'image/png',
        },
      },
    )
    store.selected.value = ['selected']
    assistant.includeImages.value = true
    assistant.input.value = '分析选图的光线'
    await assistant.send()
    const inputs = api.run.mock.calls[0]?.[1].inputs
    expect(inputs.images).toEqual([{ assetId: 'selected-image' }])
    expect(JSON.parse(inputs.prompt).context.imageBindings).toEqual([
      { itemId: 'selected', assetId: 'selected-image', name: '人物参考' },
    ])
    expect(conversation.messages[0]?.submission?.images).toEqual([{ assetId: 'selected-image' }])
  })
  it('收到提案后不自动修改画布，确认后才建立撤销点', async () => {
    const { assistant, project, checkpoint } = await fixture()
    assistant.input.value = '增加日落配色便签'
    await assistant.send()
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(project.items).toEqual([])
    expect(checkpoint).not.toHaveBeenCalled()
    const reply = assistant.messages.value.find((message) => message.role === 'assistant')!
    expect(reply.proposal?.operations).toEqual([
      { type: 'note', id: 'new-note', text: '日落配色', x: 20, y: 30 },
    ])
    await assistant.applyMessage(reply)
    expect(project.items[0]).toMatchObject({
      id: 'new-note',
      x: 20,
      y: 30,
      content: { text: '日落配色' },
    })
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(api.run.mock.calls[0]?.[1]).toMatchObject({
      projectId: 'assistant:project',
      inputs: { prompt: expect.any(String) },
    })
  })
  it('等待回复时画布发生修改，旧提案不能覆盖用户修改', async () => {
    const { assistant, project, checkpoint } = await fixture()
    assistant.input.value = '添加便签'
    await assistant.send()
    project.title = '我刚改过的标题'
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    await assistant.applyMessage(
      assistant.messages.value.find((message) => message.role === 'assistant')!,
    )
    expect(project.title).toBe('我刚改过的标题')
    expect(project.items).toEqual([])
    expect(checkpoint).not.toHaveBeenCalled()
    expect(assistant.failure.value).toContain('重新生成提案')
  })
  it('刷新后用持久化幂等键恢复未确认的提交，保留实际请求内容', async () => {
    conversation = {
      revision: 3,
      messages: [
        {
          id: 'persisted-request',
          role: 'user',
          text: '旧请求',
          baseKey: documentKey({ id: 'project', title: '画布', items: [] }),
          submission: { stepId: 'assistant-step', stepRevision: 1, prompt: '持久化上下文' },
        },
      ],
    }
    const { assistant, project } = await fixture()
    expect(api.run).toHaveBeenCalledWith(
      'owner',
      {
        projectId: 'assistant:project',
        stepId: 'assistant-step',
        stepRevision: 1,
        inputs: { prompt: '持久化上下文' },
      },
      'persisted-request',
    )
    expect(
      assistant.messages.value.find((message) => message.role === 'assistant')?.proposal,
    ).toBeDefined()
    expect(project.items).toEqual([])
    expect(conversation.messages[0]?.submission).toBeUndefined()
  })
})
