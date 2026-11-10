<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * CardsTab — 「卡片」页：管理角色做的桌面卡片（仅 Electron 主应用）。
 *
 * - 「我的卡片」：收藏的与正打开的临时卡片，可打开/关闭、收藏、置顶、改名、开机自动打开、看源码、删除；
 * - 「最近关闭」：临时卡片关闭后保留 7 天，期间可以收藏捡回，过期由主进程清理；
 * - 删除需要二次确认，其余操作都能撤回，直接执行。
 *
 * 入口：侧边栏、托盘菜单、桌宠「更多」菜单。卡片本身由主进程管理，这里只调用管理通道。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 卡片页
 */
import { onMounted, ref } from 'vue'
import type { DesktopCardListItem } from '@infos/shared'
import { PButton, PDialog, PInput, PixelIcon } from '../../pixel'
import CardTile from './CardTile.vue'
import FenceToolbar from './FenceToolbar.vue'
import { useDesktopCardAdmin } from './useDesktopCardAdmin'

const admin = useDesktopCardAdmin()
const { busy, query, mine, recent, cards } = admin

const removing = ref<DesktopCardListItem | null>(null)
const removeOpen = ref(false)
const renaming = ref<DesktopCardListItem | null>(null)
const renameOpen = ref(false)
const sourceCard = ref<DesktopCardListItem | null>(null)
const sourceText = ref('')
const sourceOpen = ref(false)

function askRemove(card: DesktopCardListItem): void {
  removing.value = card
  removeOpen.value = true
}

function confirmRemove(): void {
  const card = removing.value
  removeOpen.value = false
  removing.value = null
  if (card) void admin.remove(card.id)
}

function askRename(card: DesktopCardListItem): void {
  renaming.value = card
  renameOpen.value = true
}

function confirmRename(value?: string): void {
  const card = renaming.value
  renameOpen.value = false
  renaming.value = null
  const name = value?.trim()
  if (card && name && name !== card.name) void admin.patch(card.id, { name })
}

async function showSource(card: DesktopCardListItem): Promise<void> {
  const html = await admin.source(card.id)
  if (html === null) return
  sourceCard.value = card
  sourceText.value = html
  sourceOpen.value = true
}

onMounted(() => void admin.refresh())
</script>

<template>
  <div class="cards-page" :aria-busy="busy">
    <header class="cards-page__head">
      <div>
        <h1>{{ __t('ui.desktop-shell', '卡片') }}</h1>
        <p>{{ __t('ui.desktop-shell', '角色为你做的桌面小卡片都在这里') }}</p>
      </div>
      <div class="cards-page__tools">
        <PInput v-model="query" size="sm" :placeholder="__t('ui.desktop-shell', '搜索卡片名称')" />
        <PButton variant="ghost" size="sm" :disabled="busy" @click="admin.refresh()">
          <PixelIcon name="refresh" size="sm" />
          {{ __t('ui.desktop-shell', '刷新') }}
        </PButton>
      </div>
    </header>

    <p v-if="!admin.enabled" class="cards-page__empty">
      {{ __t('ui.desktop-shell', '卡片只在桌面版中可用。') }}
    </p>
    <template v-else>
      <!-- 预制件入口：新建收纳框、隐藏 / 恢复桌面原图标 -->
      <FenceToolbar :busy="busy" @changed="admin.refresh()" />
      <section class="cards-page__section">
        <h2>{{ __t('ui.desktop-shell', '我的卡片') }}</h2>
        <p v-if="!mine.length" class="cards-page__empty">
          {{
            cards.length && query
              ? __t('ui.desktop-shell', '没有找到匹配的卡片。')
              : __t('ui.desktop-shell', '还没有卡片。可以请角色帮你做一张，比如待办或倒计时。')
          }}
        </p>
        <div v-else class="cards-page__grid">
          <CardTile
            v-for="card in mine"
            :key="card.id"
            :card="card"
            :busy="busy"
            @open="admin.open(card.id)"
            @close="admin.close(card.id)"
            @save="(saved) => admin.patch(card.id, { saved })"
            @pin="(alwaysOnTop) => admin.patch(card.id, { alwaysOnTop })"
            @auto-open="(autoOpen) => admin.patch(card.id, { autoOpen })"
            @rename="askRename(card)"
            @source="showSource(card)"
            @remove="askRemove(card)"
          />
        </div>
      </section>

      <section v-if="recent.length" class="cards-page__section">
        <h2>{{ __t('ui.desktop-shell', '最近关闭') }}</h2>
        <p class="cards-page__hint">
          {{ __t('ui.desktop-shell', '没收藏的卡片关闭后在这里保留 7 天，收藏后就会一直留着。') }}
        </p>
        <div class="cards-page__grid">
          <CardTile
            v-for="card in recent"
            :key="card.id"
            :card="card"
            :busy="busy"
            recent
            @open="admin.open(card.id)"
            @save="(saved) => admin.patch(card.id, { saved })"
            @source="showSource(card)"
            @remove="askRemove(card)"
          />
        </div>
      </section>
      <p class="cards-page__hint">
        {{ __t('ui.desktop-shell', '在卡片窗口中按 Ctrl+W 也可以关闭卡片。') }}
      </p>
    </template>

    <PDialog
      v-model="removeOpen"
      :title="__t('ui.desktop-shell', '删除卡片')"
      :message="
        __t('ui.desktop-shell', '删除卡片「{0}」？此操作不能撤销。', [removing?.name ?? ''])
      "
      :confirm-text="__t('ui.desktop-shell', '删除')"
      confirm-variant="danger"
      @confirm="confirmRemove"
    />
    <PDialog
      v-model="renameOpen"
      mode="prompt"
      :title="__t('ui.desktop-shell', '卡片改名')"
      :default-value="renaming?.name ?? ''"
      :placeholder="__t('ui.desktop-shell', '新的卡片名称')"
      @confirm="confirmRename"
    />
    <PDialog
      v-model="sourceOpen"
      :title="__t('ui.desktop-shell', '卡片源码：{0}', [sourceCard?.name ?? ''])"
      width="min(880px, 92vw)"
    >
      <pre class="cards-page__source">{{ sourceText }}</pre>
      <template #footer>
        <PButton size="sm" variant="secondary" @click="sourceOpen = false">
          {{ __t('ui.desktop-shell', '关闭') }}
        </PButton>
      </template>
    </PDialog>
  </div>
</template>

<style scoped>
.cards-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px;
}
.cards-page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}
.cards-page__head h1 {
  font-family: var(--ui-font-pixel);
  font-size: 20px;
  color: var(--ui-text-primary);
}
.cards-page__head p,
.cards-page__hint,
.cards-page__empty {
  font-size: 12px;
  color: var(--ui-text-tertiary);
}
.cards-page__tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cards-page__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cards-page__section h2 {
  font-size: 13px;
  font-weight: 700;
  color: var(--ui-text-secondary);
}
.cards-page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.cards-page__source {
  max-height: 60vh;
  overflow: auto;
  padding: 10px;
  font-family: var(--ui-font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ui-text-primary);
  background: var(--ui-bg-canvas);
}
</style>
