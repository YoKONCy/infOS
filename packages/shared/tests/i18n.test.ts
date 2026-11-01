import { afterEach, describe, expect, it } from 'vitest'
import {
  getLocale,
  normalizeLocale,
  resolvePreferredLocale,
  resolveEnvironmentLocale,
  onLocaleChange,
  registerCatalog,
  setLocale,
  translate,
  translateDiagnostic,
} from '../src/i18n'

afterEach(() => setLocale('zh-CN'))

describe('分类翻译运行时', () => {
  it('只选择简中、繁中与英文，并兼容浏览器语言标记', () => {
    expect(normalizeLocale('zh-HK')).toBe('zh-TW')
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(normalizeLocale('zh-TW,zh;q=0.8')).toBe('zh-TW')
    expect(normalizeLocale('en_GB')).toBe('en-US')
    expect(normalizeLocale('zh-Hans-TW')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hant-CN')).toBe('zh-TW')
    expect(normalizeLocale('zh_SG.UTF-8')).toBe('zh-CN')
    expect(normalizeLocale('ja-JP')).toBe('en-US')
    expect(normalizeLocale(undefined)).toBe('en-US')
  })

  it('按系统偏好顺序找受支持语言，全部不支持时回退英文', () => {
    expect(resolvePreferredLocale(['ja-JP', 'zh-Hant-HK', 'en-GB'])).toBe('zh-TW')
    expect(resolvePreferredLocale(['en-AU', 'zh-CN'])).toBe('en-US')
    expect(resolvePreferredLocale(['ja-JP', 'fr-FR'])).toBe('en-US')
    expect(resolvePreferredLocale([])).toBe('en-US')
    expect(normalizeLocale('zh-TW;q=0,en;q=0.8')).toBe('en-US')
  })

  it('显式环境覆盖优先，缺失或不支持的区域信息继续使用系统提示', () => {
    expect(
      resolveEnvironmentLocale({ INFOS_LANGUAGE: 'zh-TW', LANG: 'en_US.UTF-8' }, 'en-US'),
    ).toBe('zh-TW')
    expect(resolveEnvironmentLocale({ LANG: 'zh_CN.UTF-8' }, 'en-US')).toBe('zh-CN')
    expect(resolveEnvironmentLocale({ LANG: 'C.UTF-8' }, 'zh-Hant-TW')).toBe('zh-TW')
    expect(resolveEnvironmentLocale({}, 'fr-FR')).toBe('en-US')
  })

  it('分类词库彼此隔离，缺少译文依次回退英文、简中和查询原文', () => {
    registerCatalog('test.actions', 'zh-CN', { 打开: '打开', 未译: '缺省文案' })
    registerCatalog('test.actions', 'en-US', { 打开: 'Open' })
    registerCatalog('test.status', 'en-US', { 打开: 'On' })
    setLocale('en-US')
    expect(translate('test.actions', '打开')).toBe('Open')
    expect(translate('test.status', '打开')).toBe('On')
    expect(translate('test.actions', '未译')).toBe('缺省文案')
    expect(translate('test.actions', '打开', [], 'zh-TW')).toBe('Open')
    expect(translate('test.actions', '打开', [], 'zh-CN')).toBe('打开')
    expect(translate('unknown', '未知原文')).toBe('未知原文')
  })

  it('插值参数保持原样，不二次解释用户文本、HTML、路径或占位符', () => {
    registerCatalog('test.parameters', 'en-US', { '文件 {0}：{1}': 'File {0}: {1}' })
    setLocale('en-US')
    expect(translate('test.parameters', '文件 {0}：{1}', ['工作区/主人.txt', '<b>{0}</b>'])).toBe(
      'File 工作区/主人.txt: <b>{0}</b>',
    )
  })

  it('只广播实际语言变化，取消订阅后不再调用', () => {
    const updates: string[] = []
    const stop = onLocaleChange((value) => updates.push(value))
    setLocale('en-US')
    setLocale('en-US')
    stop()
    setLocale('zh-TW')
    expect(updates).toEqual(['en-US'])
    expect(getLocale()).toBe('zh-TW')
  })

  it('异常仅在展示边界翻译，不修改异常原文、参数或业务错误码', () => {
    registerCatalog('errors.test', 'zh-CN', { '文件 {0} 无法读取': '文件 {0} 无法读取' })
    registerCatalog('errors.test', 'en-US', { '文件 {0} 无法读取': 'Cannot read file {0}' })
    const error = new Error('文件 主人的笔记.md 无法读取')
    expect(translateDiagnostic(error.message, 'en-US')).toBe('Cannot read file 主人的笔记.md')
    expect(error.message).toBe('文件 主人的笔记.md 无法读取')
    expect(translateDiagnostic('用户自己写的一段话', 'en-US')).toBe('用户自己写的一段话')
  })
})
