import { t as __t } from './i18n'
import type { Store } from './store'
import type { Assets } from './assets'
import { serviceSchema, stepSchema, type ServiceProfile } from './domain'
import { validate } from './schema'

interface VideoModel {
  id: string
  name: string
  adapter: 'atlascloud' | 'apimodels'
  maxImages: number
  imageModel?: string
  fields: Record<string, Record<string, unknown>>
}
const choice = (title: string, values: string[], fallback: string) => ({
  type: 'string',
  title,
  enum: values,
  default: fallback,
})
export const videoModels: VideoModel[] = [
  {
    id: 'alibaba/wan-2.6/text-to-video',
    imageModel: 'alibaba/wan-2.6/image-to-video',
    name: 'Wan 2.6',
    adapter: 'atlascloud',
    maxImages: 1,
    fields: {
      duration: {
        type: 'integer',
        title: __t('apps.pictoria.ui', '时长（秒）'),
        enum: [5, 10, 15],
        default: 5,
      },
      resolution: choice('分辨率', ['720p', '1080p'], '720p'),
      aspect_ratio: choice('画面比例', ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9'),
      negative_prompt: {
        type: 'string',
        title: __t('apps.pictoria.ui', '负面提示词'),
        maxLength: 4000,
      },
      generate_audio: {
        type: 'boolean',
        title: __t('apps.pictoria.ui', '生成音频'),
        default: true,
      },
      enable_prompt_expansion: {
        type: 'boolean',
        title: __t('apps.pictoria.ui', '优化提示词'),
        default: true,
      },
    },
  },
  ...['grok-video-3', 'grok-video-3-10s'].map((id) => ({
    id,
    name: id.endsWith('10s') ? 'Grok Video 3 · 固定计价' : 'Grok Video 3',
    adapter: 'apimodels' as const,
    maxImages: 7,
    fields: {
      duration: {
        type: 'integer',
        title: __t('apps.pictoria.ui', '时长（秒）'),
        enum: [6, 10, 15],
        default: id.endsWith('10s') ? 10 : 6,
      },
      size: choice('分辨率', id.endsWith('10s') ? ['720P', '1080P'] : ['480P', '720P'], '720P'),
      aspect_ratio: choice('画面比例', ['16:9', '9:16', '1:1', '2:3', '3:2'], '16:9'),
    },
  })),
  ...['veo-3.1', 'veo-3.1-fast-fhd', 'veo-3.1-fast-hd'].map((id) => ({
    id,
    name:
      id === 'veo-3.1'
        ? 'Veo 3.1'
        : id.endsWith('fhd')
          ? 'Veo 3.1 Fast · 1080p'
          : 'Veo 3.1 Fast · 720p',
    adapter: 'apimodels' as const,
    maxImages: 2,
    fields: { aspect_ratio: choice('画面比例', ['16:9', '9:16'], '16:9') },
  })),
]
export const videoOptions = (adapter: string) =>
  videoModels
    .filter((model) => model.adapter === adapter)
    .map(({ id, name, maxImages }) => ({ id, name, maxImages, mode: 'video' as const }))
export function configureVideo(
  store: Store,
  owner: string,
  adapter: 'atlascloud' | 'apimodels',
  id: string,
) {
  const model = videoModels.find((model) => model.adapter === adapter && model.id === id)
  if (!model) throw new Error('视频模型不存在')
  const serviceId = `${adapter}.video`,
    stepId = `builtin.${adapter}.video-generate`,
    brand = adapter === 'atlascloud' ? 'AtlasCloud' : 'APIModels'
  const service = serviceSchema.parse({
    id: serviceId,
    name: `${brand} · ${model.name}`,
    adapter,
    credentialId: `provider:${adapter}`,
    baseUrl:
      adapter === 'atlascloud' ? 'https://api.atlascloud.ai' : 'https://api.apimodels.app/v1/',
    requiresCredential: true,
    submit: {
      path: adapter === 'atlascloud' ? '/api/v1/model/generateVideo' : 'video/generations',
      body: {
        model: model.id,
        ...Object.fromEntries(
          Object.entries(model.fields).flatMap(([name, field]) =>
            field.default === undefined ? [] : [[name, field.default]],
          ),
        ),
      },
      taskIdField: 'data.id',
      outputs: { videos: { path: 'data.outputs', kind: 'video' } },
    },
    poll: {
      path:
        adapter === 'atlascloud'
          ? '/api/v1/model/prediction/{id}'
          : 'video/generations?task_id={id}',
      stateField: 'data.status',
      success: ['completed'],
      failed: ['failed'],
      intervalMs: 5000,
    },
    timeoutMs: 3600000,
    requestTimeoutMs: 90000,
    recoveryWindowMs: 21600000,
    concurrency: 2,
  })
  const previous = store.get<ServiceProfile>(owner, 'service', serviceId)
  store.put(
    owner,
    'service',
    { ...service, hasCredential: Boolean(store.secret(owner, `provider:${adapter}`)) },
    previous?.revision ?? 0,
  )
  const asset = {
    type: 'object',
    properties: { assetId: { type: 'string' } },
    required: ['assetId'],
    additionalProperties: false,
  }
  const step = stepSchema.parse({
    id: stepId,
    name: '视频生成',
    enabled: true,
    usageDescription: `${brand} 的 ${model.name}。使用自然语言描述动作、场景和镜头。参考图片可选，按顺序提供最多 ${model.maxImages} 张 PNG/JPEG/WebP，每张不超过 10 MB。${id.startsWith('veo-') ? '固定 8 秒，参考图顺序为首帧、尾帧。' : adapter === 'atlascloud' ? '参考图决定起始画面；无参考时按比例生成。' : '多图作为人物与场景参考。'}参数遵循 schema，未声明的字段不可传入。`,
    inputSchema: {
      type: 'object',
      ...(model.imageModel || id.startsWith('veo-')
        ? { 'x-pictoria-video': { startFrameField: 'images' } }
        : {}),
      properties: {
        prompt: {
          type: 'string',
          title: __t('apps.pictoria.ui', '提示词'),
          minLength: 1,
          maxLength: 20000,
        },
        images: {
          type: 'array',
          title: __t('apps.pictoria.ui', '参考图片'),
          items: asset,
          maxItems: model.maxImages,
          default: [],
        },
        ...model.fields,
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { videos: { type: 'array', items: asset, minItems: 1 } },
      required: ['videos'],
      additionalProperties: false,
    },
    implementation: { kind: 'service', serviceId },
  })
  const oldStep = store.get<{ revision: number }>(owner, 'step', stepId),
    saved = store.put(owner, 'step', step, oldStep?.revision ?? 0)
  store.put(owner, 'step-version', { id: `${saved.id}:${saved.revision}`, snapshot: saved }, 0)
}
type Request = (
  path: string,
  method: string,
  body: unknown,
  beforeSend?: () => void,
  uploadKey?: string,
) => Promise<unknown>
export async function submitVideo(
  owner: string,
  service: ServiceProfile,
  inputs: Record<string, unknown>,
  assets: Assets,
  request: Request,
  upload: (source: unknown, slot: number) => Promise<string>,
  beforeSend?: () => void,
) {
  const model = videoModels.find(
    (model) => model.adapter === service.adapter && model.id === service.submit.body.model,
  )
  if (!model) throw new Error('视频模型未适配')
  const payload: Record<string, unknown> = { ...service.submit.body, prompt: inputs.prompt }
  for (const name of Object.keys(model.fields))
    if (inputs[name] !== undefined) payload[name] = inputs[name]
  validate(
    {
      type: 'object',
      properties: { prompt: { type: 'string', minLength: 1, maxLength: 20000 }, ...model.fields },
      required: ['prompt'],
      additionalProperties: false,
    },
    Object.fromEntries(Object.entries(payload).filter(([name]) => name !== 'model')),
  )
  if (
    inputs.images !== undefined &&
    (!Array.isArray(inputs.images) || inputs.images.length > model.maxImages)
  )
    throw new Error(`最多 ${model.maxImages} 张参考图片`)
  const sources = Array.isArray(inputs.images) ? inputs.images : [],
    images: string[] = []
  for (let index = 0; index < sources.length; index++) {
    const file = await assets.file(owner, sources[index], 10 * 1024 * 1024)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.blob.type))
      throw new Error('视频参考图支持 PNG、JPEG、WebP')
    images.push(await upload(sources[index], index))
  }
  if (service.adapter === 'atlascloud') {
    if (images.length) {
      payload.model = model.imageModel
      payload.image = images[0]
      delete payload.aspect_ratio
    } else {
      const sizes: Record<string, string[]> = {
        '16:9': ['1280*720', '1920*1080'],
        '9:16': ['720*1280', '1080*1920'],
        '1:1': ['960*960', '1440*1440'],
        '4:3': ['1088*832', '1632*1248'],
        '3:4': ['832*1088', '1248*1632'],
      }
      payload.size = sizes[String(payload.aspect_ratio)]![payload.resolution === '1080p' ? 1 : 0]
      delete payload.resolution
      delete payload.aspect_ratio
    }
  } else if (images.length) payload.images = images
  return request(service.submit.path, 'POST', payload, beforeSend)
}
