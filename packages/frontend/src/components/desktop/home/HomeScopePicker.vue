<script setup lang="ts">
import { t as __t } from '../../../i18n/index'
import { PSelect, PixelIcon } from '../../pixel'
import type { HomeScopeState } from './useHomeScope'

// 共享空间与授权记录共用同一份角色、会话选择。
const props = defineProps<{ state: HomeScopeState }>()
const { agentId, sessionId } = props.state
</script>

<template>
  <div class="home-scope">
    <div class="home-scope__lead">
      <span class="home-scope__icon" aria-hidden="true">
        <PixelIcon name="users" size="xs" />
      </span>
      <div class="home-scope__text">
        <strong>{{ __t('ui.desktop', '当前范围') }}</strong>
        <p>{{ __t('ui.desktop', '选择角色与会话，查看对应物品和记录。') }}</p>
      </div>
    </div>

    <div class="home-scope__selectors">
      <div class="home-scope__field">
        <span class="home-scope__field-label">
          <PixelIcon name="cat" size="xs" />
          {{ __t('ui.desktop', '角色') }}
        </span>
        <div class="home-scope__select-wrap">
          <PSelect v-model="agentId" :options="state.agentOptions.value" size="sm" />
        </div>
      </div>

      <div class="home-scope__field">
        <span class="home-scope__field-label">
          <PixelIcon name="chat" size="xs" />
          {{ __t('ui.desktop', '对话') }}
        </span>
        <div class="home-scope__select-wrap">
          <PSelect
            v-model="sessionId"
            :options="state.sessionOptions.value"
            :disabled="!state.sessionOptions.value[0]?.value"
            size="sm"
          />
        </div>
      </div>
    </div>

    <p v-if="state.error.value" role="alert" class="home-scope-error">{{ state.error.value }}</p>
  </div>
</template>

<style scoped>
.home-scope {
  --scope-surface: var(--home-surface, #ffffff);
  --scope-inset: var(--home-inset-bg, #eef1f6);
  --scope-border: var(--home-border, rgba(15, 23, 42, 0.12));
  --scope-shadow: var(
    --home-panel-shadow,
    inset 0 1px 0 rgba(255, 255, 255, 0.88),
    2px 2px 0 rgba(15, 23, 42, 0.06)
  );

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 18px;
  flex-wrap: wrap;
  padding: 11px 14px;
  border-radius: 0;
  background: var(--scope-surface);
  border: 1px solid var(--scope-border);
  border-left: 2px solid var(--ui-accent-purple);
  box-shadow: var(--scope-shadow);
  color: var(--ui-text-primary);
}

[data-theme='dark'] .home-scope {
  --scope-surface: var(--home-surface, rgba(22, 25, 34, 0.94));
  --scope-inset: var(--home-inset-bg, #0d1017);
  --scope-border: var(--home-border, rgba(255, 255, 255, 0.11));
  --scope-shadow: var(
    --home-panel-shadow,
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    2px 2px 0 rgba(0, 0, 0, 0.44)
  );
}

.home-scope__lead {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 220px;
  min-width: 0;
}

.home-scope__icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 0;
  border: 1px solid var(--scope-border);
  background: color-mix(in srgb, var(--ui-accent-purple) 8%, var(--scope-inset));
  color: var(--ui-accent-purple);
}

.home-scope__text {
  min-width: 0;
}

.home-scope__text strong {
  display: block;
  font: 700 12px/1.3 var(--ui-font-pixel);
  color: var(--ui-text-primary);
}

.home-scope__text p {
  margin: 2px 0 0;
  color: var(--ui-text-tertiary);
  font-size: 11.5px;
  line-height: 1.4;
}

.home-scope__selectors {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 2 1 420px;
  flex-wrap: wrap;
}

.home-scope__field {
  display: flex;
  align-items: stretch;
  flex: 1 1 200px;
  min-width: 180px;
  border: 1px solid var(--scope-border);
  background: var(--scope-inset);
}

.home-scope__field-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-right: 1px solid var(--scope-border);
  background: color-mix(in srgb, var(--ui-text-primary) 3%, transparent);
  font: 700 11px/1 var(--ui-font-pixel);
  color: var(--ui-text-secondary);
  white-space: nowrap;
  user-select: none;
}

.home-scope__select-wrap {
  flex: 1;
  min-width: 0;
}

.home-scope__select-wrap :deep(.p-select),
.home-scope__select-wrap :deep(.p-select-trigger) {
  border-radius: 0;
  border-color: transparent;
  box-shadow: none;
}

.home-scope-error {
  flex-basis: 100%;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ui-danger) 35%, var(--scope-border));
  border-left: 2px solid var(--ui-danger);
  border-radius: 0;
  background: color-mix(in srgb, var(--ui-danger) 8%, var(--scope-inset));
  color: var(--ui-text-primary);
  font-size: 12px;
}
</style>
