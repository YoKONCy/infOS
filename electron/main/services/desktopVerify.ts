/**
 * @file 「手」的每步回读：动作发出后核对真实结果，没做成就明确说没做成、为什么、下一步怎么办。
 *
 * 依据（有哪个用哪个，纯函数，便于单独测试）：
 * - 控件回读：桥接在控件操作前后各读一次状态（值、勾选、展开、选中）；写值时桥接读完整值直接比较；
 *   输入文字前后各读一次焦点控件的值，比较这段字出现的次数有没有增加（原来就有不算做成）。
 * - `expect`（可选）：角色说明这一步应该带来什么——某段文字出现（`text`）、消失（`gone`），
 *   或出现某个标题的新窗口（`window`，只认动作后新出现的）；动作后的元素图与窗口列表里核对。
 * - 画面：动作前后两次观察的画面指纹几乎一样时，提示可能没生效（变化很小时也可能误报，所以只算提示）。
 *
 * 拿不准的一律报 unverified 或 no_change，不报 confirmed：只核对了开头、没读到元素图、元素图被截断、
 * 动作前没记下窗口列表、前后画面比不了。
 *
 * 参考 clawdcursor 的 `expect` / 「操作后核对」做法（MIT，见 THIRD_PARTY_NOTICES.md）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 动作后回读
 */

/** 前后画面差异小于它，视为「画面几乎没变」。 */
export const NO_CHANGE_THRESHOLD = 0.0005

export interface ActionExpect {
  text?: string
  gone?: string
  window?: string
}

export interface VerifyCheck {
  check: string
  ok: boolean
  /** 拿不准：既不能说做成，也不能说没做成。 */
  uncertain?: boolean
  detail?: string
}

/**
 * confirmed：核对到了预期结果；failed：核对到没做成；
 * no_change：没有可核对的结果且画面几乎没变；changed：比较过前后画面，画面变了，但没有可核对的具体结果；
 * unverified：拿不准（回读不完整，或前后画面比不了）。
 */
export interface ActionVerify {
  status: 'confirmed' | 'failed' | 'no_change' | 'changed' | 'unverified'
  checks: VerifyCheck[]
  reason?: string
  suggestion?: string
}

type State = Record<string, unknown> | null | undefined

export interface VerifyInput {
  action: string
  text?: string
  receipt?: {
    before?: State
    after?: State
    observed?: Record<string, unknown> | null
  }
  expect?: ActionExpect
  /** 前后画面指纹差异；比不了时不给。 */
  frameDiff?: number
  /** 动作后元素图里的文字与当前值；没读元素图或元素图为空时不给。 */
  texts?: string[]
  /** 元素图完整（没有被截断）；不完整时「没出现 / 已消失」不能下结论。 */
  textsComplete?: boolean
  /** 动作后新出现（或标题变了）的窗口标题；动作前没记下窗口列表时不给。 */
  windows?: string[]
}

const norm = (value: unknown) =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * set_value 的回读：新桥接读完整值直接比较（valueMatches）。只有 200 字预览时，
 * 短文字照常比较；长文字只能核对开头——开头对得上也只算拿不准（undefined）。
 */
function sameValue(after: Record<string, unknown>, expected: string): boolean | undefined {
  if (typeof after.valueMatches === 'boolean') return after.valueMatches
  const left = String(after.value ?? '')
  const right = expected.replace(/[\r\n]/g, ' ').trim()
  if (right.length <= 200) return left.trim() === right
  const prefix = left.replace(/…$/, '')
  // 控件为空、比预期短（被截断）、开头不一样：没做成。
  if (prefix.length < 200 || !right.startsWith(prefix)) return false
  return undefined
}

/** 输入文字的回读：比较输入前后这段字出现的次数。 */
function typedCheck(observed: Record<string, unknown>): VerifyCheck | undefined {
  if (observed.otherProgram === true)
    return { check: 'typed', ok: false, detail: '输入后焦点在另一个程序上' }
  if (observed.readable !== true) return undefined
  const role = String(observed.role)
  if (observed.contains !== true)
    return { check: 'typed', ok: false, detail: `焦点控件（${role}）里没有刚输入的字` }
  if (typeof observed.added === 'boolean')
    return observed.added
      ? { check: 'typed', ok: true, detail: `焦点控件（${role}）里多了刚输入的字` }
      : {
          check: 'typed',
          ok: false,
          detail: `焦点控件（${role}）里这段字在输入前就有，输入后没有多出来`,
        }
  // 旧桥接没有输入前的值：有这段字，但可能原来就有。
  return {
    check: 'typed',
    ok: false,
    uncertain: true,
    detail: `焦点控件（${role}）里有这段字，但没读到输入前的内容，不能确定是这次输入的`,
  }
}

/** 控件与输入的回读核对；没有可用回读时返回 undefined。 */
function readBackCheck(input: VerifyInput): VerifyCheck | undefined {
  const { before, after, observed } = input.receipt ?? {}
  if (input.action === 'set_value' && after && 'value' in after) {
    const same = sameValue(after, input.text ?? '')
    return {
      check: 'value',
      ok: same === true,
      ...(same === undefined ? { uncertain: true } : {}),
      detail:
        same === undefined
          ? `只核对了开头 200 字：${JSON.stringify(after.value)}`
          : `控件现在的值：${JSON.stringify(after.value)}`,
    }
  }
  if (input.action === 'toggle' && before?.toggle !== undefined && after?.toggle !== undefined)
    return {
      check: 'toggle',
      ok: before.toggle !== after.toggle,
      detail: `勾选状态：${String(before.toggle)} → ${String(after.toggle)}`,
    }
  if ((input.action === 'expand' || input.action === 'collapse') && after?.expand !== undefined) {
    const want = input.action === 'expand' ? /expanded/i : /collapsed/i
    return {
      check: 'expand',
      ok: want.test(String(after.expand)) && !/partially/i.test(String(after.expand)),
      detail: `展开状态：${String(after.expand)}`,
    }
  }
  if (input.action === 'select' && after?.selected !== undefined)
    return { check: 'selected', ok: after.selected === true, detail: `选中：${after.selected}` }
  if (input.action === 'type' && observed) return typedCheck(observed)
  return undefined
}

const SUGGEST: Record<string, string> = {
  value: '控件可能只读或会改写输入：先点中它，用 type 输入，或看看界面上的提示。',
  toggle: '控件可能需要先选中或被禁用：重新观察，确认它可用后再点。',
  expand: '重新观察，确认展开按钮的位置后改用点击。',
  selected: '重新观察，改用点击这一项。',
  typed: '先点中输入框（看新观察里光标在哪），再输入；输入法开着时先关掉或切到英文。',
  text: '可能还没加载完：用 wait（until.text）等一会儿；或者点错了位置，重新观察换一个目标。',
  gone: '可能没点中或还在处理：用 wait（until.gone）等一会儿，再重新观察。',
  window: '窗口可能还在打开：用 wait（until.window）等一会儿；仍没有就重新观察看看卡在哪。',
}

const UNSURE_SUGGESTION = '请看操作后画面确认；需要时局部放大，或带 includeElements 重新观察。'

/** expect 的三项核对；读不到依据时给「拿不准」，不给结论。 */
function expectChecks(input: VerifyInput): VerifyCheck[] {
  const checks: VerifyCheck[] = []
  const expect = input.expect ?? {}
  const complete = input.textsComplete !== false
  if (expect.text) {
    const seen = !!input.texts?.some((text) => norm(text).includes(norm(expect.text)))
    if (!input.texts)
      checks.push({ check: 'text', ok: false, uncertain: true, detail: '没读到元素图，无法核对' })
    else
      checks.push({
        check: 'text',
        ok: seen,
        ...(!seen && !complete ? { uncertain: true } : {}),
        detail: `「${expect.text}」${seen ? '出现了' : complete ? '没有出现' : '在读到的部分里没有出现（元素图不完整）'}`,
      })
  }
  if (expect.gone) {
    const still = !!input.texts?.some((text) => norm(text).includes(norm(expect.gone)))
    if (!input.texts)
      checks.push({ check: 'gone', ok: false, uncertain: true, detail: '没读到元素图，无法核对' })
    else
      checks.push({
        check: 'gone',
        ok: !still,
        ...(!still && !complete ? { uncertain: true } : {}),
        detail: `「${expect.gone}」${still ? '还在' : complete ? '已消失' : '在读到的部分里没有（元素图不完整）'}`,
      })
  }
  if (expect.window) {
    if (!input.windows)
      checks.push({
        check: 'window',
        ok: false,
        uncertain: true,
        detail: '没拿到动作前后的窗口列表，无法核对',
      })
    else {
      const found = input.windows.find((title) => norm(title).includes(norm(expect.window)))
      checks.push({
        check: 'window',
        ok: !!found,
        detail: found ? `窗口「${found}」已出现` : `没有新出现标题含「${expect.window}」的窗口`,
      })
    }
  }
  return checks
}

/** 综合各项核对给出结论。 */
export function judgeAction(input: VerifyInput): ActionVerify {
  const checks: VerifyCheck[] = []
  const readBack = readBackCheck(input)
  if (readBack) checks.push(readBack)
  checks.push(...expectChecks(input))
  const failed = checks.find((check) => !check.ok && !check.uncertain)
  if (failed)
    return {
      status: 'failed',
      checks,
      reason: failed.detail,
      suggestion: SUGGEST[failed.check],
    }
  const unsure = checks.find((check) => check.uncertain)
  if (unsure)
    return { status: 'unverified', checks, reason: unsure.detail, suggestion: UNSURE_SUGGESTION }
  if (checks.length) return { status: 'confirmed', checks }
  if (input.frameDiff === undefined)
    return {
      status: 'unverified',
      checks,
      reason: '前后画面没法比较（换了窗口或观察范围不同）',
      suggestion: UNSURE_SUGGESTION,
    }
  if (input.frameDiff < NO_CHANGE_THRESHOLD)
    return {
      status: 'no_change',
      checks,
      reason: '动作后画面几乎没有变化',
      suggestion:
        '可能没点中或程序没反应（变化很小时也会这样）：局部放大看看；确实没变就换元素编号或坐标再试，界面慢就用 wait 等一下。',
    }
  return { status: 'changed', checks }
}

/** 给模型看的一句话结论。 */
export function verifyMessage(verify: ActionVerify): string {
  if (verify.status === 'confirmed') return '已核对：这一步做成了。'
  if (verify.status === 'failed')
    return `没做成：${verify.reason ?? '核对不通过'}。${verify.suggestion ?? ''}`
  if (verify.status === 'no_change') return `可能没生效：${verify.reason}。${verify.suggestion}`
  if (verify.status === 'unverified')
    return `拿不准做成了没有：${verify.reason ?? '没有可靠的核对依据'}。${verify.suggestion ?? UNSURE_SUGGESTION}`
  return '动作已发出，画面有变化，但没有可以自动核对的结果：请看操作后画面确认；需要时用 expect 说明预期。'
}
