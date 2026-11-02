<template>
  <svg
    class="pixel-icon"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${grid.width} ${grid.height}`"
    shape-rendering="crispEdges"
    aria-hidden="true"
    focusable="false"
  >
    <rect
      v-for="(r, i) in grid.rects"
      :key="i"
      :x="r.x"
      :y="r.y"
      :width="r.w"
      height="1"
      fill="currentColor"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/**
 * 像素小图标：用字符点阵描述，按行合并为矩形，颜色跟随 currentColor。
 */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 })

const ICONS: Record<string, readonly string[]> = {
  heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  sparkle: ['...#...', '...#...', '..###..', '#######', '..###..', '...#...', '...#...'],
  chat: ['#######', '#.....#', '#.#.#.#', '#.....#', '#######', '.#.....', '#......'],
  book: ['##...##', '#.#.#.#', '#.#.#.#', '#.#.#.#', '##.#.##', '...#...'],
  home: ['...#...', '..###..', '.#####.', '#######', '.#...#.', '.#.#.#.', '.#.#.#.'],
  star: ['...#...', '..###..', '#######', '.#####.', '.##.##.', '#.....#'],
  cloud: ['..###..', '.#####.', '#######', '#######', '.#####.'],
  arrow: ['...#...', '....#..', '#######', '....#..', '...#...'],
  code: ['..#...#..', '.#.....#.', '#.......#', '.#.....#.', '..#...#..'],
}

const grid = computed(() => {
  const rows = ICONS[props.name] ?? ICONS.sparkle
  const rects: { x: number; y: number; w: number }[] = []
  rows.forEach((row, y) => {
    let start = -1
    for (let x = 0; x <= row.length; x++) {
      const on = row[x] === '#'
      if (on && start < 0) start = x
      if (!on && start >= 0) {
        rects.push({ x: start, y, w: x - start })
        start = -1
      }
    }
  })
  return { width: Math.max(...rows.map((r) => r.length)), height: rows.length, rects }
})
</script>

<style scoped>
.pixel-icon {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: -0.125em;
}
</style>
