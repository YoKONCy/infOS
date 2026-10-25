<script setup lang="ts">
import { useId } from 'vue'
defineProps<{ platform: string }>()
const maskId = `social-platform-${useId()}`
</script>
<template>
  <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" class="social-platform-icon">
    <!-- 真正镂空图形，不用面板底色伪装孔洞，半透明背景下也保持正确轮廓。 -->
    <defs>
      <mask
        :id="maskId"
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="32"
        height="32"
        style="mask-type: luminance"
      >
        <rect width="32" height="32" fill="white" />
        <g v-if="platform === 'qq'" fill="black">
          <ellipse cx="16" cy="19" rx="5.5" ry="7" />
          <path d="M10 14h12v3H10z" />
          <circle cx="13" cy="10" r="1.4" />
          <circle cx="19" cy="10" r="1.4" />
        </g>
        <g v-else-if="platform === 'weixin'" fill="black">
          <circle cx="9" cy="11" r="1.2" />
          <circle cx="17" cy="11" r="1.2" />
          <circle cx="19" cy="15" r="1" />
          <circle cx="25" cy="15" r="1" />
        </g>
        <g v-else-if="platform === 'discord'" fill="black">
          <ellipse cx="11" cy="17" rx="2.2" ry="2.6" />
          <ellipse cx="21" cy="17" rx="2.2" ry="2.6" />
        </g>
      </mask>
    </defs>
    <g :mask="`url(#${maskId})`">
      <template v-if="platform === 'qq'">
        <path
          d="M16 3c-5 0-8 4-8 10v3c-2 3-3 7-2 8 1 1 2-1 3-2 0 4 3 6 7 6s7-2 7-6c1 1 2 3 3 2 1-1 0-5-2-8v-3c0-6-3-10-8-10Z"
        />
      </template>
      <template v-else-if="platform === 'weixin'">
        <path
          d="M13 4C6.9 4 2 7.8 2 12.5c0 2.7 1.6 5.1 4.1 6.7L5 23l4.4-2.3c1.1.3 2.3.4 3.6.4h1c-1.2-1.5-1.9-3.3-1.9-5.3 0-4.6 4.2-8.3 9.7-8.9C19.8 5.1 16.6 4 13 4Z"
        />
        <path
          d="M22 9c-4.9 0-9 3.2-9 7.1s4.1 7.1 9 7.1c1 0 2-.1 2.9-.4L29 25l-1-3.3c2-1.3 3-3.3 3-5.6C31 12.2 26.9 9 22 9Z"
        />
      </template>
      <path
        v-else-if="platform === 'telegram'"
        d="M28.8 4.1 3.3 14c-1.7.7-1.7 1.7-.3 2.1l6.5 2 2.5 7.5c.4 1.1.2 1.6 1.4 1.6.9 0 1.3-.4 1.8-.9l3.2-3.1 6.7 4.9c1.2.7 2 .3 2.3-1.2l4.1-20.3c.4-1.8-.7-2.7-2.7-2.5ZM11 17.7 25.7 8.4c.7-.4 1.3-.2.8.3L14.3 19.8l-.5 5.3L11 17.7Z"
      />
      <template v-else-if="platform === 'discord'">
        <path
          d="M25 7a24 24 0 0 0-6-2l-.7 1.5a21 21 0 0 0-4.6 0L13 5a24 24 0 0 0-6 2C3.1 12.6 2 18 2.5 23.3A25 25 0 0 0 10 27l1.5-2.5-2.2-1.1.5-.4a20 20 0 0 0 12.4 0l.5.4-2.2 1.1L22 27a25 25 0 0 0 7.5-3.7C30 18 28.9 12.6 25 7Z"
        />
      </template>
      <path
        v-else
        d="m13 2-1 4-3 2-4-1-3 6 3 3v3l-3 3 3 6 4-1 3 2 1 3h6l1-3 3-2 4 1 3-6-3-3v-3l3-3-3-6-4 1-3-2-1-4h-6Zm3 10a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z"
      />
    </g>
  </svg>
</template>
<style scoped>
.social-platform-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}
</style>
