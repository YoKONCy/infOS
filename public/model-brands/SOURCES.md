# 模型与服务商品牌图形

来源：Lobe Icons，静态资源包 `@lobehub/icons-static-svg@1.95.1`。以下 SVG 保留原始内容，随应用本地提供。

TTS 补充：`microsoft-color.svg` 复用同一版本的微软品牌图形；`xiaomimimo.svg` 取自固定版本 `@lobehub/icons-static-svg@1.98.0`。MiMo 单色图形沿用主题遮罩，Edge TTS 以微软服务商品牌标识。

项目采用 MIT 许可，许可副本见 `LICENSE.lobe-icons.txt`。品牌图形属于相应品牌，用于标识模型或服务，不表示其对 infOS 的背书。

许可来源：[https://raw.githubusercontent.com/lobehub/lobe-icons/bcdb7c82792a854c2967f7328e11a30205ea584d/LICENSE](https://raw.githubusercontent.com/lobehub/lobe-icons/bcdb7c82792a854c2967f7328e11a30205ea584d/LICENSE)

核对来源：[Lobe Icons](https://github.com/lobehub/lobe-icons)、[Agnes 官方模型资产](https://huggingface.co/Agnes-AI/Agnes-3.0-Flash/tree/main/assets)、[OpenAI 品牌规范](https://openai.com/brand/)。

彩色图形使用原色；单色图形用遮罩呈现，深浅主题分别采用中性浅色与深色。像素边框与微立体感仅用于图标底座。

Kimi、OpenRouter、Yi、LongCat 的小尺寸展示采用库提供的单色版本，以保证深浅背景上的辨识度；对应彩色素材同时保留。

## 接入方式

- `packages/frontend/src/lib/modelBrands.ts` 统一管理图形、模型家族与服务商域名映射。
- `BrandIcon.vue` 呈现图形；`BrandSelect.vue` 通过 `PSelect` 的选项插槽复用选择行为。
- 模型按 `modelId` 识别，服务商按预设和显式 API 地址识别；二者独立。用户昵称不参与识别，未知模型或服务使用通用图标。
- 新品牌先添加本地 SVG 和来源记录，再补充映射；兼容协议类型不代表实际服务商品牌。

## 资源清单

- `microsoft-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/microsoft-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/microsoft-color.svg)
- `xiaomimimo.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.98.0/icons/xiaomimimo.svg](https://unpkg.com/@lobehub/icons-static-svg@1.98.0/icons/xiaomimimo.svg)

- `openai.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/openai.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/openai.svg)
- `anthropic.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/anthropic.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/anthropic.svg)
- `google-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/google-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/google-color.svg)
- `gemini-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/gemini-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/gemini-color.svg)
- `deepseek-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/deepseek-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/deepseek-color.svg)
- `zhipu-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/zhipu-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/zhipu-color.svg)
- `zai.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/zai.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/zai.svg)
- `kimi-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/kimi-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/kimi-color.svg)
- `moonshot.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/moonshot.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/moonshot.svg)
- `minimax-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/minimax-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/minimax-color.svg)
- `grok.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/grok.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/grok.svg)
- `xai.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/xai.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/xai.svg)
- `agnesai.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/agnesai.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/agnesai.svg)
- `qwen-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/qwen-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/qwen-color.svg)
- `doubao-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/doubao-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/doubao-color.svg)
- `hunyuan-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/hunyuan-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/hunyuan-color.svg)
- `mistral-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/mistral-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/mistral-color.svg)
- `groq.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/groq.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/groq.svg)
- `siliconcloud-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/siliconcloud-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/siliconcloud-color.svg)
- `bailian-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/bailian-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/bailian-color.svg)
- `volcengine-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/volcengine-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/volcengine-color.svg)
- `ollama.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/ollama.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/ollama.svg)
- `yi-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/yi-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/yi-color.svg)
- `stepfun-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/stepfun-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/stepfun-color.svg)
- `meta-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/meta-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/meta-color.svg)
- `gemma-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/gemma-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/gemma-color.svg)
- `cohere-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/cohere-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/cohere-color.svg)
- `openrouter-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/openrouter-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/openrouter-color.svg)
- `baai.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/baai.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/baai.svg)
- `jina.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/jina.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/jina.svg)
- `nvidia-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/nvidia-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/nvidia-color.svg)
- `longcat-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/longcat-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/longcat-color.svg)
- `baichuan-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/baichuan-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/baichuan-color.svg)
- `internlm-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/internlm-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/internlm-color.svg)
- `wenxin-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/wenxin-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/wenxin-color.svg)
- `spark-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/spark-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/spark-color.svg)
- `claude-color.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/claude-color.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/claude-color.svg)
- `kimi.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/kimi.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/kimi.svg)
- `openrouter.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/openrouter.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/openrouter.svg)
- `yi.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/yi.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/yi.svg)
- `longcat.svg`：[https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/longcat.svg](https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/longcat.svg)
