<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * MotionSkeleton — 骨架占位
 *
 * 等待数据时代替空白或单独的转圈，形状接近真实内容，加载完成后不会突然跳版。
 *
 * @prop variant - list：头像 + 两行文字的列表项；text：段落；card：卡片块
 * @prop rows - 列表项 / 段落行 / 卡片的数量
 * @prop label - 读屏播报文字，默认「正在加载」
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{ variant?: 'list' | 'text' | 'card'; rows?: number; label?: string }>(),
  { variant: 'list', rows: 3, label: undefined },
)
const spokenLabel = computed(() => props.label ?? __t('ui.motion', '正在加载'))
/** 每行宽度略有错落，看起来更像真实文字 */
const WIDTHS = [92, 76, 84, 64, 88, 70]
const widthAt = (index: number): number => WIDTHS[index % WIDTHS.length] ?? 80
</script>

<template>
  <div class="motion-skeleton-group" :class="`motion-skeleton-group--${variant}`" role="status">
    <span class="motion-skeleton-group__label">{{ spokenLabel }}</span>
    <template v-if="variant === 'list'">
      <div
        v-for="row in rows"
        :key="row"
        class="motion-skeleton-group__item"
        :style="{ opacity: 1 - (row - 1) * 0.18 }"
        aria-hidden="true"
      >
        <i class="motion-skeleton motion-skeleton-group__avatar" />
        <div class="motion-skeleton-group__lines">
          <i class="motion-skeleton" :style="{ width: `${widthAt(row)}%` }" />
          <i class="motion-skeleton" :style="{ width: `${widthAt(row + 2) - 30}%` }" />
        </div>
      </div>
    </template>
    <template v-else-if="variant === 'text'">
      <i
        v-for="row in rows"
        :key="row"
        class="motion-skeleton motion-skeleton-group__line"
        :style="{ width: row === rows ? '48%' : `${widthAt(row)}%` }"
        aria-hidden="true"
      />
    </template>
    <template v-else>
      <div
        v-for="row in rows"
        :key="row"
        class="motion-skeleton-group__card"
        :style="{ opacity: 1 - (row - 1) * 0.15 }"
        aria-hidden="true"
      >
        <i class="motion-skeleton" style="width: 42%; height: 12px" />
        <i class="motion-skeleton" style="width: 86%" />
        <i class="motion-skeleton" style="width: 64%" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.motion-skeleton-group {
  display: grid;
  gap: 10px;
  padding: 6px 4px;
  animation: motion-fade-in var(--motion-duration-medium) var(--motion-ease-out) backwards;
  /* 短加载不闪现占位：延迟一会儿再淡入 */
  animation-delay: 120ms;
}
.motion-skeleton-group i {
  display: block;
  height: 9px;
}
.motion-skeleton-group__label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.motion-skeleton-group__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
}
.motion-skeleton-group i.motion-skeleton-group__avatar {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: var(--ui-radius-sm);
}
.motion-skeleton-group__lines {
  display: grid;
  flex: 1;
  gap: 8px;
}
.motion-skeleton-group--text {
  gap: 9px;
}
.motion-skeleton-group__card {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-surface-soft);
}
</style>
