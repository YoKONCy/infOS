<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { onMounted, onUnmounted, ref, computed } from 'vue'
import { socialApi, type SocialStickerPage } from '../../api/modules/socialApi'
import { PixelIcon, PButton } from '../pixel'

const props = defineProps<{ platform?: string }>()
const accounts = ref<Array<{ platform: string; accountId: string }>>([])
const accountKey = ref('')
const key = (item: { platform: string; accountId: string }) =>
  JSON.stringify([item.platform, item.accountId])
const selected = computed(() => accounts.value.find((item) => key(item) === accountKey.value))
const accountId = computed(() => selected.value?.accountId ?? '')
const selectedPlatform = computed(() => selected.value?.platform ?? '')
const query = ref('')
const offset = ref(0)
const page = ref<SocialStickerPage>()
const drafts = ref<Record<string, string>>({})
const previews = ref<Record<string, string>>({})
const failedImages = ref<Record<string, boolean>>({})
const busy = ref(false)
const error = ref('')
const notice = ref('')
const deleting = ref('')
let revision = 0
let disposed = false
onUnmounted(() => {
  disposed = true
  revision++
})

async function loadImages(items: SocialStickerPage['stickers'], account: string, version: number) {
  let cursor = 0
  const worker = async () => {
    while (!disposed && version === revision && cursor < items.length) {
      const item = items[cursor++]!
      try {
        const result = await socialApi.getStickerImage(account, item.id, selectedPlatform.value)
        if (!disposed && version === revision && result.data)
          previews.value[item.id] = result.data.dataUrl
      } catch {
        if (!disposed && version === revision) failedImages.value[item.id] = true
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
}

async function load(refresh = false) {
  const version = ++revision
  page.value = undefined
  previews.value = {}
  failedImages.value = {}
  drafts.value = {}
  deleting.value = ''
  error.value = ''
  if (!accountId.value) return
  busy.value = true
  const account = accountId.value
  try {
    const result = await socialApi.getStickers(
      account,
      query.value.trim(),
      offset.value,
      refresh,
      selectedPlatform.value,
    )
    if (disposed || version !== revision) return
    if (!result.data) throw new Error('没有收到收藏列表')
    page.value = result.data
    for (const item of result.data.stickers) drafts.value[item.id] = item.description
    void loadImages(result.data.stickers, account, version)
  } catch (e) {
    if (!disposed && version === revision)
      error.value = e instanceof Error ? e.message : '同步收藏失败'
  } finally {
    if (!disposed && version === revision) busy.value = false
  }
}

async function sync() {
  if (busy.value) return
  notice.value = ''
  busy.value = true
  try {
    const result = await socialApi.getStickerAccounts()
    if (disposed) return
    accounts.value = (result.data?.connections ?? []).filter(
      (item) => !props.platform || item.platform === props.platform,
    )
    if (!accounts.value.some((item) => key(item) === accountKey.value))
      accountKey.value = accounts.value[0] ? key(accounts.value[0]) : ''
    offset.value = 0
    if (!accountId.value) {
      revision++
      page.value = undefined
      error.value = ''
      return
    }
    await load(true)
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : '获取账号失败'
  } finally {
    if (!disposed) busy.value = false
  }
}

function changeAccount() {
  offset.value = 0
  notice.value = ''
  void load(true)
}
function search() {
  offset.value = 0
  notice.value = ''
  void load()
}
function turnPage(delta: number) {
  offset.value = Math.max(0, offset.value + delta * 30)
  void load()
}

async function save(id: string) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await socialApi.describeSticker(
      accountId.value,
      id,
      drafts.value[id] ?? '',
      selectedPlatform.value,
    )
    if (disposed) return
    if (!result.data) throw new Error('描述未保存')
    const item = page.value?.stickers.find((sticker) => sticker.id === id)
    if (item) item.description = result.data.description
    notice.value = __t('ui.social', '描述已同步到平台')
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    if (!disposed) busy.value = false
  }
}

async function remove(id: string) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await socialApi.deleteSticker(accountId.value, id, selectedPlatform.value)
    if (disposed) return
    if (page.value?.stickers.length === 1 && offset.value > 0) offset.value -= 30
    await load(true)
    notice.value = __t('ui.social', '已从平台收藏中移除')
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    if (!disposed) busy.value = false
  }
}

onMounted(() => {
  void sync()
})
</script>

<template>
  <section class="account-stickers">
    <header class="stickers-heading">
      <div>
        <span class="stickers-kicker">ACCOUNT COLLECTION</span>
        <h3>
          <PixelIcon name="image" size="sm" />
          {{ __t('ui.social', '收藏表情') }}
        </h3>
        <p>{{ __t('ui.social', '属于平台账号，随聊天慢慢积累。') }}</p>
      </div>
      <PButton size="sm" variant="secondary" :disabled="busy" @click="sync">
        <PixelIcon name="refresh" size="xs" />
        {{ __t('ui.social', '同步') }}
      </PButton>
    </header>
    <form v-if="accounts.length" class="stickers-toolbar" @submit.prevent="search">
      <label>
        {{ __t('ui.social', '平台账号') }}
        <select v-model="accountKey" :disabled="busy" @change="changeAccount">
          <option v-for="account in accounts" :key="key(account)" :value="key(account)">
            {{ account.platform }} · {{ account.accountId }}
          </option>
        </select>
      </label>
      <input
        v-model="query"
        :disabled="busy"
        maxlength="200"
        :placeholder="__t('ui.social', '按描述找表情…')"
        :aria-label="__t('ui.social', '搜索收藏表情')"
      />
      <PButton size="sm" variant="secondary" :disabled="busy" type="submit">
        {{ __t('ui.social', '搜索') }}
      </PButton>
      <span v-if="page" class="stickers-count">{{ page.total }} {{ __t('ui.social', '张') }}</span>
    </form>
    <p v-if="error" class="stickers-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="stickers-notice" role="status">{{ notice }}</p>
    <p v-if="busy && !page" class="stickers-empty">{{ __t('ui.social', '正在同步收藏…') }}</p>
    <p v-else-if="!accounts.length && !error" class="stickers-empty">
      {{ __t('ui.social', '连接支持收藏表情的平台账号后，点同步查看收藏。') }}
    </p>
    <p v-else-if="page && !page.stickers.length" class="stickers-empty">
      {{
        query
          ? __t('ui.social', '没找到匹配的表情。')
          : __t('ui.social', '收藏还是空的。Agent 可以从收到的消息中收藏表情。')
      }}
    </p>
    <TransitionGroup name="sticker" tag="div" class="stickers-grid">
      <article
        v-for="item in page?.stickers ?? []"
        :key="`${accountId}:${item.id}`"
        class="sticker-tile"
      >
        <div class="sticker-picture">
          <img
            v-if="previews[item.id]"
            :src="previews[item.id]"
            :alt="item.description || __t('ui.social', '收藏表情')"
            loading="lazy"
          />
          <span v-else>
            {{
              failedImages[item.id] ? __t('ui.social', '预览暂不可用') : __t('ui.social', '加载中…')
            }}
          </span>
        </div>
        <textarea
          v-model="drafts[item.id]"
          maxlength="200"
          rows="2"
          :disabled="busy"
          :placeholder="__t('ui.social', '画面含义、适用语境…')"
          :aria-label="__t('ui.social', '表情描述')"
        />
        <footer v-if="deleting !== item.id">
          <PButton
            size="sm"
            variant="ghost"
            :disabled="busy || drafts[item.id] === item.description"
            @click="save(item.id)"
          >
            {{ __t('ui.social', '保存描述') }}
          </PButton>
          <PButton size="sm" variant="ghost" :disabled="busy" @click="deleting = item.id">
            <PixelIcon name="trash" size="xs" />
          </PButton>
        </footer>
        <footer v-else class="sticker-confirm">
          <span>{{ __t('ui.social', '移除此账号的收藏？') }}</span>
          <PButton size="sm" variant="danger" :disabled="busy" @click="remove(item.id)">
            {{ __t('ui.social', '移除') }}
          </PButton>
          <PButton size="sm" variant="ghost" :disabled="busy" @click="deleting = ''">
            {{ __t('ui.social', '取消') }}
          </PButton>
        </footer>
      </article>
    </TransitionGroup>
    <footer v-if="page && (offset > 0 || page.hasMore)" class="stickers-pagination">
      <PButton size="sm" variant="secondary" :disabled="busy || offset === 0" @click="turnPage(-1)">
        {{ __t('ui.social', '上一页') }}
      </PButton>
      <span>{{ Math.floor(offset / 30) + 1 }}</span>
      <PButton size="sm" variant="secondary" :disabled="busy || !page.hasMore" @click="turnPage(1)">
        {{ __t('ui.social', '下一页') }}
      </PButton>
    </footer>
    <p v-if="page?.truncated" class="stickers-hint">
      {{ __t('ui.social', '本次仅同步到部分收藏，数量为当前已同步范围。') }}
    </p>
  </section>
</template>

<style scoped>
.account-stickers {
  color: var(--ui-text-primary);
}
.stickers-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--ui-border-default);
  border-top: 2px solid var(--ui-accent-pink);
  background: var(--app-panel-fill, var(--ui-bg-surface));
}
.stickers-kicker {
  font: 10px var(--ui-font-pixel);
  letter-spacing: 2px;
  color: var(--ui-accent-pink);
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 18px;
}
.stickers-heading p,
.stickers-hint {
  margin: 0;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.stickers-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 18px 0;
}
.stickers-toolbar label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
select,
input,
textarea {
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface);
  color: var(--ui-text-primary);
  border-radius: 0;
  font: inherit;
  padding: 8px 10px;
}
input {
  flex: 1;
  min-width: 140px;
}
input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline: 1px solid var(--ui-accent-pink);
  outline-offset: 2px;
}
.stickers-count,
.stickers-pagination span {
  font: 12px var(--ui-font-pixel);
  color: var(--ui-text-secondary);
}
.stickers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 14px;
  position: relative;
}
.sticker-tile {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--app-panel-fill, var(--ui-bg-surface));
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--ui-border-default) 40%, transparent);
  transition:
    border-color 0.16s,
    transform 0.16s;
}
.sticker-tile:hover {
  border-color: var(--ui-accent-pink);
  transform: translateY(-2px);
}
.sticker-picture {
  height: 140px;
  display: grid;
  place-items: center;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-tertiary);
  font-size: 12px;
  margin-bottom: 10px;
}
.sticker-picture img {
  max-width: 100%;
  max-height: 140px;
  object-fit: contain;
}
textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 64px;
  resize: vertical;
  font-size: 12px;
  line-height: 1.6;
}
.sticker-tile footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding-top: 8px;
}
.sticker-confirm span {
  width: 100%;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.stickers-error {
  color: var(--ui-danger);
  overflow-wrap: anywhere;
  font-size: 12px;
}
.stickers-notice {
  color: var(--ui-success);
  font-size: 12px;
}
.stickers-empty {
  padding: 36px 16px;
  text-align: center;
  color: var(--ui-text-secondary);
  font-size: 13px;
}
.stickers-pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 20px;
  padding: 20px;
}
.sticker-enter-active,
.sticker-leave-active,
.sticker-move {
  transition:
    opacity 0.2s,
    transform 0.2s;
}
.sticker-enter-from,
.sticker-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.sticker-leave-active {
  position: absolute;
}
@media (prefers-reduced-motion: reduce) {
  .sticker-tile,
  .sticker-enter-active,
  .sticker-leave-active,
  .sticker-move {
    transition: none;
  }
}
</style>
