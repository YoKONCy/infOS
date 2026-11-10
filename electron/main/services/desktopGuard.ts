/**
 * @file 桌面操作护栏
 * @description 阶段 2（精简版）：角色操作用户电脑（桌面自动化的点击、键入、启动程序）之前，按目标程序分区并审批。
 *
 *              - 名单：内置草案 `packages/shared/src/safety-lists.draft.json`（与工具执行审批共用，打包进应用，需审阅定稿）+ 用户数据目录
 *                `desktop-safety.json`（普通区模式、追加的禁区 / 高危区、信任名单；用户可手动编辑，加载时校验）。
 *              - 用户文件带签名：在应用外修改（包括角色的文件工具）时，收紧的部分立即生效，放宽的部分要用户在
 *                设置页点「接受修改」并在原生确认框中同意；之前接受过的版本另存为 `desktop-safety.accepted.json`。
 *              - 审批用主进程原生对话框：页面脚本与角色都不能代替用户点击；infOS 自己的进程在禁区内，
 *                角色也不能用桌面自动化点它。审批后焦点已变化，执行类动作要求角色重新观察后再执行一次。
 *              - 角色可以收紧设置（立即生效）、申请放宽（原生确认框）、提交任务预批、关闭总开关；不能打开总开关。
 *
 *              按职责拆分：`desktopGuardModel`（通道与结构）、`desktopGuardCore`（名单、设置与审批）、
 *              `desktopGuardPrompt`（原生对话框）、`desktopGuardHandlers`（单例与接入点）；本文件统一再导出。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 2
 * @module electron/main/services/desktopGuard
 */

export * from './desktopGuardModel'
export * from './desktopGuardCore'
export * from './desktopGuardPrompt'
export * from './desktopGuardHandlers'
