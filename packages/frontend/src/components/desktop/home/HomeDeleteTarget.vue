<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { HomeDeleteTarget } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { apiClient } from '../../../api'
import { MotionSkeleton } from '../../motion'
import { homeErrorText } from './homeFormat'

// 删除去向：她删除你的文件时放进 Windows 回收站（默认）还是 infOS 回收区（home.deleteTarget.v1）。
const target = ref<HomeDeleteTarget | null>(null)
const busy = ref(false)
const error = ref('')
const saved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(savedTimer))

const choices = computed<Array<{ value: HomeDeleteTarget; label: string; hint: string }>>(() => [
  {
    value: 'system',
    label: __t('ui.desktop', 'Windows 回收站（推荐）'),
    hint: __t('ui.desktop', '在你熟悉的地方还原。'),
  },
  {
    value: 'infos',
    label: __t('ui.desktop', 'infOS 回收区'),
    hint: __t('ui.desktop', '集中放在下面的回收区里，由你手动清空。'),
  },
])

onMounted(async () => {
  try {
    const result = await apiClient.get<{ target: HomeDeleteTarget }>('/home/settings/delete-target')
    target.value = result.data?.target ?? 'system'
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
})

async function choose(value: HomeDeleteTarget) {
  if (busy.value || value === target.value) return
  const previous = target.value
  target.value = value
  busy.value = true
  try {
    const result = await apiClient.put<{ target: HomeDeleteTarget }>(
      '/home/settings/delete-target',
      { target: value },
    )
    target.value = result.data?.target ?? value
    error.value = ''
    saved.value = true
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => (saved.value = false), 1600)
  } catch (cause) {
    target.value = previous
    error.value = homeErrorText(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="home-panel">
    <header>
      <div>
        <h4>{{ __t('ui.desktop', '她删除你的文件时放到哪里') }}</h4>
        <p class="home-muted">
          {{
            __t(
              'ui.desktop',
              '无论选哪个都不会永久删除。放进 Windows 回收站失败时，会自动改放 infOS 回收区。',
            )
          }}
        </p>
      </div>
      <Transition name="motion-fade">
        <span v-if="saved" class="home-ok" role="status">{{ __t('ui.desktop', '已保存') }}</span>
      </Transition>
    </header>
    <MotionSkeleton v-if="!target && !error" variant="text" :rows="1" />
    <div
      v-else-if="target"
      class="home-choices"
      role="radiogroup"
      :aria-label="__t('ui.desktop', '她删除你的文件时放到哪里')"
    >
      <button
        v-for="choice in choices"
        :key="choice.value"
        type="button"
        role="radio"
        class="home-choice motion-press"
        :class="{ 'is-on': target === choice.value }"
        :aria-checked="target === choice.value"
        :disabled="busy"
        @click="choose(choice.value)"
      >
        <i aria-hidden="true" />
        <span>
          <strong>{{ choice.label }}</strong>
          <small>{{ choice.hint }}</small>
        </span>
      </button>
    </div>
    <Transition name="motion-rise">
      <p v-if="error" role="alert" class="home-error">{{ error }}</p>
    </Transition>
  </section>
</template>

<style scoped src="./homePanel.css"></style>
<style scoped>
.home-choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.home-choice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  text-align: left;
  cursor: pointer;
}
.home-choice.is-on {
  border-color: var(--ui-accent-sky);
  background: color-mix(in srgb, var(--ui-accent-sky) 8%, var(--ui-bg-surface));
}
.home-choice:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.home-choice:disabled {
  cursor: progress;
}
.home-choice i {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 2px solid var(--ui-border-strong);
  border-radius: 50%;
  transition:
    border-color var(--motion-duration-fast) var(--motion-ease-out),
    box-shadow var(--motion-duration-fast) var(--motion-ease-out);
}
.home-choice.is-on i {
  border-color: var(--ui-accent-sky);
  box-shadow: inset 0 0 0 3px var(--ui-bg-surface);
  background: var(--ui-accent-sky);
}
.home-choice span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.home-choice strong {
  font-size: 13px;
}
.home-choice small {
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.home-ok {
  font-size: 12px;
}
</style>
