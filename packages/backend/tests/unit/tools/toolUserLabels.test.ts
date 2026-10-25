import { ADVANCED_TOOL_NAMES } from '../../../src/tools/advancedTools'
import { getBuiltinToolDefinitions } from '../../../src/tools'
import { describe, expect, it } from 'vitest'
import { resolveToolUserDescription, resolveToolUserLabel } from '../../../src/tools/toolUserLabels'

describe('工具用户文案', () => {
  it('工具包来源自动取自清单，同包子工具共享分组标识', () => {
    const definitions = getBuiltinToolDefinitions()
    expect(definitions.every((definition) => definition.packageId?.startsWith('builtin:'))).toBe(
      true,
    )
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    expect(byName.get('read_file')?.packageId).toBe('builtin:file-ops')
    expect(byName.get('write_file')?.packageId).toBe(byName.get('read_file')?.packageId)
    expect(byName.get('read_file')?.packageId).not.toBe(byName.get('update_plan')?.packageId)
  })

  it('所有主内核内置工具都必须自行声明用户名称和说明', () => {
    const missing = getBuiltinToolDefinitions()
      .filter(
        (definition) =>
          !definition.display?.label?.trim() || !definition.display?.description?.trim(),
      )
      .map((definition) => definition.name)
    expect(missing).toEqual([])
  })

  it('高级工具应按浏览器、Computer Use 和远程节点终端工具包维护', () => {
    expect([...ADVANCED_TOOL_NAMES]).toEqual(
      expect.arrayContaining([
        'browser_open_url',
        'browser_status',
        'automation_execute',
        'get_mouse_position',
        'open_application',
        'get_active_windows',
        'activate_window',
        'remote_terminal_nodes',
        'remote_terminal_create',
        'remote_terminal_read',
        'remote_terminal_close',
      ]),
    )
    expect(ADVANCED_TOOL_NAMES.has('take_screenshot')).toBe(false)
    expect(ADVANCED_TOOL_NAMES.has('web_fetch')).toBe(false)
    expect(ADVANCED_TOOL_NAMES.has('get_system_info')).toBe(false)
  })

  it('应优先使用工具自身声明的用户文案', () => {
    expect(resolveToolUserLabel('finish_task', '扩展自定义名称')).toBe('扩展自定义名称')
    expect(resolveToolUserDescription('finish_task', '扩展自定义说明', '模型技术说明')).toBe(
      '扩展自定义说明',
    )
  })

  it('未知扩展未声明文案时不应暴露函数名和内部术语', () => {
    const internalName = 'some_internal_command'
    const technicalDescription = 'AgentApplication SubAgent command API'
    const copy = [
      resolveToolUserLabel(internalName),
      resolveToolUserDescription(internalName, undefined, technicalDescription),
    ]
    for (const text of copy) {
      expect(text.trim()).not.toBe('')
      expect(text).not.toMatch(/some_internal_command|AgentApplication|SubAgent|command|API/)
    }
  })
})
