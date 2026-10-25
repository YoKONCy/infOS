<script setup lang="ts">
import { ref, watch } from 'vue'
import { PButton } from '../../pixel'
import { socialApi, type SocialConnection } from '../../../api/modules/socialApi'
import { t } from '../../../i18n'
const props = defineProps<{ connection: SocialConnection; label: string; hint: string }>()
const emit = defineEmits<{ changed: [] }>()
const value = ref(props.connection.ownerId ?? '')
const busy = ref(false)
const error = ref('')
const saved = ref(false)
watch(
  () => props.connection.ownerId,
  (owner) => {
    value.value = owner ?? ''
    saved.value = false
  },
)
async function save() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  saved.value = false
  try {
    await socialApi.saveConnectionOwner(props.connection.id, value.value.trim())
    emit('changed')
    saved.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('ui.social', '连接操作失败')
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="sp-platform-card sp-owner-card">
    <header class="sp-platform-card-head">
      <div>
        <h3>{{ t('ui.social', '主人身份') }}</h3>
        <p>{{ hint }}</p>
      </div>
    </header>
    <form class="sp-platform-form" @submit.prevent="save">
      <label :for="`owner-${connection.id}`">{{ label }}</label>
      <div class="sp-platform-input-row">
        <input
          :id="`owner-${connection.id}`"
          v-model="value"
          class="sp-platform-input"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
          @input="saved = false"
        />
        <PButton type="submit" size="sm" variant="secondary" :loading="busy">
          {{ saved ? t('ui.social', '已保存') : t('ui.social', '保存') }}
        </PButton>
      </div>
      <p v-if="error" class="sp-platform-error" role="alert">{{ error }}</p>
    </form>
  </section>
</template>
<style scoped src="./platformSettings.css"></style>
