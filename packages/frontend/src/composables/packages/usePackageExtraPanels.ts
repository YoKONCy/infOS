import { ref } from 'vue'
import type { PackagePanel } from '@infos/shared'
import { packagesApi } from '../../api/modules/packagesApi'

/** 插件卡片的设置入口和本机页面入口共用同一次注册表快照。 */
export function usePackageExtraPanels() {
  const settingsPanels = ref<PackagePanel[]>([])
  const pagePanels = ref<PackagePanel[]>([])
  const settingsPanel = ref<PackagePanel>()

  async function refreshExtraPanels(): Promise<void> {
    const panels = (await packagesApi.panels('integrations')).data ?? []
    settingsPanels.value = panels.filter((panel) => panel.settings?.kind === 'tool-groups')
    pagePanels.value = panels.filter((panel) => panel.settings?.kind === 'local-page')
    if (settingsPanel.value && !settingsPanels.value.some((panel) => panel.id === settingsPanel.value?.id))
      settingsPanel.value = undefined
  }

  return { settingsPanels, pagePanels, settingsPanel, refreshExtraPanels }
}
