# 运行时与依赖安全基线

> 最后复核：2026-10-25。覆盖本轮 Node.js、Electron 及完整依赖审计发现的问题。
> 当前策略：按用户明确选择保留 Electron 稳定版，独立 Node 与 Electron 内嵌 Node 分别核验基线。内嵌 Node 与独立安全基线的差异保留警告，不宣称相关漏洞已经修复。文内包含历史验收记录，实际发行结果以最新标签流水线为准。

## 运行时版本

- 基线集中在 `scripts/runtime-security-policy.json`。独立 Node 分支下限为 22.23.4、24.22.1、26.12.1；Electron 内嵌 Node 使用单独的 24.22.0 兼容下限。未知主版本与预发布版本继续阻断。
- 开发依赖、发行基础配置及锁文件的 Electron 版本必须完全一致；当前锁定稳定版 44.9.3。
- `scripts/rebuild-daemon-deps.mjs` 从 Electron 包声明读取目标版本，避免本机 ABI 重编译仍停留在旧版本。
- `.node-version` 固定 Node 22.23.4，CI 使用该文件；Docker 构建与后端运行镜像同步使用 `node:22.23.4-bookworm-slim`。
- 根包 engines 只接受达到当前安全基线的 Node 分支；安装已有旧包的用户仍需后续安全版本升级，源码配置不会改变既有安装程序。

Electron 44.9.3 的官方组件记录仍标注 Node 24.22.0，低于独立 Node 的 24.22.1 安全基线。Node 更新已合并到上游 44-x-y 分支，但尚未提供对应稳定包。用户明确选择修改门禁并保持稳定版，因此在 Electron 模式按内嵌兼容下限放行，同时输出差异警告；这不构成 Node 本轮漏洞已经全部修复的证据。

内置 Daemon 通过 Electron 可执行文件的 Node 模式运行，因此只升级宿主机 Node 无法修复该路径。发布检查读取实际二进制的 `process.versions`，不能使用 CI 构建机 Node 或 npm 类型声明代替。

## 发布门控

1. `pnpm security:runtime` 检查当前 Node、声明与锁文件、Electron 打包配置及 Docker 镜像基线。
2. `pnpm security:electron` 检查本地 Electron 实际运行时。探测清除继承的 `NODE_OPTIONS`，不打开 GUI，不加载应用与用户数据。
3. Release 的标准、Steam 与便携构建均在业务构建前检查 Electron。
4. electron-builder 的 beforePack 再检查一次；标准版安装器钩子先执行同一检查，再准备展示插件。
5. afterPack 检查最终解包 EXE 的实际版本；签名、归档与发包不能绕过内嵌 Node 安全基线。

已下载 Electron 44.9.3 官方预编译运行时并以 Node 模式只读探测，确认实际内嵌 24.22.0。调整后的门禁保留实际二进制检查、稳定版下限、版本匹配和内嵌兼容下限。独立 Node 模式仍拒绝 24.22.0；不能借 Electron 兼容策略放宽 CI、Docker 或 Linux 的独立 Node 要求。

## 依赖更新与本地回补

本轮更新 Electron Builder、HTTP / WebSocket、MCP、Drizzle、Vue、Vite、压缩、XML、代理与工具链等依赖，并使用分支约束避免旧的传递依赖继续解析到已知漏洞版本。所有变更由 `package.json` 和 `pnpm-lock.yaml` 保存；pnpm install 使用 ignore-scripts，没有运行原生编译。

两条旧依赖链采用明确的本地回补：

| 公告 | 原因 | 补丁与边界 |
| --- | --- | --- |
| GHSA-ch52-4w7c-c8xp | http-cache-semantics 4.2.0 没有上游修复版本 | 安全清零或不可存储条目必须重新验证，客户端 max-stale 不能重新启用；覆盖 cookie、private、no-store、no-cache、Vary 与正常公开缓存 |
| GHSA-5v7r-6r5c-r473 | nut-js → Jimp 仍使用 CommonJS file-type 16；不能直接换入 ESM 21 并假定 API 兼容 | 检查 ASF 子头的整数、最小尺寸及文件剩余长度，阻止负的负载长度使解析游标回退；保留 CommonJS API 与合法 PNG 识别 |

补丁在 `patches/`，由 pnpm patchedDependencies 应用；`scripts/security-backports.json` 精确记录公告、包版本、补丁 SHA-256 及回归测试。

`pnpm security:audit` 调用 npm 官方审计端点，保留完整原始结果，再核验回补：包名、公告、全部发现版本、补丁内容、清单与锁文件必须匹配，回归测试也必须通过。同包的新公告、混入其他版本或失效补丁仍会失败。网络错误和不完整报告不能当作零漏洞。

`pnpm security:audit:raw` 输出未分类的原始扫描结果。扫描器仍可能报告上述两个原版本的告警；不能将它们描述为上游审计已清零。原始报告与核验结果分别存于 `TEMP/security-audit/raw.json`、`evaluation.json`，CI 保存为审阅产物。

## Electron 安全边界与兼容调整

- Windows 透明窗口不能设置 Electron 的 `backgroundMaterial`，包括 `none`，也不能调用 `setBackgroundMaterial('none')`。Electron 44 的该实现会把 DWM 客户区边距归零并切换合成状态，导致透明区域变为黑底。桌宠、独立开屏与通知覆盖层改用现有 koffi 直接写入 `DWMWA_SYSTEMBACKDROP_TYPE=DWMSBT_NONE`，仅关闭系统背景，保留 Electron 的逐像素透明合成；旧系统或原生组件不可用时保留原透明配置。隔离实窗验证复现了旧方案的 RGB(18,18,18) 黑底，并验证新方案在首次显示及重新显窗后均能透出后方测试窗口；记录位于 `TEMP/transparent-window-check/result.json`。这不代替打包后的完整应用及第三方美化工具兼容验收。

- Vite 6 默认的依赖预打包目标包含 Safari 14.0，与升级后的 esbuild 0.28 解构语法处理不兼容，会导致 Vue 依赖预打包失败并触发开发进程整体退出。`scripts/vite-browser-compat.ts` 统一保留 ES2020、Chrome 87、Edge 88、Firefox 78，并将 Safari 下限调整为 14.1；Arca、Pictoria、Web 和 Electron 渲染器均显式配置依赖预打包目标。Web 正式输出也使用同一范围，两个子应用已有的 ES2022 输出范围保持不变。不能只设置 `build.target`、伪造 `supported`，或回退已修复安全问题的依赖。定向回归覆盖实际 Vue 响应式源码及四个配置入口；依赖预打包检查结果保存在 `TEMP/vite-compat/result.json`。

- 主窗口明确启用 sandbox、contextIsolation、webSecurity，关闭 Node 集成、webview 与不安全混合内容；调用者的额外选项不能覆盖这些安全设置。
- 桌宠移除 webSecurity=false。模型 asset 协议只接受只读请求，拒绝不匹配的网络 Origin，并为正式 file 页面与精确开发来源提供 CORS 响应。
- 外部浏览器使用独立 Session，权限请求与权限检查均默认拒绝；原有原生弹窗拒绝策略保留。
- 适配 Electron 新版异步剪贴板与 ClipboardItem；写入必须等待成功再回传，失败不能被吞掉。
- electron-builder 升至 26.15.3 后已人工核对自定义安装 / 卸载页宏入口与顺序；实际安装、卸载、透明窗口、模型加载及原生模块兼容仍须在获准构建后验收。

## 验证边界与后续事项

### 窗口激活命令注入修复（Issue #78）

`activate_window` 已删除 Windows、macOS、Linux 三个平台将 `target` 拼入 Shell 或脚本的降级分支。窗口激活只委托已注入的客户端 `WindowProvider`；缺少提供者返回 `WINDOW_ACTIVATION_UNAVAILABLE`，提供者执行失败返回 `WINDOW_ACTIVATION_FAILED`，两种情况都不会启动本机命令。空白或非字符串目标返回 `WINDOW_TARGET_REQUIRED`，合法中文、引号及括号名称继续作为普通数据传递。

参数错误、能力不可用及执行失败提示已维护三语言词条。新增回归用例使用模拟提供者与被拦截的命令执行函数，覆盖三平台缺少提供者、提供者失败、特殊字符名称、非法参数及本地化；本次仅修改并人工审阅，尚未执行这些用例、类型检查、构建或发布。

### 既有安全基线验证记录

- 本轮获准执行依赖审计、类型检查与相关定向单测；全包及测试代码类型检查通过，主批 16 文件 / 131 项及补充的运行时与办公交换定向用例通过。依赖门禁核验两份本地回补并通过对应回归测试；原始扫描仍报告这两个旧版本公告。日志位于 TEMP/security-hardening 与 TEMP/security-audit。
- 未执行构建、原生编译、安装卸载、真实账号登录或攻击复现；没有提交或发布改动。
- 待上游 Electron 内嵌 Node 安全补丁可用后，优先更新稳定版本并消除差异警告；继续执行构建前及产物二进制门控。
- 待 http-cache-semantics 发布修复版、Jimp 链迁移后，优先移除本地回补及对应核验记录。

### 0.9.6 非构建验收

- Windows 本地全量测试通过：439 个文件、2876 项用例；工作区、Vue 模板及测试代码类型检查通过，ESLint 为 0 错误、16 条非阻断警告。
- 运行时配置、当前 Node 与 Docker 静态接线检查通过。运行时 pnpm 升至 10.34.5，Zod 升至 4.6.7 并迁移记录类型与递归 Schema，happy-dom 升至 21.0.4；全依赖安全门禁通过，继续核验两份精确回补。
- 富文本净化回归改用 DOMPurify 官方支持的 jsdom 环境，避免 happy-dom 对净化流程的兼容缺陷掩盖危险属性；生产环境仍使用浏览器原生 DOM。
- 初次验收时，Electron 44.9.3 内嵌 Node 24.22.0 被共用的 Node 24.22.1 基线阻断。之后按用户明确选择拆分两种基线；Electron 稳定版按兼容下限核验并保留警告，独立 Node 的安全补丁要求不变。
- 本地未执行构建、打包或容器启动。源码与标签可正常同步，桌面发行完成与否以标签流水线实际结果为准。

### 正式版本号下的工作区审计误报

pnpm 9 与 10 的审计会将 `electron/` importer 的路径末段与应用版本 `0.9.6` 组合，误报成 npm 的 `electron@0.9.6`；这与真实锁定的 `electron@44.9.3` 不同。预发布版本号不匹配相关漏洞范围，版本同步前的审计因此未暴露该问题。

审计评估同时核验 importer 对应的真实清单与完整锁文件：仅识别私有、真实名称不同于路径末段、版本完全相同、无依赖路径，且锁文件没有同名同版本实际依赖的 finding。任一条件缺失仍按原公告阻断；混合公告保留所有真实依赖 finding。原始报告不改写，核验记录单独保存，并附上锁文件证据。额外回归覆盖误报、真实依赖、peer 后缀、混合公告、路径、名称、私有性和锁文件缺失边界。此修正不改变 Electron 实际二进制安全门禁。

云端构建另暴露 Wiki 的 VitePress 入口仍使用默认 Safari 14.0 目标，Mermaid 依赖在 esbuild 0.28 的解构转换阶段失败。该入口补齐与 Web 相同的 `browserTargets` 及依赖预打包目标，配置回归覆盖第五个入口；不回退安全依赖、不伪造语法支持。本地仅验证配置与定向测试，实际构建继续交由 CD。
- 后续安全公告需继续更新分支基线；每日 Dependabot 不会自动证明 YAML 固定版本和内嵌运行时已修复。

官方来源：[Node 2026-10 安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)、[Electron 44.9.3 组件](https://releases.electronjs.org/release/v44.9.3)、[Electron 证书安全公告](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)。
