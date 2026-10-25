import type { PackagePanel, PackageUiSlot } from '@infos/shared'

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
    { panel: PackagePanel; action?: (id: string) => Promise<unknown> }
  >()
  register(panel: PackagePanel, action?: (id: string) => Promise<unknown>): () => void {
    if (
      !PACKAGE_UI_SLOTS.includes(panel.slot) ||
      typeof panel.id !== 'string' ||
      typeof panel.title !== 'string' ||
      panel.title.length > 200 ||
      !panel.title ||
      this.panels.has(panel.id) ||
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
  async invoke(panelId: string, actionId: string): Promise<unknown> {
    const entry = this.panels.get(panelId)
    if (!entry?.action || !entry.panel.actions?.some((item) => item.id === actionId))
      throw new Error('PACKAGE_ACTION_UNAVAILABLE')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        entry.action(actionId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PACKAGE_ACTION_TIMEOUT')), 10_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
