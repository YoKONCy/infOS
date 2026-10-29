// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createModelRouter } from '@infos/backend/routers/model.router'
import { ApiError } from '../../../src/api/errors'
import { useModelConfig } from '../../../src/composables/dashboard/useModelConfig'
import { prepareModelPayload } from '../../../src/lib/modelEditor'
import { configApi } from '../../../src/api/modules/configApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listRemote: vi.fn(),
  connections: vi.fn(),
  connection: vi.fn(),
  toast: vi.fn(),
}))
vi.mock('../../../src/api/modules/modelApi', () => ({
  modelApi: {
    list: mocks.list,
    getById: mocks.getById,
    create: mocks.create,
    update: mocks.update,
    listRemote: mocks.listRemote,
  },
}))
vi.mock('../../../src/api/modules/providerApi', () => ({
  providerApi: { list: mocks.connections, get: mocks.connection },
}))
vi.mock('../../../src/api/modules/configApi', () => ({
  configApi: {
    get: vi.fn(async () => ({ data: { value: null } })),
    batch: vi.fn(async () => ({ data: {} })),
  },
}))
vi.mock('../../../src/stores/useNotificationStore', () => ({
  useNotificationStore: () => ({ toast: mocks.toast }),
}))

let wrapper: VueWrapper
let editor: ReturnType<typeof useModelConfig>
const saved = vi.fn(async (body: unknown) => ({ id: 1, ...(body as object) }))
const updated = vi.fn(async (id: number, body: unknown) => ({ id, ...(body as object) }))
const remoteListed = vi.fn(async () => ['test-model'])
const connection = {
  id: 'shared',
  name: '共享连接',
  brand: 'custom',
  protocol: 'openai',
  apiBase: 'https://shared.example/v1',
  authMode: 'api_key',
  hasApiKey: true,
  models: [],
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue({ data: [] })
  mocks.connections.mockResolvedValue({ data: [] })
  mocks.connection.mockResolvedValue({ data: { ...connection, apiKey: 'shared-key' } })
  const router = createModelRouter({
    modelService: { create: saved, update: updated, listRemoteModels: remoteListed },
  } as never)
  // 表单提交经过真实 HTTP JSON 边界和生产路由校验，避免只验证模拟 API 的入参。
  async function submit(path: string, method: string, body: unknown) {
    const response = await router.request(`http://test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new ApiError(result.code, result.message, result.data)
    return result
  }
  mocks.create.mockImplementation((body) => submit('/', 'POST', body))
  mocks.update.mockImplementation((id, body) => submit(`/${id}`, 'PUT', body))
  mocks.listRemote.mockImplementation((body) => submit('/list-remote', 'POST', body))
  wrapper = mount(
    defineComponent({
      setup() {
        editor = useModelConfig()
        return () => h('div')
      },
    }),
  )
  await flushPromises()
})
afterEach(() => wrapper.unmount())

describe('模型编辑器保存边界', () => {
  it.each([false, true])('新建不依赖共享连接，也不自动选中已有连接：%s', async (hasConnection) => {
    mocks.connections.mockResolvedValue({ data: hasConnection ? [connection] : [] })
    await editor.openEditor(null)
    expect(editor.editorForm.value.providerConnectionId).toBeNull()
    editor.handleProviderChange('custom')
    Object.assign(editor.editorForm.value, {
      modelId: '  proxy/model-test  ',
      apiBase: '  https://custom.example/api/v3  ',
      apiKey: ' key ',
      enableVision: true,
    })
    vi.mocked(configApi.get).mockResolvedValueOnce({
      code: 'OK',
      message: '',
      data: { value: '1' },
    })
    await editor.saveModel()
    expect(editor.mainModelId.value).toBe('1')
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'proxy/model-test',
        modelId: 'proxy/model-test',
        provider: 'custom',
        providerConnectionId: null,
        connectionOverride: true,
        apiBase: 'https://custom.example/api/v3',
        apiKey: 'key',
        contextWindowTokens: null,
        maxReActTurns: null,
        maxTokens: null,
        temperature: null,
        topP: null,
        reasoningEffort: null,
        enableVision: true,
      }),
    )
    expect(editor.isEditorOpen.value).toBe(false)
  })

  it('模型 ID 留空时定位到字段，保留输入且不发送无效请求', async () => {
    await editor.openEditor(null)
    editor.editorForm.value.name = '我的模型'
    editor.editorForm.value.apiKey = 'keep-key'
    await editor.saveModel()
    expect(editor.editorErrors.value.modelId).toBeTruthy()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(editor.isEditorOpen.value).toBe(true)
    expect(editor.editorForm.value.apiKey).toBe('keep-key')
  })

  it('选择共享连接后保存引用，不复制或覆盖其密钥与地址', async () => {
    mocks.connections.mockResolvedValue({ data: [connection] })
    await editor.openEditor(null)
    await editor.handleConnectionChange('shared')
    editor.editorForm.value.modelId = 'test-model'
    await editor.saveModel()
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnectionId: 'shared',
        connectionOverride: false,
        apiBase: '',
        apiKey: '',
      }),
    )
  })

  it('后端拒绝某个字段时显示字段详情，不再只弹笼统错误', async () => {
    await editor.openEditor(null)
    editor.editorForm.value.modelId = 'test-model'
    editor.editorForm.value.wireApi = 'invalid' as never
    await editor.saveModel()
    expect(editor.editorErrors.value.wireApi).toBeTruthy()
    expect(editor.isEditorOpen.value).toBe(true)
    expect(saved).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('重复点击只保存一次，等待时保持保存状态', async () => {
    await editor.openEditor(null)
    editor.editorForm.value.modelId = 'test-model'
    let finish!: (value: { data: object }) => void
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = editor.saveModel()
    expect(editor.isSavingModel.value).toBe(true)
    await editor.saveModel()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    finish({ data: {} })
    await pending
    expect(editor.isSavingModel.value).toBe(false)
  })

  it('已保存的独立卡片可编辑，空白可选参数经过路由后仍为 null', async () => {
    await editor.openEditor(null)
    const model = {
      ...editor.editorForm.value,
      id: '7',
      name: '原卡片',
      modelId: 'test-model',
    }
    mocks.getById.mockResolvedValue({ data: model })
    await editor.openEditor(model)
    editor.editorForm.value.maxReActTurns = 500
    await editor.saveModel()
    expect(updated).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        providerConnectionId: null,
        connectionOverride: true,
        maxTokens: null,
        contextWindowTokens: null,
        maxReActTurns: 500,
      }),
    )
  })

  it('从共享连接切回独立配置会完整复制连接，支持保存和免密列表查询', async () => {
    mocks.connections.mockResolvedValue({ data: [connection] })
    await editor.openEditor(null)
    await editor.handleConnectionChange('shared')
    expect(editor.editorForm.value.connectionOverride).toBe(false)
    await editor.handleConnectionChange('')
    expect(editor.editorForm.value).toMatchObject({
      providerConnectionId: null,
      connectionOverride: true,
      apiBase: connection.apiBase,
      apiKey: 'shared-key',
    })
    editor.editorForm.value.modelId = 'test-model'
    editor.editorForm.value.connectionAuthMode = 'none'
    await editor.fetchRemoteModels()
    expect(mocks.listRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnectionId: undefined,
        apiBase: connection.apiBase,
        apiKey: '',
      }),
    )
    expect(remoteListed).toHaveBeenCalledWith(
      expect.objectContaining({ apiBase: connection.apiBase, apiKey: '' }),
    )
    expect(editor.remoteModels.value).toEqual(['test-model'])
    await editor.saveModel()
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnectionId: null,
        connectionAuthMode: 'none',
        apiKey: '',
      }),
    )
  })

  it('空白数值归一为 null，非整数或超出范围的输入不会被静默保存', async () => {
    await editor.openEditor(null)
    editor.editorForm.value.modelId = 'test-model'
    const blank = prepareModelPayload({
      ...editor.editorForm.value,
      contextWindowTokens: ' ' as never,
    })
    expect(blank.payload.contextWindowTokens).toBeNull()
    expect(blank.errors).toEqual({})
    editor.editorForm.value.maxReActTurns = 1.5
    editor.editorForm.value.temperature = 3
    await editor.saveModel()
    expect(Object.keys(editor.editorErrors.value)).toEqual(['temperature', 'maxReActTurns'])
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
