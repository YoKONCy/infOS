# 桌面自动化

## 执行边界

Windows 桌面输入由 Electron 的 `desktopControl` 统一串行化，复用 Capability、聊天／工作模式和现有审批。模型思考期间不锁住用户桌面。内置浏览器继续走独立的页面工具。

`Input Seat` 确认客户端归属；桌面控制权版本用于拒绝用户接管前的旧观察与排队动作。控制服务只在内存中保存观察，重启不会恢复坐标动作。

## 工具协议

1. `take_screenshot` 返回 `observationId`、目标窗口、截图坐标信息。可以指定 `windowId`、`displayId`；`includeElements` 返回带编号的元素图，`ocr` 识别画面文字，`annotate` 在截图上叠加编号，`watch` 持续盯一个窗口并可同时听、陪看。观察分三种视角（结果 `observation.scope`）：
   - `window`：传了 `windowId`。客户端先等用户空闲（不在用户打字时抢焦点），再经桥接 `focus` 把目标切到前台（最小化的先还原；直接切换被前台锁拦下时临时挂接前台线程的输入队列再试，300ms 内核对），然后按窗口区域截图。infOS 自己的窗口（进程号等于主进程）只看不切。切换失败或用户正忙时照常截图，但观察只供查看，`observation.blockedCode` 为 `DESKTOP_FOCUS_DENIED` / `DESKTOP_USER_BUSY`，`notice` 给出下一步建议。
   - `region`：局部放大，沿用参考观察的窗口与可否操作。
   - `screen`：没传 `windowId`。不再默认绑定前台窗口（用户在 infOS 里聊天时前台就是 infOS 这个禁区），只供查看，引用它操作返回 `DESKTOP_WINDOW_REQUIRED`。
   结果另带 `observation.windowState`（`minimized`、`occluded`、`elevated`）；被遮挡时 `notice` 说明截图混入了上层窗口；目标以更高权限运行时只供查看（`DESKTOP_TARGET_ELEVATED`，模拟输入会被 Windows 静默拦下）。元素图里的框都是截图坐标。
2. `automation_execute` 引用观察执行。可以按元素编号 `ref`（见下文「手」），或给控件 ID 用 UIA 的 invoke、set_value、toggle、select、expand、collapse、scroll；给了 `elementId` 而控件不支持该操作时报 `DESKTOP_PATTERN_UNSUPPORTED`，由模型重新观察后明确选择坐标操作，不自动降级（按编号时才由系统按「元素优先、坐标退路」选择）。
3. 原生输入支持点击、双击、三击、中键、修饰键加点击、移动、拖拽、滚轮、Unicode 文本、快捷键（含标点、小键盘、媒体与音量键）与按住／释放。按住操作最多保留两秒；停止与异常只清理执行器持有的键和鼠标。
4. 动作发出后先等画面稳定再返回新观察：每 150ms 按观察区域采样一张小灰度指纹（`desktopFrame.ts`，32 列网格的平均亮度），连续两次平均差异不超过 0.4% 即视为稳定，上限默认 1500ms，可用 `settleTimeoutMs`（200～5000）调整；结果带 `settle{stable, waitedMs, samples}`。回读截图沿用动作前的视角：窗口观察仍截同一窗口，局部观察仍截同一块 DIP 区域；动作关掉或最小化了目标窗口时改截整屏并带 `targetClosed: true`，不当作结果不明。发出动作后执行器即释放输入控制，等待与回读期间用户动鼠标只让新观察标注为可能变化，不触发接管暂停。`wait` 可等待 100～3000 毫秒后重新观察，带 `until` 时改为等条件（见下文）。动作已发送不等于业务目标已完成：结果带 `verify`（见下文「每步回读」），模型仍要依据画面、控件或实际产物验证。
5. 执行类动作经分区护栏（`desktopGuard`）审批。用户批准后不再一律要求重新观察：护栏返回 `prompted`，`desktopControl` 核对目标窗口进程与位置没变、把目标切回前台（审批框抢走了焦点）、再按观察区域采样比对画面指纹（差异超过 3% 视为变化）。都通过就直接执行并用掉这次“允许这一次”；否则返回 `DESKTOP_APPROVED_REOBSERVE`，批准保留两分钟，只对完全相同的动作意图有效一次。用户点审批按钮造成的控制权版本变化在这条路径上由画面比对代替。

观察绑定调用方、窗口句柄与进程、窗口边界、显示器布局和控制权版本，有效期由「眼睛」偏好 `observationTtlSec` 决定（60～1800 秒，默认 600；原来固定两分钟）。用户动鼠标键盘仍让注入类引用立即失效，有效期只解决「看完之后思考太久」。一次操作后旧观察失效。窗口区域截图仅包含所选显示器上的可见区域；跨屏窗口可以指定显示器分别观察。

### 引导与工具位置

内置 Skill `desktop-operation`（`packages/backend/src/skills/desktop-operation/SKILL.md`）讲桌面操作的完整流程：`get_active_windows` 找 `windowId` → `take_screenshot` 传 `windowId` 切前台并观察 → 优先元素编号或控件、坐标兜底定位 → `automation_execute` 操作 → 按 `verify`、返回画面与 `settle` 核对，需要时等窗口或文字出现，直通操作用 `desktop_direct`，以及常见错误码的处理。`take_screenshot` 常驻工具清单。`automation_execute`、`get_active_windows`、`activate_window` 属于高级工具包 `computerUse`（「桌面操作」），但客户端「桌面操作」总开关打开时常驻工具清单（`DESKTOP_RESIDENT_TOOLS`，`packages/backend/src/tools/advancedTools.ts`）：`AgentService.prepareRuntimeContext` 在每次执行开始时经 `desktop.environment/control` 的 `status` 读一次总开关（Electron 在状态里附带 `enabled`，读不到按关闭处理），结果作为 `residentTools` 传给 ReAct、执行器与 NIT 脚本检查，同一次执行内不变。这样总开关开着时工具清单在整个会话里稳定，不会因中途展开工具包让提示词缓存失效；代价是这三个工具的说明与参数（约 2.8K 字符）每轮都带上。总开关关闭时它们照旧留在包里，需要先 `expand_advanced_tools`；`get_mouse_position`、`desktop_direct`、`open_application`、`desktop_plan`、`desktop_safety` 始终在包里。`automation_execute` 的 `ref`、`expect`、`until`、`modifiers` 等参数说明只留一句，用法细节放在 Skill。常驻不授予权限：展开入口被关闭或未获授权时同样不出现，能力检查、审批与总开关的执行期拦截照常。

### 截图：三级退路与编码

窗口观察按 `desktopWindowCapture.ts` 取画面：窗口没被遮挡时直接裁屏幕（最快，和用户所见一致）；被遮挡时先用桥接的 `capture` 请求走 PrintWindow（`PW_RENDERFULLCONTENT`，裁到 DWM 可见边框），抽样检测到全黑（UWP、WinUI、DirectComposition 常见）就改用 Windows.Graphics.Capture，两者都失败才退回屏幕裁剪；WGC 成功返回的暗色或纯黑画面保留，不按颜色判失败。三级都失败时按窗口状态报第 0 步的错误码（如 `DESKTOP_WINDOW_MINIMIZED`），并在消息后附前两级原因。结果的 `capture{method, fallbacks, format, bytes}` 记录实际方法；用窗口自身画面时 `notice` 提醒「点击被挡住的位置会点到上层窗口」。观察记下截图方法，局部放大、批准后核对画面、动作后回读都沿用同一方法。

PrintWindow 与 WGC 都写成原始 BGRA 文件（系统临时目录 `infos-desktop`，读后即删），由 `nativeImage.createFromBitmap` 读回并统一改为不透明。WGC 在视觉助手里实现：经 `IGraphicsCaptureItemInterop` 按 HWND 建捕获项、自由线程帧池取一帧、`SoftwareBitmap.CreateCopyFromSurfaceAsync` 取像素，只用 .NET Framework 的 csc 即可编译。

编码同时生成 JPEG 与 PNG 取更小的：照片类画面 JPEG 小得多，纯色界面和大段文字往往 PNG 更小且无损。JPEG 质量来自「眼睛」偏好 `vision.imageQuality`（50～95，默认 80），局部放大不低于 90，保存在「桌面与家」统一配置里（见下文）。非 Windows 的旧截图路径保持 PNG。

### 文字层与元素图

- **视觉助手**：OCR 与 WGC 要引用 WinRT 元数据，`Add-Type` 编不了，改用系统 `csc.exe` 编译 `windowsVisionSource.ts`，按源码哈希缓存到用户数据目录 `desktop-bridge/infos-vision-*.dll`（`windowsVisionHelper.ts`）。桥接按字节加载（先比对编译时记下的 SHA-256，见「编译缓存的完整性」）并反射调用。WinRT 调用放在单独的 MTA 线程（执行线程是 STA，同步等 WinRT 有死锁风险），等待可取消、有超时；超时不会强制终止原生线程。上一个工作线程尚未退出时拒绝新视觉任务，工作线程结束时清理被放弃的截图；桥接报告线程的放弃与结束状态，由主进程独立监测。找不到 csc 或元数据、编译失败报 `DESKTOP_VISION_UNAVAILABLE`，十分钟内不重试。
- **OCR**（`desktopOcr.ts`）：用原始清晰度的画面识别（宽不超过 1600 时先放大两倍），没指定语言时用偏好 `vision.ocrLanguage`（空为跟随系统），框换成物理像素后经 `physicalRectToScreenshot` 换到截图坐标。不可用（`DESKTOP_OCR_NO_LANGUAGE` 没装语言包、`DESKTOP_VISION_UNAVAILABLE`、`DESKTOP_OCR_FAILED`）时结果 `ocr{available:false, reason}`，观察照常成功；只有取消向上抛。
- **UIA 界面结构**（`windowsDesktopUiaSource.ts`）：`includeElements` 时广度遍历控件视图，用 `CacheRequest` 一次取回节点属性。可操作控件照旧登记引用并带当前值（密码框不读）；标签、状态栏、表格单元、列表项等文字和文档正文（前 2000 字，最多 3 个文档）也一并返回。上限 3000 个节点、150 个控件、300 条文字、4 秒，超出标注 `truncated`。控件编号是进程内递增的短编号（`e1`、`e2`…），不会在两次观察之间复用到别的控件。Chromium/Electron 窗口第一次读时先读一次页面根节点唤醒页面无障碍树，最多等 1 秒。
- **元素图**（`desktopElementMap.ts`，`desktopObserveLayers.ts`）：UIA 控件、UIA 文字和 OCR 文字合成一份清单，按阅读顺序从 1 编号。OCR 与 UIA 同位置（IoU ≥ 0.5 或互相包含）同文字的合并并标记 `confirmed`；无名的可操作控件用落在里面的 OCR 文字补名；文档正文已覆盖的 OCR 片段丢弃；其余 OCR 作为 `OcrText` 只读条目。UIA 读到的太少（少于 5 条或不足 20 字）时自动补 OCR 并在 `notice` 说明。结果字段 `elementMap{format, lines, count, truncated?, notice?}`，每行 `编号 类型(*=可操作) "文字" [x,y,w,h] elementId 操作 = 当前值`，总长不超过 16000 字；不再返回体积大的 `elements` JSON。条目登记在 `Observation.elementMap`，`resolveElementRef(entries, n)` 按编号取回条目、`elementId` 与中心点（「点 7 号」的接口，见下文「手」）。
- **编号叠加**：`annotate: true` 时在输出截图上画框和编号标签（`desktopAnnotate.ts`，直接改 BGRA 位图；可操作控件洋红、UIA 文字蓝、OCR 橙），编号与元素图一致。

### 手：按编号操作、每步回读、等待、按键与直通通道

键鼠动作在 `capabilityProvider` 交给 `desktopControl.execute` 之前、之后各经过 `desktopHands.ts` 一次；审批、禁区、高危名单、后端许可、用户接管与取消仍全部在 `desktopControl` 与护栏入口里，「手」不另开通路。

- **按元素编号**（`desktopHandsRef.ts`）：`ref` 必须和同一次观察的 `observationId` 一起给，编号只在那次观察的元素图里查（`desktopObservationIndex.ts`：`desktopObserve` 登记观察时另记一份，最多 32 份，按调用方归属查找；能否操作仍由 `desktopControl` 按 `observationId` 核对）。条目是本次登记过的 UIA 控件、且有对应模式时按控件执行（点带 invoke 的控件改为 invoke）；否则取框中心按坐标执行。`set_value`、`expand`、`collapse` 没有控件时报 `DESKTOP_PATTERN_UNSUPPORTED`；`type`、`hotkey` 不接受编号。结果带 `target{ref, role, text, method: uia|point}`；编号对应的文字作为 `refText` 进入动作参数，供许可分类识别「发送」「付款」。
- **按点击点下方实际的窗口判断分区**：按坐标的点击、拖动（起点和终点）、滚动，先经桥接只读请求 `windowAt`（`WindowFromPoint` → `GetAncestor(GA_ROOT)`）看点击点下方的顶层窗口，进程与观察的窗口不同就不发出，报 `DESKTOP_POINT_OTHER_WINDOW` 并附挡在上面的 `windowId`（审批因此不会问错程序）；桥接在移动鼠标之前再核对一次。同一程序的弹出菜单、下拉框（同进程的另一个顶层窗口）照常放行。拖动的终点可以在另一个程序的窗口里（例如把文件拖进聊天窗口）：主进程记下终点窗口（`__hostFacts.drop`）并把终点进程交给桥接（`dropPid`，只由主进程填写），终点程序同样过本机护栏（禁区拒绝，含浏览器里的 infOS 网页端）和后端许可（`parameters.dropApp` 也要声明、授权，否则确认）；确认里写明「把 X 拖到 Y」和终点程序。拖进聊天、邮件、浏览器本身不算发送，拖进终端、系统设置按终点归类。
- **每步回读**（`desktopVerify.ts`）：桥接在控件操作前后各读一次状态（值、勾选、展开、选中），写值时另读完整值直接比较（`valueMatches`）；`type` 前后各读一次焦点控件的值，比较刚输入的字出现次数有没有增加（`added`，原来就有不算做成；密码框不读；焦点在别的程序时如实报出），放进 `actionReceipt`。`expect{text, gone, window}` 在动作后的元素图（要核对文字时自动带元素图）与窗口列表里核对：没读到元素图或元素图被截断时不下结论，`window` 只认动作后新出现的窗口。都没有可核对的依据时，比较动作前后两次观察的画面指纹（同视角、同窗口），平均差异低于 0.05% 报「画面几乎没变」。结论 `verify{status, checks, reason?, suggestion?}`：`confirmed`、`failed`（附原因与建议）、`no_change`、`changed`（比较过画面且有变化）、`unverified`（拿不准：只核对了开头、读不到依据、画面比不了）；拿不准一律不报 `confirmed`。结果的 `message` 直接说结论。
- **等待**（`desktopWaitFor.ts`）：`wait` 带 `until{window|text|gone}`。`window` 按窗口标题或进程名找，不需要观察；`text` / `gone` 用观察确定窗口，经桥接只读请求 `findText` 在控件树里找（名字、当前值、前 3 个文档的前 4000 字；不登记控件引用、不切前台；4000 个节点、2.5 秒上限，桥接超时 6 秒）。每 500ms 一次，默认 10 秒，上限 30 秒；超时 `DESKTOP_WAIT_TIMEOUT` 并列出现有窗口。等待不进动作队列、不发出输入，每轮都经 `desktopControl.assertAvailable`，总开关关闭、停止快捷键、取消时立即停。
- **按键补全**（`windowsDesktopHandsSource.ts`）：快捷键补上标点（分号、等号、逗号、减号、句点、斜杠、反引号、方括号、反斜杠、单引号）、`PLUS`（`Ctrl++` 末尾的加号）、`Num0`–`Num9` 与小键盘运算键、`NumLock`、`CapsLock`、`ScrollLock`、`Pause`、`PrintScreen`、`Menu`、右侧修饰键、媒体与音量键，扩展键标志随键码表补齐。鼠标 `button: middle`、`triple_click`，`modifiers`（ctrl/alt/shift，不收 Win）用于点击、滚动、拖动，按下后在 `finally` 里松开。桥接在移动鼠标后才解析鼠标键和修饰键，所以后端工具边界与客户端都先核对，非法值不发出。
- **直通通道**（`desktop_direct`，`desktopDirect.ts`）：`clipboard_read` / `clipboard_write` / `media_key` / `open_url`，能力 `desktop.environment/desktopDirect`（`elevated`）。与键鼠动作同一个护栏入口 `desktopActionGuard`，分区程序名为 `clipboard`、`media-keys` 与系统默认浏览器的程序名（`app.getApplicationInfoForProtocol('https://')`），批准后先 consume 再执行、执行后 complete。媒体键与打开网址借用 `desktopControl.mutate`；媒体键经桥接 `media` 发给系统，不绑定窗口。网址只收 http/https、不带账号密码；剪贴板带 `ExcludeClipboardContentFromMonitorProcessing` / `Clipboard Viewer Ignore` 标记（密码管理器常用）时不读（`DESKTOP_CLIPBOARD_PROTECTED`），读取最多两万字。打开程序仍用 `open_application`，文件读写搜索走后端 `home_files`。

### 持续盯窗口

`take_screenshot` 的 `watch{action, fps, durationSec}` 由 `desktopWatch.ts` 处理（接线在 `desktopWatchService.ts`，只读、不切前台、不进动作队列）。`start` 后本机按帧率截目标窗口（被遮挡时截窗口自身画面，最小化时跳过），平时不发给模型。首次成功截图后固定目标 PID，后续先检查 HWND 对应的 PID；变化时停止，防止继续观察被其他进程复用的句柄。每帧按比例缩到长边最多 480，不放大小窗口，再与上一帧用 pixelmatch 比较，按 12 像素的格子累计变化（一格少于 3 个变化像素不算）。

`poll` 只返回「现在和上次取时不一样」的格子：相邻格子合并成块并外扩一格，平均哈希只筛选去重候选，尺寸和实际像素均相同时才合并（重复的位置记在 `alsoAt`），最多 12 块，按原清晰度拼成一张带编号的图（`desktopWatchAtlas.ts`），附 `since/until/frames`、`frame`（窗口画面尺寸与物理矩形）和每块的 `frame`、`physical`、`atlas` 三种坐标。`atlas` 矩形按编码后实际图片尺寸换算，`screenshots` 附实际宽高。第一次拉取或窗口尺寸变了发整帧（`kind: full`），变化面积过半也发整帧；没有净变化返回 `changed: false` 且不带图，中间变过又变回去只报 `transientCells`。`status` 返回运行状态、帧数、跳过帧数、最近错误与内存占用；`stop` 停止。

上限：帧率 0.2～2（默认 1）、时长 10 秒～1 小时（默认 30 分钟）、同时最多 2 个、每帧长边最多 1600；原始窗口超过 32×1024×1024 像素时拒绝捕获。停止后仍在等待的截图也计入并发上限；同一观察者反复启动仍共用截帧间隔，所有观察者共用每秒最多 4 次的捕获预算。只保留最新一帧原图和两张比较小图。窗口关闭或 PID 变化、连续 10 次截图失败、到时、总开关关闭、桌面暂停、锁屏休眠、桥接断开或退出时停止，并取消在途请求；停止后迟到的帧不得写回会话。`desktopObservationLifecycle.ts` 负责控制器与观察服务之间的停止通知。停止原因在之后的 `status`/`poll` 里给出。会话按「角色 + Thread」区分，跨轮次保持。思路按 Watch Buddy 公开 README 描述自行实现。

### 「桌面与家」设置

左侧导航「设置 → 桌面与家」打开独立页面 `DesktopHomeSettings.vue`（页面标识 `desktop_home`），提供「桌面操作」「感知与陪伴」「共享空间」「授权与记录」「保护设置」五个分区。状态栏的感知设置入口直接打开「感知与陪伴」，Electron 支持将整页摘为独立面板。浏览器提供共享空间、授权记录与后端文件保护设置。

眼睛、耳朵、陪看、环境事件的用户选项都存在用户数据目录的 `desktop-home.json`（`electron/main/services/home/homeSettings.ts`，字段与范围在 `homeSettingsSchema.ts`）。桌面操作总开关与停止快捷键由「桌面操作」分区即时保存，继续使用独立的签名文件。原生程序保护由「保护设置」中的 `DesktopSafetySettings.vue` 管理，共享物品、授权记录和文件保护通过后端 `/api/home` 管理，设备偏好与服务端数据各自持有权威状态。

- 文件带 `version`（当前 2）。旧版本按 `homeSettingsMigrations.ts` 的迁移链逐级迁移后写回（写回失败时本次仍用迁移后的值，旧文件保留）；v1→v2 新增 `environment` 分区，v1 文件里碰巧存在的同名字段整块丢弃。新增版本时在迁移链里登记上一版到新版的一步。读取时按 schema 校验：不是对象、版本更新、超过 256 KB 时整份按默认值；字段类型不对用默认值，数值超出范围截到边界，未登记的字段丢弃。设置页提交的修改反过来严格校验：未知分区或字段、类型或枚举不对直接拒绝。写入先写临时文件再改名。
- 第一步前半的 `desktop-vision.json` 在第一次读取时并入 `vision` 分区，新文件写好后删除；新文件已存在时以新文件为准。
- 分区与默认值：`vision{imageQuality 80, observationTtlSec 600, ocrLanguage ""}`、`ears{enabled false, language auto, silenceThreshold 0.008, petIndicator true, selfExclusion process}`、`companion{interject true, minIntervalSec 120, maxPerHour 30, pauseAfterSec 20}`、`environment{enabled false, idle true, idleMinutes 5, fullscreen true, taskCompleted true}`。另有不出现在设置页的 `internal`：耳朵模型文件的校验记录、编译缓存 DLL 的哈希与签名。
- IPC：`desktop-home:get` → `{settings, status}`；`desktop-home:update({section, patch})`；`desktop-home:model(download|cancel|remove)`；`desktop-home:stop-listening`。状态推送 `desktop-home:status`（录音、陪看、模型下载进度）。环境事件另有 `desktop-home:environment-take(agentId)`（界面发消息前取走）与 `desktop-home:environment-task({agentId, taskId})`（界面转告后台任务完成）。这个文件与 `desktop-bridge/` 在客户端安全设置的受保护名单里，agent 的文件工具改它们要逐次确认。

### 环境事件

默认关闭（`environment.enabled`），只有三种：空闲（`idle`，系统无输入达到 `idleMinutes` 分钟算离开，有输入算回来）、全屏（`fullscreen`，前台有别的程序的窗口与某块屏幕边界重合；只记是否全屏，不记程序名和画面；桌面本身与 infOS 自己的窗口不算）、infOS 自己启动的后台任务完成（`taskCompleted`）。

- 主进程（`home/environmentRuntime.ts`）每 5 秒采样一次，事件进有界信箱（`home/environmentEvents.ts`，最多 50 条、最长 24 小时，第一次观察只记基线、状态翻转才记）。总开关关闭、桌面操作关闭、锁屏或休眠时不采样；桌面暂停、断线、锁屏、退出（`desktopObservationLifecycle.ts`）后重新起算。关掉某一类时这一类的事件立即丢弃。
- 任务完成由界面从任务推送得知后转告主进程；只交给发起任务的角色，同一任务只记一次。
- 不会因为事件叫醒模型：用户在聊天页发消息前，界面取走信箱里的事件（最多 20 条），作为请求字段 `environmentEvents` 随消息发给后端；后端（`services/conversation/environmentContext.ts`）只把它整理成 `<desktop_environment>` 追加到本轮送给模型的用户消息末尾，不写入 Thread 正文。任务事件要核对任务属于这个角色且状态为已完成，否则丢弃。
- 取走后即从信箱删除；消息没有发出去时这批事件不会补发。

### 耳朵

`take_screenshot` 的 `watch.start` 加 `listen: true`（或 `companion: true`）开始听；不给 `windowId` 只给 `listen` 时只听不看。只有设置里打开耳朵、模型已下载并校验通过才会录音，否则结果 `ears{listening:false, reason}` 说明 `EARS_DISABLED` / `EARS_MODEL_MISSING`，盯窗口照常。

- **录音方式**（`earsCaptureSelect.ts`）：`ears.selfExclusion` 为 `process`（默认）时用进程回环录「除 infOS 进程树以外」的整机声音，她的 TTS 根本录不进来，电影声音不受影响；为 `drop`、系统不支持（低于 Windows 10 2004 / 内部版本 19041）、或助手编译 / 激活 / 运行失败时，退回下面的整机录音 + 她出声时整段丢弃。中途失败无缝切换、不打断耳朵；失败后同一次运行 10 分钟内不再重试。设置页在听的时候显示当前方式，退回时显示原因（状态字段 `earsCapture`、`earsCaptureFallback`）。
- **进程回环**（`earsLoopback.ts`，C# 源在 `earsLoopbackSource.ts`）：`ActivateAudioInterfaceAsync("VAD\Process_Loopback")`，激活参数 `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` + `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`，目标是主进程 PID（渲染进程、识别进程都是它的子进程）；格式直接要 16 kHz 单声道 float32（`AUTOCONVERTPCM`）。助手用系统 .NET Framework 的 `csc.exe` 编译，按源码哈希缓存在 `desktop-bridge/infos-ears-loopback-<hash>.dll`，与视觉助手同一套完整性校验（编译时记 SHA-256 并签名，加载前比对，不一致删掉重编）；隐藏 PowerShell 读 DLL 字节、比对哈希后 `Assembly.Load(byte[])` 再运行。助手标准输出是连续裸采样（没有声音、引擎不给包时按墙钟补零，VAD 才能判断句尾），标准错误每行一个 JSON（`ready` / `error`），关闭标准输入即结束；错误码 `EARS_LOOPBACK_UNSUPPORTED` / `EARS_LOOPBACK_UNAVAILABLE` / `EARS_LOOPBACK_FAILED` 只用于退回，不会让耳朵停止。写法参考 Microsoft ApplicationLoopback 示例与 NAudio（均 MIT），见 `THIRD_PARTY_NOTICES.md`。
- **整机录音**（`ears/earsCapture.ts`、`preload/earsCapture.ts`）：隐藏窗口 + 独立内存 session，只给这个 session 设 `setDisplayMediaRequestHandler`，回调给 `audio: 'loopback'`（整机声音），不开麦克风；页面是 `infos-ears://capture/` 空白页（安全来源，`getDisplayMedia` 需要），画面轨道拿到后立刻停止，声音降到 16 kHz 单声道、每 0.5 秒交一块。
- **闸门**（`earsAudio.ts`）：RMS 低于 `ears.silenceThreshold` 算静音，说话后再送 1.2 秒静音让 VAD 判断句尾，之后的静音直接丢弃并让识别端收尾；只在整机录音时：infOS 自己的窗口在出声（`webContents.isCurrentlyAudible`，例如 TTS）时整块丢弃，停止后再丢 0.6 秒，这段时间里电脑的其他声音也一起丢；按进程排除时不需要这一步。
- **识别**（`earsWorker.ts` 经 `utilityProcess` 运行，逻辑在 `earsEngine.ts`）：sherpa-onnx-node（Apache-2.0）的 silero VAD 切段，每段交给 SenseVoice int8 离线识别，语言取 `ears.language`；逆文本规范化偶尔拆坏的「十0」「三.7」两种数字写法在输出前修正（`tidyText`）。原生模块只在这个进程里加载，崩溃只影响它；electron-vite 把它打成主进程旁的 `earsWorker.js`，`.node` 与 DLL 由 `asarUnpack` 解包。段落起止按每块音频的时刻换回墙钟时间（被丢弃的静音不会让时间漂移）。
- **转写参数**（`earsEngine.ts` 的 `DEFAULT_TUNING`）：VAD 阈值 0.4、句末静音 0.3 秒、最短 0.25 秒、最长一句 8 秒。按中文实测选定：阈值从 0.5 降到 0.4 后，背景音乐里的人声不再被整段漏掉；有背景音乐时 VAD 很少等到静音，一句常拖到 12–20 秒，最长一句缩到 8 秒后台词从开口到交付的平均等待从约 10.6 秒降到约 8 秒，字错率不变。阈值再降（0.3）对很响的背景音乐更好，但纯解说视频会多出误识别，没有采用。语言提示：中文内容选 `zh` 与 `auto` 差别很小，默认保留 `auto`。CPU：两线程实时率约 0.02（1 分钟音频约 1.2 秒算完）。
- **台词**（`earsTranscript.ts`）：内存里最多 400 句、2 小时；按调用方记游标。每次观察与 `watch.poll` 附带 `heard{since, until, count, lines, more?}`（`lines` 一行一句 `[时:分:秒] 台词`，一次最多 60 句），每句只给一次；`watch.heard` 用 `from/to`（ISO）或 `lastSec` 查时间段，只看不动游标，不返回未来的内容。
- **模型**（`earsModel.ts`）：不进仓库、不随安装包。设置里打开耳朵后显示大小，用户点「下载」才下载到 `用户数据/ears-model/sense-voice-2024-07-17/`：`silero_vad.onnx`（643,854 字节，sherpa-onnx 发布页）、`tokens.txt`（315,894）与 `model.int8.onnx`（239,233,841，Hugging Face `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`，不通时试 hf-mirror.com）。边下边算 SHA-256，大小或哈希不对删掉并报 `EARS_MODEL_SIZE_MISMATCH` / `EARS_MODEL_HASH_MISMATCH`，全部地址失败报 `EARS_MODEL_DOWNLOAD_FAILED`。通过后记下大小、修改时间与哈希，之后启动只比对前两项。
- **停止**：最后一个调用方停了、设置里关掉耳朵、桌面操作总开关关闭、识别进程退出或报错、录音页失败时立刻停止，原因记在状态里。录音时整个工作台上方有红色标识（不能关掉，带「停止」），切到设置或子应用仍显示；最小化后系统托盘仍有录音状态和停止入口。桌宠旁另有可选「正在听」小标记（`ears.petIndicator`）。操作系统可能把托盘折叠进溢出区域，应用不能保证其始终露在桌面上。

### 陪看模式

`watch.start` 加 `companion: true`（需要在对话会话里调用）在盯窗口的同时开始陪看（`companion/companionService.ts`，时钟在 `companionClock.ts`）：

- **在播 / 暂停**：画面有变化或听到台词算在播；两者都静止 `pauseAfterSec` 视为暂停，暂停时不触发插话、`poll` 也不会有新图（本机仍按帧率截图判断恢复，不发给模型）。媒体时间只在播放时累计。
- **插话频率**：两次主动插话至少隔 `minIntervalSec`，每小时不超过 `maxPerHour`；服务端按角色维护滚动小时额度，并强制至少三分钟、每小时最多二十次，宿主设置只能进一步收紧。重连和切换会话不重置服务端额度，后端进程重启会清空内存额度。`companion.interject` 关掉后只在用户说话时回应。
- **触发**：每 5 秒检查一次，在播、允许插话、自上次以来有新画面或新台词时，经后端 `POST /api/scheduler/proactive/watch-along`（`watchAlongTurn.ts`，复用全局主动行为的执行器，与「智能陪伴」开关无关）在她的桌面会话里跑一个主动回合。新台词直接写进提示，需要画面时她自己 `poll`。后端回 `busy`（她正忙、全局主动回合在跑）时不计次数，台词退回下次再给；用户开始说话会取消正在进行的插话回合。
- **送达估计**使用本机生成耗时的指数平滑值，播放时钟按画面与声音活动推进。间隔与小时配额由 `CompanionClock` 独立维护。
- **不剧透**：她只拿得到已经播出的画面与台词；提示里要求不用对作品后续情节的了解。
- **调用边界**：插话及输入在场接口仅接受管理凭据的显式 Bearer 请求，拒绝浏览器 Origin、设备凭据和 Cookie。主进程按可信主窗口 IPC 转发输入焦点信号，不发送草稿；输入信号每五秒续期，十五秒失联过期。用户输入会取消陪看回合，正常聊天等待其退出后执行。该边界不防御已能读取本机管理凭据的同用户任意代码。
- 盯窗口停止（窗口关闭、到时、总开关关闭）时陪看随之结束；`watch.stop` 一并停止盯窗口、耳朵与陪看。

### 区域截图与坐标

每次观察的 `coordinateContext.mapping` 给出截图像素、桌面 DIP 与物理像素三者的线性换算：`screenshotToDip` 与 `screenshotToPhysical` 均为 `目标 = offset + 截图坐标 × scale`，`scale = (区域尺寸 - 1) / (截图尺寸 - 1)`，与 `resolveDesktopPoint` 的两端对齐口径一致；`physical` 由 `screen.dipToScreenRect` 求得，125%、150% 等 DPI 缩放和副屏偏移都已包含。`get_mouse_position`、控件 `bounds` 与 `coordinateSpace: desktop` 都是物理像素，反向换算用 `(物理 - offset) / scale`。换算逻辑在 `desktopCoordinateMapping.ts`。

`take_screenshot` 的 `region: {x, y, width, height}` 使用参考截图的像素坐标，必须同时提供该图的 `observationId`。窗口、显示器和实际桌面 DIP 范围由客户端从观察记录解析，模型不能覆盖；显式指定的窗口或显示器必须与参考观察一致。选区须完全位于参考图内，截图重新采集当前画面，不复用历史图片。局部图返回新的观察编号、实际宽高及 `coordinateContext.bounds`，后续坐标操作引用新编号，以局部图左上角为原点；也可继续在局部图中选区。

采样密度按选区宽度与显示器 DPI 决定，先保留局部细节，再按 `maxWidth` 限制输出。不再一律缩到 1280：默认整屏 1600、窗口 1920、局部放大 2560（`DEFAULT_MAX_WIDTH`，`desktopImageEncode.ts`），窗口和局部在上限内保持原始像素，只有整屏明显缩小；显式传 `maxWidth`（320～2560）时以它为准。实际裁切像素向外取整，坐标范围与最终裁切保持一致。Windows 沿用窗口、输入控制权与布局复查；其他 Electron 平台只提供屏幕选区观察，引用同样绑定调用方、显示器布局和有效期，不因此增加桌面输入能力。

内置浏览器的 `browser_screenshot` 使用同形状 `region`，参考编号为 `screenshotId`。`browser_page_image` 的元素截图也返回该编号，允许后续继续选区。浏览器输出携带实际图片尺寸、网页 CSS 视口范围、页面代次及缩放信息；`maxWidth` 可选，默认保留采集尺寸。编号仅在所属调用方、账号／会话范围和标签页内有效，最长两分钟；跳转、切换目标标签、滚动、视口缩放或尺寸变化后需重新截图。视口版本在隔离世界中跟踪滚动与缩放，避免页面脚本修改观察状态。

`browser_interact` 的 `click/hover` 可采用 `screenshotId` 与截图像素 `x/y`，客户端回映到网页视口；元素 `target/handle` 与像素定位互斥。坐标动作消费当前截图引用，下一步先重新截图。原有元素句柄操作仍可使用；原生输入由浏览器能力执行，沿用账号范围和取消边界。截图元数据经 Tool ABI 与多模态注入保留，图片数据仍按现有资源与检查点规则处理。

## 用户接管与暂停

- 动作开始前先等待输入空闲：最近 600 毫秒没有用户输入才允许发送，最多等待两秒。持续繁忙返回 `DESKTOP_USER_BUSY`，动作尚未发送，模型可继续文件、终端或内置浏览器任务；这不等同于用户明确接管。旧观察与排队动作的控制权版本变化仍要求重新观察。
- 明确接管、锁屏、停止快捷键、监听失效或结果不明会中止当前桌面执行。普通会话将 `executionPause` 与原工具结果持久保存，保留在后续上下文中，实时和历史界面均显示暂停而非输出完成。点击“继续任务”先解除设备暂停，再发起同 Thread 的续接轮次，不自动重放旧动作；NIT 内部遇到接管也取消脚本和内部工具。
- Windows 桥接标记自身注入事件，其他鼠标键盘事件视为用户接管；监听不可用时拒绝自动输入。
- 用户正在操作、锁屏、休眠、取消、连接断开时停止后续输入并作废旧观察。后台 API、文件与内置浏览器任务不持有这个桌面锁。
- 暂停分两种（`desktopControl.pause` / `pauseInput`）：**只暂停输入**用于她操作时用户动了鼠标键盘、执行中断、动作已发送但结果不确定，只作废可操作观察、松开按键，盯窗口、耳朵、陪看照常（`assertAvailable(signal, 'observe')` 放行），陪看时碰一下鼠标不会断；**完全停止**用于停止快捷键、总开关关闭、锁屏休眠、断线、桥接断开、客户端退出、界面「停止」与顶部「她在操作」标记的停止按钮，输入与只读观察一起停（`stopDesktopObservations`），需要用户手动继续。已完全停止时再出现接管不会降级为只暂停输入。
- 她操作别的程序时（`phase=running`，以及动作间 8 秒内）屏幕顶部居中显示「她正在操作「窗口」」标记与停止按钮（`home/homeOperatingBar.ts`），置顶不抢焦点，`setContentProtection` 不进截图。
- 执行模式接入：后端随 `__desktopCaller` 带上会话执行模式；手动模式下即使程序已信任、已预批或普通区为「只提醒」，每个动作也要用户在本机审批框点「允许这一次」。发消息、付款、系统设置、终端在任何模式下都逐次确认（后端固定规则）。
- 正在执行的后台任务进入可恢复暂停，保留工具检查点。已发送但结果不明的动作保留核验要求，不能自动重试。
- 主应用和任务详情提供暂停／继续入口，桌宠仅出现短提醒与跳转。恢复后重新观察，不默认在用户停手后抢回控制权。
- 用户从任务面板或已绑定主人的社交入口恢复桌面任务时，同步恢复设备控制权；后台 Agent 的任务工具不能自行解除用户接管。结果不明的动作仍必须先核验。
- 「桌面与家 → 桌面操作」可以关闭桌面操作或录入停止快捷键，默认 `Control+Alt+Escape`。

## 生命周期与依赖

Windows 桥接通过系统 Windows PowerShell 按需启动一个隐藏常驻进程，使用系统 .NET Framework UI Automation 与 Win32 输入 API，无需额外 Python 服务。源码内置到主进程包中，按内容哈希编译成缓存 DLL（用户数据目录 `desktop-bridge/infos-desktop-*.dll`），之后启动直接加载；缓存不可用时退回内存编译。需要编译时桥接先输出 `{"compiling":true}`，启动超时从 20 秒放宽到 60 秒，`DesktopControlState.preparing` 为真，状态条显示「正在准备桌面组件」。启动脚本与超时规则在 `windowsDesktopProtocol.ts`。桥接故障时停止输入，恢复后重新初始化。

**编译缓存的完整性**（`home/assemblyIntegrity.ts`）：桥接 DLL 与视觉助手 DLL 在用户数据目录里，同一用户的其他程序可以替换。编译时记下 SHA-256（存在 `desktop-home.json` 的内部状态里，附 settingsSigner 的 HMAC 签名），加载前比对：没有记录、签名不对或哈希不一致就删掉重编。PowerShell 启动脚本和桥接 C# 都改为读字节、算哈希、一致后用 `Assembly.Load(byte[])` 加载，不再按路径加载，读取与加载之间被换掉也无效；新编译出的桥接 DLL 由启动脚本输出 `{"assembly":"<sha256>"}` 交给 TS 记下。系统加密不可用时只记哈希不签名。能同时改配置并调用系统加密接口的本机程序不在这道防线的范围内。

单个请求超时（observe 15 秒、ocr 20 秒、capture 12 秒、其余 10 秒）只取消这一个请求：发 cancel，迟到的回音丢弃，返回 `DESKTOP_REQUEST_TIMEOUT`；注入类请求超时标记 `dispatched: true`，按结果不确定处理。被放弃的请求 30 秒仍无回音才视为执行线程卡死并回收进程。原生视觉工作线程另外登记，普通错误回音不代表该线程已退出；放弃后 30 秒仍未退出也回收桥接。`desktopBridgeFiles.ts` 仅登记主进程生成、位于专用临时目录的 UUID 像素文件，在迟到回音、原生线程结束或桥接退出后清理，防止调用方清理后文件又被迟到任务重建。

Capability 取消信号从工具、绑定端口和 WebSocket 传到 Electron，再传至桥接；桥接在字符与拖拽步之间检查取消。已经送出的输入不能撤销。

截图进入当前视觉上下文，最多保留最近两组。工具审计剥离图片数据，检查点只保存摘要，避免数据库积累截图和恢复时误用旧画面。

## 平台限制与维护入口

原生输入操作当前活动桌面，不能保证用户与 Agent 同时操作互不干扰。独立 Windows 子会话、虚拟机和隔离 GUI 节点不属于此桥接实现。UIA 的可见性与控件支持取决于目标应用，桥接返回不支持时应保留具体原因。

调用链从后端 Capability 授权进入 Electron，再由 `electron/main/services/desktopAutomation.ts` 与 `windowsDesktop.ts` 调用隐藏 PowerShell 桥接；脚本源位于 `windowsDesktopSource.ts`（主体）与 `windowsDesktopUiaSource.ts`、`windowsDesktopCaptureSource.ts`、`windowsDesktopVisionSource.ts`（partial 片段），视觉助手源在 `windowsVisionSource.ts`。部分 C# 移植自 dsh-computer-use-win（MIT），元素图融合参考 clawdcursor（MIT），见仓库根 `THIRD_PARTY_NOTICES.md`。耳朵使用 npm 依赖 sherpa-onnx-node，标注页与陪看时钟由本仓库实现。修改坐标、控件句柄或取消行为时，同时审阅输入控制权和观察有效期，不能让重连复用旧句柄。

排障先区分提供者未连接、桥接启动失败、观察过期、输入控制权争用和目标应用不支持 UIA。截图失败不再只报“无法获取屏幕内容”：`captureScreenDetailed` 给出 `SCREEN_CAPTURE_DENIED`（系统没有提供可截取的屏幕：权限被拒、锁屏或管理员确认界面、远程桌面断开）、`SCREEN_CAPTURE_SOURCE_MISSING`、`SCREEN_CAPTURE_REGION_INVALID`、`SCREEN_CAPTURE_EMPTY`、`SCREEN_CAPTURE_FAILED`，目标窗口最小化时改报 `DESKTOP_WINDOW_MINIMIZED`（`desktopCaptureFailure.ts`）。目标窗口在操作途中关闭返回 `DESKTOP_WINDOW_GONE`。观察与回读在 `desktopObserve.ts`，批准后核对、等画面稳定和回读视角在 `desktopActionFollowUp.ts` / `desktopSettle.ts`，总开关文件的签名读写在 `desktopControlSettings.ts`。需要实机确认时使用可撤销操作，核对输入取消、窗口切换和高 DPI 坐标；单元模拟无法证明目标应用兼容性。

## 常驻感知

常驻感知的设置迁移、临时回合和统一停止边界见 [常驻感知](B_PERCEPTION.md)。

