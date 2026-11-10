import type { DesktopHomeSection } from '@infos/shared'
import { t as __t } from '../../i18n/index'

/** 设置页「桌面与家」的一项：所在分区、键名、标题、说明、可选值（标题与说明随语言切换）。 */
export interface HomeOption {
  section: DesktopHomeSection
  key: string
  kind: 'select' | 'switch'
  readonly label: string
  readonly hint: string
  readonly options?: Array<{ value: string | number; label: string }>
  /** 不常改的选项：收在分组底部的「更多选项」里。 */
  advanced?: boolean
}

const tr = (source: string) => __t('ui.desktop', source)
const seconds = (value: number) =>
  value < 60
    ? __t('ui.desktop', '{0} 秒', [value])
    : __t('ui.desktop', '{0} 分钟', [Math.round(value / 60)])

function option(
  section: DesktopHomeSection,
  key: string,
  kind: HomeOption['kind'],
  label: string,
  hint: string,
  options?: () => Array<{ value: string | number; label: string }>,
  advanced = false,
): HomeOption {
  return {
    section,
    key,
    kind,
    advanced,
    get label() {
      return tr(label)
    },
    get hint() {
      return tr(hint)
    },
    get options() {
      return options?.()
    },
  }
}

export const PERCEPTION_MAIN_OPTION: HomeOption = option(
  'perception',
  'enabled',
  'switch',
  '让她常驻感知',
  '打开后她平时就知道电脑上发生了什么，不用你说「看一下」。她只看和听，不会因此动你的电脑。默认关闭。',
)

export const PERCEPTION_TITLES_OPTION: HomeOption = option(
  'perception',
  'windowTitles',
  'switch',
  '知道窗口和程序',
  '前台窗口的标题、开着哪些程序、在做什么。约 4 秒看一次，只留在内存里。',
)

export const PERCEPTION_IMAGE_OPTION: HomeOption = option(
  'perception',
  'screenImages',
  'switch',
  '带上屏幕图',
  '你说话或陪看时，把当前窗口的小图一起给她，要预设里放了屏幕图才会带。会多花模型额度。',
)

export const PERCEPTION_HEAR_OPTION: HomeOption = option(
  'perception',
  'sound',
  'switch',
  '平时也听',
  '有程序出声且分得清是谁时，才在本机转成文字。分不清就只知道有声音。声音不发给任何云端。',
)

export const PERCEPTION_SPEAK_OPTION: HomeOption = option(
  'perception',
  'proactive',
  'switch',
  '可以自己开口',
  '你回到电脑前、换了程序待一阵这类时候，她可以说两句，也可以不说。只说话，不动手。',
)

export const PERCEPTION_LEVEL_OPTION: HomeOption = option(
  'perception',
  'proactiveLevel',
  'select',
  '开口频率',
  '她最多多久自己开口一次。',
  () => [
    { value: 'low', label: tr('少（至少隔 1 小时，每天 6 次）') },
    { value: 'medium', label: tr('中（至少隔 30 分钟，每天 12 次）') },
    { value: 'high', label: tr('多（至少隔 15 分钟，每天 24 次）') },
  ],
)

export const PERCEPTION_WATCH_OPTION: HomeOption = option(
  'perception',
  'watchAlong',
  'switch',
  '允许陪看',
  '你说「陪我看」时她边看边听。关掉后她不接这个请求，平时知道的不受影响。',
)

export const VISION_OPTIONS: HomeOption[] = [
  option(
    'vision',
    'imageQuality',
    'select',
    '截图质量',
    '她看屏幕时图片的清晰度。越清晰越容易认出小字，也越占用模型额度；纯文字画面会自动用无损格式。',
    () => [
      { value: 60, label: tr('省流量（60）') },
      { value: 80, label: tr('均衡（80）') },
      { value: 92, label: tr('清晰（92）') },
    ],
  ),
  option(
    'vision',
    'observationTtlSec',
    'select',
    '看一眼管多久',
    '她看过屏幕后，这段时间里可以照着刚才看到的画面直接动手，过了就要再看一眼。你一动鼠标键盘，她也会重新看。',
    () => [120, 600, 1800].map((value) => ({ value, label: seconds(value) })),
    true,
  ),
  option(
    'vision',
    'ocrLanguage',
    'select',
    '认字语言',
    '她读屏幕上的字时优先按哪种语言认。这种语言要先在 Windows 里装好语言包。',
    () => [
      { value: '', label: tr('跟随系统') },
      { value: 'zh-Hans-CN', label: tr('简体中文') },
      { value: 'zh-Hant-TW', label: tr('繁体中文') },
      { value: 'en-US', label: 'English' },
      { value: 'ja', label: '日本語' },
    ],
    true,
  ),
]

export const EARS_OPTIONS: HomeOption[] = [
  option(
    'ears',
    'language',
    'select',
    '听写语言',
    '电脑里在说哪种语言；自动识别适合中英混杂的内容。',
    () => [
      { value: 'auto', label: tr('自动识别') },
      { value: 'zh', label: tr('中文') },
      { value: 'yue', label: tr('粤语') },
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
      { value: 'ko', label: '한국어' },
    ],
  ),
  option(
    'ears',
    'selfExclusion',
    'select',
    '她自己说话时',
    '她说话时，怎么避免把自己的声音也听进去。「只排除她的声音」：别的声音照常听，需要 Windows 10 2004 或更新版本；「那几秒整段不听」：她说话的那几秒，电脑上的声音都不听。',
    () => [
      { value: 'process', label: tr('只排除她的声音') },
      { value: 'drop', label: tr('那几秒整段不听') },
    ],
  ),
  option(
    'ears',
    'silenceThreshold',
    'select',
    '多小的声音当没声音',
    '比这更轻的声音直接忽略，不去听写。背景音乐吵就调高，说话声音小就调低。',
    () => [
      { value: 0.004, label: tr('灵敏') },
      { value: 0.008, label: tr('标准') },
      { value: 0.02, label: tr('只听较响的') },
    ],
    true,
  ),
  option(
    'ears',
    'petIndicator',
    'switch',
    '桌宠旁显示「正在听」',
    '录音时除了应用里的标识，桌宠旁边也显示一个小标记。',
  ),
]

export const COMPANION_OPTIONS: HomeOption[] = [
  option(
    'companion',
    'interject',
    'switch',
    '陪看时主动说话',
    '一起看视频时，她可以不等你开口就聊两句；关掉后只在你说话时回应。',
  ),
  option('companion', 'minIntervalSec', 'select', '最短间隔', '两次主动说话之间至少隔多久。', () =>
    [60, 120, 180, 300, 600].map((value) => ({ value, label: seconds(value) })),
  ),
  option(
    'companion',
    'maxPerHour',
    'select',
    '每小时最多',
    '一小时里最多主动说几次，达到后等下一小时。',
    () => [6, 12, 20, 30, 60].map((value) => ({ value, label: __t('ui.desktop', '{0} 次', [value]) })),
  ),
  option(
    'companion',
    'pauseAfterSec',
    'select',
    '多久没动静算暂停',
    '画面和声音都停了这么久，就当你按了暂停：这时她不看也不说话，省模型额度。',
    () => [10, 20, 60].map((value) => ({ value, label: seconds(value) })),
    true,
  ),
]

export const ENVIRONMENT_OPTIONS: HomeOption[] = [
  option(
    'environment',
    'enabled',
    'switch',
    '记下环境变化',
    '把你离开或回来、程序全屏、她发起的任务完成记下来，等你下次说话时顺带告诉她；不会因此叫醒她。需要先打开桌面操作。默认关闭。',
  ),
  option('environment', 'idle', 'switch', '离开与回来', '你离开电脑和回到电脑前时各记一次。'),
  option(
    'environment',
    'idleMinutes',
    'select',
    '多久没动算离开',
    '这么久没碰键盘和鼠标，就算你离开了。',
    () => [3, 5, 10, 30].map((value) => ({ value, label: __t('ui.desktop', '{0} 分钟', [value]) })),
  ),
  option(
    'environment',
    'fullscreen',
    'switch',
    '全屏',
    '别的程序进入或退出全屏时记一次；只记是否全屏，不记程序名和画面。',
  ),
  option(
    'environment',
    'taskCompleted',
    'switch',
    '任务完成',
    '她在 infOS 里发起的后台任务完成时记一次，只告诉发起任务的那个角色。',
  ),
]
