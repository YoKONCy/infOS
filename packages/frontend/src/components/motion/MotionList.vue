<script setup lang="ts">
/**
 * MotionList — 列表增删与重排的平滑过渡
 *
 * 包一层 TransitionGroup：新增项淡入，删除项淡出，其余项用 transform 平滑让位。
 * 子元素必须带稳定的 key；用于会话列表、设置项列表等中短列表。
 * 不要用在消息流这类可能上百项的长列表上。
 *
 * @example
 * <MotionList tag="ul" class="my-list">
 *   <li v-for="item in items" :key="item.id">…</li>
 * </MotionList>
 */
import { lockLeaving } from './lockLeaving'

withDefaults(defineProps<{ tag?: string }>(), { tag: 'div' })
</script>

<template>
  <TransitionGroup
    :tag="tag"
    name="motion-list"
    class="motion-list-host"
    @before-leave="lockLeaving"
  >
    <slot />
  </TransitionGroup>
</template>
