# 运行时与依赖安全基线

本文说明运行时选择、依赖审计和发行门禁的维护契约。版本下限与公告来源由策略文件维护，验证结果留在 CI 与审计产物中；文档不凭历史通过记录宣称当前依赖安全。

## 两类 Node 运行时

| 执行路径 | 实际运行时 | 判定依据 |
| --- | --- | --- |
| 源码后端、Linux 服务、Docker、CI 脚本 | 独立 Node.js | `nodeMinimums` |
| Electron 内置 Daemon 的 Node 模式 | Electron 内嵌 Node.js | `electronEmbeddedNodeMinimums` 及 Electron 基线 |

策略入口为 `scripts/runtime-security-policy.json`，实现入口为 `scripts/runtime-security.cjs`。独立 Node 与 Electron 内嵌 Node 分开判断，未知主版本与预发布版本按门禁规则拒绝。兼容放行不能表述为相应安全漏洞已修复；内嵌版本低于独立安全下限时保留差异警告，不能用该兼容规则放宽 Docker 或 Linux 的独立 Node 要求。

Electron 的开发依赖、锁文件和发行配置必须一致。升级宿主 Node 不会改变内置 Daemon 的内嵌运行时；检查实际可执行文件的 `process.versions`，不能使用构建机 Node 或类型声明代替证据。

## 发行检查链

1. `security:runtime` 核对当前 Node、清单、锁文件、Electron 配置及 Docker 镜像基线。
2. `security:electron` 探测本地 Electron 二进制。探测清除继承的 `NODE_OPTIONS`，不加载应用或用户数据。
3. 标签流水线在业务构建前执行检查，标准版、Steam 和便携版遵守同一规则。
4. `scripts/electron-security-before-pack.cjs` 在打包入口检查；安装器钩子不能绕过该入口。
5. `scripts/electron-security-after-pack.cjs` 核验最终解包产物的实际版本，避免下载缓存或构建配置导致产物偏离声明。

更新运行时时同时审阅 `.node-version`、根 `package.json`、`pnpm-lock.yaml`、Electron 发行配置、Dockerfile 与工作流。具体下限以策略 JSON 为准，避免在多个文档复制版本数字形成第二权威源。

## 审计与精确回补

`scripts/dependency-security.cjs` 调用官方审计端点，保留原始报告并单独记录评估结果。网络失败、不完整报告或缺失证据不能当作零漏洞。入口 `security:audit:raw` 输出原始结果，`security:audit` 进行分类、回补核验和门控。

回补清单为 `scripts/security-backports.json`，每项绑定公告、包名、精确版本、补丁文件、SHA-256 与回归测试。pnpm 的 patchedDependencies、锁文件、实际补丁和清单必须一致；同包新公告、其他版本、补丁失效或回归失败仍须阻断。

| 回补对象 | 必须保护的行为 |
| --- | --- |
| http-cache-semantics 的缓存重新验证 | 清零或不可存储的响应不能被客户端 max-stale 重新启用；保留正常公开缓存，覆盖 Cookie、private、no-store、no-cache、Vary 边界 |
| file-type 的 CommonJS 兼容链 | ASF 子头的整数、最小尺寸和剩余长度合法，解析游标不能因负负载倒退；同时保留合法图片识别与既有 CommonJS API |

回补不改变上游版本号，原始扫描仍可能报告原公告。报告位于 `TEMP/security-audit/raw.json` 与 `evaluation.json`，CI 保存审阅产物；不能称为“上游已修复”或删除原始 finding 来制造清零结果。上游发布兼容修复后，优先升级并成套删除补丁、清单条目和例外核验。

### 私有工作区 importer 误报

审计可能把工作区 importer 路径末段与应用版本组合成同名 npm 包。评估器只有同时满足私有包、真实名称不同、版本完全匹配、无真实依赖路径、完整锁文件不存在同名同版本依赖等条件时，才识别为工作区误报。任一证据缺失按原公告处理；混合 finding 必须保留真实依赖部分。该分类不改变 Electron 二进制门禁。

## 应用安全边界

- 主窗口固定 sandbox、contextIsolation、webSecurity，关闭 Node 集成、webview 与不安全混合内容；额外窗口选项不能覆盖安全设置。
- 桌宠资源协议只接受只读请求，校验 Origin；正式 file 页面与精确开发来源分别处理 CORS，不能关闭 webSecurity 解决资源加载问题。
- 外部浏览器使用独立 Session，权限请求与权限检查默认拒绝；网页内容不获得宿主权限。
- 窗口激活只委托客户端 `WindowProvider`，目标名称按普通数据传递，不拼入 Shell 或脚本。缺少提供者、非法目标和执行失败分别返回稳定错误，不能降级为本机命令执行。
- 异步剪贴板写入必须等待成功；未完成写入不能提前返回成功。

生产力运行时的软件策略和 OS 隔离边界见 [B01](./B01_PRODUCTIVITY_RUNTIME.md)；设备身份、Capability 与 Realm 的调用授权见 [M02](./M02_CAPABILITY_GATE.md) 和 [A09](./A09_AIOS_ARCHITECTURE.md)。

## 原生依赖与兼容维护

仓库通过 npm 接入 TriviumDB、node-pty、better-sqlite3 等原生依赖，不维护这些依赖的 Rust 源码或 Cargo 工程。`scripts/rebuild-daemon-deps.mjs` 按 Electron 声明重建指定 ABI 依赖，`scripts/collect-daemon-deps.mjs` 收集实际运行文件。升级时分别核对 ABI、存储格式、资源路径与目标架构；源码依赖能安装不代表安装包完整。

Windows 透明窗口不能通过 Electron `backgroundMaterial`（包括 none）关闭系统背景，该路径可能破坏透明合成。现有实现使用 koffi 调用 DWM 仅关闭系统 backdrop，原生接口不可用时保持透明配置。维护者应检查桌宠、开屏与通知层的首次显示和重新显窗，不能以普通不透明窗口替代验证。

前端语法目标集中于 `scripts/vite-browser-compat.ts`。依赖预打包和正式输出分别使用明确目标，Web、Electron、子应用和 Wiki 入口都须审阅；只改 build.target 不能解决 optimizeDeps 的语法兼容问题，也不能伪造 supported 掩盖编译器限制。

## 维护顺序与故障定位

先确认失败属于版本声明、实际二进制、上游审计、回补证据还是资源收集，再修改对应权威文件。门禁失败应保留真实错误，不跳过检查或把检查对象换成构建机运行时。需要兼容例外时明确范围、保留差异，并记录消除条件。

补丁回归入口由回补 JSON 指定；运行时与审计分类用例分别为 `packages/shared/tests/runtimeSecurity.test.ts`、`dependencySecurity.test.ts`。回归应验证过旧运行时、混入真实漏洞依赖、缺失锁文件和被修改补丁等失败路径。执行任何测试、静态检查或构建前仍遵守根目录 AGENTS.md；具体结果属于执行记录，不写入本文。
