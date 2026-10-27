<script setup lang="ts">
import { computed } from 'vue'
import { ACHIEVEMENTS } from '@infos/shared'
import { useAchievementStore } from '../../stores/useAchievementStore'
import { getDisplayLocale, t } from '../../i18n'
import { PCard, PixelIcon } from '../pixel'
import AchievementBadge from './AchievementBadge.vue'

const store = useAchievementStore()
const entries = computed(() =>
  ACHIEVEMENTS.map((definition) => ({
    ...definition,
    record: store.snapshot?.achievements.find((item) => item.id === definition.id),
  })),
)
const unlockedCount = computed(() => entries.value.filter((item) => item.record?.unlockedAt).length)
function date(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleDateString(getDisplayLocale())
    : ''
}
async function refresh(): Promise<void> {
  await store.refresh()
  await store.notifyEarned()
}
</script>

<template>
  <PCard pixel padding="none" class="achievements-card" :aria-busy="store.loading">
    <header class="achievement-header">
      <h3>
        <PixelIcon name="sparkle" size="sm" />
        {{ t('ui.achievements', '旅途成就') }}
      </h3>
      <span class="achievement-count">{{ unlockedCount }} / {{ entries.length }}</span>
      <button
        type="button"
        class="achievement-refresh"
        :disabled="store.loading"
        :aria-label="t('ui.achievements', '刷新成就')"
        @click="refresh"
      >
        <PixelIcon name="refresh" size="xs" :animation="store.loading ? 'spin' : ''" />
      </button>
    </header>
    <p v-if="store.failed" class="achievement-hint" role="status">
      {{ t('ui.achievements', '暂时无法读取成就，连接恢复后可重试。') }}
    </p>
    <p v-else-if="!store.snapshot" class="achievement-hint" role="status">
      {{ t('ui.achievements', '正在读取旅途记录…') }}
    </p>
    <template v-else>
      <article
        v-for="item in entries"
        :key="item.id"
        class="achievement-entry"
        :class="{ 'is-unlocked': item.record?.unlockedAt }"
      >
        <AchievementBadge :unlocked="!!item.record?.unlockedAt" />
        <div class="achievement-copy">
          <span class="achievement-state">
            {{ t('ui.achievements', item.record?.unlockedAt ? '已达成' : '等待启程') }}
          </span>
          <h4>{{ t('ui.achievements', item.name) }}</h4>
          <p>{{ t('ui.achievements', item.description) }}</p>
          <small v-if="item.record?.unlockedAt">
            {{ date(item.record.unlockedAt) }}
            <span v-if="store.accountMismatch">
              · {{ t('ui.achievements', '请使用首次绑定的 Steam 账号提交') }}
            </span>
            <span v-else-if="item.record.steamSubmittedAt">
              · {{ t('ui.achievements', '已提交 Steam') }}
            </span>
            <span v-else-if="store.steamAvailable">
              · {{ t('ui.achievements', '等待提交 Steam') }}
            </span>
          </small>
        </div>
        <span class="achievement-complete" aria-hidden="true">
          {{ item.record?.unlockedAt ? '✦' : '◇' }}
        </span>
      </article>
    </template>
  </PCard>
</template>

<style scoped>
.achievements-card {
  overflow: hidden;
  color: var(--ui-text-primary);
}
.achievement-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ui-border);
}
.achievement-header h3 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font: 700 14px/1.5 var(--ui-font-pixel);
}
.achievement-header h3 :deep(svg) {
  color: var(--ui-accent-purple);
}
.achievement-count {
  margin-left: auto;
  color: var(--ui-text-secondary);
  font: 12px var(--ui-font-pixel);
  font-variant-numeric: tabular-nums;
}
.achievement-refresh {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--ui-border);
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    transform 0.15s;
}
.achievement-refresh:hover:not(:disabled),
.achievement-refresh:focus-visible {
  color: var(--ui-accent-purple);
  border-color: var(--ui-accent-purple);
  transform: translateY(-1px);
  outline-offset: 3px;
}
.achievement-refresh:active:not(:disabled) {
  transform: translateY(1px);
}
.achievement-refresh:disabled {
  opacity: 0.5;
  cursor: wait;
}
.achievement-entry {
  position: relative;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px 20px;
  background: color-mix(in srgb, var(--ui-accent-purple) 3%, transparent);
  transition: background 0.2s;
}
.achievement-entry.is-unlocked {
  background: linear-gradient(
    110deg,
    color-mix(in srgb, var(--ui-accent-purple) 9%, transparent),
    transparent 85%
  );
}
.achievement-entry:hover :deep(.is-unlocked) {
  transform: translateY(-3px) rotate(-3deg);
}
.achievement-copy {
  flex: 1;
  min-width: 0;
}
.achievement-state {
  color: var(--ui-text-secondary);
  font: 10px var(--ui-font-pixel);
  letter-spacing: 0.08em;
}
.is-unlocked .achievement-state {
  color: var(--ui-accent-purple);
}
.achievement-copy h4 {
  margin: 7px 0;
  font: 700 18px/1.4 var(--ui-font-pixel);
}
.achievement-copy p,
.achievement-hint {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.achievement-copy small {
  display: block;
  margin-top: 10px;
  color: var(--ui-text-secondary);
  font-size: 10px;
  line-height: 1.6;
}
.achievement-complete {
  align-self: flex-start;
  color: var(--ui-text-secondary);
}
.is-unlocked .achievement-complete {
  color: var(--ui-accent-purple);
}
.achievement-hint {
  padding: 20px;
}
@media (max-width: 480px) {
  .achievement-entry {
    gap: 12px;
    padding: 18px 14px;
  }
  .achievement-entry :deep(.achievement-badge) {
    width: 64px;
    height: 64px;
  }
  .achievement-copy h4 {
    font-size: 16px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .achievement-entry,
  .achievement-refresh {
    transition: none;
  }
  .achievement-entry:hover :deep(.is-unlocked) {
    transform: none;
  }
}
</style>
