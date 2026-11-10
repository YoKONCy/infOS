import type { PackagePanel, PackageUiSlot } from '@infos/shared'
import { invalidSettingsEntry, isSettingsAction, settingsActionResult } from './packageSettingsEntry'

export { readLocalPageUrl } from './packageSettingsEntry'

export const PACKAGE_UI_SLOTS: PackageUiSlot[] = [
  'dashboard.overview',
  'chat.header',
  'chat.footer',
  'integrations',
]

/** 前端只渲染声明式卡片；操作仅分派给当前激活贡献注册的处理器。 */
export class PackageUiRegistry {
  private panels = new Map<
    string,
    {
      panel: PackagePanel
      action?: (id: string, payload?: Record<string, unknown>) => Promise<unknown>
    }
  >()
  register(
    panel: PackagePanel,
    action?: (id: string, payload?: Record<string, unknown>) => Promise<unknown>,
  ): () => void {
    if (
      !PACKAGE_UI_SLOTS.includes(panel.slot) ||
      typeof panel.id !== 'string' ||
      typeof panel.title !== 'string' ||
      panel.title.length > 200 ||
      !panel.title ||
      this.panels.has(panel.id) ||
      invalidSettingsEntry(panel) ||
      (action !== undefined && typeof action !== 'function') ||
      (panel.settings !== undefined && !action) ||
      (panel.text !== undefined && typeof panel.text !== 'string') ||
      (panel.fields !== undefined &&
        (!Array.isArray(panel.fields) ||
          panel.fields.some(
            (field) =>
              !field ||
              typeof field.label !== 'string' ||
              typeof field.value !== 'string' ||
              field.label.length > 200 ||
              field.value.length > 4000,
          ))) ||
      (panel.actions !== undefined &&
        (!Array.isArray(panel.actions) ||
          panel.actions.some(
            (action) =>
              !action ||
              typeof action.id !== 'string' ||
              typeof action.label !== 'string' ||
              action.label.length > 100 ||
              action.id.length > 100,
          ))) ||
      (panel.text?.length ?? 0) > 8000 ||
      (panel.fields?.length ?? 0) > 30 ||
      (panel.actions?.length ?? 0) > 10
    )
      throw new Error('PACKAGE_PANEL_INVALID')
    const entry = { panel: structuredClone(panel), action }
    this.panels.set(panel.id, entry)
    return () => {
      if (this.panels.get(panel.id) === entry) this.panels.delete(panel.id)
    }
  }
  list(slot: PackageUiSlot): PackagePanel[] {
    return [...this.panels.values()]
      .filter((entry) => entry.panel.slot === slot)
      .map((entry) => structuredClone(entry.panel))
  }
  async invoke(
    panelId: string,
    actionId: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const entry = this.panels.get(panelId)
    const settingsAction = isSettingsAction(entry?.panel, actionId)
    if (
      !entry?.action ||
      (!settingsAction && !entry.panel.actions?.some((item) => item.id === actionId))
    )
      throw new Error('PACKAGE_ACTION_UNAVAILABLE')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        entry.action(actionId, payload === undefined ? undefined : structuredClone(payload)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PACKAGE_ACTION_TIMEOUT')), 10_000)
        }),
      ])
      if (this.panels.get(panelId) !== entry) throw new Error('PACKAGE_ACTION_UNAVAILABLE')
      return settingsAction ? settingsActionResult(actionId, result) : result
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
