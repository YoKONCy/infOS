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
  '常驻桌面感知',
  '开启后无需手动提醒，她也能感知当前窗口与声音（仅观察，不操作电脑）。',
)

export const PERCEPTION_TITLES_OPTION: HomeOption = option(
  'perception',
  'windowTitles',
  'switch',
  '读取窗口与程序',
  '定期读取前台窗口标题与运行中的程序，仅暂存内存。',
)

export const PERCEPTION_IMAGE_OPTION: HomeOption = option(
  'perception',
  'screenImages',
  'switch',
  '附带窗口截图',
  '对话或陪看时附带当前窗口缩略图，会额外消耗模型额度。',
)

export const PERCEPTION_HEAR_OPTION: HomeOption = option(
  'perception',
  'sound',
  'switch',
  '日常音频转写',
  '仅在识别出来源程序时于本机转写文字，音频不上传云端。',
)

export const PERCEPTION_SPEAK_OPTION: HomeOption = option(
  'perception',
  'proactive',
  'switch',
  '允许主动搭话',
  '当你回到电脑前或切换窗口时，允许她偶尔主动搭话。',
)

export const PERCEPTION_LEVEL_OPTION: HomeOption = option(
  'perception',
  'proactiveLevel',
  'select',
  '搭话频率',
  '主动搭话的最大频率。',
  () => [
    { value: 'low', label: tr('较少（间隔 1 小时，每日最多 6 次）') },
    { value: 'medium', label: tr('适中（间隔 30 分钟，每日最多 12 次）') },
    { value: 'high', label: tr('较多（间隔 15 分钟，每日最多 24 次）') },
  ],
)

export const PERCEPTION_WATCH_OPTION: HomeOption = option(
  'perception',
  'watchAlong',
  'switch',
  '允许陪看',
  '对她说「陪我看」时边看边聊；关闭后不影响日常感知。',
)

export const VISION_OPTIONS: HomeOption[] = [
  option(
    'vision',
    'imageQuality',
    'select',
    '截图质量',
    '画面越清晰越易识别小字，也会消耗更多模型额度。',
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
    '画面有效时长',
    '观察屏幕后可直接操作的时间窗口；你移动键鼠后会重新观察。',
    () => [120, 600, 1800].map((value) => ({ value, label: seconds(value) })),
    true,
  ),
  option(
    'vision',
    'ocrLanguage',
    'select',
    '文字识别语言',
    '屏幕文字识别优先语言（需系统已安装对应语言包）。',
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
    '系统音频的主要语言；中英混杂推荐选择自动识别。',
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
    '伙伴发声过滤',
    '避免录入她自己的语音；按进程排除需 Windows 10 2004 及以上版本。',
    () => [
      { value: 'process', label: tr('仅排除她的语音') },
      { value: 'drop', label: tr('说话期间暂停收音') },
    ],
  ),
  option(
    'ears',
    'silenceThreshold',
    'select',
    '静音过滤阈值',
    '低于此音量的背景声直接忽略，不进行转写。',
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
    '桌宠收音提示',
    '收音时在桌宠旁显示状态标记。',
  ),
]

export const COMPANION_OPTIONS: HomeOption[] = [
  option(
    'companion',
    'interject',
    'switch',
    '陪看时主动插话',
    '一起看视频时无需等你开口即可搭话；关闭后仅在你说话时回应。',
  ),
  option('companion', 'minIntervalSec', 'select', '最短发言间隔', '两次主动发言之间的最短间隔。', () =>
    [60, 120, 180, 300, 600].map((value) => ({ value, label: seconds(value) })),
  ),
  option(
    'companion',
    'maxPerHour',
    'select',
    '每小时上限',
    '每小时主动发言的最大次数。',
    () => [6, 12, 20, 30, 60].map((value) => ({ value, label: __t('ui.desktop', '{0} 次', [value]) })),
  ),
  option(
    'companion',
    'pauseAfterSec',
    'select',
    '无动静自动暂停',
    '画面与声音静止超过此时长后暂停观察，节省模型额度。',
    () => [10, 20, 60].map((value) => ({ value, label: seconds(value) })),
    true,
  ),
]

export const ENVIRONMENT_OPTIONS: HomeOption[] = [
  option(
    'environment',
    'enabled',
    'switch',
    '记录环境变化',
    '记录离开与返回、全屏状态和后台任务完成，在你下次对话时同步给她（需开启桌面操作）。',
  ),
  option('environment', 'idle', 'switch', '离开与返回', '记录离开电脑与回到电脑前的时刻。'),
  option(
    'environment',
    'idleMinutes',
    'select',
    '离开判定时长',
    '键鼠无操作达到此时长后视作离开。',
    () => [3, 5, 10, 30].map((value) => ({ value, label: __t('ui.desktop', '{0} 分钟', [value]) })),
  ),
  option(
    'environment',
    'fullscreen',
    'switch',
    '全屏状态',
    '记录其他程序进入或退出全屏（不记录程序名与画面）。',
  ),
  option(
    'environment',
    'taskCompleted',
    'switch',
    '后台任务完成',
    '记录她发起的后台任务完成事件。',
  ),
]
