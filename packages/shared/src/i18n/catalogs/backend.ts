import indexMaintenanceCn from '../locales/zh-CN/server/index-maintenance.json'
import indexMaintenanceTw from '../locales/zh-TW/server/index-maintenance.json'
import indexMaintenanceEn from '../locales/en-US/server/index-maintenance.json'
import { registerCatalog as registerIndexMaintenanceCatalog } from '../index'
registerIndexMaintenanceCatalog('server.index-maintenance', 'zh-CN', indexMaintenanceCn)
registerIndexMaintenanceCatalog('server.index-maintenance', 'zh-TW', indexMaintenanceTw)
registerIndexMaintenanceCatalog('server.index-maintenance', 'en-US', indexMaintenanceEn)
import audioInputCn from '../locales/zh-CN/server/audio-input.json'
import backupCn from '../locales/zh-CN/server/backup.json'
import backupTw from '../locales/zh-TW/server/backup.json'
import backupEn from '../locales/en-US/server/backup.json'
import { registerCatalog as registerBackupCatalog } from '../index'
registerBackupCatalog('server.backup', 'zh-CN', backupCn)
registerBackupCatalog('server.backup', 'zh-TW', backupTw)
registerBackupCatalog('server.backup', 'en-US', backupEn)
import knowledgeRecallCn from '../locales/zh-CN/logs/knowledge-recall.json'
import knowledgeRecallTw from '../locales/zh-TW/logs/knowledge-recall.json'
import knowledgeRecallEn from '../locales/en-US/logs/knowledge-recall.json'
import audioInputTw from '../locales/zh-TW/server/audio-input.json'
import audioInputEn from '../locales/en-US/server/audio-input.json'
import tts0 from '../locales/zh-CN/server/tts.json'
import tts1 from '../locales/zh-TW/server/tts.json'
import tts2 from '../locales/en-US/server/tts.json'
import packagesZhCn from '../locales/zh-CN/server/packages.json'
import runtimeDebugZhCn from '../locales/zh-CN/server/runtime-debug.json'
import runtimeDebugZhTw from '../locales/zh-TW/server/runtime-debug.json'
import runtimeDebugEnUs from '../locales/en-US/server/runtime-debug.json'
import packagesZhTw from '../locales/zh-TW/server/packages.json'
import packagesEnUs from '../locales/en-US/server/packages.json'
// 按模块、语言分别维护词库；此入口只装配当前运行端需要的资源。
import { registerCatalog } from '../index'
import userAvatarServerZhCn from '../locales/zh-CN/server/user-avatar.json'
import userAvatarServerZhTw from '../locales/zh-TW/server/user-avatar.json'
import userAvatarServerEnUs from '../locales/en-US/server/user-avatar.json'
import userAvatarErrorsZhCn from '../locales/zh-CN/errors/user-avatar.json'
import userAvatarErrorsZhTw from '../locales/zh-TW/errors/user-avatar.json'
import userAvatarErrorsEnUs from '../locales/en-US/errors/user-avatar.json'
import archiveEditZhCn from '../locales/zh-CN/server/archive-edit.json'
import archiveEditZhTw from '../locales/zh-TW/server/archive-edit.json'
import archiveEditEnUs from '../locales/en-US/server/archive-edit.json'
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
import messages12 from '../locales/zh-CN/server/app/ts.json'
import messages13 from '../locales/zh-TW/server/app/ts.json'
import messages14 from '../locales/en-US/server/app/ts.json'
import messages15 from '../locales/zh-CN/logs/applications.json'
import messages16 from '../locales/zh-TW/logs/applications.json'
import messages17 from '../locales/en-US/logs/applications.json'
import messages18 from '../locales/zh-CN/server/applications.json'
import messages19 from '../locales/zh-TW/server/applications.json'
import messages20 from '../locales/en-US/server/applications.json'
import messages21 from '../locales/zh-CN/logs/capabilities.json'
import messages22 from '../locales/zh-TW/logs/capabilities.json'
import messages23 from '../locales/en-US/logs/capabilities.json'
import messages24 from '../locales/zh-CN/server/capabilities.json'
import messages25 from '../locales/zh-TW/server/capabilities.json'
import messages26 from '../locales/en-US/server/capabilities.json'
import messages27 from '../locales/zh-CN/logs/container/ts.json'
import messages28 from '../locales/zh-TW/logs/container/ts.json'
import messages29 from '../locales/en-US/logs/container/ts.json'
import messages30 from '../locales/zh-CN/server/container/ts.json'
import messages31 from '../locales/zh-TW/server/container/ts.json'
import messages32 from '../locales/en-US/server/container/ts.json'
import messages33 from '../locales/zh-CN/logs/core.json'
import messages34 from '../locales/zh-TW/logs/core.json'
import messages35 from '../locales/en-US/logs/core.json'
import messages36 from '../locales/zh-CN/logs/database.json'
import messages37 from '../locales/zh-TW/logs/database.json'
import messages38 from '../locales/en-US/logs/database.json'
import messages39 from '../locales/zh-CN/logs/kernel.json'
import messages40 from '../locales/zh-TW/logs/kernel.json'
import messages41 from '../locales/en-US/logs/kernel.json'
import messages42 from '../locales/zh-CN/logs/lib.json'
import messages43 from '../locales/zh-TW/logs/lib.json'
import messages44 from '../locales/en-US/logs/lib.json'
import messages45 from '../locales/zh-CN/logs/lifecycle.json'
import messages46 from '../locales/zh-TW/logs/lifecycle.json'
import messages47 from '../locales/en-US/logs/lifecycle.json'
import messages48 from '../locales/zh-CN/server/lifecycle.json'
import messages49 from '../locales/zh-TW/server/lifecycle.json'
import messages50 from '../locales/en-US/server/lifecycle.json'
import messages51 from '../locales/zh-CN/logs/main/ts.json'
import messages52 from '../locales/zh-TW/logs/main/ts.json'
import messages53 from '../locales/en-US/logs/main/ts.json'
import messages54 from '../locales/zh-CN/logs/middleware.json'
import messages55 from '../locales/zh-TW/logs/middleware.json'
import messages56 from '../locales/en-US/logs/middleware.json'
import messages57 from '../locales/zh-CN/server/middleware.json'
import messages58 from '../locales/zh-TW/server/middleware.json'
import messages59 from '../locales/en-US/server/middleware.json'
import messages60 from '../locales/zh-CN/logs/migrations.json'
import messages61 from '../locales/zh-TW/logs/migrations.json'
import messages62 from '../locales/en-US/logs/migrations.json'
import messages63 from '../locales/zh-CN/logs/nit.json'
import messages64 from '../locales/zh-TW/logs/nit.json'
import messages65 from '../locales/en-US/logs/nit.json'
import messages66 from '../locales/zh-CN/server/observer.json'
import messages67 from '../locales/zh-TW/server/observer.json'
import messages68 from '../locales/en-US/server/observer.json'
import messages69 from '../locales/zh-CN/logs/observer.json'
import messages70 from '../locales/zh-TW/logs/observer.json'
import messages71 from '../locales/en-US/logs/observer.json'
import messages72 from '../locales/zh-CN/logs/packages.json'
import messages73 from '../locales/zh-TW/logs/packages.json'
import messages74 from '../locales/en-US/logs/packages.json'
import messages75 from '../locales/zh-CN/server/projections.json'
import messages76 from '../locales/zh-TW/server/projections.json'
import messages77 from '../locales/en-US/server/projections.json'
import messages78 from '../locales/zh-CN/logs/repositories.json'
import messages79 from '../locales/zh-TW/logs/repositories.json'
import messages80 from '../locales/en-US/logs/repositories.json'
import messages81 from '../locales/zh-CN/server/routers.json'
import messages82 from '../locales/zh-TW/server/routers.json'
import messages83 from '../locales/en-US/server/routers.json'
import messages84 from '../locales/zh-CN/logs/routers.json'
import messages85 from '../locales/zh-TW/logs/routers.json'
import messages86 from '../locales/en-US/logs/routers.json'
import messages87 from '../locales/zh-CN/server/schemas.json'
import messages88 from '../locales/zh-TW/server/schemas.json'
import messages89 from '../locales/en-US/server/schemas.json'
import messages90 from '../locales/zh-CN/logs/agent.json'
import messages91 from '../locales/zh-TW/logs/agent.json'
import messages92 from '../locales/en-US/logs/agent.json'
import messages93 from '../locales/zh-CN/server/agent.json'
import messages94 from '../locales/zh-TW/server/agent.json'
import messages95 from '../locales/en-US/server/agent.json'
import messages96 from '../locales/zh-CN/server/attachment.json'
import messages97 from '../locales/zh-TW/server/attachment.json'
import messages98 from '../locales/en-US/server/attachment.json'
import messages99 from '../locales/zh-CN/logs/attachment.json'
import messages100 from '../locales/zh-TW/logs/attachment.json'
import messages101 from '../locales/en-US/logs/attachment.json'
import messages102 from '../locales/zh-CN/logs/companion.json'
import messages103 from '../locales/zh-TW/logs/companion.json'
import messages104 from '../locales/en-US/logs/companion.json'
import messages105 from '../locales/zh-CN/logs/context.json'
import messages106 from '../locales/zh-TW/logs/context.json'
import messages107 from '../locales/en-US/logs/context.json'
import messages108 from '../locales/zh-CN/logs/conversation.json'
import messages109 from '../locales/zh-TW/logs/conversation.json'
import messages110 from '../locales/en-US/logs/conversation.json'
import messages111 from '../locales/zh-CN/server/conversation.json'
import messages112 from '../locales/zh-TW/server/conversation.json'
import messages113 from '../locales/en-US/server/conversation.json'
import messages114 from '../locales/zh-CN/server/document.json'
import messages115 from '../locales/zh-TW/server/document.json'
import messages116 from '../locales/en-US/server/document.json'
import messages117 from '../locales/zh-CN/logs/embedding.json'
import messages118 from '../locales/zh-TW/logs/embedding.json'
import messages119 from '../locales/en-US/logs/embedding.json'
import messages120 from '../locales/zh-CN/logs/execution.json'
import messages121 from '../locales/zh-TW/logs/execution.json'
import messages122 from '../locales/en-US/logs/execution.json'
import messages123 from '../locales/zh-CN/logs/gateway.json'
import messages124 from '../locales/zh-TW/logs/gateway.json'
import messages125 from '../locales/en-US/logs/gateway.json'
import messages126 from '../locales/zh-CN/server/integrations.json'
import messages127 from '../locales/zh-TW/server/integrations.json'
import messages128 from '../locales/en-US/server/integrations.json'
import messages129 from '../locales/zh-CN/server/knowledge.json'
import messages130 from '../locales/zh-TW/server/knowledge.json'
import messages131 from '../locales/en-US/server/knowledge.json'
import messages132 from '../locales/zh-CN/logs/knowledge.json'
import messages133 from '../locales/zh-TW/logs/knowledge.json'
import messages134 from '../locales/en-US/logs/knowledge.json'
import messages135 from '../locales/zh-CN/logs/llm.json'
import messages136 from '../locales/zh-TW/logs/llm.json'
import messages137 from '../locales/en-US/logs/llm.json'
import messages138 from '../locales/zh-CN/server/llm.json'
import messages139 from '../locales/zh-TW/server/llm.json'
import messages140 from '../locales/en-US/server/llm.json'
import messages141 from '../locales/zh-CN/logs/maintenance.json'
import messages142 from '../locales/zh-TW/logs/maintenance.json'
import messages143 from '../locales/en-US/logs/maintenance.json'
import messages144 from '../locales/zh-CN/logs/mcp.json'
import messages145 from '../locales/zh-TW/logs/mcp.json'
import messages146 from '../locales/en-US/logs/mcp.json'
import messages147 from '../locales/zh-CN/logs/memory.json'
import messages148 from '../locales/zh-TW/logs/memory.json'
import messages149 from '../locales/en-US/logs/memory.json'
import messages150 from '../locales/zh-CN/server/memory.json'
import messages151 from '../locales/zh-TW/server/memory.json'
import messages152 from '../locales/en-US/server/memory.json'
import messages153 from '../locales/zh-CN/logs/model.json'
import messages154 from '../locales/zh-TW/logs/model.json'
import messages155 from '../locales/en-US/logs/model.json'
import messages156 from '../locales/zh-CN/server/model.json'
import messages157 from '../locales/zh-TW/server/model.json'
import messages158 from '../locales/en-US/server/model.json'
import messages159 from '../locales/zh-CN/logs/retrieval.json'
import messages160 from '../locales/zh-TW/logs/retrieval.json'
import messages161 from '../locales/en-US/logs/retrieval.json'
import messages162 from '../locales/zh-CN/logs/runtime.json'
import messages163 from '../locales/zh-TW/logs/runtime.json'
import messages164 from '../locales/en-US/logs/runtime.json'
import messages165 from '../locales/zh-CN/logs/scheduler.json'
import messages166 from '../locales/zh-TW/logs/scheduler.json'
import messages167 from '../locales/en-US/logs/scheduler.json'
import messages168 from '../locales/zh-CN/server/scheduler.json'
import messages169 from '../locales/zh-TW/server/scheduler.json'
import messages170 from '../locales/en-US/server/scheduler.json'
import messages171 from '../locales/zh-CN/logs/stronghold.json'
import messages172 from '../locales/zh-TW/logs/stronghold.json'
import messages173 from '../locales/en-US/logs/stronghold.json'
import messages174 from '../locales/zh-CN/server/stronghold.json'
import messages175 from '../locales/zh-TW/server/stronghold.json'
import messages176 from '../locales/en-US/server/stronghold.json'
import messages177 from '../locales/zh-CN/logs/task.json'
import messages178 from '../locales/zh-TW/logs/task.json'
import messages179 from '../locales/en-US/logs/task.json'
import messages180 from '../locales/zh-CN/server/task.json'
import messages181 from '../locales/zh-TW/server/task.json'
import messages182 from '../locales/en-US/server/task.json'
import messages183 from '../locales/zh-CN/logs/thread.json'
import messages184 from '../locales/zh-TW/logs/thread.json'
import messages185 from '../locales/en-US/logs/thread.json'
import messages186 from '../locales/zh-CN/logs/voice.json'
import messages187 from '../locales/zh-TW/logs/voice.json'
import messages188 from '../locales/en-US/logs/voice.json'
import messages189 from '../locales/zh-CN/server/voice.json'
import messages190 from '../locales/zh-TW/server/voice.json'
import messages191 from '../locales/en-US/server/voice.json'
import messages192 from '../locales/zh-CN/logs/workspace.json'
import messages193 from '../locales/zh-TW/logs/workspace.json'
import messages194 from '../locales/en-US/logs/workspace.json'
import messages195 from '../locales/zh-CN/logs/shared.json'
import messages196 from '../locales/zh-TW/logs/shared.json'
import messages197 from '../locales/en-US/logs/shared.json'
import messages198 from '../locales/zh-CN/logs/startup/ts.json'
import messages199 from '../locales/zh-TW/logs/startup/ts.json'
import messages200 from '../locales/en-US/logs/startup/ts.json'
import messages201 from '../locales/zh-CN/server/tools.json'
import messages202 from '../locales/zh-TW/server/tools.json'
import messages203 from '../locales/en-US/server/tools.json'
import messages204 from '../locales/zh-CN/logs/tools.json'
import messages205 from '../locales/zh-TW/logs/tools.json'
import messages206 from '../locales/en-US/logs/tools.json'
import messages207 from '../locales/zh-CN/errors/backend.json'
import messages208 from '../locales/zh-TW/errors/backend.json'
import messages209 from '../locales/en-US/errors/backend.json'
import messages210 from '../locales/zh-CN/logs/prompt.json'
import messages211 from '../locales/zh-TW/logs/prompt.json'
import messages212 from '../locales/en-US/logs/prompt.json'
import messages213 from '../locales/zh-CN/logs/daemon.json'
import messages214 from '../locales/zh-TW/logs/daemon.json'
import messages215 from '../locales/en-US/logs/daemon.json'
registerCatalog('server.user-avatar', 'zh-CN', userAvatarServerZhCn)
registerCatalog('server.user-avatar', 'zh-TW', userAvatarServerZhTw)
registerCatalog('server.user-avatar', 'en-US', userAvatarServerEnUs)
registerCatalog('errors.user-avatar', 'zh-CN', userAvatarErrorsZhCn)
registerCatalog('errors.user-avatar', 'zh-TW', userAvatarErrorsZhTw)
registerCatalog('errors.user-avatar', 'en-US', userAvatarErrorsEnUs)
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
registerCatalog('server.app.ts', 'zh-CN', messages12)
registerCatalog('server.app.ts', 'zh-TW', messages13)
registerCatalog('server.app.ts', 'en-US', messages14)
registerCatalog('logs.applications', 'zh-CN', messages15)
registerCatalog('logs.applications', 'zh-TW', messages16)
registerCatalog('logs.applications', 'en-US', messages17)
registerCatalog('server.applications', 'zh-CN', messages18)
registerCatalog('server.applications', 'zh-TW', messages19)
registerCatalog('server.applications', 'en-US', messages20)
registerCatalog('logs.capabilities', 'zh-CN', messages21)
registerCatalog('logs.capabilities', 'zh-TW', messages22)
registerCatalog('logs.capabilities', 'en-US', messages23)
registerCatalog('server.capabilities', 'zh-CN', messages24)
registerCatalog('server.capabilities', 'zh-TW', messages25)
registerCatalog('server.capabilities', 'en-US', messages26)
registerCatalog('logs.container.ts', 'zh-CN', messages27)
registerCatalog('logs.container.ts', 'zh-TW', messages28)
registerCatalog('logs.container.ts', 'en-US', messages29)
registerCatalog('server.container.ts', 'zh-CN', messages30)
registerCatalog('server.container.ts', 'zh-TW', messages31)
registerCatalog('server.container.ts', 'en-US', messages32)
registerCatalog('logs.core', 'zh-CN', messages33)
registerCatalog('logs.core', 'zh-TW', messages34)
registerCatalog('logs.core', 'en-US', messages35)
registerCatalog('logs.database', 'zh-CN', messages36)
registerCatalog('logs.database', 'zh-TW', messages37)
registerCatalog('logs.database', 'en-US', messages38)
registerCatalog('logs.kernel', 'zh-CN', messages39)
registerCatalog('logs.kernel', 'zh-TW', messages40)
registerCatalog('logs.kernel', 'en-US', messages41)
registerCatalog('logs.lib', 'zh-CN', messages42)
registerCatalog('logs.lib', 'zh-TW', messages43)
registerCatalog('logs.lib', 'en-US', messages44)
registerCatalog('logs.lifecycle', 'zh-CN', messages45)
registerCatalog('logs.lifecycle', 'zh-TW', messages46)
registerCatalog('logs.lifecycle', 'en-US', messages47)
registerCatalog('server.lifecycle', 'zh-CN', messages48)
registerCatalog('server.lifecycle', 'zh-TW', messages49)
registerCatalog('server.lifecycle', 'en-US', messages50)
registerCatalog('logs.main.ts', 'zh-CN', messages51)
registerCatalog('logs.main.ts', 'zh-TW', messages52)
registerCatalog('logs.main.ts', 'en-US', messages53)
registerCatalog('logs.middleware', 'zh-CN', messages54)
registerCatalog('logs.middleware', 'zh-TW', messages55)
registerCatalog('logs.middleware', 'en-US', messages56)
registerCatalog('server.middleware', 'zh-CN', messages57)
registerCatalog('server.middleware', 'zh-TW', messages58)
registerCatalog('server.middleware', 'en-US', messages59)
registerCatalog('logs.migrations', 'zh-CN', messages60)
registerCatalog('logs.migrations', 'zh-TW', messages61)
registerCatalog('logs.migrations', 'en-US', messages62)
registerCatalog('logs.nit', 'zh-CN', messages63)
registerCatalog('logs.nit', 'zh-TW', messages64)
registerCatalog('logs.nit', 'en-US', messages65)
registerCatalog('server.observer', 'zh-CN', messages66)
registerCatalog('server.observer', 'zh-TW', messages67)
registerCatalog('server.observer', 'en-US', messages68)
registerCatalog('logs.observer', 'zh-CN', messages69)
registerCatalog('logs.observer', 'zh-TW', messages70)
registerCatalog('logs.observer', 'en-US', messages71)
registerCatalog('logs.packages', 'zh-CN', messages72)
registerCatalog('logs.packages', 'zh-TW', messages73)
registerCatalog('logs.packages', 'en-US', messages74)
registerCatalog('server.projections', 'zh-CN', messages75)
registerCatalog('server.projections', 'zh-TW', messages76)
registerCatalog('server.projections', 'en-US', messages77)
registerCatalog('logs.repositories', 'zh-CN', messages78)
registerCatalog('logs.repositories', 'zh-TW', messages79)
registerCatalog('logs.repositories', 'en-US', messages80)
registerCatalog('server.routers', 'zh-CN', messages81)
registerCatalog('server.routers', 'zh-TW', messages82)
registerCatalog('server.routers', 'en-US', messages83)
registerCatalog('logs.routers', 'zh-CN', messages84)
registerCatalog('logs.routers', 'zh-TW', messages85)
registerCatalog('logs.routers', 'en-US', messages86)
registerCatalog('server.schemas', 'zh-CN', messages87)
registerCatalog('server.schemas', 'zh-TW', messages88)
registerCatalog('server.schemas', 'en-US', messages89)
registerCatalog('logs.agent', 'zh-CN', messages90)
registerCatalog('logs.agent', 'zh-TW', messages91)
registerCatalog('logs.agent', 'en-US', messages92)
registerCatalog('server.agent', 'zh-CN', messages93)
registerCatalog('server.agent', 'zh-TW', messages94)
registerCatalog('server.agent', 'en-US', messages95)
registerCatalog('server.attachment', 'zh-CN', messages96)
registerCatalog('server.attachment', 'zh-TW', messages97)
registerCatalog('server.attachment', 'en-US', messages98)
registerCatalog('logs.attachment', 'zh-CN', messages99)
registerCatalog('logs.attachment', 'zh-TW', messages100)
registerCatalog('logs.attachment', 'en-US', messages101)
registerCatalog('logs.companion', 'zh-CN', messages102)
registerCatalog('logs.companion', 'zh-TW', messages103)
registerCatalog('logs.companion', 'en-US', messages104)
registerCatalog('logs.context', 'zh-CN', messages105)
registerCatalog('logs.context', 'zh-TW', messages106)
registerCatalog('logs.context', 'en-US', messages107)
registerCatalog('logs.conversation', 'zh-CN', messages108)
registerCatalog('logs.conversation', 'zh-TW', messages109)
registerCatalog('logs.conversation', 'en-US', messages110)
registerCatalog('server.conversation', 'zh-CN', messages111)
registerCatalog('server.conversation', 'zh-TW', messages112)
registerCatalog('server.conversation', 'en-US', messages113)
registerCatalog('server.document', 'zh-CN', messages114)
registerCatalog('server.document', 'zh-TW', messages115)
registerCatalog('server.document', 'en-US', messages116)
registerCatalog('logs.embedding', 'zh-CN', messages117)
registerCatalog('logs.embedding', 'zh-TW', messages118)
registerCatalog('logs.embedding', 'en-US', messages119)
registerCatalog('logs.execution', 'zh-CN', messages120)
registerCatalog('logs.execution', 'zh-TW', messages121)
registerCatalog('logs.execution', 'en-US', messages122)
registerCatalog('logs.gateway', 'zh-CN', messages123)
registerCatalog('logs.gateway', 'zh-TW', messages124)
registerCatalog('logs.gateway', 'en-US', messages125)
registerCatalog('server.integrations', 'zh-CN', messages126)
registerCatalog('server.integrations', 'zh-TW', messages127)
registerCatalog('server.integrations', 'en-US', messages128)
registerCatalog('server.knowledge', 'zh-CN', messages129)
registerCatalog('server.knowledge', 'zh-TW', messages130)
registerCatalog('server.knowledge', 'en-US', messages131)
registerCatalog('logs.knowledge', 'zh-CN', messages132)
registerCatalog('logs.knowledge', 'zh-TW', messages133)
registerCatalog('logs.knowledge', 'en-US', messages134)
registerCatalog('logs.llm', 'zh-CN', messages135)
registerCatalog('logs.llm', 'zh-TW', messages136)
registerCatalog('logs.llm', 'en-US', messages137)
registerCatalog('server.llm', 'zh-CN', messages138)
registerCatalog('server.llm', 'zh-TW', messages139)
registerCatalog('server.llm', 'en-US', messages140)
registerCatalog('logs.maintenance', 'zh-CN', messages141)
registerCatalog('logs.maintenance', 'zh-TW', messages142)
registerCatalog('logs.maintenance', 'en-US', messages143)
registerCatalog('logs.mcp', 'zh-CN', messages144)
registerCatalog('logs.mcp', 'zh-TW', messages145)
registerCatalog('logs.mcp', 'en-US', messages146)
registerCatalog('logs.memory', 'zh-CN', messages147)
registerCatalog('logs.memory', 'zh-TW', messages148)
registerCatalog('logs.memory', 'en-US', messages149)
registerCatalog('server.memory', 'zh-CN', messages150)
registerCatalog('server.memory', 'zh-TW', messages151)
registerCatalog('server.memory', 'en-US', messages152)
registerCatalog('logs.model', 'zh-CN', messages153)
registerCatalog('logs.model', 'zh-TW', messages154)
registerCatalog('logs.model', 'en-US', messages155)
registerCatalog('server.model', 'zh-CN', messages156)
registerCatalog('server.model', 'zh-TW', messages157)
registerCatalog('server.model', 'en-US', messages158)
registerCatalog('logs.retrieval', 'zh-CN', messages159)
registerCatalog('logs.retrieval', 'zh-TW', messages160)
registerCatalog('logs.retrieval', 'en-US', messages161)
registerCatalog('logs.runtime', 'zh-CN', messages162)
registerCatalog('logs.runtime', 'zh-TW', messages163)
registerCatalog('logs.runtime', 'en-US', messages164)
registerCatalog('logs.scheduler', 'zh-CN', messages165)
registerCatalog('logs.scheduler', 'zh-TW', messages166)
registerCatalog('logs.scheduler', 'en-US', messages167)
registerCatalog('server.scheduler', 'zh-CN', messages168)
registerCatalog('server.scheduler', 'zh-TW', messages169)
registerCatalog('server.scheduler', 'en-US', messages170)
registerCatalog('logs.stronghold', 'zh-CN', messages171)
registerCatalog('logs.stronghold', 'zh-TW', messages172)
registerCatalog('logs.stronghold', 'en-US', messages173)
registerCatalog('server.stronghold', 'zh-CN', messages174)
registerCatalog('server.stronghold', 'zh-TW', messages175)
registerCatalog('server.stronghold', 'en-US', messages176)
registerCatalog('logs.task', 'zh-CN', messages177)
registerCatalog('logs.task', 'zh-TW', messages178)
registerCatalog('logs.task', 'en-US', messages179)
registerCatalog('server.task', 'zh-CN', messages180)
registerCatalog('server.task', 'zh-TW', messages181)
registerCatalog('server.task', 'en-US', messages182)
registerCatalog('logs.thread', 'zh-CN', messages183)
registerCatalog('logs.thread', 'zh-TW', messages184)
registerCatalog('logs.thread', 'en-US', messages185)
registerCatalog('logs.voice', 'zh-CN', messages186)
registerCatalog('logs.voice', 'zh-TW', messages187)
registerCatalog('logs.voice', 'en-US', messages188)
registerCatalog('server.voice', 'zh-CN', messages189)
registerCatalog('server.voice', 'zh-TW', messages190)
registerCatalog('server.voice', 'en-US', messages191)
registerCatalog('logs.workspace', 'zh-CN', messages192)
registerCatalog('logs.workspace', 'zh-TW', messages193)
registerCatalog('logs.workspace', 'en-US', messages194)
registerCatalog('logs.shared', 'zh-CN', messages195)
registerCatalog('logs.shared', 'zh-TW', messages196)
registerCatalog('logs.shared', 'en-US', messages197)
registerCatalog('logs.startup.ts', 'zh-CN', messages198)
registerCatalog('logs.startup.ts', 'zh-TW', messages199)
registerCatalog('logs.startup.ts', 'en-US', messages200)
registerCatalog('server.tools', 'zh-CN', messages201)
registerCatalog('server.tools', 'zh-TW', messages202)
registerCatalog('server.tools', 'en-US', messages203)
registerCatalog('logs.tools', 'zh-CN', messages204)
registerCatalog('logs.tools', 'zh-TW', messages205)
registerCatalog('logs.tools', 'en-US', messages206)
registerCatalog('errors.backend', 'zh-CN', messages207)
registerCatalog('errors.backend', 'zh-TW', messages208)
registerCatalog('errors.backend', 'en-US', messages209)
registerCatalog('logs.prompt', 'zh-CN', messages210)
registerCatalog('logs.prompt', 'zh-TW', messages211)
registerCatalog('logs.prompt', 'en-US', messages212)
registerCatalog('logs.daemon', 'zh-CN', messages213)
registerCatalog('logs.daemon', 'zh-TW', messages214)
registerCatalog('logs.daemon', 'en-US', messages215)
registerCatalog('server.archive-edit', 'zh-CN', archiveEditZhCn)
registerCatalog('server.archive-edit', 'zh-TW', archiveEditZhTw)
registerCatalog('server.archive-edit', 'en-US', archiveEditEnUs)

registerCatalog('server.packages', 'zh-CN', packagesZhCn)
registerCatalog('server.packages', 'zh-TW', packagesZhTw)
registerCatalog('server.packages', 'en-US', packagesEnUs)
registerCatalog('server.runtime-debug', 'zh-CN', runtimeDebugZhCn)
registerCatalog('server.runtime-debug', 'zh-TW', runtimeDebugZhTw)
registerCatalog('server.runtime-debug', 'en-US', runtimeDebugEnUs)

registerCatalog('server.tts', 'zh-CN', tts0)
registerCatalog('server.tts', 'zh-TW', tts1)
registerCatalog('server.tts', 'en-US', tts2)
import resourceVersionsZh from '../locales/zh-CN/server/resource-versions.json'
import resourceVersionsTw from '../locales/zh-TW/server/resource-versions.json'
import resourceVersionsEn from '../locales/en-US/server/resource-versions.json'
registerCatalog('server.resource-versions', 'zh-CN', resourceVersionsZh)
registerCatalog('server.resource-versions', 'zh-TW', resourceVersionsTw)
registerCatalog('server.resource-versions', 'en-US', resourceVersionsEn)

registerCatalog('server.audio-input', 'zh-CN', audioInputCn)
registerCatalog('logs.knowledge-recall', 'zh-CN', knowledgeRecallCn)
registerCatalog('logs.knowledge-recall', 'zh-TW', knowledgeRecallTw)
registerCatalog('logs.knowledge-recall', 'en-US', knowledgeRecallEn)
registerCatalog('server.audio-input', 'zh-TW', audioInputTw)
registerCatalog('server.audio-input', 'en-US', audioInputEn)
