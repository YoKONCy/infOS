<template>
  <div class="dialog" :class="{ done: !typing }" @click="finish">
    <span class="plate">{{ name }}</span>
    <p class="text" aria-hidden="true">
      {{ shown }}
      <span v-if="typing" class="caret"></span>
    </p>
    <!-- 读屏只读完整句子，不逐字播报 -->
    <p class="sr-only" aria-live="polite">{{ text }}</p>
    <span class="next" aria-hidden="true">▼</span>
  </div>
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useTypewriter } from '../composables/motion'

/** Galgame 式对话框：名牌 + 打字机文字，点一下直接显示整句 */
const props = defineProps<{ name: string; text: string; reduced?: boolean }>()
const emit = defineEmits<{ typing: [boolean] }>()

const { shown, typing, type, finish } = useTypewriter()

watch(
  () => props.text,
  (t) => type(t, props.reduced),
)
watch(typing, (v) => emit('typing', v))
onMounted(() => type(props.text, props.reduced))
</script>

<style scoped>
.dialog {
  position: relative;
  padding: 26px 28px 22px;
  min-height: 118px;
  border-radius: 22px;
  background:
    linear-gradient(rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.84)) padding-box,
    linear-gradient(120deg, var(--c), #ffd1ec, var(--c-soft)) border-box;
  border: 3px solid transparent;
  box-shadow:
    0 14px 40px rgba(30, 20, 80, 0.22),
    inset 0 0 0 2px rgba(255, 255, 255, 0.7);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  cursor: pointer;
}

.plate {
  position: absolute;
  top: -18px;
  left: 22px;
  padding: 4px 18px 5px;
  font-size: 15px;
  font-weight: 900;
  letter-spacing: 0.08em;
  color: #fff;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--c-deep), var(--c));
  box-shadow: 0 4px 0 color-mix(in srgb, var(--c-deep) 70%, #000);
}

.text {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.8;
  color: var(--ink);
}

.caret {
  display: inline-block;
  width: 2px;
  height: 1.1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: var(--c);
  animation: blink-soft 0.7s steps(2) infinite;
}

.next {
  position: absolute;
  right: 20px;
  bottom: 12px;
  font-size: 13px;
  color: var(--c);
  opacity: 0;
}

.done .next {
  opacity: 1;
  animation: float-y 1s ease-in-out infinite;
}

@media (max-width: 640px) {
  .dialog {
    padding: 22px 18px 18px;
    min-height: 96px;
  }
  .text {
    font-size: 16px;
  }
}
</style>
