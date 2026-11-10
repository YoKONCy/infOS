<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * PSelect — 像素风下拉选择器
 *
 * - CSS 变量色值 (取代硬编码 sky-400)
 * - useEventListener 管理点击外部关闭
 * - 列表传送到 body 并按可用空间定位，不会被滚动容器或视口底边裁掉
 * - TypeScript strict
 */
import { ref, computed, nextTick, onBeforeUnmount, onDeactivated, useId, watch } from 'vue'
import PixelIcon from './PixelIcon.vue'
import { useEventListener } from '../../composables'
import { useSelectKeyboard } from '../../composables/ui/useSelectKeyboard'
import {
  collectClipRects,
  computeDropdownPlacement,
  isAnchorVisible,
} from '../../lib/floatingPlacement'

export interface SelectOption {
  label: string
  value: string | number
  disabled?: boolean
  icon?: string
}

interface Props {
  modelValue: string | number
  options: SelectOption[]
  label?: string
  icon?: string
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md' | 'lg'
  /** @deprecated 列表现在总是传送到 body；保留此项只为兼容旧调用。 */
  teleport?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  label: '',
  icon: '',
  placeholder: undefined,
  disabled: false,
  size: 'md',
  teleport: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: string | number]
  change: [value: string | number]
}>()

const isOpen = ref(false)
const displayPlaceholder = computed(() => props.placeholder ?? __t('ui.pixel', '请选择...'))
const containerRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const dropdownRef = ref<HTMLElement | null>(null)
const dropdownStyle = ref<Record<string, string>>({})
const openAbove = ref(false)
const listId = `p-select-${useId()}`

function updateDropdownPosition(): void {
  const trigger = triggerRef.value
  const dropdown = dropdownRef.value
  if (!trigger || !dropdown) return
  const rect = trigger.getBoundingClientRect()
  const placed = computeDropdownPlacement({
    anchor: rect,
    // scrollHeight 不含边框，也不受 max-height 影响，加上边框才是完整高度。
    contentHeight: dropdown.scrollHeight + dropdown.offsetHeight - dropdown.clientHeight,
    width: rect.width,
    viewportWidth: window.innerWidth,
    viewportHeight: window.visualViewport?.height || window.innerHeight,
    layoutHeight: window.innerHeight,
  })
  openAbove.value = placed.side === 'above'
  // 传送后离开了自定义壁纸的作用域，把触发器处的面板底色和字体带过去，外观才和原地展开一致。
  const material = getComputedStyle(trigger).getPropertyValue('--dash-panel-elevated').trim()
  const fontFamily = containerRef.value ? getComputedStyle(containerRef.value).fontFamily : ''
  dropdownStyle.value = {
    left: `${placed.left}px`,
    width: `${placed.width}px`,
    maxHeight: `${placed.maxHeight}px`,
    top: placed.top === null ? 'auto' : `${placed.top}px`,
    bottom: placed.bottom === null ? 'auto' : `${placed.bottom}px`,
    ...(material ? { '--dash-panel-elevated': material } : {}),
    ...(fontFamily ? { fontFamily } : {}),
  }
}

function closeDropdown(): void {
  isOpen.value = false
}

function openDropdown(): void {
  if (props.disabled) return
  const selected = props.options.findIndex(
    (option) => option.value === props.modelValue && !option.disabled,
  )
  activeIndex.value = selected >= 0 ? selected : props.options.findIndex((o) => !o.disabled)
  isOpen.value = true
  void nextTick(() => {
    updateDropdownPosition()
    revealActiveOption()
  })
}

/** 容器滚动或窗口缩放时跟随触发器；触发器滚出可见区域后才关闭。 */
function handleViewportChange(event?: Event): void {
  if (!isOpen.value) return
  if (event?.target instanceof Node && dropdownRef.value?.contains(event.target)) return
  const trigger = triggerRef.value
  if (!trigger) return
  if (!isAnchorVisible(trigger.getBoundingClientRect(), collectClipRects(trigger))) {
    closeDropdown()
    return
  }
  updateDropdownPosition()
}

const selectedOption = computed(() => props.options.find((opt) => opt.value === props.modelValue))

function toggleDropdown() {
  if (isOpen.value) closeDropdown()
  else openDropdown()
}

function selectOption(option: SelectOption) {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  emit('change', option.value)
  isOpen.value = false
}

const { activeIndex, revealActiveOption, handleTriggerKeydown } = useSelectKeyboard({
  items: () => props.options,
  isOpen,
  triggerRef,
  dropdownRef,
  optionSelector: '.p-select-option',
  open: openDropdown,
  close: closeDropdown,
  select: (index) => selectOption(props.options[index]!),
})

// 点击外部关闭
useEventListener(document as unknown as EventTarget, 'click', (e: Event) => {
  const target = e.target as Node
  if (
    containerRef.value &&
    !containerRef.value.contains(target) &&
    !dropdownRef.value?.contains(target)
  ) {
    closeDropdown()
  }
})
useEventListener(window, 'resize', handleViewportChange)
if (window.visualViewport) useEventListener(window.visualViewport, 'resize', handleViewportChange)
useEventListener(document, 'scroll', handleViewportChange, { capture: true, passive: true })

// 选项异步加载完时高度会变，重新量一次。
watch(
  () => props.options,
  () => {
    if (isOpen.value) void nextTick(updateDropdownPosition)
  },
)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) closeDropdown()
  },
)
// 列表不在原组件树的 DOM 里，KeepAlive 切走时不会跟着隐藏，要主动关。
onDeactivated(closeDropdown)
onBeforeUnmount(closeDropdown)
</script>

<template>
  <div ref="containerRef" class="p-select-wrapper">
    <!-- 标签 -->
    <label v-if="label" class="p-select-label">
      <PixelIcon v-if="icon" :name="icon" size="xs" />
      {{ label }}
    </label>

    <div class="p-select-container">
      <button
        ref="triggerRef"
        type="button"
        :class="['p-select-trigger', `p-select-${size}`, { 'p-select-open': isOpen }]"
        :disabled="disabled"
        aria-haspopup="listbox"
        :aria-expanded="isOpen"
        :aria-controls="isOpen ? listId : undefined"
        :aria-activedescendant="isOpen && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined"
        @click="toggleDropdown"
        @keydown="handleTriggerKeydown"
      >
        <span :class="selectedOption ? 'p-select-value' : 'p-select-placeholder'">
          <slot name="selected" :option="selectedOption">
            <PixelIcon v-if="selectedOption?.icon" :name="selectedOption.icon" size="xs" />
            {{ selectedOption?.label || displayPlaceholder }}
          </slot>
        </span>
        <PixelIcon
          name="chevron-down"
          size="xs"
          :class="['p-select-arrow', { 'p-select-arrow-open': isOpen }]"
        />
      </button>

      <Teleport to="body">
        <Transition name="select-dropdown">
          <!-- mousedown.prevent 让焦点留在触发器上，点选项或拖滚动条后方向键仍然有效。 -->
          <div
            v-if="isOpen"
            :id="listId"
            ref="dropdownRef"
            role="listbox"
            :class="['p-select-dropdown', { 'p-select-dropdown-above': openAbove }]"
            :style="dropdownStyle"
            @mousedown.prevent
          >
            <div class="p-select-options">
              <div
                v-for="(option, index) in options"
                :id="`${listId}-${index}`"
                :key="option.value"
                role="option"
                :aria-selected="modelValue === option.value"
                :aria-disabled="option.disabled || undefined"
                :class="[
                  'p-select-option',
                  { 'p-select-option-active': modelValue === option.value },
                  { 'p-select-option-disabled': option.disabled },
                  { 'p-select-option-focused': index === activeIndex && !option.disabled },
                ]"
                @click="selectOption(option)"
                @mouseenter="activeIndex = index"
              >
                <div class="p-select-option-content">
                  <slot name="option" :option="option" :selected="modelValue === option.value">
                    <PixelIcon v-if="option.icon" :name="option.icon" size="xs" />
                    {{ option.label }}
                  </slot>
                </div>
                <PixelIcon
                  v-if="modelValue === option.value"
                  name="check"
                  size="xs"
                  class="p-select-check"
                />
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.p-select-wrapper {
  width: 100%;
}

.p-select-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--ui-text-tertiary);
}

.p-select-container {
  position: relative;
  width: 100%;
}

.p-select-trigger {
  --ui-focus-color: var(--ui-accent-sky);
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  background: var(--dash-input-bg);
  border: 2px solid var(--dash-input-border);
  border-radius: 0;
  color: var(--ui-text-primary);
  cursor: pointer;
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard);
  font-family: var(--ui-font-pixel);
}
.p-select-trigger:hover:not(:disabled) {
  border-color: var(--ui-accent-sky);
}
.p-select-trigger:disabled {
  color: var(--ui-text-disabled);
  background: var(--ui-bg-surface-soft);
  cursor: not-allowed;
}
.p-select-open {
  border-color: var(--ui-accent-sky);
  box-shadow: 0 0 0 1px var(--ui-accent-sky);
}

.p-select-sm {
  padding: 4px 8px;
  font-size: 12px;
}
.p-select-md {
  padding: 6px 12px;
  font-size: 14px;
}
.p-select-lg {
  padding: 10px 16px;
  font-size: 16px;
}

.p-select-value {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.p-select-value,
.p-select-placeholder,
.p-select-option-content {
  min-width: 0;
  text-align: left;
  overflow-wrap: anywhere;
}
.p-select-value :deep(.pixel-icon),
.p-select-option-content :deep(.pixel-icon) {
  flex-shrink: 0;
}
.p-select-placeholder {
  color: var(--ui-text-tertiary);
}

.p-select-arrow {
  flex-shrink: 0;
  color: var(--ui-text-secondary);
  transition:
    transform var(--ui-duration-normal) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard);
}
.p-select-arrow-open {
  transform: rotate(180deg);
  color: var(--ui-accent-sky);
}

.p-select-dropdown {
  /* 高于 PDialog(10000)，在对话框里打开也能盖住。 */
  position: fixed;
  z-index: 10020;
  /* 列表可能盖到标题栏拖动区上，声明 no-drag 才点得到。 */
  -webkit-app-region: no-drag;
  background: var(--dash-panel-elevated);
  border: 2px solid var(--ui-border-strong);
  box-shadow: var(--ui-shadow-md);
  max-height: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
  transform-origin: top center;
}

.p-select-dropdown-above {
  transform-origin: bottom center;
}

.p-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard);
  color: var(--ui-text-secondary);
}
.p-select-option:hover:not(.p-select-option-disabled),
.p-select-option-focused {
  background: var(--ui-bg-hover);
  color: var(--ui-accent-sky);
}
.p-select-option-active {
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  font-weight: 700;
}
.p-select-option-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.p-select-option-content {
  display: flex;
  align-items: center;
  gap: 8px;
}
.p-select-check {
  flex-shrink: 0;
  color: var(--ui-accent-sky);
}

/* 下拉动画 */
.select-dropdown-enter-active {
  transition:
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}
.select-dropdown-leave-active {
  transition:
    opacity var(--ui-duration-instant) var(--ui-ease-standard),
    transform var(--ui-duration-instant) var(--ui-ease-standard);
}
.select-dropdown-enter-from,
.select-dropdown-leave-to {
  opacity: 0;
  transform: translateY(calc(-1 * var(--ui-motion-distance-sm)));
}
.p-select-dropdown-above.select-dropdown-enter-from,
.p-select-dropdown-above.select-dropdown-leave-to {
  transform: translateY(var(--ui-motion-distance-sm));
}
</style>
