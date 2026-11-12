<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * CardsTab — 「桌面卡片」独立主页面（仅 Electron 主应用可用）
 *
 * - 「我的卡片」：已收藏与正打开的卡片及桌面预制件（收纳框），支持打开/关闭、收藏、置顶、开机自启、改名、源码与删除；
 * - 「最近关闭」：未收藏临时卡片关闭后保留 7 天，期间可一键收藏捡回；
 * - 删除需二次确认，其余状态切换即时生效并可随时撤回。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 卡片页
 */
import { onActivated, onMounted, ref } from 'vue'
import type { DesktopCardListItem } from '@infos/shared'
import { PButton, PDialog, PixelIcon } from '../../pixel'
import CardTile from './CardTile.vue'
import FenceToolbar from './FenceToolbar.vue'
import { useDesktopCardAdmin } from './useDesktopCardAdmin'

defineOptions({ name: 'CardsTab' })

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

let lastCardsRefreshAt = 0
onMounted(() => {
  lastCardsRefreshAt = Date.now()
  void admin.refresh()
})
onActivated(() => {
  if (Date.now() - lastCardsRefreshAt > 15_000) {
    lastCardsRefreshAt = Date.now()
    void admin.refresh()
  }
})
</script>

<template>
  <div class="cards-page" :aria-busy="busy">
    <!-- 页面顶栏：工程徽标标题 + 搜索与刷新机械按键 -->
    <header class="cards-page__head">
      <div class="cards-page__brand">
        <span class="cards-page__emblem" aria-hidden="true">
          <PixelIcon name="layout" size="md" />
        </span>
        <div class="cards-page__title-wrap">
          <div class="cards-page__title-row">
            <h1>{{ __t('ui.desktop-shell', '桌面卡片') }}</h1>
            <span v-if="admin.enabled" class="cards-page__count">{{ mine.length }}</span>
          </div>
          <p>{{ __t('ui.desktop-shell', '角色为你做的桌面小卡片都在这里') }}</p>
        </div>
      </div>

      <div v-if="admin.enabled" class="cards-page__tools">
        <label class="cards-search">
          <PixelIcon name="search" size="xs" class="cards-search__icon" />
          <input
            v-model="query"
            type="text"
            :placeholder="__t('ui.desktop-shell', '搜索卡片名称')"
            :aria-label="__t('ui.desktop-shell', '搜索卡片名称')"
          />
          <button
            v-if="query"
            type="button"
            class="cards-search__clear"
            :title="__t('ui.desktop-shell', '清空搜索')"
            :aria-label="__t('ui.desktop-shell', '清空搜索')"
            @click="query = ''"
          >
            <PixelIcon name="close" size="xs" />
          </button>
        </label>

        <button
          type="button"
          class="cards-refresh-btn"
          :disabled="busy"
          @click="admin.refresh()"
        >
          <PixelIcon name="refresh" size="xs" :animation="busy ? 'spin' : ''" />
          <span>{{ __t('ui.desktop-shell', '刷新') }}</span>
        </button>
      </div>
    </header>

    <div v-if="!admin.enabled" class="cards-empty-card">
      <span class="cards-empty-card__icon">
        <PixelIcon name="desktop" size="md" />
      </span>
      <p>{{ __t('ui.desktop-shell', '卡片只在桌面版中可用。') }}</p>
    </div>

    <template v-else>
      <!-- 预制件模块：新建收纳框、映射文件夹、隐藏/恢复桌面原图标 -->
      <FenceToolbar :busy="busy" @changed="admin.refresh()" />

      <!-- 我的卡片 -->
      <section class="cards-page__section">
        <div class="cards-section-head">
          <span class="cards-section-head__dot" aria-hidden="true" />
          <h2>{{ __t('ui.desktop-shell', '我的卡片') }}</h2>
          <span class="cards-section-head__badge">{{ mine.length }}</span>
          <span class="cards-section-head__line" aria-hidden="true" />
        </div>

        <div v-if="!mine.length" class="cards-empty-card">
          <span class="cards-empty-card__icon">
            <PixelIcon :name="cards.length && query ? 'search' : 'layout'" size="md" />
          </span>
          <p>
            {{
              cards.length && query
                ? __t('ui.desktop-shell', '没有找到匹配的卡片。')
                : __t('ui.desktop-shell', '还没有卡片。可以请角色帮你做一张，比如待办或倒计时。')
            }}
          </p>
        </div>

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

      <!-- 最近关闭（7天保留期） -->
      <section v-if="recent.length" class="cards-page__section">
        <div class="cards-section-head">
          <span class="cards-section-head__dot cards-section-head__dot--recent" aria-hidden="true" />
          <h2>{{ __t('ui.desktop-shell', '最近关闭') }}</h2>
          <span class="cards-section-head__badge">{{ recent.length }}</span>
          <span class="cards-section-head__line" aria-hidden="true" />
        </div>
        <p class="cards-page__section-desc">
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

      <!-- 底部快捷键说明条 -->
      <footer class="cards-page__tip">
        <PixelIcon name="info" size="xs" />
        <span>{{ __t('ui.desktop-shell', '在卡片窗口中按 Ctrl+W 也可以关闭卡片。') }}</span>
      </footer>
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
  /* 硬朗哑光工程面板语义变量，供 FenceToolbar 与 CardTile 统一继承 */
  --cards-surface: #ffffff;
  --cards-surface-soft: #f6f8fb;
  --cards-inset-bg: #eef1f6;
  --cards-border: rgba(15, 23, 42, 0.12);
  --cards-border-strong: rgba(15, 23, 42, 0.22);
  --cards-step-shadow: rgba(15, 23, 42, 0.06);
  --cards-panel-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.88),
    2px 2px 0 var(--cards-step-shadow);
  --cards-key-bg: #ffffff;
  --cards-key-hover: #f3f6fa;
  --cards-key-border: rgba(15, 23, 42, 0.14);
  --cards-key-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.92),
    2px 2px 0 var(--cards-step-shadow);

  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  max-width: 1260px;
  margin: 0 auto;
  padding: 24px 32px 36px;
}

[data-theme='dark'] .cards-page {
  --cards-surface: rgba(22, 25, 34, 0.94);
  --cards-surface-soft: rgba(17, 20, 28, 0.92);
  --cards-inset-bg: #0d1017;
  --cards-border: rgba(255, 255, 255, 0.11);
  --cards-border-strong: rgba(255, 255, 255, 0.22);
  --cards-step-shadow: rgba(0, 0, 0, 0.44);
  --cards-panel-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    2px 2px 0 var(--cards-step-shadow);
  --cards-key-bg: #181b24;
  --cards-key-hover: #1f2431;
  --cards-key-border: rgba(255, 255, 255, 0.12);
  --cards-key-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    2px 2px 0 var(--cards-step-shadow);
}

/* ── 页面顶栏 ── */
.cards-page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.cards-page__brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.cards-page__emblem {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 0;
  border: 1px solid var(--cards-border);
  border-left: 2px solid var(--ui-accent-sky);
  background: var(--cards-surface);
  color: var(--ui-accent-sky);
  box-shadow: var(--cards-key-shadow);
}

.cards-page__title-wrap {
  min-width: 0;
}

.cards-page__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cards-page__head h1 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 20px;
  font-weight: 900;
  line-height: 1.2;
  color: var(--ui-text-primary);
}

.cards-page__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  border-radius: 0;
  border: 1px solid var(--cards-border);
  background: var(--cards-surface-soft);
  font-family: var(--ui-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--ui-text-secondary);
}

.cards-page__head p {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--ui-text-secondary);
}

/* ── 搜索与刷新工具组 ── */
.cards-page__tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cards-search {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 220px;
  height: 30px;
  padding: 0 9px;
  border-radius: 0;
  border: 1px solid var(--cards-key-border);
  background: var(--cards-inset-bg);
  transition: border-color 140ms ease;
}

.cards-search:focus-within {
  border-color: var(--ui-accent-sky);
}

.cards-search__icon {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
}

.cards-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 12px;
  color: var(--ui-text-primary);
}

.cards-search input::placeholder {
  color: var(--ui-text-tertiary);
}

.cards-search__clear {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
}

.cards-search__clear:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}

.cards-refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border-radius: 0;
  border: 1px solid var(--cards-key-border);
  background: var(--cards-key-bg);
  box-shadow: var(--cards-key-shadow);
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-pixel);
  font-size: 11px;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.cards-refresh-btn:hover:not(:disabled) {
  background: var(--cards-key-hover);
  border-color: var(--cards-border-strong);
  color: var(--ui-text-primary);
}

.cards-refresh-btn:active:not(:disabled) {
  transform: translate(1px, 1px);
  box-shadow: inset 1px 1px 0 var(--cards-step-shadow);
}

.cards-refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── 分区标题与网格 ── */
.cards-page__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cards-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cards-section-head__dot {
  width: 5px;
  height: 5px;
  border-radius: 0;
  background: var(--ui-accent-sky);
}

.cards-section-head__dot--recent {
  background: var(--ui-warning);
}

.cards-section-head h2 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 12.5px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--ui-text-primary);
}

.cards-section-head__badge {
  padding: 1px 6px;
  border-radius: 0;
  border: 1px solid var(--cards-border);
  background: var(--cards-surface-soft);
  font-family: var(--ui-font-mono);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--ui-text-tertiary);
}

.cards-section-head__line {
  flex: 1;
  height: 1px;
  background: var(--cards-border);
}

.cards-page__section-desc {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--ui-text-secondary);
}

.cards-page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

/* ── 空状态卡片 ── */
.cards-empty-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 0;
  border: 1px dashed var(--cards-border-strong);
  background: var(--cards-surface-soft);
  color: var(--ui-text-secondary);
}

.cards-empty-card__icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 0;
  border: 1px solid var(--cards-border);
  background: var(--cards-inset-bg);
  color: var(--ui-text-tertiary);
}

.cards-empty-card p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
}

/* ── 底部提示与源码弹窗 ── */
.cards-page__tip {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 0;
  border: 1px solid var(--cards-border);
  background: var(--cards-surface-soft);
  font-size: 11.5px;
  color: var(--ui-text-secondary);
}

.cards-page__source {
  max-height: 60vh;
  overflow: auto;
  padding: 12px;
  border-radius: 0;
  border: 1px solid var(--ui-border-subtle);
  font-family: var(--ui-font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ui-text-primary);
  background: var(--ui-bg-canvas);
}

@media (max-width: 720px) {
  .cards-page {
    padding: 16px;
  }
  .cards-page__tools {
    width: 100%;
  }
  .cards-search {
    flex: 1;
    width: auto;
  }
}
</style>
