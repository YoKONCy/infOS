<script setup lang="ts">
import { ref, watch } from 'vue'
import { PixelIcon } from '../pixel'
import { useUserAvatar } from '../../composables/ui/useUserAvatar'
import { t } from '../../i18n'

withDefaults(defineProps<{ size?: number; framed?: boolean }>(), { size: 36, framed: true })
const avatar = useUserAvatar()
const failed = ref(false)
watch(avatar.imageUrl, () => {
  failed.value = false
})
</script>

<template>
  <span
    class="user-avatar"
    :class="{ 'user-avatar--plain': !framed }"
    :style="{ '--user-avatar-size': `${size}px` }"
  >
    <img
      v-if="avatar.imageUrl.value && !failed"
      :src="avatar.imageUrl.value"
      :alt="t('ui.user-avatar', '用户头像')"
      draggable="false"
      @error="failed = true"
    />
    <PixelIcon v-else name="user" size="sm" />
  </span>
</template>

<style scoped>
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 var(--user-avatar-size);
  width: var(--user-avatar-size);
  height: var(--user-avatar-size);
  padding: 2px;
  overflow: hidden;
  border: 2px solid var(--ui-border-strong);
  background: var(--dash-panel-soft);
  box-shadow: 2px 2px 0 var(--ui-border-default);
  color: var(--ui-accent-purple);
  vertical-align: middle;
}
.user-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.user-avatar--plain {
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
</style>
