/**
 * 桌面操作护栏（阶段 2）：分区名单的校验、分区判断、审批决定与“放宽 / 收紧”判断
 *
 * 高危操作只有一份定义：内置名单 `safety-lists.draft.json`（与本文件同目录）。两层都读它：
 * - 桌面操作护栏（Electron `desktopGuard.ts`）：禁区 / 高危区程序、高危窗口标题与快捷键；
 * - 工具执行审批（后端 `toolExecutor.ts`）：`highRiskTools`（终端与脚本执行）与 `sensitiveResources`
 *   （hosts、开机启动项与计划任务、环境变量与 Shell 启动脚本、受信任证书、注册表与系统目录），
 *   加上工作区外删除，见 `isHighRiskToolCall`。
 * 高危操作在任何执行模式下都必须由用户本人确认。infOS 自身的外壳、主题与卡片不经过这里。
 *
 * - 用户设置：Electron 用户数据目录的 `desktop-safety.json`（普通区模式、追加的禁区 / 高危区、信任名单）。
 *
 * 按职责拆分：`desktopSafetyModel`（常量与结构）、`desktopSafetyNormalize`（归一化）、
 * `desktopSafetyValidation`（名单校验）、`desktopSafetyZones`（分区与审批决定）、
 * `desktopSafetyResources`（工具执行的高危操作）；本文件统一再导出。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 2
 */

export * from './desktopSafetyModel'
export {
  isModifierKey,
  normalizeHotkey,
  normalizeKeyName,
  normalizeProgramName,
  splitHotkey,
} from './desktopSafetyNormalize'
export * from './desktopSafetyValidation'
export * from './desktopSafetyZones'
export * from './desktopSafetyResources'
