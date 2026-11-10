# 桌面感知与手动陪看

桌面感知由 Electron 采样，后端为当前执行提供临时资料，主动发言经主线与内核调度提交。配置来自客户端 `desktop-home.json`，共用合同位于 `packages/shared/src/types/perception.ts`。

## 设置与来源

「桌面与家」集中提供感知、眼睛、耳朵、陪看、圈选与环境事件设置。常驻授权使用独立 perception 分区，配置迁移按版本处理。手动环境事件只记录空闲、全屏和应用任务完成，在下次发送时作为环境资料附带。

前台窗口和可选声音由 `perceptionCoordinator`、`perceptionSampling` 与耳朵服务采集。过滤和打码发生在客户端，快照经持有管理 Bearer 的原生入口发送，接口限定来源、长度、图像数量、序号和过期时间。

耳朵模型按用户下载操作保存到本机。识别在独立 utilityProcess 中加载 `sherpa-onnx-node`，音频源切换、停止与工作进程退出共用代次清理。模型文件和下载校验由 `earsModel.ts` 管理。

## 临时上下文

`PerceptionSnapshotStore` 在内存中保留短期快照，续期最长十二秒。普通桌面执行取得当前资料，由 `perceptionTurn.ts` 附加标记为 `transientSource=perception` 的消息。图片依据模型视觉能力与预设选项装配。

据点、Realm、后台任务与主动执行各自通过明确的入口取资料。普通桌面入口排除据点场景适配器。执行审计、热轨迹和检查点采用去除临时消息及感知脱敏后的副本。

主动感知使用受限的 perception 作用域，模型可判断本次是否发言。正式回复经主线独立消息保存，过程属于本次 Execution。主线、侧线与据点的历史合同见 [主侧会话](./B26_MAIN_SIDE_THREADS.md)。

## 手动陪看

用户明确发起陪看后，`take_screenshot` 的 `watch.start` 加 `companion=true` 为目标窗口开启观察与间歇发言。Electron 维护画面活动、播放时钟、发言间隔与小时配额，后端重新核对角色、主线、忙碌状态、许可及发言预算。

工具入口在调用客户端能力前核对角色主线及当前代次，侧会话请求返回「手动陪看请在角色主会话中开启」。启动校验与插话入口共用 `isWatchAlongMainThread`，客户端收到的任务已经通过业务身份校验。

用户输入活动会让陪看执行让位，停止、失联、过期或角色变化会取消旧回合。语音复用角色 TTS 与音频输出座席，用户交流拥有优先级，临时音频在播放后清理。

## 停止与恢复

硬停止、暂停、来源切换和设置变化通过许可代次向主进程及后端传播。待补图请求检查代次和过期时间，旧录音、旧图像和旧执行结果按对应代次结束。重启后的启用状态从已保存设置与有效许可恢复。

## 源码入口

- 客户端位于 `electron/main/services/home/`、`ears/`、`companion/`。
- 后端位于 `services/perception/`、`services/companion/`、`services/conversation/perceptionContext.ts` 与 `perceptionTurn.ts`。
- 原生管理入口位于 `routers/watchAlong.routes.ts`。
- 前端位于 `components/desktop/perception/`、`composables/usePerception.ts` 与 `composables/chat/useWatchAlongInput.ts`。
