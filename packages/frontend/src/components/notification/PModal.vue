<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * PModal — 全局模态通知对话框
 *
 * 来自 useNotificationStore.modal，阻断式错误提示。
 */
import { useNotificationStore } from '../../stores'

const store = useNotificationStore()
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="store.modal" class="modal-overlay" @click.self="store.closeModal()">
        <div :class="['modal-dialog', `modal-${store.modal.type}`]">
          <div class="modal-header">
            <span class="modal-title">
              {{ store.modal.title ?? __t('ui.notification', '提示') }}
            </span>
          </div>
          <div class="modal-body">
            {{ store.modal.message }}
          </div>
          <div class="modal-footer">
            <button class="pixel-btn-primary" @click="store.closeModal()">
              {{ __t('ui.notification', '确定') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.modal-dialog {
  min-width: 320px;
  max-width: 480px;
  background: var(--color-bg-primary);
  border: 3px solid var(--color-border);
  box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.2);
}

.modal-error {
  border-color: var(--color-red-face);
}
.modal-warning {
  border-color: var(--color-yellow-500);
}
.modal-info {
  border-color: var(--color-sky-500);
}

.modal-header {
  padding: 12px 16px;
  border-bottom: 2px solid var(--color-border);
  font-weight: 700;
  font-size: 15px;
  color: var(--color-text-primary);
}

.modal-body {
  padding: 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.modal-footer {
  padding: 12px 16px;
  border-top: 2px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
}

/* 动画 */
.modal-enter-active {
  transition: opacity var(--motion-duration-slow) var(--motion-ease-out);
}
.modal-leave-active {
  transition: opacity var(--motion-duration-medium) var(--motion-ease-in);
}
.modal-enter-active .modal-dialog {
  transition: transform var(--motion-duration-slow) var(--motion-ease-emphasized);
}
.modal-leave-active .modal-dialog {
  transition: transform var(--motion-duration-medium) var(--motion-ease-in);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-dialog,
.modal-leave-to .modal-dialog {
  transform: translate3d(0, var(--motion-distance-md), 0) scale(var(--motion-scale-in));
}
</style>
