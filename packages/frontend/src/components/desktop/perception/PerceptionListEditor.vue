<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t as __t } from '../../../i18n/index'
import { PButton, PTextarea } from '../../pixel'

// 程序名单：一行一个，点保存才生效；没改动时跟着外部值走。
const props = defineProps<{
  title: string
  hint: string
  value: string[]
  saved?: boolean
}>()
const emit = defineEmits<{ save: [value: string[]] }>()

const parse = (text: string) => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
]
const text = ref(props.value.join('\n'))
const dirty = computed(() => parse(text.value).join('\n') !== props.value.join('\n'))
watch(
  () => props.value,
  (value, previous) => {
    // 只有内容真的变了才覆盖，保存后推回来的同一份名单不打断输入。
    if (value.join('\n') !== previous.join('\n')) text.value = value.join('\n')
  },
)
</script>

<template>
  <div class="perception-list">
    <!-- 用 label 包住输入框：PTextarea 的属性落在外层，aria-label 到不了 textarea。 -->
    <label>
      <strong>{{ title }}</strong>
      <span class="perception-list-hint">{{ hint }}</span>
      <PTextarea v-model="text" :rows="3" />
    </label>
    <div class="perception-list-actions">
      <Transition name="motion-fade">
        <span v-if="saved && !dirty" role="status">{{ __t('ui.desktop', '已保存') }}</span>
      </Transition>
      <PButton size="sm" variant="ghost" :disabled="!dirty" @click="emit('save', parse(text))">
        {{ __t('ui.desktop', '保存名单') }}
      </PButton>
    </div>
  </div>
</template>

<style scoped>
.perception-list {
  padding: 10px 0;
  color: var(--ui-text-primary);
  font-size: 13px;
}
.perception-list-hint {
  display: block;
  margin: 2px 0 6px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.perception-list-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
</style>
