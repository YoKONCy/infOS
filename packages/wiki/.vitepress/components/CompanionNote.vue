<template>
  <aside class="wk-note" :class="`is-${companion.id}`" :aria-label="`${companion.name} 的小提示`">
    <span class="wk-portrait">
      <img :src="withBase(companion.avatar)" alt="" width="48" height="48" loading="lazy" />
    </span>
    <div class="wk-bubble">
      <span class="wk-bubble-name">
        {{ companion.name }}
        <PixelIcon name="heart" :size="9" />
      </span>
      <div class="wk-note-body"><slot /></div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'
import PixelIcon from './PixelIcon.vue'
import { companions, type CompanionId } from '../theme/characters'

/**
 * 正文里的角色小提示：头像 + 像素气泡。只放真正有用的提醒，每页至多一两处。
 */
const props = withDefaults(defineProps<{ who?: string }>(), { who: 'pero' })

const companion = computed(() => companions[props.who as CompanionId] ?? companions.pero)
</script>
