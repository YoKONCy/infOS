<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ManagedPackageInfo, PackagePanel } from '@infos/shared'
import { t } from '../../i18n'
import { openPackageLocalPage } from '../../composables/packages/packageLocalPage'
import { PButton, PixelIcon } from '../pixel'

const props = defineProps<{
  item: ManagedPackageInfo
  busy: boolean
  settingsPanels: PackagePanel[]
  pagePanels: PackagePanel[]
}>()
const emit = defineEmits<{
  settings: [panel: PackagePanel]
  error: [message: string]
}>()
const settings = computed(() => props.settingsPanels.filter((panel) => panel.packageId === props.item.manifest.packageId))
const pages = computed(() => props.pagePanels.filter((panel) => panel.packageId === props.item.manifest.packageId))
const opening = ref(false)

async function openPage(panel: PackagePanel): Promise<void> {
  if (props.busy || opening.value) return
  opening.value = true
  emit('error', '')
  try {
    await openPackageLocalPage(panel.id)
  } catch (error) {
    emit('error', error instanceof Error ? error.message : t('ui.packages', '操作失败，请重试。'))
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <PButton
    v-for="panel in settings"
    :key="panel.id"
    size="sm"
    variant="secondary"
    :disabled="busy || item.state !== 'active'"
    :title="panel.title"
    @click="emit('settings', panel)"
  >
    <PixelIcon name="settings" size="xs" />
    {{ t('ui.packages', '工具管理') }}
  </PButton>
  <PButton
    v-for="panel in pages"
    :key="panel.id"
    size="sm"
    variant="secondary"
    :disabled="busy || opening || item.state !== 'active'"
    :title="panel.title"
    @click="openPage(panel)"
  >
    <PixelIcon name="external-link" size="xs" />
    {{ t('ui.packages', '打开页面') }}
  </PButton>
</template>
