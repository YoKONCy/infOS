import { computed, type MaybeRefOrGetter, toValue } from 'vue'
import { EXECUTION_MODE_OPTIONS, type ExecutionMode } from '@infos/shared'
import { t as __t } from '../../i18n/index'

/** 从此档起（自动审批、完整权限）提升权限需要二次确认。 */
export const EXECUTION_CONFIRM_FROM = EXECUTION_MODE_OPTIONS.findIndex(
  (option) => option.value === 'auto_approve',
)

/**
 * 会话设置面板的执行权限档位：按风险从低到高排列，附带本地化文案与强调色。
 * 入口提示与权限分区共用同一份档位，避免两处各自换算当前档。
 */
export function useExecutionLevels(executionMode: MaybeRefOrGetter<ExecutionMode>) {
  const levels = computed(() =>
    EXECUTION_MODE_OPTIONS.map((option) => ({
      value: option.value,
      label: __t('common.interface', option.label),
      description: __t('common.interface', option.description),
      accent: {
        manual: 'var(--ui-success)',
        auto: 'var(--ui-accent-sky)',
        auto_approve: 'var(--ui-warning)',
        full: 'var(--ui-danger)',
      }[option.value],
    })),
  )
  const index = computed(() =>
    Math.max(
      0,
      levels.value.findIndex((level) => level.value === toValue(executionMode)),
    ),
  )
  const raised = computed(() => index.value >= EXECUTION_CONFIRM_FROM)
  return { levels, index, raised }
}
