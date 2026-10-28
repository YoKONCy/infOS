import indexMaintenanceCn from '../locales/zh-CN/ui/index-maintenance.json'
import browserObserverCn from '../locales/zh-CN/ui/browser-observer.json'
import browserObserverTw from '../locales/zh-TW/ui/browser-observer.json'
import browserObserverEn from '../locales/en-US/ui/browser-observer.json'
import { registerCatalog as registerBrowserObserver } from '../index'
registerBrowserObserver('ui.browser-observer', 'zh-CN', browserObserverCn)
registerBrowserObserver('ui.browser-observer', 'zh-TW', browserObserverTw)
registerBrowserObserver('ui.browser-observer', 'en-US', browserObserverEn)
import indexMaintenanceTw from '../locales/zh-TW/ui/index-maintenance.json'
import indexMaintenanceEn from '../locales/en-US/ui/index-maintenance.json'
import { registerCatalog as registerIndexMaintenanceCatalog } from '../index'
registerIndexMaintenanceCatalog('ui.index-maintenance', 'zh-CN', indexMaintenanceCn)
registerIndexMaintenanceCatalog('ui.index-maintenance', 'zh-TW', indexMaintenanceTw)
registerIndexMaintenanceCatalog('ui.index-maintenance', 'en-US', indexMaintenanceEn)
import audioInputCn from '../locales/zh-CN/ui/audio-input.json'
import knowledgeRecallCn from '../locales/zh-CN/ui/knowledge-recall.json'
import knowledgeRecallTw from '../locales/zh-TW/ui/knowledge-recall.json'
import knowledgeRecallEn from '../locales/en-US/ui/knowledge-recall.json'
import audioInputTw from '../locales/zh-TW/ui/audio-input.json'
import audioInputEn from '../locales/en-US/ui/audio-input.json'
import tts0 from '../locales/zh-CN/ui/tts.json'
import inputControlsZhCn from '../locales/zh-CN/ui/input-controls.json'
import inputControlsZhTw from '../locales/zh-TW/ui/input-controls.json'
import inputControlsEnUs from '../locales/en-US/ui/input-controls.json'
import promptPresetsZhCn from '../locales/zh-CN/ui/prompt-presets.json'
import promptPresetsZhTw from '../locales/zh-TW/ui/prompt-presets.json'
import promptPresetsEnUs from '../locales/en-US/ui/prompt-presets.json'
import tts1 from '../locales/zh-TW/ui/tts.json'
import tts2 from '../locales/en-US/ui/tts.json'
import packagesZhCn from '../locales/zh-CN/ui/packages.json'
import runtimeDebugZhCn from '../locales/zh-CN/ui/runtime-debug.json'
import runtimeDebugZhTw from '../locales/zh-TW/ui/runtime-debug.json'
import runtimeDebugEnUs from '../locales/en-US/ui/runtime-debug.json'
import packagesZhTw from '../locales/zh-TW/ui/packages.json'
import packagesEnUs from '../locales/en-US/ui/packages.json'
// 按模块、语言分别维护词库；此入口只装配当前运行端需要的资源。
import { registerCatalog } from '../index'
import backupCn from '../locales/zh-CN/ui/backup.json'
import backupTw from '../locales/zh-TW/ui/backup.json'
import backupEn from '../locales/en-US/ui/backup.json'
registerCatalog('ui.backup', 'zh-CN', backupCn)
registerCatalog('ui.backup', 'zh-TW', backupTw)
registerCatalog('ui.backup', 'en-US', backupEn)
import userAvatarUiZhCn from '../locales/zh-CN/ui/user-avatar.json'
import userAvatarUiZhTw from '../locales/zh-TW/ui/user-avatar.json'
import userAvatarUiEnUs from '../locales/en-US/ui/user-avatar.json'
import archiveEditZhCn from '../locales/zh-CN/ui/archive-edit.json'
import archiveEditZhTw from '../locales/zh-TW/ui/archive-edit.json'
import archiveEditEnUs from '../locales/en-US/ui/archive-edit.json'
import providerChecksZhCn from '../locales/zh-CN/ui/provider-connections.json'
import providerChecksZhTw from '../locales/zh-TW/ui/provider-connections.json'
import providerChecksEnUs from '../locales/en-US/ui/provider-connections.json'
import ragZhCn from '../locales/zh-CN/ui/rag.json'
import ragZhTw from '../locales/zh-TW/ui/rag.json'
import ragEnUs from '../locales/en-US/ui/rag.json'
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
import messages12 from '../locales/zh-CN/ui/errors.json'
import messages13 from '../locales/zh-TW/ui/errors.json'
import messages14 from '../locales/en-US/ui/errors.json'
import messages15 from '../locales/zh-CN/ui/modules.json'
import messages16 from '../locales/zh-TW/ui/modules.json'
import messages17 from '../locales/en-US/ui/modules.json'
import messages18 from '../locales/zh-CN/ui/stream.json'
import messages19 from '../locales/zh-TW/ui/stream.json'
import messages20 from '../locales/en-US/ui/stream.json'
import messages21 from '../locales/zh-CN/logs/frontend/stream.json'
import messages22 from '../locales/zh-TW/logs/frontend/stream.json'
import messages23 from '../locales/en-US/logs/frontend/stream.json'
import messages24 from '../locales/zh-CN/ui/agent.json'
import messages25 from '../locales/zh-TW/ui/agent.json'
import messages26 from '../locales/en-US/ui/agent.json'
import messages27 from '../locales/zh-CN/ui/approval.json'
import messages28 from '../locales/zh-TW/ui/approval.json'
import messages29 from '../locales/en-US/ui/approval.json'
import messages30 from '../locales/zh-CN/logs/frontend/avatar.json'
import messages31 from '../locales/zh-TW/logs/frontend/avatar.json'
import messages32 from '../locales/en-US/logs/frontend/avatar.json'
import messages33 from '../locales/zh-CN/ui/avatar.json'
import messages34 from '../locales/zh-TW/ui/avatar.json'
import messages35 from '../locales/en-US/ui/avatar.json'
import messages36 from '../locales/zh-CN/ui/brands.json'
import messages37 from '../locales/zh-TW/ui/brands.json'
import messages38 from '../locales/en-US/ui/brands.json'
import messages39 from '../locales/zh-CN/ui/chat.json'
import messages40 from '../locales/zh-TW/ui/chat.json'
import messages41 from '../locales/en-US/ui/chat.json'
import messages42 from '../locales/zh-CN/logs/frontend/chat.json'
import messages43 from '../locales/zh-TW/logs/frontend/chat.json'
import messages44 from '../locales/en-US/logs/frontend/chat.json'
import messages45 from '../locales/zh-CN/ui/compositor.json'
import messages46 from '../locales/zh-TW/ui/compositor.json'
import messages47 from '../locales/en-US/ui/compositor.json'
import messages48 from '../locales/zh-CN/ui/connection.json'
import messages49 from '../locales/zh-TW/ui/connection.json'
import messages50 from '../locales/en-US/ui/connection.json'
import messages51 from '../locales/zh-CN/ui/settings.json'
import messages52 from '../locales/zh-TW/ui/settings.json'
import messages53 from '../locales/en-US/ui/settings.json'
import messages54 from '../locales/zh-CN/logs/frontend/settings.json'
import messages55 from '../locales/zh-TW/logs/frontend/settings.json'
import messages56 from '../locales/en-US/logs/frontend/settings.json'
import messages57 from '../locales/zh-CN/ui/desktop.json'
import messages58 from '../locales/zh-TW/ui/desktop.json'
import messages59 from '../locales/en-US/ui/desktop.json'
import messages60 from '../locales/zh-CN/ui/integrations.json'
import messages61 from '../locales/zh-TW/ui/integrations.json'
import messages62 from '../locales/en-US/ui/integrations.json'
import messages63 from '../locales/zh-CN/ui/knowledge.json'
import messages64 from '../locales/zh-TW/ui/knowledge.json'
import messages65 from '../locales/en-US/ui/knowledge.json'
import messages66 from '../locales/zh-CN/ui/layout.json'
import messages67 from '../locales/zh-TW/ui/layout.json'
import messages68 from '../locales/en-US/ui/layout.json'
import messages69 from '../locales/zh-CN/ui/navigation.json'
import messages70 from '../locales/zh-TW/ui/navigation.json'
import messages71 from '../locales/en-US/ui/navigation.json'
import messages72 from '../locales/zh-CN/logs/frontend/navigation.json'
import messages73 from '../locales/zh-TW/logs/frontend/navigation.json'
import messages74 from '../locales/en-US/logs/frontend/navigation.json'
import messages75 from '../locales/zh-CN/ui/motion.json'
import messages76 from '../locales/zh-TW/ui/motion.json'
import messages77 from '../locales/en-US/ui/motion.json'
import messages78 from '../locales/zh-CN/ui/notification.json'
import messages79 from '../locales/zh-TW/ui/notification.json'
import messages80 from '../locales/en-US/ui/notification.json'
import messages81 from '../locales/zh-CN/logs/frontend/overlays.json'
import messages82 from '../locales/zh-TW/logs/frontend/overlays.json'
import messages83 from '../locales/en-US/logs/frontend/overlays.json'
import messages84 from '../locales/zh-CN/ui/overlays.json'
import messages85 from '../locales/zh-TW/ui/overlays.json'
import messages86 from '../locales/en-US/ui/overlays.json'
import messages87 from '../locales/zh-CN/ui/pet.json'
import messages88 from '../locales/zh-TW/ui/pet.json'
import messages89 from '../locales/en-US/ui/pet.json'
import messages90 from '../locales/zh-CN/ui/pixel.json'
import messages91 from '../locales/zh-TW/ui/pixel.json'
import messages92 from '../locales/en-US/ui/pixel.json'
import messages93 from '../locales/zh-CN/ui/resources.json'
import messages94 from '../locales/zh-TW/ui/resources.json'
import messages95 from '../locales/en-US/ui/resources.json'
import messages96 from '../locales/zh-CN/ui/social.json'
import messages97 from '../locales/zh-TW/ui/social.json'
import messages98 from '../locales/en-US/ui/social.json'
import messages99 from '../locales/zh-CN/ui/stronghold.json'
import messages100 from '../locales/zh-TW/ui/stronghold.json'
import messages101 from '../locales/en-US/ui/stronghold.json'
import messages102 from '../locales/zh-CN/ui/tarot.json'
import messages103 from '../locales/zh-TW/ui/tarot.json'
import messages104 from '../locales/en-US/ui/tarot.json'
import messages105 from '../locales/zh-CN/ui/taskCenter.json'
import messages106 from '../locales/zh-TW/ui/taskCenter.json'
import messages107 from '../locales/en-US/ui/taskCenter.json'
import messages108 from '../locales/zh-CN/logs/frontend/taskCenter.json'
import messages109 from '../locales/zh-TW/logs/frontend/taskCenter.json'
import messages110 from '../locales/en-US/logs/frontend/taskCenter.json'
import messages111 from '../locales/zh-CN/ui/workspace.json'
import messages112 from '../locales/zh-TW/ui/workspace.json'
import messages113 from '../locales/en-US/ui/workspace.json'
import messages114 from '../locales/zh-CN/ui/tools.json'
import messages115 from '../locales/zh-TW/ui/tools.json'
import messages116 from '../locales/en-US/ui/tools.json'
import messages117 from '../locales/zh-CN/ui/usage.json'
import messages118 from '../locales/zh-TW/ui/usage.json'
import messages119 from '../locales/en-US/ui/usage.json'
import messages120 from '../locales/zh-CN/ui/weather.json'
import messages121 from '../locales/zh-TW/ui/weather.json'
import messages122 from '../locales/en-US/ui/weather.json'
import messages123 from '../locales/zh-CN/logs/frontend/gateway.json'
import messages124 from '../locales/zh-TW/logs/frontend/gateway.json'
import messages125 from '../locales/en-US/logs/frontend/gateway.json'
import messages126 from '../locales/zh-CN/ui/launcher.json'
import messages127 from '../locales/zh-TW/ui/launcher.json'
import messages128 from '../locales/en-US/ui/launcher.json'
import messages129 from '../locales/zh-CN/logs/frontend/launcher.json'
import messages130 from '../locales/zh-TW/logs/frontend/launcher.json'
import messages131 from '../locales/en-US/logs/frontend/launcher.json'
import messages132 from '../locales/zh-CN/logs/frontend/pet.json'
import messages133 from '../locales/zh-TW/logs/frontend/pet.json'
import messages134 from '../locales/en-US/logs/frontend/pet.json'
import messages135 from '../locales/zh-CN/logs/frontend/tools.json'
import messages136 from '../locales/zh-TW/logs/frontend/tools.json'
import messages137 from '../locales/en-US/logs/frontend/tools.json'
import messages138 from '../locales/zh-CN/ui/ui.json'
import messages139 from '../locales/zh-TW/ui/ui.json'
import messages140 from '../locales/en-US/ui/ui.json'
import messages141 from '../locales/zh-CN/logs/frontend/useStronghold.json'
import messages142 from '../locales/zh-TW/logs/frontend/useStronghold.json'
import messages143 from '../locales/en-US/logs/frontend/useStronghold.json'
import messages144 from '../locales/zh-CN/ui/useStronghold.json'
import messages145 from '../locales/zh-TW/ui/useStronghold.json'
import messages146 from '../locales/en-US/ui/useStronghold.json'
import messages147 from '../locales/zh-CN/ui/chatRichRenderer.json'
import messages148 from '../locales/zh-TW/ui/chatRichRenderer.json'
import messages149 from '../locales/en-US/ui/chatRichRenderer.json'
import messages150 from '../locales/zh-CN/ui/modelBrands.json'
import messages151 from '../locales/zh-TW/ui/modelBrands.json'
import messages152 from '../locales/en-US/ui/modelBrands.json'
import messages153 from '../locales/zh-CN/ui/toolSearchResult.json'
import messages154 from '../locales/zh-TW/ui/toolSearchResult.json'
import messages155 from '../locales/en-US/ui/toolSearchResult.json'
import messages156 from '../locales/zh-CN/ui/common.json'
import messages157 from '../locales/zh-TW/ui/common.json'
import messages158 from '../locales/en-US/ui/common.json'
import messages159 from '../locales/zh-CN/logs/frontend/common.json'
import messages160 from '../locales/zh-TW/logs/frontend/common.json'
import messages161 from '../locales/en-US/logs/frontend/common.json'
import messages162 from '../locales/zh-CN/ui/index.json'
import messages163 from '../locales/zh-TW/ui/index.json'
import messages164 from '../locales/en-US/ui/index.json'
import messages165 from '../locales/zh-CN/logs/frontend/taskCenterStore.json'
import messages166 from '../locales/zh-TW/logs/frontend/taskCenterStore.json'
import messages167 from '../locales/en-US/logs/frontend/taskCenterStore.json'
import messages168 from '../locales/zh-CN/ui/taskCenterStore.json'
import messages169 from '../locales/zh-TW/ui/taskCenterStore.json'
import messages170 from '../locales/en-US/ui/taskCenterStore.json'
import messages171 from '../locales/zh-CN/ui/useAgentStore.json'
import messages172 from '../locales/zh-TW/ui/useAgentStore.json'
import messages173 from '../locales/en-US/ui/useAgentStore.json'
import messages174 from '../locales/zh-CN/ui/useCompositorStore.json'
import messages175 from '../locales/zh-TW/ui/useCompositorStore.json'
import messages176 from '../locales/en-US/ui/useCompositorStore.json'
import messages177 from '../locales/zh-CN/ui/useNotificationStore.json'
import messages178 from '../locales/zh-TW/ui/useNotificationStore.json'
import messages179 from '../locales/en-US/ui/useNotificationStore.json'
import messages180 from '../locales/zh-CN/logs/frontend/useThreadStore.json'
import messages181 from '../locales/zh-TW/logs/frontend/useThreadStore.json'
import messages182 from '../locales/en-US/logs/frontend/useThreadStore.json'
import messages183 from '../locales/zh-CN/ui/historyExport.json'
import messages184 from '../locales/zh-TW/ui/historyExport.json'
import messages185 from '../locales/en-US/ui/historyExport.json'
import messages186 from '../locales/zh-CN/logs/frontend/ipcAdapter.json'
import messages187 from '../locales/zh-TW/logs/frontend/ipcAdapter.json'
import messages188 from '../locales/en-US/logs/frontend/ipcAdapter.json'
import messages189 from '../locales/zh-CN/ui/petShortcuts.json'
import messages190 from '../locales/zh-TW/ui/petShortcuts.json'
import messages191 from '../locales/en-US/ui/petShortcuts.json'
import messages192 from '../locales/zh-CN/errors/frontend.json'
import messages193 from '../locales/zh-TW/errors/frontend.json'
import messages194 from '../locales/en-US/errors/frontend.json'
registerCatalog('ui.user-avatar', 'zh-CN', userAvatarUiZhCn)
registerCatalog('ui.user-avatar', 'zh-TW', userAvatarUiZhTw)
registerCatalog('ui.user-avatar', 'en-US', userAvatarUiEnUs)
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
registerCatalog('ui.errors', 'zh-CN', messages12)
registerCatalog('ui.errors', 'zh-TW', messages13)
registerCatalog('ui.errors', 'en-US', messages14)
registerCatalog('ui.modules', 'zh-CN', messages15)
registerCatalog('ui.modules', 'zh-TW', messages16)
registerCatalog('ui.modules', 'en-US', messages17)
registerCatalog('ui.stream', 'zh-CN', messages18)
registerCatalog('ui.stream', 'zh-TW', messages19)
registerCatalog('ui.stream', 'en-US', messages20)
registerCatalog('logs.frontend.stream', 'zh-CN', messages21)
registerCatalog('logs.frontend.stream', 'zh-TW', messages22)
registerCatalog('logs.frontend.stream', 'en-US', messages23)
registerCatalog('ui.agent', 'zh-CN', messages24)
registerCatalog('ui.agent', 'zh-TW', messages25)
registerCatalog('ui.agent', 'en-US', messages26)
registerCatalog('ui.approval', 'zh-CN', messages27)
registerCatalog('ui.approval', 'zh-TW', messages28)
registerCatalog('ui.approval', 'en-US', messages29)
registerCatalog('logs.frontend.avatar', 'zh-CN', messages30)
registerCatalog('logs.frontend.avatar', 'zh-TW', messages31)
registerCatalog('logs.frontend.avatar', 'en-US', messages32)
registerCatalog('ui.avatar', 'zh-CN', messages33)
registerCatalog('ui.avatar', 'zh-TW', messages34)
registerCatalog('ui.avatar', 'en-US', messages35)
registerCatalog('ui.brands', 'zh-CN', messages36)
registerCatalog('ui.brands', 'zh-TW', messages37)
registerCatalog('ui.brands', 'en-US', messages38)
registerCatalog('ui.chat', 'zh-CN', messages39)
registerCatalog('ui.chat', 'zh-TW', messages40)
registerCatalog('ui.chat', 'en-US', messages41)
registerCatalog('logs.frontend.chat', 'zh-CN', messages42)
registerCatalog('logs.frontend.chat', 'zh-TW', messages43)
registerCatalog('logs.frontend.chat', 'en-US', messages44)
registerCatalog('ui.compositor', 'zh-CN', messages45)
registerCatalog('ui.compositor', 'zh-TW', messages46)
registerCatalog('ui.compositor', 'en-US', messages47)
registerCatalog('ui.connection', 'zh-CN', messages48)
registerCatalog('ui.connection', 'zh-TW', messages49)
registerCatalog('ui.connection', 'en-US', messages50)
registerCatalog('ui.settings', 'zh-CN', messages51)
registerCatalog('ui.settings', 'zh-TW', messages52)
registerCatalog('ui.settings', 'en-US', messages53)
registerCatalog('logs.frontend.settings', 'zh-CN', messages54)
registerCatalog('logs.frontend.settings', 'zh-TW', messages55)
registerCatalog('logs.frontend.settings', 'en-US', messages56)
registerCatalog('ui.desktop', 'zh-CN', messages57)
registerCatalog('ui.desktop', 'zh-TW', messages58)
registerCatalog('ui.desktop', 'en-US', messages59)
registerCatalog('ui.integrations', 'zh-CN', messages60)
registerCatalog('ui.integrations', 'zh-TW', messages61)
registerCatalog('ui.integrations', 'en-US', messages62)
registerCatalog('ui.knowledge', 'zh-CN', messages63)
registerCatalog('ui.knowledge', 'zh-TW', messages64)
registerCatalog('ui.knowledge', 'en-US', messages65)
registerCatalog('ui.layout', 'zh-CN', messages66)
registerCatalog('ui.layout', 'zh-TW', messages67)
registerCatalog('ui.layout', 'en-US', messages68)
registerCatalog('ui.navigation', 'zh-CN', messages69)
registerCatalog('ui.navigation', 'zh-TW', messages70)
registerCatalog('ui.navigation', 'en-US', messages71)
registerCatalog('logs.frontend.navigation', 'zh-CN', messages72)
registerCatalog('logs.frontend.navigation', 'zh-TW', messages73)
registerCatalog('logs.frontend.navigation', 'en-US', messages74)
registerCatalog('ui.motion', 'zh-CN', messages75)
registerCatalog('ui.motion', 'zh-TW', messages76)
registerCatalog('ui.motion', 'en-US', messages77)
registerCatalog('ui.notification', 'zh-CN', messages78)
registerCatalog('ui.notification', 'zh-TW', messages79)
registerCatalog('ui.notification', 'en-US', messages80)
registerCatalog('logs.frontend.overlays', 'zh-CN', messages81)
registerCatalog('logs.frontend.overlays', 'zh-TW', messages82)
registerCatalog('logs.frontend.overlays', 'en-US', messages83)
registerCatalog('ui.overlays', 'zh-CN', messages84)
registerCatalog('ui.overlays', 'zh-TW', messages85)
registerCatalog('ui.overlays', 'en-US', messages86)
registerCatalog('ui.pet', 'zh-CN', messages87)
registerCatalog('ui.pet', 'zh-TW', messages88)
registerCatalog('ui.pet', 'en-US', messages89)
registerCatalog('ui.pixel', 'zh-CN', messages90)
registerCatalog('ui.pixel', 'zh-TW', messages91)
registerCatalog('ui.pixel', 'en-US', messages92)
registerCatalog('ui.resources', 'zh-CN', messages93)
registerCatalog('ui.resources', 'zh-TW', messages94)
registerCatalog('ui.resources', 'en-US', messages95)
registerCatalog('ui.social', 'zh-CN', messages96)
registerCatalog('ui.social', 'zh-TW', messages97)
registerCatalog('ui.social', 'en-US', messages98)
registerCatalog('ui.stronghold', 'zh-CN', messages99)
registerCatalog('ui.stronghold', 'zh-TW', messages100)
registerCatalog('ui.stronghold', 'en-US', messages101)
registerCatalog('ui.tarot', 'zh-CN', messages102)
registerCatalog('ui.tarot', 'zh-TW', messages103)
registerCatalog('ui.tarot', 'en-US', messages104)
registerCatalog('ui.taskCenter', 'zh-CN', messages105)
registerCatalog('ui.taskCenter', 'zh-TW', messages106)
registerCatalog('ui.taskCenter', 'en-US', messages107)
registerCatalog('logs.frontend.taskCenter', 'zh-CN', messages108)
registerCatalog('logs.frontend.taskCenter', 'zh-TW', messages109)
registerCatalog('logs.frontend.taskCenter', 'en-US', messages110)
registerCatalog('ui.workspace', 'zh-CN', messages111)
registerCatalog('ui.workspace', 'zh-TW', messages112)
registerCatalog('ui.workspace', 'en-US', messages113)
registerCatalog('ui.tools', 'zh-CN', messages114)
registerCatalog('ui.tools', 'zh-TW', messages115)
registerCatalog('ui.tools', 'en-US', messages116)
registerCatalog('ui.usage', 'zh-CN', messages117)
registerCatalog('ui.usage', 'zh-TW', messages118)
registerCatalog('ui.usage', 'en-US', messages119)
registerCatalog('ui.weather', 'zh-CN', messages120)
registerCatalog('ui.weather', 'zh-TW', messages121)
registerCatalog('ui.weather', 'en-US', messages122)
registerCatalog('logs.frontend.gateway', 'zh-CN', messages123)
registerCatalog('logs.frontend.gateway', 'zh-TW', messages124)
registerCatalog('logs.frontend.gateway', 'en-US', messages125)
registerCatalog('ui.launcher', 'zh-CN', messages126)
registerCatalog('ui.launcher', 'zh-TW', messages127)
registerCatalog('ui.launcher', 'en-US', messages128)
registerCatalog('logs.frontend.launcher', 'zh-CN', messages129)
registerCatalog('logs.frontend.launcher', 'zh-TW', messages130)
registerCatalog('logs.frontend.launcher', 'en-US', messages131)
registerCatalog('logs.frontend.pet', 'zh-CN', messages132)
registerCatalog('logs.frontend.pet', 'zh-TW', messages133)
registerCatalog('logs.frontend.pet', 'en-US', messages134)
registerCatalog('logs.frontend.tools', 'zh-CN', messages135)
registerCatalog('logs.frontend.tools', 'zh-TW', messages136)
registerCatalog('logs.frontend.tools', 'en-US', messages137)
registerCatalog('ui.ui', 'zh-CN', messages138)
registerCatalog('ui.ui', 'zh-TW', messages139)
registerCatalog('ui.ui', 'en-US', messages140)
registerCatalog('logs.frontend.useStronghold', 'zh-CN', messages141)
registerCatalog('logs.frontend.useStronghold', 'zh-TW', messages142)
registerCatalog('logs.frontend.useStronghold', 'en-US', messages143)
registerCatalog('ui.useStronghold', 'zh-CN', messages144)
registerCatalog('ui.useStronghold', 'zh-TW', messages145)
registerCatalog('ui.useStronghold', 'en-US', messages146)
registerCatalog('ui.chatRichRenderer', 'zh-CN', messages147)
registerCatalog('ui.chatRichRenderer', 'zh-TW', messages148)
registerCatalog('ui.chatRichRenderer', 'en-US', messages149)
registerCatalog('ui.modelBrands', 'zh-CN', messages150)
registerCatalog('ui.modelBrands', 'zh-TW', messages151)
registerCatalog('ui.modelBrands', 'en-US', messages152)
registerCatalog('ui.toolSearchResult', 'zh-CN', messages153)
registerCatalog('ui.toolSearchResult', 'zh-TW', messages154)
registerCatalog('ui.toolSearchResult', 'en-US', messages155)
registerCatalog('ui.common', 'zh-CN', messages156)
registerCatalog('ui.common', 'zh-TW', messages157)
registerCatalog('ui.common', 'en-US', messages158)
registerCatalog('logs.frontend.common', 'zh-CN', messages159)
registerCatalog('logs.frontend.common', 'zh-TW', messages160)
registerCatalog('logs.frontend.common', 'en-US', messages161)
registerCatalog('ui.index', 'zh-CN', messages162)
registerCatalog('ui.index', 'zh-TW', messages163)
registerCatalog('ui.index', 'en-US', messages164)
registerCatalog('logs.frontend.taskCenterStore', 'zh-CN', messages165)
registerCatalog('logs.frontend.taskCenterStore', 'zh-TW', messages166)
registerCatalog('logs.frontend.taskCenterStore', 'en-US', messages167)
registerCatalog('ui.taskCenterStore', 'zh-CN', messages168)
registerCatalog('ui.taskCenterStore', 'zh-TW', messages169)
registerCatalog('ui.taskCenterStore', 'en-US', messages170)
registerCatalog('ui.useAgentStore', 'zh-CN', messages171)
registerCatalog('ui.useAgentStore', 'zh-TW', messages172)
registerCatalog('ui.useAgentStore', 'en-US', messages173)
registerCatalog('ui.useCompositorStore', 'zh-CN', messages174)
registerCatalog('ui.useCompositorStore', 'zh-TW', messages175)
registerCatalog('ui.useCompositorStore', 'en-US', messages176)
registerCatalog('ui.useNotificationStore', 'zh-CN', messages177)
registerCatalog('ui.useNotificationStore', 'zh-TW', messages178)
registerCatalog('ui.useNotificationStore', 'en-US', messages179)
registerCatalog('logs.frontend.useThreadStore', 'zh-CN', messages180)
registerCatalog('logs.frontend.useThreadStore', 'zh-TW', messages181)
registerCatalog('logs.frontend.useThreadStore', 'en-US', messages182)
registerCatalog('ui.historyExport', 'zh-CN', messages183)
registerCatalog('ui.historyExport', 'zh-TW', messages184)
registerCatalog('ui.historyExport', 'en-US', messages185)
registerCatalog('logs.frontend.ipcAdapter', 'zh-CN', messages186)
registerCatalog('logs.frontend.ipcAdapter', 'zh-TW', messages187)
registerCatalog('logs.frontend.ipcAdapter', 'en-US', messages188)
registerCatalog('ui.petShortcuts', 'zh-CN', messages189)
registerCatalog('ui.petShortcuts', 'zh-TW', messages190)
registerCatalog('ui.petShortcuts', 'en-US', messages191)
registerCatalog('errors.frontend', 'zh-CN', messages192)
registerCatalog('errors.frontend', 'zh-TW', messages193)
registerCatalog('errors.frontend', 'en-US', messages194)
registerCatalog('ui.rag', 'zh-CN', ragZhCn)
registerCatalog('ui.rag', 'zh-TW', ragZhTw)
registerCatalog('ui.rag', 'en-US', ragEnUs)
registerCatalog('ui.provider-connections', 'zh-CN', providerChecksZhCn)
registerCatalog('ui.provider-connections', 'zh-TW', providerChecksZhTw)
registerCatalog('ui.provider-connections', 'en-US', providerChecksEnUs)
registerCatalog('ui.archive-edit', 'zh-CN', archiveEditZhCn)
registerCatalog('ui.archive-edit', 'zh-TW', archiveEditZhTw)
registerCatalog('ui.archive-edit', 'en-US', archiveEditEnUs)

registerCatalog('ui.packages', 'zh-CN', packagesZhCn)
registerCatalog('ui.packages', 'zh-TW', packagesZhTw)
registerCatalog('ui.packages', 'en-US', packagesEnUs)
registerCatalog('ui.runtime-debug', 'zh-CN', runtimeDebugZhCn)
registerCatalog('ui.runtime-debug', 'zh-TW', runtimeDebugZhTw)
registerCatalog('ui.runtime-debug', 'en-US', runtimeDebugEnUs)
registerCatalog('ui.input-controls', 'zh-CN', inputControlsZhCn)
registerCatalog('ui.input-controls', 'zh-TW', inputControlsZhTw)
registerCatalog('ui.input-controls', 'en-US', inputControlsEnUs)

registerCatalog('ui.tts', 'zh-CN', tts0)
registerCatalog('ui.tts', 'zh-TW', tts1)
registerCatalog('ui.tts', 'en-US', tts2)
registerCatalog('ui.prompt-presets', 'zh-CN', promptPresetsZhCn)
registerCatalog('ui.prompt-presets', 'zh-TW', promptPresetsZhTw)
registerCatalog('ui.prompt-presets', 'en-US', promptPresetsEnUs)
import resourceVersionsZh from '../locales/zh-CN/ui/resource-versions.json'
import resourceVersionsTw from '../locales/zh-TW/ui/resource-versions.json'
import resourceVersionsEn from '../locales/en-US/ui/resource-versions.json'
registerCatalog('ui.resource-versions', 'zh-CN', resourceVersionsZh)
registerCatalog('ui.resource-versions', 'zh-TW', resourceVersionsTw)
registerCatalog('ui.resource-versions', 'en-US', resourceVersionsEn)
import attachmentsZh from '../locales/zh-CN/ui/attachments.json'
import attachmentsTw from '../locales/zh-TW/ui/attachments.json'
import attachmentsEn from '../locales/en-US/ui/attachments.json'
registerCatalog('ui.attachments', 'zh-CN', attachmentsZh)
registerCatalog('ui.attachments', 'zh-TW', attachmentsTw)
registerCatalog('ui.attachments', 'en-US', attachmentsEn)

registerCatalog('ui.audio-input', 'zh-CN', audioInputCn)
registerCatalog('ui.knowledge-recall', 'zh-CN', knowledgeRecallCn)
registerCatalog('ui.knowledge-recall', 'zh-TW', knowledgeRecallTw)
registerCatalog('ui.knowledge-recall', 'en-US', knowledgeRecallEn)
registerCatalog('ui.audio-input', 'zh-TW', audioInputTw)
registerCatalog('ui.audio-input', 'en-US', audioInputEn)
import achievementsCn from '../locales/zh-CN/ui/achievements.json'
import achievementsTw from '../locales/zh-TW/ui/achievements.json'
import achievementsEn from '../locales/en-US/ui/achievements.json'
import { registerCatalog as registerAchievements } from '../index'
registerAchievements('ui.achievements', 'zh-CN', achievementsCn)
registerAchievements('ui.achievements', 'zh-TW', achievementsTw)
registerAchievements('ui.achievements', 'en-US', achievementsEn)
