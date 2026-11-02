<template>
  <section class="not-found" aria-labelledby="not-found-title">
    <img
      class="nf-art"
      :src="withBase('/characters/pero-cry.webp')"
      alt="Pero 坐在地上哭鼻子"
      width="240"
      height="325"
    />
    <div class="nf-copy">
      <span class="wk-eyebrow">404 · PAGE NOT FOUND</span>
      <h1 id="not-found-title">{{ target ? '这一页搬家了' : '这一页走丢了' }}</h1>
      <div class="wk-bubble tail-left nf-bubble">
        <span class="wk-bubble-name">
          Pero
          <PixelIcon name="heart" :size="9" />
        </span>
        <p v-if="target">找到啦！文档换了新位置，Pero 这就带你过去~</p>
        <p v-else>呜……Pero 翻遍了也没找到这一页。可能是地址打错了，或者它已经换了位置。</p>
      </div>
      <div class="nf-actions">
        <a v-if="target" class="wk-btn primary" :href="withBase(target)">立即前往</a>
        <template v-else>
          <a class="wk-btn primary" :href="withBase('/')">回到首页</a>
          <a class="wk-btn" :href="withBase('/guide/intro')">从「开始使用」找起</a>
        </template>
      </div>
      <p v-if="!target" class="nf-hint">也可以点右上角的搜索，输入关键词找找看。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'
import PixelIcon from './PixelIcon.vue'
import { findRedirect } from '../theme/redirects'

/**
 * 404 页：旧地址命中重定向表时自动跳转，否则由 Pero 引导回首页。
 */
const { site } = useData()
const target = ref<string | null>(null)

onMounted(() => {
  const base = site.value.base.replace(/\/$/, '')
  const path = window.location.pathname.slice(base.length) || '/'
  const next = findRedirect(path)
  if (!next) return
  // 新地址自带锚点时用新锚点，否则保留原地址的锚点
  target.value = next.includes('#') ? next : next + window.location.hash
  window.location.replace(withBase(target.value))
})
</script>

<style scoped>
.not-found {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 32px 56px;
  margin: 0 auto;
  padding: 72px 24px 96px;
  max-width: 880px;
}

.nf-art {
  width: 220px;
  height: auto;
}

.nf-copy {
  flex: 1 1 320px;
  max-width: 440px;
}

.nf-copy h1 {
  margin: 8px 0 20px;
  font-size: 32px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--vp-c-text-1);
}

.nf-bubble p {
  margin: 0;
  font-size: 15px;
  line-height: 1.8;
}

.nf-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
}

.nf-hint {
  margin-top: 16px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
</style>
