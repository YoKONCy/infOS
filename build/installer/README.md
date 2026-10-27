# Windows 安装与卸载展示层

仅标准安装版通过 `electron-builder.standard.yml` 的 `beforePack` 和 `nsis.include` 接入。使用 electron-builder 原安装脚本，不替换解压、更新、卸载、注册表及快捷方式实现，不修改其依赖模板。

- `installer.nsh`：安装首页与选项、MUI 安装进度页外观、完成页，以及卸载分支入口。选项页只创建一次，返回后保留输入值。提权时传递目录与快捷方式选择，取消提权留在原页面。重装保留现有安装目录。
- `presentation.nsh`：安装与卸载共用资源初始化、控件布局及品牌；美术和字体在操作前提取到 `$PLUGINSDIR`，程序目录被移除后仍可显示结果页。
- `uninstaller.nsh` / `uninstall-pages.nsh`：卸载确认、双重安装时的范围选择、真实进度、结果页，以及中止后的失败展示。不替换文件删除、快捷方式、注册表、运行进程检查或提权实现。
- `InfosSetup.cpp` / `.def`：x86 Unicode NSIS 展示插件。原生直角窗口、Pero 图、官方字标、分段进度条、按钮、右侧切页和随机提示；原控件保留实际进度及详情。切页不移动左侧插画或品牌。
- `assets/`：定稿 SVG 派生的静态 PNG，按两倍分辨率导出；正式安装器不读取高密度 SVG 母稿。品牌 SVG 为可追溯的轻量源文件。
- `messages.cjs` / `uninstall-messages.cjs`：原文与 NSIS 标识映射；三语言文案分别保存在共享资源的 `electron/ui/installer.json`、`electron/ui/uninstaller.json`，编译前生成 `LangString`。
- `generated/`：忽略的构建产物；只有正式打包钩子编译，不提交 DLL、OBJ、LIB 或 EXP。

`scripts/prepare-installer.cjs` 在 Windows 标准版打包时调用 Visual Studio 的 x86 编译环境，使用静态 C++ 运行库。CI 原有 Visual Studio C++ 环境可复用；本地打包同样需要 MSVC x86 工具。并发架构的钩子共用一个准备任务，避免同一进程重复编译插件。

安装页退场约 90ms、入场约 180ms；系统减弱动效时使用 60ms/80ms 的短淡入淡出。提示每隔 9–13 秒随机轮换，一轮内不重复且轮次交界避免连续重复，手动按钮支持键盘操作；后台、最小化及页面销毁时暂停或释放相应资源。提示不驱动安装进度，也不触发完成页面。

进度页以 40ms 定时器读取 NSIS 原控件的真实状态，只有进度或状态文字变化时才重绘进度区域，提示切换只重绘提示区域。动画状态由定时器推进并保证提交结束帧，绘制过程只读取快照。`WM_PAINT` 使用 Windows [Buffered Paint](https://learn.microsoft.com/en-us/windows/win32/api/uxtheme/nf-uxtheme-beginbufferedpaint) 在离屏缓冲中完成背景和动态内容，再一次提交失效区域；缓冲服务在初始化时启用，宿主销毁时释放。`WM_PRINTCLIENT` 仍直接绘入切页快照提供的 DC。切页时停止旧定时器，旧页面的迟到消息不修改当前页的进度与动效状态。

## 快捷方式与安装后启动

Electron 44 的 Windows 通知激活器从 EXE 的 `ProductName` 取名，并自动创建或修正当前用户开始菜单的同名 `.lnk`，写入运行中 EXE、空参数及通知 AppUserModelID。仅区分开发版和正式版 AppUserModelID 无法避免同名链接互相覆盖。`scripts/dev-electron.mjs` 因此给开发运行时的原生产品名追加固定技术标识 `[dev]`，并更新缓存修订号；正式版产品名和窗口品牌保持不变。开发模式继续通过 `pnpm start` 等开发脚本启动，通知生成的开发入口不作为发行入口。上游行为见 [通知快捷方式注册](https://github.com/electron/electron/blob/v44.9.3/shell/browser/notifications/win/windows_toast_activator.cc#L227) 与 [原生产品名读取](https://github.com/electron/electron/blob/v44.9.3/shell/common/application_info_win.cc#L36)。

electron-builder 更新时可能保留已有快捷方式。安装节的 `customInstall` 在其快捷方式处理之后，将仍存在的官方开始菜单和桌面链接重绑到本次安装的 `$appExe`，同步图标、工作目录和正式 AppUserModelID，避免继续指向开发运行时缓存或旧安装目录。已删除的链接不主动重建，桌面快捷方式仍遵守安装选项与 `--no-desktop-shortcut`。安装完成页及上游自动启动入口直接使用已安装 EXE，不将快捷方式目标当作启动权威。开发运行时的名称和图标不构成发行身份，正式程序入口由安装目录中的应用包决定。

## 卸载界面

和安装页使用相同的 1040×652 原生直角窗口、左侧 Pero 插画、右侧官方字标及操作区、底部版本栏，沿用同一套轻量切页动效。确认页的数据说明使用细蓝边面板；默认保留聊天记录、记忆与配置，不新增清理数据复选框。原有 `--delete-app-data` 参数和编译时清理策略只用于如实展示，实际处理仍由 electron-builder 的原卸载节执行。

卸载进度读取 NSIS 控件，复用分段进度、可折叠执行详情和独立的随机提示。完成后检查程序目录残留；有残留显示未完成和“打开安装目录”，中止则原地保留错误详情及关闭入口。存在系统重启标记时展示待重启状态，只有明确点击“立即重启”才调用 NSIS 重启指令。

失败展示在进度页 LEAVE 回调中用 `IfAbort` 判断；`un.onUninstFailed` 只设置失败退出码。NSIS 的该回调在关闭失败窗口时才执行，不能依靠它提前展示错误页面；失败关闭按钮转发原生取消入口。回调顺序已对照 [NSIS 3.0.4 UI 源码](https://github.com/kichik/nsis/blob/v304/Source/exehead/Ui.c)。

当前 electron-builder 26.15.3 的标准卸载页序列没有独立的进度展示钩子。项目在 `customUnWelcomePage` 展开时，使用 NSIS 的 [`!macroundef`](https://nsis.sourceforge.io/Docs/Chapter5.html#macroundef) 重绑两个 MUI 页面声明工厂：进度仍使用 `MUI_PAGEDECLARATION_INSTFILES`，完成页换成自定义页面。没有设置 `nsis.script`，不绕开 electron-builder 生成和签名卸载器的流程，也不修改 `node_modules`。安全升级后已人工核对这些入口和调用顺序；尚未构建或运行安装器，后续升级仍需复核。

`/S` 静默卸载和更新中的旧版本卸载不会显示这些页面。只存在一份安装时，原范围页自动跳过；同时存在当前用户和所有用户安装时，仅重新排布原页面控件，仍使用原来的选择与 UAC 行为。卸载回调使用 `un.` 命名空间。
