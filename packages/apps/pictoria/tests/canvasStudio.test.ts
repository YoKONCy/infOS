import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServiceClient } from '../src/serviceClient'
import { serviceSchema } from '../src/domain'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store'
import { PictoriaApplication } from '../src/application'
import { applyCanvasOperations, documentKey } from '../src/canvasDocument'
import { saveProvider } from '../src/providers'
import type { Project } from '../client/src/types'
import type { Step, ServiceProfile, HostPort } from '../src/domain'
import { defaultAssistantSettings, type AssistantSettingsRecord } from '../src/assistantSettings'

const fixtures: Array<{ store: Store; app: PictoriaApplication }> = []
const scope = { owner: 'studio-owner', callId: 'studio-call' }
function fixture(host?: HostPort) {
  const store = new Store(
    mkdtempSync(path.join(tmpdir(), 'pictoria-studio-')),
    fileURLToPath(new URL('../src/database/migrations', import.meta.url)),
  )
  const app = new PictoriaApplication(store, host)
  fixtures.push({ store, app })
  return { store, app }
}
afterEach(async () => {
  for (const { store, app } of fixtures.splice(0)) {
    await app.execution.stop()
    store.close()
    if (path.dirname(path.resolve(store.root)) !== path.resolve(tmpdir()))
      throw new Error('临时目录越界')
    rmSync(store.root, { recursive: true, force: true })
  }
})
function document(): Project {
  return {
    id: 'canvas',
    title: '画布',
    revision: 1,
    items: [
      {
        id: 'a',
        x: 100,
        y: 200,
        content: { version: 1, kind: 'text', width: 200, height: 100, text: '原文' },
      },
      { id: 'b', x: 400, y: 200, content: { version: 1, kind: 'text', width: 200, height: 100 } },
    ],
  }
}
describe('画布增量操作', () => {
  it('任一引用失败时不留下前序操作；禁止任意执行操作', () => {
    const before = document()
    expect(() =>
      applyCanvasOperations(before, [
        { type: 'move', id: 'a', x: 900, y: 0 },
        { type: 'rename', id: 'missing', name: '错误' },
      ]),
    ).toThrow('CANVAS_NODE_MISSING')
    expect(before.items[0]!.x).toBe(100)
    expect(() => applyCanvasOperations(before, [{ type: 'execute', code: 'anything' }])).toThrow()
  })
  it('分组移动保持子节点相对位置，解组后保留实际坐标', () => {
    const grouped = applyCanvasOperations(document(), [
      { type: 'group', id: 'group', ids: ['a', 'b'], name: '参考' },
      { type: 'move', id: 'group', x: 176, y: 252 },
      { type: 'ungroup', id: 'group' },
    ]).document
    expect(grouped.items.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: 'a', x: 200, y: 300 },
      { id: 'b', x: 500, y: 300 },
    ])
    expect(grouped.items.every((item) => item.content.groupId === undefined)).toBe(true)
  })
  it('草稿可以被后续连线引用，重复草稿 ID 被拒绝', () => {
    const result = applyCanvasOperations(document(), [
      { type: 'draft', id: 'draft', stepId: 'image', inputs: {}, x: 900, y: 200 },
      { type: 'connect', id: 'edge', source: 'a', target: 'draft', field: 'prompt' },
    ])
    expect(result.document.edges).toEqual([
      { id: 'edge', source: 'a', target: 'draft', field: 'prompt' },
    ])
    expect(result.drafts[0]?.stepId).toBe('image')
    expect(() =>
      applyCanvasOperations(document(), [
        { type: 'draft', id: 'same', stepId: 'image', inputs: {}, x: 0, y: 0 },
        { type: 'draft', id: 'same', stepId: 'image', inputs: {}, x: 0, y: 0 },
      ]),
    ).toThrow('CANVAS_DUPLICATE_ID')
  })
})
describe('画布上下文与持久会话', () => {
  it('助手设置按角色与画布隔离，并拒绝旧版本覆盖', async () => {
    const { app } = fixture()
    const settings = {
      ...defaultAssistantSettings(),
      generation: { temperature: 0, topP: 0, maxTokens: 2048 },
      historyMessages: 0,
    }
    const saved = (await app.invoke(
      'canvas.assistant.settings.save',
      { projectId: 'canvas', expectedRevision: 0, settings },
      scope,
    )) as AssistantSettingsRecord
    expect(saved.settings).toEqual(settings)
    expect(
      await app.invoke(
        'canvas.assistant.settings.get',
        { projectId: 'canvas' },
        { owner: 'other' },
      ),
    ).toMatchObject({ revision: 0, settings: { generation: {}, historyMessages: 12 } })
    expect(
      await app.invoke('canvas.assistant.settings.get', { projectId: 'another' }, scope),
    ).toMatchObject({ revision: 0, settings: { generation: {} } })
    await expect(
      app.invoke(
        'canvas.assistant.settings.save',
        { projectId: 'canvas', expectedRevision: 0, settings: defaultAssistantSettings() },
        scope,
      ),
    ).rejects.toThrow()
    expect(
      await app.invoke('canvas.assistant.settings.get', { projectId: 'canvas' }, scope),
    ).toMatchObject({ revision: saved.revision, settings })
  })
  it('主模型执行收到已配置参数和创作偏好，后续设置不改写已接受任务', async () => {
    const generate = vi
      .fn<HostPort['generate']>()
      .mockResolvedValue({ text: '{"message":"建议","operations":[]}' })
    const { app, store } = fixture({ generate })
    const settings = {
      ...defaultAssistantSettings(),
      generation: { temperature: 0, topP: 0.8, maxTokens: 2048, reasoningEffort: 'high' as const },
      timeoutSeconds: 90,
      instructions: '只写简短便签',
    }
    const step = (await app.invoke(
      'canvas.assistant.prepare',
      { projectId: 'canvas', settings },
      scope,
    )) as Step
    expect(app.catalog(scope.owner).map((entry) => entry.id)).not.toContain(step.id)
    const accepted = (await app.invoke(
      'task.submit',
      {
        stepId: step.id,
        stepRevision: step.revision,
        projectId: 'assistant:canvas',
        inputs: { prompt: '当前画布上下文' },
      },
      { ...scope, key: 'assistant-options' },
    )) as { taskId: string }
    await vi.waitFor(() => expect(store.run(accepted.taskId)?.state).toBe('completed'))
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      inputs: { prompt: '当前画布上下文' },
      options: {
        temperature: 0,
        topP: 0.8,
        maxTokens: 2048,
        reasoningEffort: 'high',
        timeoutMs: 90000,
      },
    })
    expect(generate.mock.calls[0]?.[0].modelId).toBeUndefined()
    expect(generate.mock.calls[0]?.[0].system).toContain('只写简短便签')
    const newer = (await app.invoke(
      'canvas.assistant.prepare',
      { projectId: 'canvas', settings: { ...settings, generation: { maxTokens: 4096 } } },
      scope,
    )) as Step
    expect(newer.id).not.toBe(step.id)
    expect(store.run(accepted.taskId)?.nodes[0]?.step.implementation).toMatchObject({
      options: { maxTokens: 2048 },
    })
  })
  it('隔离角色会话并拒绝旧序号提案，确认前不修改项目', async () => {
    const { app, store } = fixture(),
      project = document()
    await app.invoke(
      'project.save',
      {
        definition: { id: project.id, title: project.title, items: project.items },
        expectedRevision: 0,
      },
      scope,
    )
    await app.invoke(
      'canvas.context.set',
      {
        projectId: 'canvas',
        sessionId: 'window',
        sequence: 2,
        snapshot: { baseKey: documentKey(project), selected: ['a'] },
      },
      scope,
    )
    await app.invoke(
      'canvas.context.set',
      { projectId: 'canvas', sessionId: 'window', sequence: 1, snapshot: { selected: ['b'] } },
      scope,
    )
    const context = (await app.invoke('canvas.context.get', {}, scope)) as {
      sequence: number
      snapshot: { selected: string[] }
    }
    expect(context.sequence).toBe(2)
    expect(context.snapshot.selected).toEqual(['a'])
    expect(await app.invoke('canvas.context.get', {}, { owner: 'other' })).toEqual({ sessions: [] })
    const proposal = { message: '移动', operations: [{ type: 'move', id: 'a', x: 0, y: 0 }] }
    await expect(
      app.invoke('canvas.propose', { projectId: 'canvas', sequence: 1, proposal }, scope),
    ).rejects.toThrow('重新读取')
    const pending = (await app.invoke(
      'canvas.propose',
      { projectId: 'canvas', sequence: 2, proposal },
      scope,
    )) as { id: string; revision: number }
    expect(store.get<Project>(scope.owner, 'project', 'canvas')?.items[0]?.x).toBe(100)
    await app.invoke(
      'canvas.proposal.resolve',
      {
        projectId: 'canvas',
        id: pending.id,
        expectedRevision: pending.revision,
        state: 'rejected',
      },
      scope,
    )
    await expect(
      app.invoke(
        'canvas.proposal.resolve',
        {
          projectId: 'canvas',
          id: pending.id,
          expectedRevision: pending.revision,
          state: 'applied',
        },
        scope,
      ),
    ).rejects.toThrow('已处理')
  })
  it('独立助手引用加密供应商凭据，其他角色不能借用', async () => {
    const { app, store } = fixture()
    saveProvider(
      store,
      scope.owner,
      {
        id: 'private-model',
        name: '本机模型',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:8000/v1/',
        defaultModel: 'local-model',
        credential: 'private-key',
        enabled: true,
        requiresCredential: true,
      },
      0,
    )
    const step = (await app.invoke(
      'canvas.assistant.prepare',
      { projectId: 'canvas', providerId: 'private-model' },
      scope,
    )) as Step
    expect(step.implementation.kind).toBe('service')
    const service = store.get<ServiceProfile>(scope.owner, 'service', step.id)!
    expect(service.submit.body.model).toBe('local-model')
    expect(service.submit.outputs.text).toEqual({ path: 'choices.0.message.content', kind: 'text' })
    expect(JSON.stringify({ step, service })).not.toContain('private-key')
    expect(store.secret(scope.owner, service.credentialId!)).toBe('private-key')
    await expect(
      app.invoke(
        'canvas.assistant.prepare',
        { projectId: 'canvas', providerId: 'private-model' },
        { owner: 'other' },
      ),
    ).rejects.toThrow('兼容供应商')
  })
  it('独立视觉请求发送所选图片的真实内容，并在发送前拒绝过量图片', async () => {
    const { app, store } = fixture()
    const pixels = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz7sAAAAASUVORK5CYII=',
      'base64',
    )
    const asset = await app.assets.save(scope.owner, '参考图', 'image/png', pixels)
    const client = new ServiceClient(store, app.assets)
    const service: ServiceProfile = {
      ...serviceSchema.parse({
        id: 'vision',
        name: '视觉',
        baseUrl: 'http://127.0.0.1:8000/v1/',
        submit: {
          path: 'chat/completions',
          body: { model: 'vision-model', messages: [{ role: 'user', content: '' }] },
          fields: { 'messages.0.content': { from: 'prompt', format: 'openai_content' } },
        },
      }),
      revision: 1,
      hasCredential: false,
    }
    const request = vi.spyOn(client, 'request').mockResolvedValue({ text: '分析结果' })
    const inputs = { prompt: '观察光照', images: [{ assetId: asset.id }] }
    await client.submit(
      scope.owner,
      service,
      inputs,
      new AbortController().signal,
      'vision-request',
    )
    expect(request.mock.calls[0]?.[4]).toEqual({
      model: 'vision-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '观察光照' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${pixels.toString('base64')}` },
            },
          ],
        },
      ],
    })
    expect(inputs.images).toEqual([{ assetId: asset.id }])
    await expect(
      client.submit(
        scope.owner,
        service,
        { ...inputs, images: Array.from({ length: 5 }, () => ({ assetId: asset.id })) },
        new AbortController().signal,
        'too-many',
      ),
    ).rejects.toThrow('ASSISTANT_IMAGE_LIMIT')
    await expect(
      client.submit('other-owner', service, inputs, new AbortController().signal, 'wrong-owner'),
    ).rejects.toThrow()
  })
  it('项目保存保留各步骤的参考图用途记录', async () => {
    const { app } = fixture()
    const uses = [{ field: 'images', assetId: 'subject-image', purpose: 'subject' }]
    await app.invoke(
      'project.save',
      {
        expectedRevision: 0,
        definition: {
          id: 'purpose-canvas',
          title: '用途项目',
          items: [],
          creation: {
            stepId: 'image-edit',
            text: '原要求',
            inputsByStep: { 'image-edit': { images: [{ assetId: 'subject-image' }] } },
            referenceUsesByStep: { 'image-edit': uses },
          },
        },
      },
      scope,
    )
    const saved = (await app.invoke('project.get', { id: 'purpose-canvas' }, scope)) as Project
    expect(saved.creation?.text).toBe('原要求')
    expect(saved.creation?.referenceUsesByStep).toEqual({ 'image-edit': uses })
  })
})
