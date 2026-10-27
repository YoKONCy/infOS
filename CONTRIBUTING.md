# 参与 infOS / Contributing to infOS

欢迎一起改进 infOS！反馈问题、完善文档、改进交互和贡献代码，都很有帮助。这里的约定是为了让设计方向一致，也让大家少花时间反复补充信息。

Welcome! Bug reports, documentation, UX improvements and code contributions all help. These guidelines keep designs consistent and give reviewers enough context to help you.

**Issue 和 PR 任选中文或英文填写即可，不需要自己写双语。** 模板中的双语只是阅读提示。

**Please answer in either Chinese or English. You do not need to translate your answers.** The bilingual templates are here to help you read the questions.

## 先理解设计 / Start with the architecture

**实现与设计必须遵循项目的架构文档与理念。** 开始前阅读架构总纲，再按改动范围阅读对应主题；PR 中引用实际相关的文档章节，说明职责、依赖、数据归属和权限边界如何保持一致。

**Designs and implementations must follow the project's architecture and principles.** Start with the architecture overview, then read the documents relevant to your change. In your PR, reference the relevant sections and explain responsibility, dependency, data ownership and permission boundaries.

| 改动范围 / Area | 阅读入口 / Read first |
| --- | --- |
| 所有设计 / All designs | [A09 架构总纲 / Architecture](.docs/A09_AIOS_ARCHITECTURE.md) |
| 后端、持久化 / Backend and persistence | [A02 后端架构 / Backend](.docs/A02_BACKEND_ARCHITECTURE.md) |
| 前端与交互 / Frontend and UX | [A03 前端架构 / Frontend](.docs/A03_FRONTEND_ARCHITECTURE.md)、[S06 UI/UX](.docs/S06_UI_UX_DESIGN_SPEC.md) |
| 子应用与跨应用能力 / Application integration | [A10 应用集成 / Integration](.docs/A10_APPLICATION_INTEGRATION.md) |
| Package、插件与工具 / Packages, plugins and tools | [A06 扩展系统 / Packages](.docs/A06_EXTENSION_SYSTEM.md) |
| 平台与设备能力 / Platforms and devices | [A07 跨平台 / Cross-platform](.docs/A07_CROSS_PLATFORM.md) |
| 其他子系统 / Other subsystems | [技术文档导航 / Documentation index](.docs/README.md) |

尤其注意 / In particular:

- 人格、Thread、Execution 和 Application 各有职责；新功能应放入对应的权威层，前端只维护显示缓存与窗口偏好。
  Keep PrincipalAgent, Thread, Execution and Application responsibilities distinct. Put authoritative state in its owning layer; frontend state is limited to display caches and window preferences.
- 子应用遵循“主应用 → 主适配层 → 子适配层 → 子应用”的接入边界，保留自治能力；通过声明的协议、SDK 与 Capability 协作，不直接导入另一应用的私有服务。
  Preserve the host → host adapter → application adapter → application boundary and application autonomy. Use declared protocols, SDKs and capabilities instead of another application's private services.
- 权限、审批、取消和生命周期沿用通用入口；安装、启动或注册工具不会自动授予额外权限。
  Reuse the existing permission, approval, cancellation and lifecycle paths. Installation, startup and tool registration do not grant additional authority.
- 若设计需要改变这些约束，请先提交功能／设计 Issue，讨论取舍并获得维护者认可，再修改实现及权威文档。文档与源码有出入时请指出具体位置，先澄清契约。
  If your proposal changes these boundaries, open a feature/design issue and agree on the trade-offs with maintainers before implementation. Update the authoritative documentation too. If code and docs disagree, identify the discrepancy and clarify the contract first.

## 反馈问题或建议 / Opening an issue

请使用仓库的 [Issue 表单](https://github.com/YoKONCy/infOS/issues/new/choose)，先搜索一下是否已有相同反馈。

Please use the [issue forms](https://github.com/YoKONCy/infOS/issues/new/choose) and check for an existing report first.

- **问题反馈 / Bug report**：填写版本、安装与连接方式、环境、复现步骤、预期和实际结果，并提供相关日志或截图。源码版可以填写 commit；不了解的环境字段可以写“不确定”。
  Include the version, distribution, backend connection, environment, reproduction steps, expected/actual behavior and relevant logs or screenshots. Source installations may use a commit ID; “not sure” is fine for environment details you do not know.
- **功能／设计 / Feature or design**：描述实际场景、希望改善的行为及可能受影响的范围。架构提案说明相关文档和取舍；普通使用建议不要求了解内部实现。
  Describe your use case, desired behavior and likely impact. Architecture proposals should reference the relevant design and trade-offs; product suggestions do not require implementation knowledge.
- 日志暂时没有拿到时，请写明“未获取”及原因，不必猜测或编造。贴出足够定位的错误与前后文即可，上传前请隐藏密钥、令牌和私人聊天内容。
  If logs are unavailable, tell us why instead of guessing. Include the relevant error and surrounding context, and redact keys, tokens and private conversations before uploading.

## 准备开发环境 / Development setup

Node.js 推荐使用 [`.node-version`](.node-version) 指定版本，其他可用版本以根 [`package.json`](package.json) 的 `engines` 为准。pnpm 使用同一文件的 `packageManager` 版本；运行时安全基线见 [B27](.docs/B27_RUNTIME_SECURITY.md)。

Use the Node.js version in [`.node-version`](.node-version), or an alternative allowed by the root [`package.json`](package.json) `engines`. Use its `packageManager` pnpm version. See [B27](.docs/B27_RUNTIME_SECURITY.md) for runtime security requirements.

```bash
git clone https://github.com/YoKONCy/infOS.git
cd infOS
pnpm install --frozen-lockfile
pnpm start
```

外部贡献者可先 Fork，并在自己的分支上开发。启动方式、端口、Docker 和远程模式以 [A04 部署文档](.docs/A04_DEPLOYMENT.md) 为准，目录和依赖关系见 [A01](.docs/A01_PROJECT_STRUCTURE.md)。

External contributors can fork the repository and work on a branch. See [A04](.docs/A04_DEPLOYMENT.md) for startup, ports, Docker and remote mode, and [A01](.docs/A01_PROJECT_STRUCTURE.md) for package structure and dependencies.

## 编码与验证 / Code and verification

- 新增代码注释使用中文，标识符使用英文；只为有必要解释的契约、设计原因和边界写注释。未完成功能使用 `TODO`，完成后移除。
  Write new code comments in Chinese and identifiers in English. Explain contracts, reasoning and boundaries where useful. Mark unfinished work with `TODO` and remove the marker when finished.
- 界面、错误和日志通过对应端的 i18n 入口输出，维护简中、繁中和英文词条；后端日志使用 `createLogger`。见 [B25 国际化](.docs/B25_I18N.md) 和 [S03 日志](.docs/S03_LOGGING_SPEC.md)。
  Route UI text, errors and logs through the appropriate i18n entry point, with zh-CN, zh-TW and en-US translations. Use `createLogger` for backend logs. See [B25](.docs/B25_I18N.md) and [S03](.docs/S03_LOGGING_SPEC.md).
- 验证重点放在核心行为、关键边界和真实回归。优先改进已有测试，不机械追加冒烟测试、同义反复断言或源码字符串检查。见 [S04 测试规范](.docs/S04_TESTING_STANDARDS.md)。
  Verify core behavior, important boundaries and real regressions. Improve existing tests where possible; avoid redundant smoke tests, tautological assertions and source-text checks. See [S04](.docs/S04_TESTING_STANDARDS.md).
- 在 PR 中如实记录实际执行的命令、手动验证步骤、结果和未验证范围。使用编码 Agent 时还须遵守 [`AGENTS.md`](AGENTS.md) 的执行授权约定。
  Report the commands and manual checks you actually ran, their results and any gaps. Coding agents must also follow the execution authorization rules in [`AGENTS.md`](AGENTS.md).

常用检查按改动范围选择 / Choose checks relevant to your change:

```bash
pnpm test:run --maxWorkers=4
pnpm typecheck
pnpm exec tsc --noEmit
pnpm lint
pnpm format:check
pnpm version:sync --check
```

这些检查不代替界面实际运行或发行产物验收；也不要求为低影响改动一律执行全部检查。构建与发布流程见 [A08](.docs/A08_DEVOPS.md)。

These checks do not replace running the affected UI or validating release artifacts. Low-impact changes do not automatically require every check. See [A08](.docs/A08_DEVOPS.md) for build and release workflows.

## 前端运行截图 / Frontend screenshots

**前端相关 PR 必须在 PR 正文的截图栏直接附上本次变更实际运行的截图。** 可直接拖入图片，或用 Markdown／HTML 内嵌图片；只放页面链接、设计稿、CI 通过状态或“已验证”说明不符合要求。

**Frontend-related PRs must embed screenshots of the actual running change in the PR body's screenshot section.** Drag images into the editor or embed them with Markdown/HTML. A page link, mockup, passing CI status or “verified” statement does not satisfy this requirement.

- 修改已有界面时提供前后对比；新增界面提供变更后截图，并说明操作入口和状态。
  Provide before/after screenshots for an existing UI, or an after screenshot with the entry point and state for a new UI.
- 影响暗／浅主题时展示两种主题；动效和交互可补充 GIF 或短视频。按实际影响展示窄窗口、悬停、禁用、错误等相关状态。
  Show both themes when light/dark appearance is affected. Add a GIF or short video for motion or interactions, and show relevant narrow-window, hover, disabled or error states.
- 主前端、子应用客户端、Electron 开屏与窗口界面、浏览器扩展、Wiki 主题和共享界面资源都属于前端相关范围。仅后端／文档变更可以注明“不涉及前端”。
  This includes the main frontend, application clients, Electron splash/window UI, browser extensions, Wiki themes and shared UI assets. Backend/documentation-only PRs may state “No frontend changes.”
- 截图请对应本 PR 当前版本，隐藏隐私；不要复用无关旧图作为验证证据。
  Screenshots must represent the current PR revision. Redact private data and do not reuse unrelated images as evidence.

## 提交 PR / Opening a pull request

请保留 [PR 模板](.github/pull_request_template.md) 的六个问题，任选一种语言填写：问题与关联 Issue、改动范围、架构依据、实际验证、运行截图、兼容影响。简短具体即可；没有关联 Issue 或没有兼容影响时直接说明。

Keep the six questions in the [PR template](.github/pull_request_template.md) and answer in either language: problem/issue, changes, architecture, verification, screenshots and compatibility. Be concise and specific; explicitly say when there is no linked issue or compatibility impact.

PR 信息检查会在创建、修改说明、更新提交、重新打开或转为待审时执行，检查六栏是否填写，并按实际变更文件要求前端截图。Draft PR 也可提前获得缺项反馈。检查不评价架构质量，也无法证明图片真实对应变更；这些仍由审阅者核对。

The contribution check runs when a PR is opened, edited, synchronized, reopened or marked ready. It checks the six answers and requires embedded screenshots based on the changed files, including renamed frontend files. Draft PRs receive the same feedback. Architecture quality and screenshot relevance remain review responsibilities.

维护者上线该 workflow 后，应将 **`Contribution details`** 设为目标分支的必需状态检查；仅提交模板与 workflow 不会自动开启 GitHub 的分支保护。本检查仅以只读权限读取 PR 元数据、文件列表及默认分支的检查代码，不检出或执行 PR 代码，也不自动评论或关闭提交。

After deploying the workflow, maintainers should make **`Contribution details`** a required status check for the target branch. Templates and workflow files do not enable branch protection themselves. The check uses read-only permissions, PR metadata, file lists and checker code from the default branch. It does not check out or execute PR code, post comments or close submissions.

## 提交信息 / Commit messages

使用 Conventional Commits，正文可用中文或英文；说明具体问题与结果，复杂改动补充原因与验证范围。

Use Conventional Commits in Chinese or English. Describe the concrete problem and outcome; add reasoning and verification scope for substantial changes.

```text
<type>(<scope>): <description>
```

| 类型 / Type | 用途 / Purpose |
| --- | --- |
| `feat` | 新功能 / Feature |
| `fix` | 修复 / Bug fix |
| `refactor` | 重构 / Refactoring |
| `perf` | 性能 / Performance |
| `docs` | 文档 / Documentation |
| `test` | 测试 / Tests |
| `style` | 不改变行为的格式调整 / Formatting without behavior changes |
| `chore` | 工具、依赖与发行维护 / Tooling, dependencies and release maintenance |

`scope` 可使用 `backend`、`frontend`、`electron`、`shared` 或实际子系统名称。示例 / Examples:

```text
fix(backend): 保留社交导入时的特征关系
feat(frontend): 展示备份导入的冲突预览
docs(applications): clarify adapter ownership
```

感谢你花时间把问题和设计说清楚，也欢迎在开始前先交流！

Thanks for taking the time to explain the problem and design. Early discussion is always welcome!
