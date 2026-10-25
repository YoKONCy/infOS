# 工作区文件浏览

## 文件入口

文件树、已打开标签与聊天中的工作区文件引用共用中央文件标签页。文本继续使用编辑器；图片、GIF、SVG、PDF、音频、视频使用只读浏览器。文件与会话绑定当前 Agent 的工作区，符号链接与绝对路径仍经过 VirtualWorkspace 边界校验。

## 预览器

- 图片与 GIF：适应窗口、原始尺寸、缩放、拖动查看、透明棋盘底。GIF 在可见时正常播放。
- SVG：清理主动内容及外部 href，再以 Blob 图像显示，不内联进应用 DOM；预览上限 4 MB。
- PDF：使用 PDF.js 按页读取，支持翻页、跳页、缩放、文字复制、逐页查找、密码输入。扫描页没有文字层时，查找不会执行 OCR。
- 音视频：像素播放器、进度、时长、音量、静音、倍速；视频支持全屏。默认不自动播放，编码兼容范围由客户端决定，失败时提供系统打开和下载。
- 未识别的二进制：显示文件信息，提供下载和系统打开。

每个文件保存自己的缩放、页码与播放进度；切换文件不保留后台解码器。离开工作区、切换桌面应用标签、隐藏窗口时暂停媒体并释放 PDF Worker；返回后保留阅读位置。后台刷新文件不抢当前文件焦点，文件变动后重建预览。

## 内容接口

- `GET /api/workspace/file`：文件描述，仅读取最多 8 KB 文件头，签名优先识别类型。
- `GET /api/workspace/content`、`HEAD`：受工作区边界保护的文件流，支持单段 Range、下载和版本校验。文件变化时返回冲突，避免跨版本拼接音视频/PDF。
- `POST /api/workspace/open-file`：解析当前工作区文件，Electron 本机打开；Web 客户端可请求执行节点打开。

原生媒体请求沿用已有 API 查询参数鉴权，PDF 与音视频无需先读取整个文件。浏览本身不调用 LLM、PDF 解析服务或入库。协作栏只传文件路径与元信息，二进制文件不会进入文本读取校验；Agent 读图仍按需调用 `read_image`。

## 离线资源

PDF 阅读组件按需加载。两种 Vite 入口共用 `pdfAssetsPlugin`，提供本地 CMap、标准字体、WASM 与 ICC 资源；用户构建时写入前端资源目录，无 CDN 依赖。附带对应许可证。

PDF 渲染与画布生命周期依据 [PDF.js 官方示例](https://mozilla.github.io/pdf.js/examples/)，接口类型以固定依赖版本为准。

## 维护入口与运行限制

入口为 `packages/frontend/src/components/workspace/WorkspaceFilePreview.vue`，PDF、图片与媒体分别由同目录 `WorkspacePdfViewer.vue`、`WorkspaceImageViewer.vue`、`WorkspaceMediaViewer.vue` 承接，类型识别见 `packages/backend/src/services/workspace/workspaceFileType.ts`。

音视频是否可播放取决于客户端编解码器，不能仅凭扩展名承诺支持。PDF 乱码先检查本地字体/CMap 等资源及实际响应，文件切换后旧请求和画布必须释放。预览与工作区写入分离，截断预览不能保存为完整文件；版本与写入契约见 [B01](./B01_PRODUCTIVITY_RUNTIME.md)。
