<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
const paths: Record<string, string> = {
  power: 'M12 2v10M6 5a9 9 0 1 0 12 0',
  paste: 'M9 4H5v17h14V4h-4M9 2h6v4H9ZM8 11h8M8 15h8',
  workflow: 'M3 3h6v6H3ZM15 15h6v6h-6ZM15 3h6v6h-6ZM9 6h6M6 9v9h9',
  history: 'M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2',
  warning: 'm12 3 10 18H2ZM12 9v5M12 17h.01',
  edit: 'm15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z',
  heart:
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  arrange: 'M3 4h7v6H3ZM14 4h7v6h-7ZM3 15h7v6H3ZM14 15h7v6h-7ZM6 10v5M17 10v5',
  select: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4',
  arrow: 'M5 4l5 16 3-7 7-3Z',
  hand: 'M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v10c0 4-3 6-7 6h-1c-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l3 3',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4',
  note: 'M5 3h14v14l-4 4H5ZM14 21v-7h5M8 7h8M8 11h5',
  image: 'M4 4h16v16H4ZM4 16l5-5 4 4 3-3 4 4M15 8h.01',
  layers: 'm12 3 10 6-10 6L2 9Zm-9 11 9 6 9-6M3 18l9 5 9-5',
  undo: 'M9 5 4 10l5 5M4 10h9a6 6 0 0 1 6 6v3',
  redo: 'm15 5 5 5-5 5M20 10h-9a6 6 0 0 0-6 6v3',
  chevron: 'm8 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  close: 'm6 6 12 12M6 18 18 6',
  fit: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  minus: 'M5 12h14',
  copy: 'M8 8h12v12H8ZM4 15H2V2h13v2',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  play: 'm8 4 12 8-12 8Z',
  sparkle: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3ZM20 2v4m-2-2h4',
  folder: 'M3 6h7l2 3h9v12H3ZM3 6V3h6l3 3',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  check: 'm4 12 5 5L20 6',
  moon: 'M20 15A9 9 0 0 1 9 4 9 9 0 1 0 20 15Z',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  settings: 'M4 7h16M4 17h16M9 4v6M16 14v6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  brush: 'm14 4 6 6M4 20l4-1L21 6l-3-3L5 16ZM4 20l-1 1',
  eraser: 'm4 14 9-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 9H9ZM9 9l9 9M13 21h8',
  crop: 'M6 3v15h15M3 6h15v15',
  group: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8Z',
  ungroup: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M9 9h6v6H9M3 21 21 3',
  map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15',
  send: 'm4 4 17 8-17 8 4-8Zm4 8h13',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  sound: 'M3 9h4l5-5v16l-5-5H3ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
}
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.sparkle" />
  </svg>
</template>
