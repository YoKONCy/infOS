<template>
  <section id="home" ref="root" class="home-call">
    <img class="sky" :src="art('bg-night.webp')" alt="" loading="lazy" />
    <BgFx tone="dark" rings />
    <!-- 地平线上缓缓升起的光点 -->
    <div class="lanterns" aria-hidden="true">
      <i v-for="n in 12" :key="n" :style="{ '--n': n, '--s': `${6 + ((n * 7) % 5) * 2}px` }"></i>
    </div>
    <div class="inner">
      <div class="sprite" data-reveal="left">
        <CharSprite :char="char" :talking="talking" :reduced="reduced" :alt="char.name" />
      </div>
      <div class="copy" data-reveal="right">
        <span class="eyebrow">{{ t('TAKE {0} HOME', [char.name]) }}</span>
        <h2>{{ t('把她带回家吧') }}</h2>
        <DialogBox
          :name="char.name"
          :text="char.farewell"
          :reduced="reduced"
          @typing="talking = $event"
        />
        <div class="actions">
          <a class="btn" :href="LINKS.steam" target="_blank" rel="noopener noreferrer">
            {{ t('Steam 商店页') }}
          </a>
          <button
            class="btn ghost"
            type="button"
            :disabled="downloads.windows === 'loading'"
            @click="download('windows')"
          >
            {{ t(downloads.windows === 'loading' ? '正在准备下载…' : '下载 Windows 版') }}
          </button>
          <button
            class="btn ghost"
            type="button"
            :disabled="downloads.android === 'loading'"
            @click="download('android')"
          >
            {{ t(downloads.android === 'loading' ? '正在准备下载…' : '下载安卓版') }}
          </button>
        </div>
        <p v-if="downloads.windows === 'error'" class="download-error" role="status">
          {{ t('Windows 安装包获取失败，请点击下载按钮重试。') }}
        </p>
        <p v-if="downloads.android === 'error'" class="download-error" role="status">
          {{ t('安卓安装包获取失败，请点击下载按钮重试。') }}
        </p>
        <p class="links">
          <a :href="LINKS.docs" target="_blank" rel="noopener noreferrer">{{ t('使用文档') }}</a>
          ·
          <a :href="LINKS.github" target="_blank" rel="noopener noreferrer">
            {{ t('GitHub 开源') }}
          </a>
          ·
          <a :href="LINKS.mobile" target="_blank" rel="noopener noreferrer">
            {{ t('移动端仓库') }}
          </a>
        </p>
      </div>
    </div>
    <footer class="foot">
      {{ t('萌动链接：PeroperoChat！由开源项目 infOS 驱动，以 Apache-2.0 许可发布。') }}
      <br />
      {{ t('Let AI become a truly warm companion.') }}
    </footer>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import CharSprite from './CharSprite.vue'
import DialogBox from './DialogBox.vue'
import BgFx from './BgFx.vue'
import type { Character } from '../characters'
import { LINKS, art } from '../assets'
import { useReveal } from '../composables/motion'
import { t } from '../i18n'
import { latestInstaller, type DownloadPlatform } from '../latestRelease'

/** 收尾：星空下，选中的伙伴说告别台词，给出下载入口 */
defineProps<{ char: Character; reduced: boolean }>()

const root = ref<HTMLElement | null>(null)
const talking = ref(false)
const downloads = reactive<Record<DownloadPlatform, 'idle' | 'loading' | 'error'>>({
  windows: 'idle',
  android: 'idle',
})

async function download(platform: DownloadPlatform) {
  downloads[platform] = 'loading'
  try {
    const url = await latestInstaller(platform)
    window.location.assign(url)
    downloads[platform] = 'idle'
  } catch {
    downloads[platform] = 'error'
  }
}

useReveal(() => root.value)
</script>

<style scoped>
.home-call {
  position: relative;
  padding: 120px 24px 40px;
  overflow: hidden;
  isolation: isolate;
  color: #fff;
}

.sky {
  position: absolute;
  inset: 0;
  z-index: -1;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.home-call::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(
    180deg,
    rgba(30, 20, 70, 0.85),
    transparent 30%,
    rgba(20, 14, 50, 0.6)
  );
}

.lanterns {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
}

.lanterns i {
  position: absolute;
  bottom: -20px;
  left: calc(var(--n) * 8% - 4%);
  width: var(--s);
  aspect-ratio: 1;
  border-radius: 50%;
  background: #ffe6a8;
  box-shadow: 0 0 14px 4px rgba(255, 220, 150, 0.6);
  animation: rise calc(10s + var(--n) * 0.9s) linear infinite;
  animation-delay: calc(var(--n) * -1.7s);
}

@keyframes rise {
  0% {
    opacity: 0;
    translate: 0 0;
  }
  10% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    translate: 30px -90vh;
  }
}

.inner {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  align-items: end;
  gap: 40px;
  max-width: 1100px;
  margin: 0 auto;
}

.sprite {
  display: flex;
  justify-content: center;
  align-items: flex-end;
  height: min(72vh, 640px);
  min-width: 0;
  container-type: size;
}

.foot {
  position: relative;
  z-index: 2;
}

.copy {
  padding-bottom: 60px;
}

.eyebrow {
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.32em;
  color: #ffd6f0;
}

.copy h2 {
  margin: 10px 0 34px;
  font-size: clamp(34px, 5vw, 58px);
  font-weight: 900;
  text-shadow:
    0 4px 0 var(--c-deep),
    0 10px 24px rgba(10, 5, 40, 0.5);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 30px;
}

.actions button:disabled {
  cursor: wait;
  opacity: 0.75;
}

.download-error {
  margin: 18px 0 0;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
}

.links {
  margin: 22px 0 0;
  font-size: 15px;
  opacity: 0.9;
}

.links a {
  font-weight: 700;
  text-underline-offset: 4px;
}

.foot {
  margin-top: 40px;
  font-size: 13px;
  line-height: 1.8;
  text-align: center;
  opacity: 0.7;
}

@media (max-width: 900px) {
  .inner {
    grid-template-columns: 1fr;
  }
  .sprite {
    height: 52vh;
  }
  .copy {
    padding-bottom: 20px;
  }
}
</style>
