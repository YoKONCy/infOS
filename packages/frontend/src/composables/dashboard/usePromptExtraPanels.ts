import { ref, type Ref } from 'vue'
import type { PromptSection } from './usePromptWorkspace'

/** 表达调教复用提示词草稿，切换分区前先收取源码编辑。 */
export function usePromptExtraPanels(options: {
  section: Ref<PromptSection>
  setSection: (id: PromptSection) => void
  syncSource: () => boolean
}) {
  const expressionOpen = ref(false)
  function openExpression() {
    if (options.syncSource()) expressionOpen.value = true
  }
  function openSection(id: PromptSection) {
    if (!options.syncSource()) return
    expressionOpen.value = false
    if (options.section.value !== id) options.setSection(id)
  }
  return { expressionOpen, openExpression, openSection }
}
