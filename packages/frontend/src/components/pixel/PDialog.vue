<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * PDialog — 像素风通用对话框
 *
 * 支持两种用法:
 * 1. 简单确认: visible + title + message + @confirm/@cancel
 * 2. 自定义内容: visible + title + default slot + #footer slot
 *
 * 支持 v-model 绑定 (v-model = :visible + @update:visible)
 */

interface Props {
  /** 控制显示/隐藏 (支持 v-model) */
  modelValue: boolean
  title?: string
  message?: string
  mode?: 'confirm' | 'prompt'
  confirmText?: string
  cancelText?: string
  placeholder?: string
  defaultValue?: string
  confirmVariant?: 'primary' | 'danger'
  /** 自定义宽度 */
  width?: string
  /** 关闭后由内容区域自行管理滚动，适用于多栏布局。 */
  bodyScroll?: boolean
  loading?: boolean
  autoClose?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
  message: '',
  mode: 'confirm',
  confirmText: undefined,
  cancelText: undefined,
  placeholder: '',
  defaultValue: '',
  confirmVariant: 'primary',
  width: '',
  bodyScroll: true,
  loading: false,
  autoClose: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [value?: string]
  cancel: []
}>()

import { computed, ref, watch, useSlots } from 'vue'
import PButton from './PButton.vue'

const slots = useSlots()
const displayTitle = computed(() => props.title ?? __t('ui.pixel', '确认'))
const displayConfirmText = computed(() => props.confirmText ?? __t('ui.pixel', '确定'))
const displayCancelText = computed(() => props.cancelText ?? __t('ui.pixel', '取消'))
const inputValue = ref(props.defaultValue)
const overlayPointerDown = ref(false)

watch(
  () => props.modelValue,
  (val) => {
    if (val) inputValue.value = props.defaultValue
  },
)

function handleConfirm() {
  if (props.loading) return
  if (props.mode === 'prompt') {
    emit('confirm', inputValue.value)
  } else {
    emit('confirm')
  }
  if (props.autoClose) emit('update:modelValue', false)
}

function handleCancel() {
  if (props.loading) return
  emit('cancel')
  emit('update:modelValue', false)
}

/** 仅在按下和松开都发生于遮罩时关闭，避免从输入框拖选文字后误关闭。 */
function handleOverlayPointerDown(event: PointerEvent): void {
  overlayPointerDown.value = event.target === event.currentTarget
}

function handleOverlayClick(event: MouseEvent): void {
  const shouldClose =
    event.target === event.currentTarget && (overlayPointerDown.value || event.detail === 0)
  overlayPointerDown.value = false
  if (shouldClose) handleCancel()
}

/** 关闭按钮只关闭窗口，取消按钮和遮罩点击才触发取消业务。 */
function close() {
  if (props.loading) return
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="modelValue"
        class="p-dialog-overlay"
        @pointerdown="handleOverlayPointerDown"
        @click="handleOverlayClick"
      >
        <div class="p-dialog" :style="width ? { minWidth: width, maxWidth: width } : {}">
          <div class="p-dialog-header">
            <span>{{ displayTitle }}</span>
            <button class="p-dialog-close" @click="close">✕</button>
          </div>

          <div class="p-dialog-body" :class="{ 'p-dialog-body--contained': !bodyScroll }">
            <p v-if="message" class="p-dialog-message">{{ message }}</p>
            <input
              v-if="mode === 'prompt'"
              v-model="inputValue"
              :placeholder="placeholder"
              class="p-dialog-input"
              @keydown.enter="handleConfirm"
            />
            <!-- 自定义内容 slot -->
            <slot />
          </div>

          <!-- 自定义 footer 或 默认按钮 -->
          <div class="p-dialog-footer">
            <template v-if="slots.footer">
              <slot name="footer" />
            </template>
            <template v-else>
              <PButton variant="secondary" size="sm" :disabled="loading" @click="handleCancel">
                {{ displayCancelText }}
              </PButton>
              <PButton
                :variant="confirmVariant"
                size="sm"
                :disabled="loading"
                @click="handleConfirm"
              >
                {{ loading ? __t('ui.pixel', '处理中…') : displayConfirmText }}
              </PButton>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.p-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ui-overlay-backdrop);
  backdrop-filter: blur(var(--ui-overlay-blur));
}

.p-dialog {
  min-width: 340px;
  max-width: 560px;
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--ui-text-primary);
  background: color-mix(in oklab, var(--ui-bg-surface) 97%, transparent);
  backdrop-filter: blur(20px) saturate(168%);
  border: 2px solid var(--ui-border-strong);
  box-shadow:
    var(--ui-crystal-highlight, inset 0 1px 0 rgba(255, 255, 255, 0.88)),
    var(--ui-shadow-lg);
}

.p-dialog-header {
  flex-shrink: 0;
  padding: 12px 16px;
  border-bottom: 2px solid var(--ui-border-default);
  font-weight: 700;
  font-size: 15px;
  color: var(--ui-text-primary);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.p-dialog-close {
  --ui-focus-color: var(--ui-accent-sky);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--ui-text-tertiary);
  font-size: 14px;
  padding: 2px 6px;
  transition:
    color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.p-dialog-close:hover {
  color: var(--ui-text-primary);
  background: var(--ui-bg-hover);
}

.p-dialog-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px;
}
.p-dialog-body--contained {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}
.p-dialog-message {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text-secondary);
  margin-bottom: 12px;
}

.p-dialog-input {
  width: 100%;
  padding: 6px 12px;
  border: 2px solid var(--dash-input-border);
  background: var(--dash-input-bg);
  color: var(--ui-text-primary);
  font-family: var(--ui-font-pixel);
  font-size: 14px;
  outline: none;
  caret-color: var(--ui-accent-sky);
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
.p-dialog-input::placeholder {
  color: var(--ui-text-tertiary);
  opacity: 1;
}
.p-dialog-input:focus {
  border-color: var(--ui-accent-sky);
  box-shadow: 0 0 0 1px var(--ui-accent-sky);
}

.p-dialog-footer {
  flex-shrink: 0;
  padding: 12px 16px;
  border-top: 2px solid var(--ui-border-default);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dialog-enter-active {
  --dialog-duration: var(--ui-duration-normal);
  transition: opacity var(--dialog-duration) var(--ui-ease-standard);
}
.dialog-leave-active {
  --dialog-duration: var(--ui-duration-fast);
  transition: opacity var(--dialog-duration) var(--ui-ease-standard);
}
.dialog-enter-active .p-dialog,
.dialog-leave-active .p-dialog {
  transition: transform var(--dialog-duration) var(--ui-ease-standard);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .p-dialog,
.dialog-leave-to .p-dialog {
  transform: translateY(var(--ui-motion-distance-sm)) scale(0.98);
}
</style>
