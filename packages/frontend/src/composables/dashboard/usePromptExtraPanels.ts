import { ref, type Ref } from 'vue'
import type { PromptSection } from './usePromptWorkspace'

/** 表达调教与回复策略面板切换，切换分区前先收取源码编辑。 */
export function usePromptExtraPanels(options: {
  section: Ref<PromptSection>
  setSection: (id: PromptSection) => void
  syncSource: () => boolean
}) {
  const expressionOpen = ref(false)
  const strategyOpen = ref(false)
  function openExpression() {
    if (!options.syncSource()) return
    strategyOpen.value = false
    expressionOpen.value = true
  }
  function openStrategy() {
    if (!options.syncSource()) return
    expressionOpen.value = false
    strategyOpen.value = true
  }
  function openSection(id: PromptSection) {
    if (!options.syncSource()) return
    expressionOpen.value = false
    strategyOpen.value = false
    if (options.section.value !== id) options.setSection(id)
  }
  return { expressionOpen, strategyOpen, openExpression, openStrategy, openSection }
}
