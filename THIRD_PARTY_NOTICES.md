# 第三方许可声明

本仓库的部分源码移植或改编自以下开源项目。各文件头注明了具体来源；原许可证全文如下。

## Roo Code（Apache-2.0）与 SafeVault（MIT）参考

- Roo Code： https://github.com/RooCodeInc/Roo-Code/tree/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16 。参考 `src/services/checkpoints/ShadowCheckpointService.ts` 的会话检查点、前后差异和恢复职责；后端使用独立实现的 SHA-256 内容寻址及冲突检查，没有移植其 VS Code / simple-git 执行代码。`packages/backend/src/services/home/homeFiles.ts` 的搜索排除目录取自 `excludes.ts` 的小部分并缩减，保留 Roo Code contributors 署名；排除不作用于备份。Apache-2.0 全文见仓库根 [LICENSE](LICENSE)。该版本根目录没有单独 NOTICE。
- SafeVault： https://github.com/Justin-147/safevault/tree/17c131d46d27ebe4d800c181890de43026f69268 。参考内容寻址、恢复前检查和批量变化保护的设计，独立实现 TypeScript 服务，没有复制 Python 源文件。Copyright (c) 2026 Justin-147，MIT；原文见该版本 [LICENSE](https://github.com/Justin-147/safevault/blob/17c131d46d27ebe4d800c181890de43026f69268/LICENSE)。

这些参考均用于后端 `services/home/`，不涉及私仓专用或无许可证代码。

## dsh-computer-use-win（MIT）

- 项目：https://github.com/Yu-tao-Li/dsh-computer-use-win （衍生自 https://github.com/cgissing/windows-computer-use ，同为 MIT）
- 用到的部分：`scripts/windows-uia.ps1` 中的 Windows.Media.Ocr 文字识别助手；PrintWindow → Windows.Graphics.Capture → 屏幕区域的窗口截图退路与黑帧检测；Chromium 页面无障碍树的唤醒做法。
- 落在本仓库：`electron/main/services/windowsVisionSource.ts`、`windowsDesktopCaptureSource.ts`、`windowsDesktopUiaSource.ts`（C# 源码，已按本项目的桥接协议改写）与 `desktopWindowCapture.ts`（退路顺序与黑帧检测）。
- 参考设计（独立实现，未复制源码）：`wait_for` 的「轮询 + 超时、看到才报 observed」，落在 `electron/main/services/desktopWaitFor.ts`；中键按下/松开标志与 `Get-ButtonFlags` 一致，落在 `windowsDesktopHandsSource.ts`。

```
MIT License

Copyright (c) 2026 Yu-tao-Li
Copyright (c) 2026 cgissing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## clawdcursor（MIT）

- 项目：https://github.com/AmrDab/clawdcursor
- 用到的部分：`src/core/sense/ui-map-fuse.ts` 的 UI 融合做法——无障碍树与 OCR 结果按「同位置（IoU ≥ 0.5）且同文字」合并、两路一致时标记确认，再统一编号成元素图。
- 落在本仓库：`electron/main/services/desktopElementMap.ts`（按本项目的数据结构重写，并补充了「无名控件用 OCR 文字补名」「文档正文覆盖的 OCR 片段丢弃」两条规则）。
- 参考设计（独立实现，未复制源码）：按 `{element_id, snapshot_id}` 操作（编号只在所属快照里有效），落在 `electron/main/services/desktopHandsRef.ts`；`expect` 做「操作后核对」、没生效明确报出，落在 `desktopVerify.ts`。

```
MIT License

Copyright (c) 2025-2026 Amr Dabbas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## sherpa-onnx-node（Apache-2.0）

- 来源：<https://github.com/k2-fsa/sherpa-onnx>，作为 npm 依赖 `sherpa-onnx-node@2.0.1`（含平台包 `sherpa-onnx-win-x64`）引入，许可证随包分发。
- 用到的部分：「耳朵」的 silero VAD 切段与 SenseVoice 离线识别（`electron/main/services/ears/`）。
- 识别模型不随仓库与安装包分发，由用户在设置里点击下载：silero VAD（MIT，snakers4/silero-vad）、SenseVoice Small（FunASR 模型许可，见 <https://github.com/modelscope/FunASR>）。

## 进程回环录音的参考来源（MIT）

- 用到的部分：「耳朵」按进程排除 infOS 自己声音的 C# 助手（`electron/main/services/ears/earsLoopbackSource.ts`）。代码按本项目需要重写，没有复制源文件；COM 接口声明（`IActivateAudioInterfaceCompletionHandler`、`IAudioClient`、`IAudioCaptureClient` 等，按 Windows SDK 头文件的方法顺序）与激活流程参考了以下两处：
  - Microsoft Windows-classic-samples 的 ApplicationLoopback 示例：<https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback>，Copyright (c) Microsoft Corporation，MIT License。
  - NAudio 的进程回环支持（`WasapiCapture.CreateForProcessCaptureAsync`）：<https://github.com/naudio/NAudio>，Copyright 2020 Mark Heath，MIT License。
- 两者许可条款与上方 MIT 全文相同（版权行不同）。

