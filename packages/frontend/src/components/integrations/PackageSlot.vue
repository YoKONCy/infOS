<script setup lang="ts">
import { ref, onMounted, onActivated } from 'vue'
import type { PackagePanel, PackageUiSlot } from '@infos/shared'
import { packagesApi } from '../../api/modules/packagesApi'
import { PCard, PButton } from '../pixel'
import { t } from '../../i18n'
import { useInterval } from '../../composables/useInterval'
const props = defineProps<{ region: PackageUiSlot }>()
const panels = ref<PackagePanel[]>([])
const busy = ref(false)
const error = ref('')
async function refresh() {
  try {
    panels.value = (await packagesApi.panels(props.region)).data ?? []
  } catch {
    panels.value = []
  }
}
async function invoke(panel: PackagePanel, id: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await packagesApi.action(panel.id, id)
    await refresh()
  } catch {
    error.value = t('ui.packages', '操作失败，请重试。')
  } finally {
    busy.value = false
  }
}
onMounted(refresh)
onActivated(refresh)
useInterval(() => {
  void refresh()
}, 15000)
defineExpose({ refresh })
</script>
<template>
  <section v-if="panels.length" class="package-slot" :data-slot="region">
    <PCard v-for="panel in panels" :key="panel.id" pixel padding="md">
      <h3>{{ panel.title }}</h3>
      <p v-if="panel.text">{{ panel.text }}</p>
      <dl v-if="panel.fields?.length">
        <template v-for="(field, index) in panel.fields" :key="index">
          <dt>{{ field.label }}</dt>
          <dd>{{ field.value }}</dd>
        </template>
      </dl>
      <div class="package-slot-actions">
        <PButton
          v-for="action in panel.actions"
          :key="action.id"
          size="sm"
          variant="secondary"
          :disabled="busy"
          @click="invoke(panel, action.id)"
        >
          {{ action.label }}
        </PButton>
      </div>
    </PCard>
    <p v-if="error" role="status">{{ error }}</p>
  </section>
</template>
<style scoped>
.package-slot {
  display: grid;
  gap: 14px;
  margin: 12px 0;
  min-width: 0;
}
h3 {
  font: 700 14px/1.5 var(--ui-font-pixel);
  margin: 0 0 10px;
}
p {
  color: var(--ui-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.8 var(--ui-font-body);
}
dl {
  display: grid;
  grid-template-columns: minmax(80px, 1fr) 2fr;
  gap: 8px;
  font-size: 12px;
}
dt {
  color: var(--ui-text-tertiary);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.package-slot-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
