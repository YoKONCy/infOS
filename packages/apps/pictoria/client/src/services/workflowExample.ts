import { t as __t } from '../i18n'
import type { FieldSchema } from '../types'
import type { WorkflowDraft, WorkflowExampleStep, WorkflowNote } from '../workflowTypes'

const object = (
  properties: Record<string, FieldSchema>,
  required = Object.keys(properties),
): FieldSchema => ({ type: 'object', properties, required, additionalProperties: false })
const text = (title: string): FieldSchema => ({ type: 'string', title })
const images = (): FieldSchema => ({
  type: 'array',
  title: __t('apps.pictoria.ui', '图片'),
  items: object({ assetId: { type: 'string' } }),
})
const example = (
  name: string,
  kind: 'llm' | 'service',
  inputSchema: FieldSchema,
  outputSchema: FieldSchema,
  usageDescription: string,
): WorkflowExampleStep => ({ name, kind, inputSchema, outputSchema, usageDescription })

/** 示例只携带接口说明；不创建模型、API、凭据或可执行步骤。 */
export function createWorkflowExample(): WorkflowDraft {
  const note = (
    id: string,
    title: string,
    body: string,
    anchor?: string,
    x = 340,
    y = 0,
  ): WorkflowNote => ({ id, title, text: body, x, y, ...(anchor ? { anchor } : {}) })
  return {
    id: crypto.randomUUID(),
    name: '示例 · 从灵感到图片',
    revision: 0,
    usageDescription: __t(
      'apps.pictoria.ui',
      '输入画面创意、编辑要求和可选参考图。示例演示 LLM 润色 → 图像生成 → 多参考图编辑；各步骤的输入要求由作者自行声明。',
    ),
    inputSchema: object(
      {
        prompt: text('创意'),
        edit: text(__t('apps.pictoria.ui', '编辑要求')),
        references: {
          ...images(),
          title: __t('apps.pictoria.ui', '参考图'),
          default: [],
        },
      },
      ['prompt', 'edit'],
    ),
    outputSchema: object({ images: images() }),
    nodes: [
      {
        id: 'polish',
        label: __t('apps.pictoria.ui', '提示词润色'),
        x: 0,
        y: 0,
        comment: '',
        inputs: { prompt: { input: 'prompt' } },
        example: example(
          __t('apps.pictoria.ui', '提示词润色'),
          'llm',
          object({ prompt: text('创意') }),
          object({ text: text(__t('apps.pictoria.ui', '提示词')) }),
          __t(
            'apps.pictoria.ui',
            '接收创意文本，返回可直接交给下一步的提示词；提示词格式由实际绘图模型决定。',
          ),
        ),
      },
      {
        id: 'generate',
        label: __t('apps.pictoria.ui', '图像生成'),
        x: 0,
        y: 600,
        comment: '',
        inputs: { prompt: { node: 'polish', output: 'text' } },
        example: example(
          __t('apps.pictoria.ui', '图像生成'),
          'service',
          object({ prompt: text('提示词') }),
          object({ images: images() }),
          __t(
            'apps.pictoria.ui',
            '接收提示词并返回图片数组。请按所用模型声明自然语言、tags 或其他输入要求。',
          ),
        ),
      },
      {
        id: 'edit',
        label: __t('apps.pictoria.ui', '多参考图编辑'),
        x: 0,
        y: 1200,
        comment: '',
        inputs: {
          prompt: { input: 'edit' },
          images: {
            array: [{ node: 'generate', output: 'images' }, { input: 'references' }],
            flatten: true,
          },
        },
        example: example(
          __t('apps.pictoria.ui', '图像编辑'),
          'service',
          object({ prompt: text('编辑要求'), images: { ...images(), minItems: 1 } }),
          object({ images: images() }),
          __t(
            'apps.pictoria.ui',
            '接收编辑要求与按顺序排列的多张图片，返回编辑后的图片数组；数量和格式限制由模型决定。',
          ),
        ),
      },
    ],
    outputs: { images: { node: 'edit', output: 'images' } },
    io: { input: { x: 20, y: -450 }, output: { x: 20, y: 1800 } },
    routes: {},
    notes: [
      note(
        'overview',
        __t('apps.pictoria.ui', '从灵感到图片'),
        __t(
          'apps.pictoria.ui',
          '创意 → 润色 → 生成 → 编辑 → 输出。\n这是教学草稿，未配置模型或 API，不能直接运行。选中示范节点，在右侧选择已有步骤或点“配置步骤”。配置并校验通过后，再运行或发布。\n备注仅用于说明，不会发给模型或进入执行参数。',
        ),
        undefined,
        -500,
        -450,
      ),
      note(
        'input-note',
        __t('apps.pictoria.ui', '输入 · 接收创作需求'),
        __t(
          'apps.pictoria.ui',
          '创意和编辑要求是文本，参考图是可选数组。\n这些字段就是工作流发布后供画布或 Agent 填写的入口。',
        ),
        '__input',
      ),
      note(
        'polish-note',
        __t('apps.pictoria.ui', 'LLM · 提示词润色'),
        __t(
          'apps.pictoria.ui',
          '此节点把“创意”交给 LLM，输出 text。\n步骤决定使用哪个模型和系统提示词。请按下游模型要求润色；并非强制转换提示词格式。\n尚未配置：LLM 模型。',
        ),
        'polish',
      ),
      note(
        'generate-note',
        __t('apps.pictoria.ui', 'API · 图像生成'),
        __t(
          'apps.pictoria.ui',
          '此节点引用上一节点的 text，输出 images。\n步骤负责 API 地址、认证、字段映射和异步查询；连线只传递数据。\n尚未配置：图像生成 API。',
        ),
        'generate',
      ),
      note(
        'edit-note',
        __t('apps.pictoria.ui', 'API · 多参考图编辑'),
        __t(
          'apps.pictoria.ui',
          '此节点把生成图片与上传参考图按顺序合并，展开为一个数组，再配合编辑要求提交。\n可在右侧调整引用顺序、来源与固定参数。\n尚未配置：图像编辑 API。',
        ),
        'edit',
      ),
      note(
        'output-note',
        __t('apps.pictoria.ui', '输出 · 交付结果'),
        __t(
          'apps.pictoria.ui',
          '将编辑节点的 images 暴露为工作流输出。\n发布后，这条工作流会成为可复用的“步骤”。内部节点与接口仍可继续编辑。',
        ),
        '__output',
      ),
    ],
  }
}
