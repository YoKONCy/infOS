// 按模块、语言分别维护词库；此入口只装配当前运行端需要的资源。
import { registerCatalog } from '../index'
import messages0 from '../locales/zh-CN/common/tools.json'
import messages1 from '../locales/zh-TW/common/tools.json'
import messages2 from '../locales/en-US/common/tools.json'
import messages3 from '../locales/zh-CN/errors/common.json'
import messages4 from '../locales/zh-TW/errors/common.json'
import messages5 from '../locales/en-US/errors/common.json'
import messages6 from '../locales/zh-CN/common/interface.json'
import messages7 from '../locales/zh-TW/common/interface.json'
import messages8 from '../locales/en-US/common/interface.json'
import messages9 from '../locales/zh-CN/common/prompts.json'
import messages10 from '../locales/zh-TW/common/prompts.json'
import messages11 from '../locales/en-US/common/prompts.json'
import messages12 from '../locales/zh-CN/apps/pictoria/ui.json'
import messages13 from '../locales/zh-TW/apps/pictoria/ui.json'
import messages14 from '../locales/en-US/apps/pictoria/ui.json'
import messages15 from '../locales/zh-CN/apps/pictoria/logs.json'
import messages16 from '../locales/zh-TW/apps/pictoria/logs.json'
import messages17 from '../locales/en-US/apps/pictoria/logs.json'
import messages18 from '../locales/zh-CN/errors/pictoria.json'
import messages19 from '../locales/zh-TW/errors/pictoria.json'
import messages20 from '../locales/en-US/errors/pictoria.json'
import studioCN from '../locales/zh-CN/apps/pictoria/studio/ui.json'
import studioTW from '../locales/zh-TW/apps/pictoria/studio/ui.json'
import studioEN from '../locales/en-US/apps/pictoria/studio/ui.json'
import studioErrorsCN from '../locales/zh-CN/apps/pictoria/studio/errors.json'
import studioErrorsTW from '../locales/zh-TW/apps/pictoria/studio/errors.json'
import studioErrorsEN from '../locales/en-US/apps/pictoria/studio/errors.json'
import referencesCN from '../locales/zh-CN/apps/pictoria/references/ui.json'
import referencesTW from '../locales/zh-TW/apps/pictoria/references/ui.json'
import referencesEN from '../locales/en-US/apps/pictoria/references/ui.json'
import visionCN from '../locales/zh-CN/apps/pictoria/vision/ui.json'
import visionTW from '../locales/zh-TW/apps/pictoria/vision/ui.json'
import visionEN from '../locales/en-US/apps/pictoria/vision/ui.json'
import videoCN from '../locales/zh-CN/apps/pictoria/video/ui.json'
import videoTW from '../locales/zh-TW/apps/pictoria/video/ui.json'
import videoEN from '../locales/en-US/apps/pictoria/video/ui.json'
import assistantCN from '../locales/zh-CN/apps/pictoria/assistant/ui.json'
import assistantTW from '../locales/zh-TW/apps/pictoria/assistant/ui.json'
import assistantEN from '../locales/en-US/apps/pictoria/assistant/ui.json'
import assistantErrorsCN from '../locales/zh-CN/apps/pictoria/assistant/errors.json'
import assistantErrorsTW from '../locales/zh-TW/apps/pictoria/assistant/errors.json'
import assistantErrorsEN from '../locales/en-US/apps/pictoria/assistant/errors.json'
registerCatalog('apps.pictoria.studio', 'zh-CN', { ...studioCN, ...studioErrorsCN })
registerCatalog('apps.pictoria.studio', 'zh-TW', { ...studioTW, ...studioErrorsTW })
registerCatalog('apps.pictoria.studio', 'en-US', { ...studioEN, ...studioErrorsEN })
registerCatalog('common.tools', 'zh-CN', messages0)
registerCatalog('common.tools', 'zh-TW', messages1)
registerCatalog('common.tools', 'en-US', messages2)
registerCatalog('errors.common', 'zh-CN', messages3)
registerCatalog('errors.common', 'zh-TW', messages4)
registerCatalog('errors.common', 'en-US', messages5)
registerCatalog('common.interface', 'zh-CN', messages6)
registerCatalog('common.interface', 'zh-TW', messages7)
registerCatalog('common.interface', 'en-US', messages8)
registerCatalog('common.prompts', 'zh-CN', messages9)
registerCatalog('common.prompts', 'zh-TW', messages10)
registerCatalog('common.prompts', 'en-US', messages11)
registerCatalog('apps.pictoria.ui', 'zh-CN', messages12)
registerCatalog('apps.pictoria.ui', 'zh-TW', messages13)
registerCatalog('apps.pictoria.ui', 'en-US', messages14)
registerCatalog('apps.pictoria.logs', 'zh-CN', messages15)
registerCatalog('apps.pictoria.logs', 'zh-TW', messages16)
registerCatalog('apps.pictoria.logs', 'en-US', messages17)
registerCatalog('errors.pictoria', 'zh-CN', messages18)
registerCatalog('errors.pictoria', 'zh-TW', messages19)
registerCatalog('errors.pictoria', 'en-US', messages20)

registerCatalog('apps.pictoria.references', 'zh-CN', referencesCN)
registerCatalog('apps.pictoria.references', 'zh-TW', referencesTW)
registerCatalog('apps.pictoria.references', 'en-US', referencesEN)
registerCatalog('apps.pictoria.vision', 'zh-CN', visionCN)
registerCatalog('apps.pictoria.vision', 'zh-TW', visionTW)
registerCatalog('apps.pictoria.vision', 'en-US', visionEN)
registerCatalog('apps.pictoria.video', 'zh-CN', videoCN)
registerCatalog('apps.pictoria.video', 'zh-TW', videoTW)
registerCatalog('apps.pictoria.video', 'en-US', videoEN)
registerCatalog('apps.pictoria.assistant', 'zh-CN', { ...assistantCN, ...assistantErrorsCN })
registerCatalog('apps.pictoria.assistant', 'zh-TW', { ...assistantTW, ...assistantErrorsTW })
registerCatalog('apps.pictoria.assistant', 'en-US', { ...assistantEN, ...assistantErrorsEN })
