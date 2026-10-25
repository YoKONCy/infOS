# 工作模式文档能力

主 Agent 使用统一工具 `document`，以 `action` 选择操作。工具只在 Thread 工作模式开放，普通调用与 NIT 子调用执行同一权限检查；不属于系统协议工具或高级工具包。极简、聊天及据点群聊不开放。

## 操作

| action | 行为 |
| --- | --- |
| capabilities | 返回当前可用输入格式、输出格式、PDF 引擎、限制与 workbook 示例 |
| inspect | 检查文件摘要、标题、表格数量和内嵌资源清单 |
| read | 提取 Markdown，按 offset/limit 分页，返回 nextOffset；内嵌图片转为可用附件引用 |
| export | 从工作区文件、当前会话附件、Markdown 正文或结构化 workbook 生成成果 |

工具定义保持稳定，环境差异在 capabilities 结果中体现，不根据连接状态每轮改写 schema。文档生成不结束 ReAct，也不自动交付；生成后继续检查，使用现有 `send_file` 发送。

```json
{"action":"capabilities"}
```

```json
{"action":"read","source":"attachment:附件ID","offset":0,"limit":12000}
```

```json
{"action":"export","source":"周末行程/行程.md","format":"pdf","output":"周末行程/行程.pdf"}
```

## 导出

- MD：提取文字内容，保留原文件。Office 内嵌图片可通过 read 获取；不承诺原始版式无损往返。
- DOCX：由 docx 生成标题、段落、列表、基础文本强调、表格和 PNG/JPEG 图片，可继续用 Word 等应用编辑。
- XLSX：由 ExcelJS 生成工作表，支持类型化单元格、显式公式及缓存结果、表头、冻结和筛选。公式不在服务端自动求值；普通等号字符串保持文本。
- PDF：默认 PDFKit，通用服务端无需 Electron。支持随包中文字体、标题、正文、列表、分页表格和 PNG/JPEG 图片。
- Chromium PDF：显式传 `engine: "chromium"`。在线 Electron 提供 `document.render/renderPdf`，后端按次申请能力句柄。独立后台页面不使用用户的浏览器标签、账户会话或键鼠席位。断连、取消或失败时返回工具错误，不偷偷换引擎，也不终止整个 ReAct。

PDF/DOCX 支持 `template: standard|compact`、`paper: A4|Letter`、`landscape` 和 `marginMm`。PNG/JPEG 图片优先使用相对于 Markdown 源文件的工作区路径，也支持当前会话 `attachment:ID`。在线图片先保存到任务目录；转换器不直接访问外部网址。Office 转文稿时，图片集中附于文末，并在结果中说明版式变化。

XLSX 的结构化输入示例：

```json
{
  "action": "export",
  "format": "xlsx",
  "output": "周末行程/预算.xlsx",
  "workbook": {
    "sheets": [{
      "name": "预算",
      "columns": ["项目", "金额"],
      "rows": [["交通", 120], ["住宿", 300], ["合计", {"formula":"SUM(B2:B3)","result":420}]]
    }]
  }
}
```

也可通过 source 读取同结构 JSON。Markdown 表格按文本导出；有多张表格时要求 tableIndex 从 1 开始显式选择，不把整篇文章猜成工作簿。不支持以 Markdown 中间格式无损编辑已有工作簿。

## 文件、附件与恢复

输出限定在当前执行工作区的子目录。省略 output 时保存在 `documents/<任务或会话ID>/`。按内容哈希区分生成版本，禁止覆盖已有不同内容，相同字节可复用。普通任务与后台 task 分别使用既有执行工作区。

二进制成果通过 VirtualWorkspace 的同文件队列、真实路径校验、临时文件同步与原子创建落盘；发布时不替换夹入的人工文件。普通会话新建文件记录原始字节哈希并接入会话回滚；后台任务沿用独立工作区。用户修改后按现有哈希保护保留文件。

上传支持 Office 原件。无外部 PDF 解析来源时，PDF 仍可保存并在工作模式按需读取；已有 PDF/OCR 来源保留原处理流程。当前消息与历史消息均保留附件引用，原件不会随滑窗丢失。内嵌图片通过现有工具图片预览绑定到回复。

## 运行与发行

- docx、ExcelJS、PDFKit、anydoc 与 Markdown 解析器是 backend 生产依赖，不进入移动客户端。
- anydoc 在独立 Worker 内离线解析，拒绝自动调用 hosted OCR；取消或超时终止解析任务。扫描 PDF 返回需 OCR 的说明。
- 默认中文字体位于 `backend/src/assets/documents/document-font.woff2`，复用项目已有 ZCOOL KuaiLe 字体，并随附 OFL。`INFOS_DOCUMENT_FONT` 可指定服务端物理字体路径，供 PDFKit 使用。
- Electron 与 Docker 的现有 backend assets 复制规则包含字体。无需另装 Office、Python、LibreOffice 或 Chromium。
- 发行依赖收集保留文档库实际解析到的依赖版本，并检查当前平台 anydoc 原生模块，避免 Node 开发目录可用、发行包缺模块。
- 单次原文件/成果各限 20MB，正文读取每页最多 32000 字符，工作簿最多 50000 单元格；服务端并发 2 个文档任务，总时限 60 秒。Chromium 页面另设 30 秒和 4MB HTML 限制。

## 维护入口

后端领域入口为 `packages/backend/src/services/document/documentService.ts`。修改解析、生成或导出时，通过真实原件读回验证分页、中文、工作簿值类型与公式；只检查文件头或 mock 库成功返回不能证明文档可用。已有回归入口为 `packages/backend/tests/unit/services/documentService.test.ts`。

同时保护工作模式准入、输出根、禁止覆盖、大小/并发限制和取消释放。文档资源的投递与客户端预览继续遵循 [B12](./B12_MESSAGE_RESOURCES.md) 与 [B14](./B14_WORKSPACE_FILE_PREVIEW.md)，不在文档服务重复实现附件协议。
