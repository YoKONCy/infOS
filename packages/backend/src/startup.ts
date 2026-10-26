import { t as __t } from './lib/i18n'
/**
 * 公共启动模块
 *
 * 提取 backend/main.ts 与 daemon/main.ts 中重复的启动逻辑：
 * - Banner 打印
 * - 日志文件初始化
 * - 进程守护注册
 * - DI 容器初始化 + 异步初始化 + 启动后任务
 * - Hono 应用创建 + HTTP 服务器启动
 * - Gateway WebSocket 挂载
 * - CapabilityBridge WS 服务端启动
 * - 优雅退出回调注册
 *
 * 入口文件（backend/main.ts、daemon/main.ts）只需提供差异化的 Banner
 * 和回调，其余启动流程统一委托给 startServer()。
 *
 * @module packages/backend/src/startup
 */

import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { createAppContext, createDefaultConfig, initAppContext } from './container'
import { runStartupTasks } from './lifecycle'
import { closeDrizzleConnection } from './database/connection'
import { logger, initLogFile, setLogLevel, parseLogLevel, getLogLevel } from './lib/logger'
import { SERVER_HOST, SERVER_PORT, getDataDir } from './lib/env'
import { DistributedSyncService } from './services/distributed/distributedSyncService'
import { BackupService } from './services/backup/backupService'
import { BACKUP_STATE, recoverBackupRestore } from './services/backup/backupStorage'
import { readBackupRowFile } from './services/backup/backupArchive'
import type { ImportPolicy } from '@infos/shared'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { registerProcessGuards, onShutdown } from './lib/processGuards'
import { setupGatewayWebSocket } from './services/gateway/wsUpgrade'
import { initTelemetry, shutdownTelemetry } from './lib/telemetry'
import { setLocale } from './lib/i18n'
import { LANGUAGE_CONFIG_KEY } from '@infos/shared/i18n'
import { acquireDaemonLease, retryStartupIo, verifyDataDirectory } from './lib/startupStorage'
import { ResourceVersions } from '@infos/shared/resource-versions'

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

/**
 * 启动服务器选项
 *
 * 入口文件通过此选项注入差异化内容（Banner、回调等），
 * 公共启动流程由 startServer() 统一处理。
 */
export interface StartServerOptions {
  /** 进程显示名（用于日志，如 "infOS 后端" / "infOS Daemon"） */
  processName: string
  /** 启动 Banner 打印函数（在日志文件初始化之前调用，越早越好） */
  printBanner: () => void
  /** HTTP 服务器就绪回调（可选，默认使用 logger.info） */
  onHttpReady?: (address: string, port: number) => void
  /** 额外的退出清理回调（在 CapabilityBridge.stop 之后执行） */
  onExtraShutdown?: () => Promise<void> | void
}

// ─────────────────────────────────────────────
// 启动函数
// ─────────────────────────────────────────────

/**
 * 启动 infOS 服务（公共入口）
 *
 * 统一 backend 与 daemon 的启动链路：
 * 1. 打印 Banner
 * 2. 初始化日志文件持久化
 * 3. 注册进程守护（uncaughtException / SIGINT / SIGTERM）
 * 4. 初始化 DI 容器（同步阶段）
 * 5. 异步初始化（工具注册 + 扩展加载 + 资产扫描）
 * 6. 启动后任务（调度器启动 + 任务恢复）
 * 7. 创建 Hono 应用
 * 8. 启动 HTTP 业务服务器（:9120）
 * 9. 挂载 Gateway WebSocket 升级（业务通道，与 HTTP 共用端口）
 * 10. 启动 CapabilityBridge WS 服务端（能力通道 :9121）
 * 11. 注册优雅退出回调
 *
 * @param options 启动选项
 */
export async function startServer(options: StartServerOptions): Promise<void> {
  const { processName, printBanner, onHttpReady, onExtraShutdown } = options

  // 0. 启动 Banner（最早输出，在任何初始化之前）
  printBanner()
  // 在日志清理、同步快照和数据库初始化前互斥，拦住其他入口拉起的重复后端。
  const lease = await acquireDaemonLease(getDataDir())
  process.env.PERO_DATA_DIR = lease.dataDirectory
  // 实例锁持有到进程真正退出，不能在业务清理尚未完成时放行下一实例。
  process.once('exit', lease.release)
  await verifyDataDirectory(lease.dataDirectory)
  // Telemetry 必须在创建 HTTP 应用与业务服务之前注册全局 Provider。
  initTelemetry()

  // 1. 初始化日志文件持久化（越早越好）
  try {
    await retryStartupIo(() => initLogFile())
  } catch (error) {
    // 日志目录异常不应使业务服务退出；发行版仍由父进程收集标准输出。
    logger.warn(__t('logs.startup.ts', '文件日志暂不可用，继续使用标准输出: {0}', [String(error)]))
  }

  // 2. 注册进程守护（日志就绪后立即注册）
  registerProcessGuards()

  // 3. 在数据库打开前应用已校验的完整同步快照。
  await recoverBackupRestore(getDataDir())
  await BackupService.applyPending(getDataDir())
  await DistributedSyncService.applyPending(getDataDir())

  // 完整数据同步完成后再切换资源，避免新版本被待应用的同步快照覆盖。
  // 此时仍持有实例锁，数据库与第三方代码尚未加载。
  const resourceVersions = new ResourceVersions(lease.dataDirectory)
  const resourceBoot = await resourceVersions.beginBoot()
  process.env.INFOS_RESOURCE_SAFE_MODE = resourceBoot.safeMode ? '1' : '0'

  // 4. 初始化 DI 容器（同步阶段）
  const config = createDefaultConfig()
  const ctx = await createAppContext(config)
  const reindexFile = path.join(getDataDir(), BACKUP_STATE, 'reindex.json')
  if (existsSync(reindexFile)) {
    const pending = JSON.parse(await readFile(reindexFile, 'utf8')) as {
      agents: string[]
      facts: boolean
      knowledge: boolean
      socialFile?: string
      policy?: ImportPolicy
      importId?: string
    }
    for (const agentId of pending.agents) {
      await ctx.eventMemoryService.rebuildAgentStore(agentId, true)
      ctx.storeRegistry.rebuildSocialStore(agentId)
    }
    if (pending.facts) await ctx.factsRepo.rebuildStore()
    if (pending.knowledge) ctx.knowledgeService.index.rebuild()
    if (
      pending.socialFile &&
      pending.policy &&
      pending.importId &&
      /^social-import-[a-f0-9-]{36}\.jsonl$/i.test(pending.socialFile)
    ) {
      const groups = new Map<
        string,
        Array<{ id: number; payload_json: string; edges_json: string }>
      >()
      for await (const row of readBackupRowFile(
        path.join(getDataDir(), BACKUP_STATE, pending.socialFile),
      )) {
        const agentId = pending.policy.agentTargets[String(row.agent_id)] ?? String(row.agent_id)
        const entries = groups.get(agentId) ?? []
        entries.push({
          id: Number(row.id),
          payload_json: String(row.payload_json),
          edges_json: String(row.edges_json),
        })
        groups.set(agentId, entries)
      }
      for (const [agentId, rows] of groups)
        ctx.storeRegistry.importSocialBackup(
          agentId,
          rows,
          pending.policy.conflict,
          pending.importId,
        )
    }
    await rm(reindexFile)
    if (pending.socialFile && /^social-import-[a-f0-9-]{36}\.jsonl$/i.test(pending.socialFile))
      await rm(path.join(getDataDir(), BACKUP_STATE, pending.socialFile), { force: true }).catch(
        () => {},
      )
  }
  setLocale(
    (await ctx.configRepo.get(LANGUAGE_CONFIG_KEY)) ??
      process.env.INFOS_LANGUAGE ??
      process.env.LANG,
  )

  if (resourceBoot.safeMode)
    logger.warn(
      __t(
        'logs.startup.ts',
        '已进入拓展恢复模式，第三方插件及 MCP 自动连接暂停；角色和技能资料仍正常加载。',
      ),
    )

  // 4. 异步初始化（工具注册 + 扩展加载 + 资产扫描）
  await initAppContext(ctx)

  // 4.1 应用用户配置的日志级别（覆盖 dev=debug / release=info 默认行为）
  //     初次启动无配置时保持默认；用户后续在 Dashboard 设置中修改后，
  //     由 config.router 热更新即时生效，此处只需在启动时读取一次。
  const configuredLogLevel = await ctx.configRepo.get('system.logLevel')
  if (configuredLogLevel) {
    const num = parseLogLevel(configuredLogLevel)
    if (num != null) {
      setLogLevel(num)
      logger.info(
        __t('logs.startup.ts', '已应用配置的日志级别: {0} (level={1})', [configuredLogLevel, num]),
      )
    } else {
      logger.warn(
        __t('logs.startup.ts', '配置的日志级别无效: "{0}"，保持默认 (level={1})', [
          configuredLogLevel,
          getLogLevel(),
        ]),
      )
    }
  }

  // 5. 启动后任务（调度器启动 + 任务恢复）
  await runStartupTasks(ctx)

  // 6. 创建 Hono 应用
  const app = createApp(ctx)

  // 6.1 注入主 app 实例给 AppManager，启用 sub app 动态路由挂载
  // 必须在 launch 任何需要 HTTP 路由的 sub app（如社交）之前完成
  ctx.appManager.setHonoApp(app)

  // 6.2 自动启动内置社交应用
  // AIOS: 社交应用是特殊应用，跟随主 Agent 启停。
  // 后端就绪后自动 install + launch，前端 SocialTab 只管 NapCat 进程。
  await autoLaunchSocialApp(ctx)

  // 7. 启动 HTTP 业务服务器（:9120）
  logger.info(
    __t('logs.startup.ts', '{0} 启动中... → http://{1}:{2}', [
      processName,
      SERVER_HOST,
      SERVER_PORT,
    ]),
  )

  const server = serve(
    {
      fetch: app.fetch,
      hostname: SERVER_HOST,
      port: SERVER_PORT,
    },
    (info) => {
      if (onHttpReady) {
        onHttpReady(info.address, info.port)
      } else {
        // 默认回退：使用 info 日志
        logger.info(
          __t('logs.startup.ts', '{0} 已就绪 → http://{1}:{2}', [
            processName,
            info.address,
            info.port,
          ]),
        )
      }
    },
  )

  // 8. 挂载 Gateway WebSocket 升级（业务通道，与 HTTP 共用 :9120）
  //    同时挂载社交适配器 WS 端点（/api/social/ws → NapCat 反向连接）
  setupGatewayWebSocket(server as Server, ctx.gatewayHub, ctx)
  ctx.gatewayHub.startHeartbeat()

  await ctx.clientAccess.attachListener(async (port) => {
    const lan = serve({ fetch: app.fetch, hostname: '0.0.0.0', port }) as Server
    await new Promise<void>((resolve, reject) => {
      if (lan.listening) return resolve()
      const onError = (error: Error) => {
        lan.off('listening', onReady)
        reject(error)
      }
      const onReady = () => {
        lan.off('error', onError)
        resolve()
      }
      lan.once('listening', onReady)
      lan.once('error', onError)
    })
    lan.on('error', (error) =>
      logger.error(__t('logs.startup.ts', '局域网监听错误：{0}', [error.message])),
    )
    const closeSockets = setupGatewayWebSocket(lan, ctx.gatewayHub, ctx, false)
    logger.info(
      __t('logs.startup.ts', '局域网网页入口已开放，端口 {0}；所有业务请求均需要设备鉴权', [port]),
    )
    return async () => {
      closeSockets()
      lan.closeAllConnections()
      await new Promise<void>((resolve) => lan.close(() => resolve()))
    }
  })
  // 首次纯 Web 启动可从服务端控制台取得短期管理配对码；已有设备不会重复生成。
  if (!process.env.INFOS_API_TOKEN && ctx.clientAccess.status().devices.length === 0) {
    const pairing = ctx.clientAccess.createPairing(true)
    logger.info(
      __t('logs.startup.ts', '首次 Web 管理配对码：{0}（五分钟内有效，仅可使用一次）', [
        pairing.code,
      ]),
    )
  }

  // 9. 启动 CapabilityBridge WS 服务端（能力通道 :9121）
  // 9. 启动 Node Capability Transport。
  const capabilityBridgePort = Number(process.env.PERO_CAPABILITY_PORT ?? 9121)
  try {
    await ctx.capabilityBridge.start(capabilityBridgePort)
    logger.info(
      __t('logs.startup.ts', 'CapabilityBridge 已启动，监听端口 {0}', [capabilityBridgePort]),
    )
  } catch (err) {
    logger.error(
      __t('logs.startup.ts', 'CapabilityBridge 启动失败（平台能力将不可用）: {0}', [err]),
    )
  }

  // 10. 注册优雅退出回调
  onShutdown(async () => {
    logger.info(__t('logs.startup.ts', '{0} 正在关闭资源...', [processName]))
    await ctx.clientAccess.dispose()
    try {
      await ctx.appManager.shutdown()
    } catch (err) {
      logger.warn(__t('logs.startup.ts', 'Social宿主关闭失败: {0}', [err]))
    }
    try {
      await ctx.capabilityBridge.stop()
    } catch (err) {
      logger.warn(__t('logs.startup.ts', 'CapabilityBridge 关闭失败: {0}', [err]))
    }
    if (onExtraShutdown) {
      await onExtraShutdown()
    }
    try {
      await ctx.kernelLifecycle.dispose()
    } catch (err) {
      logger.warn(__t('logs.startup.ts', 'Kernel 生命周期释放失败: {0}', [err]))
    }
    await shutdownTelemetry()
    try {
      ctx.storeRegistry.closeAll()
    } catch (err) {
      logger.warn(__t('logs.startup.ts', 'TriviumDB Store关闭失败: {0}', [err]))
    }
    try {
      closeDrizzleConnection(ctx.db)
    } catch (err) {
      logger.warn(__t('logs.startup.ts', '数据库关闭失败: {0}', [err]))
    }
    logger.info(__t('logs.startup.ts', '{0} 资源清理完成', [processName]))
    await resourceVersions.cleanShutdown(resourceBoot.id)
  })
}

// ─────────────────────────────────────────────
// 内置应用自动启动
// ─────────────────────────────────────────────

/**
 * 自动启动内置社交应用
 *
 * AIOS 设计：社交应用是特殊应用，跟随主 Agent 启停。
 * 后端就绪后自动 install（幂等）+ launch，无需前端手动触发。
 * 前端 SocialTab 只负责 NapCat 进程管理，社交应用运行时由后端自动维护。
 *
 * 流程：
 * 1. 检查 social app 是否已 install（appRegistry 表），未安装则自动 install
 * 2. 检查是否已有 running 实例，无则 launch
 *
 * 失败不阻塞主启动流程（catch 后仅 warn）。
 */
async function autoLaunchSocialApp(ctx: import('./container').AppContext): Promise<void> {
  logger.info(__t('logs.startup.ts', '=== [autoLaunchSocialApp] 开始自动启动社交应用 ==='))
  try {
    // 0. 清理孤儿实例（上次运行残留的 running/launching 状态，内存中已不存在）
    // 必须在 listInstances 检查之前调用，否则会误判旧实例仍在运行
    await ctx.appManager.cleanupStaleInstances()

    const hostAgentId = ctx.agentManager.defaultAgentId
    const SOCIAL_APP_ID = 'social'

    // 1. 检查是否已安装，未安装则自动 install
    const manifest = await ctx.appManager.getManifest(SOCIAL_APP_ID)
    if (!manifest) {
      // 定位 social app 目录（packages/apps/social）
      // 便携/打包环境通过 PERO_APP_ROOT 定位内置应用（bundle 后 import.meta 失效）
      const { fileURLToPath } = await import('node:url')
      const path = await import('node:path')
      const startupDir = path.dirname(fileURLToPath(import.meta.url))
      const appRoot = process.env.PERO_APP_ROOT
      const socialAppDir = appRoot
        ? path.resolve(appRoot, 'apps', 'social')
        : path.resolve(startupDir, '..', '..', 'apps', 'social')

      logger.info(__t('logs.startup.ts', '正在自动安装内置社交应用: {0}', [socialAppDir]))
      const { warnings } = await ctx.appManager.install(socialAppDir)
      if (warnings.length > 0) {
        logger.warn(__t('logs.startup.ts', '社交应用安装警告: {0}', [warnings.join('; ')]))
      }
      logger.success(__t('logs.startup.ts', '内置社交应用已安装'))
    }

    // 2. 检查是否已有 running 实例（避免重复 launch）
    const instances = await ctx.appManager.listInstances({
      appId: SOCIAL_APP_ID,
      status: 'running',
    })
    if (instances.length > 0) {
      logger.info(
        __t('logs.startup.ts', '社交应用已在运行 (instanceId={0})，跳过自动启动', [
          instances[0]!.instanceId,
        ]),
      )
      return
    }

    // 3. 启动社交应用实例
    logger.info(__t('logs.startup.ts', '正在自动启动社交应用...'))
    const instanceId = await ctx.appManager.launch({
      appId: SOCIAL_APP_ID,
      hostAgentId,
      launchedBy: 'system-autostart',
    })
    logger.success(
      __t('logs.startup.ts', '社交应用已自动启动 (instanceId={0}, hostAgent={1})', [
        instanceId,
        hostAgentId,
      ]),
    )
  } catch (err) {
    // 失败不阻塞主启动流程
    logger.warn(__t('logs.startup.ts', '社交应用自动启动失败（不影响主服务）: {0}', [err]))
  }
}
