<script setup lang="ts">
/**
 * 世界书选择菜单 — 带独立搜索框，按书名筛选；已选中的书显示勾选标记。
 * 用于切换当前编辑的书与添加全局世界书。
 */
import { computed, ref } from 'vue'
import type { WorldbookSummary } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { PixelIcon } from '../../pixel'
import WorldbookPopover from './WorldbookPopover.vue'

const props = withDefaults(
  defineProps<{
    books: WorldbookSummary[]
    /** 显示勾选标记的书。 */
    selected?: string[]
    /** 不在列表中出现的书。 */
    exclude?: string[]
    /** 触发按钮文字；为空时显示占位文字。 */
    label?: string
    placeholder?: string
    icon?: string
    /** 触发按钮样式：完整选择框或紧凑按钮。 */
    variant?: 'field' | 'button'
    disabled?: boolean
  }>(),
  {
    selected: () => [],
    exclude: () => [],
    label: '',
    placeholder: '',
    icon: '',
    variant: 'field',
    disabled: false,
  },
)
const emit = defineEmits<{ select: [id: string] }>()
const open = ref(false)
const query = ref('')
const trigger = ref<HTMLElement | null>(null)

const options = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return props.books.filter(
    (book) =>
      !props.exclude.includes(book.id) &&
      (!keyword || book.name.toLocaleLowerCase().includes(keyword)),
  )
})
function toggle() {
  if (props.disabled) return
  open.value = !open.value
  query.value = ''
}
function choose(id: string) {
  open.value = false
  emit('select', id)
}
</script>

<template>
  <div class="wb-picker" :class="`wb-picker--${variant}`">
    <button
      ref="trigger"
      type="button"
      class="wb-picker__trigger"
      :class="{ open }"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggle"
    >
      <PixelIcon v-if="icon" :name="icon" size="xs" />
      <span :class="label ? 'wb-picker__value' : 'wb-picker__placeholder'">
        {{ label || placeholder }}
      </span>
      <PixelIcon
        v-if="variant === 'field'"
        name="chevron-down"
        size="xs"
        class="wb-picker__arrow"
      />
    </button>
    <WorldbookPopover :open="open" :anchor="trigger" :min-width="260" @close="open = false">
      <div class="wb-picker__search">
        <PixelIcon name="search" size="xs" />
        <input
          v-model="query"
          data-autofocus
          :placeholder="__t('ui.worldbook', '搜索世界书名称')"
          :aria-label="__t('ui.worldbook', '搜索世界书名称')"
          @keydown.enter.prevent="options[0] && choose(options[0].id)"
        />
      </div>
      <div class="wb-picker__list">
        <button
          v-for="book in options"
          :key="book.id"
          type="button"
          role="menuitem"
          class="wb-picker__option"
          :class="{ active: selected.includes(book.id) }"
          @click="choose(book.id)"
        >
          <span class="wb-picker__check">
            <PixelIcon v-if="selected.includes(book.id)" name="check" size="xs" />
          </span>
          <span class="wb-picker__name">{{ book.name }}</span>
          <small>{{ __t('ui.worldbook', '{0} 条', [book.entryCount]) }}</small>
        </button>
        <p v-if="!options.length" class="wb-picker__empty">
          {{
            books.length ? __t('ui.worldbook', '没有匹配的世界书') : __t('ui.worldbook', '书库为空')
          }}
        </p>
      </div>
    </WorldbookPopover>
  </div>
</template>

<style scoped>
.wb-picker {
  min-width: 0;
}
.wb-picker--field {
  width: min(320px, 100%);
}
.wb-picker__trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  background: var(--dash-input-bg);
  border: 2px solid var(--dash-input-border, var(--ui-border-default));
  color: var(--ui-text-primary);
  font-family: var(--ui-font-pixel);
  font-size: 13px;
  text-align: left;
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-picker--button .wb-picker__trigger {
  width: auto;
  min-height: 28px;
  padding: 3px 10px;
  border-style: dashed;
  color: var(--ui-text-secondary);
  background: transparent;
}
.wb-picker__trigger:hover:not(:disabled),
.wb-picker__trigger.open {
  border-color: var(--ui-accent-sky);
  color: var(--ui-text-primary);
}
.wb-picker__trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.wb-picker__value,
.wb-picker__placeholder {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-picker__placeholder {
  color: var(--ui-text-tertiary);
}
.wb-picker__arrow {
  flex-shrink: 0;
  color: var(--ui-text-secondary);
}
.wb-picker__search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-tertiary);
}
.wb-picker__search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--ui-text-primary);
  font-size: 13px;
}
.wb-picker__list {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 0;
}
.wb-picker__option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  color: var(--ui-text-secondary);
  transition: background-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-picker__option:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}
.wb-picker__option.active {
  color: var(--ui-accent-sky);
}
.wb-picker__check {
  display: inline-flex;
  width: 14px;
  flex-shrink: 0;
}
.wb-picker__name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.wb-picker__option small {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
.wb-picker__empty {
  padding: 14px 12px;
  color: var(--ui-text-tertiary);
  text-align: center;
}
</style>
