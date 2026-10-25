<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

import { computed, onMounted, ref } from 'vue'
import { PButton, PDialog, PInput, PixelIcon } from '../../pixel'
import ClientAccessSettings from '../../connection/ClientAccessSettings.vue'
import {
  distributedApi,
  type CapabilityNodeStatus,
  type DistributedIdentity,
  type FullSyncManifest,
  type SavedServer,
  type ServerProbe,
} from '../../../api/modules/distributedApi'
import { isElectron, invoke } from '../../../utils/ipcAdapter'
import { setWebServerOrigin } from '../../../api/transport'
import { useNotificationStore } from '../../../stores'

const notify = useNotificationStore()
const identity = ref<DistributedIdentity | null>(null)
const servers = ref<SavedServer[]>([])
const capabilities = ref<CapabilityNodeStatus>({ nodes: [], sessions: [], offers: [] })
const endpoint = ref('')
const token = ref('')
const displayName = ref('')
const probeResult = ref<ServerProbe | null>(null)
const busy = ref('')
const confirmServer = ref<SavedServer | null>(null)
const invite = ref<{ endpoint: string; pairingCode: string; expiresAt: string } | null>(null)
const pendingSync = ref<{ snapshotId: string; sourceServerId: string } | null>(null)
const lastSync = ref<(FullSyncManifest & { backupPath: string }) | null>(null)

const isElectronBound = computed(() => isElectron())
const isElectronRemote = computed(() => window.electron?.connectionMode?.() === 'remote')
const activeSessions = computed(() =>
  capabilities.value.sessions.filter((session) => session.health !== 'offline'),
)

const SERVER_TOKENS_KEY = 'infos.savedServerTokens'

function saveBrowserServerToken(serverId: string, value: string) {
  if (isElectronBound.value || !value) return
  const current = JSON.parse(sessionStorage.getItem(SERVER_TOKENS_KEY) || '{}') as Record<
    string,
    string
  >
  current[serverId] = value
  sessionStorage.setItem(SERVER_TOKENS_KEY, JSON.stringify(current))
}

function browserServerToken(serverId: string): string {
  if (isElectronBound.value) return ''
  const current = JSON.parse(sessionStorage.getItem(SERVER_TOKENS_KEY) || '{}') as Record<
    string,
    string
  >
  return current[serverId] ?? ''
}

async function refresh() {
  const [identityResult, serverResult, capabilityResult, syncStateResult] = await Promise.all([
    distributedApi.identity(),
    distributedApi.servers(),
    distributedApi.capabilityNodes(),
    distributedApi.pending(),
  ])
  identity.value = identityResult.data ?? null
  servers.value = serverResult.data ?? []
  capabilities.value = capabilityResult.data ?? { nodes: [], sessions: [], offers: [] }
  pendingSync.value = syncStateResult.data?.pending ?? null
  lastSync.value = syncStateResult.data?.lastSync ?? null
}

async function probe() {
  busy.value = 'probe'
  try {
    probeResult.value =
      (await distributedApi.probe({ endpoint: endpoint.value, token: token.value })).data ?? null
    notify.toast(__t('ui.settings', '远程服务器连接正常'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '连接测试')
      },
    })
  } catch (error) {
    notify.toast((error as Error).message, {
      type: 'error',
      get title() {
        return __t('ui.settings', '连接失败')
      },
    })
  } finally {
    busy.value = ''
  }
}

async function save() {
  busy.value = 'save'
  try {
    const saved = await distributedApi.saveServer({
      endpoint: endpoint.value,
      token: token.value,
      displayName: displayName.value || undefined,
    })
    if (saved.data) saveBrowserServerToken(saved.data.serverId, token.value)
    endpoint.value = ''
    token.value = ''
    displayName.value = ''
    probeResult.value = null
    await refresh()
    notify.toast(__t('ui.settings', '已加入“我的服务器”'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '保存成功')
      },
    })
  } catch (error) {
    notify.toast((error as Error).message, {
      type: 'error',
      get title() {
        return __t('ui.settings', '保存失败')
      },
    })
  } finally {
    busy.value = ''
  }
}

async function remove(server: SavedServer) {
  busy.value = `remove:${server.serverId}`
  try {
    await distributedApi.removeServer(server.serverId)
    await refresh()
  } finally {
    busy.value = ''
  }
}

async function switchServer(server: SavedServer) {
  try {
    setWebServerOrigin(server.endpoint, browserServerToken(server.serverId))
    location.reload()
  } catch (error) {
    notify.toast((error as Error).message, {
      type: 'error',
      get title() {
        return __t('ui.settings', '切换失败')
      },
    })
  }
}

async function sync() {
  const server = confirmServer.value
  if (!server) return
  busy.value = `sync:${server.serverId}`
  try {
    const result = await distributedApi.syncFrom(server.serverId)
    confirmServer.value = null
    await refresh()
    notify.toast(
      __t('ui.settings', '同步已准备好（{0}），请重启服务', [
        formatBytes(result.data?.manifest.totalBytes ?? 0),
      ]),
      {
        type: 'success',
        get title() {
          return __t('ui.settings', '同步准备完成')
        },
        duration: 10000,
      },
    )
  } catch (error) {
    notify.toast((error as Error).message, {
      type: 'error',
      get title() {
        return __t('ui.settings', '同步失败')
      },
    })
  } finally {
    busy.value = ''
  }
}

async function rollback() {
  busy.value = 'rollback'
  try {
    await distributedApi.rollback()
    notify.toast(__t('ui.settings', '请重启服务以恢复同步前的数据'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '撤销准备完成')
      },
      duration: 10000,
    })
  } catch (error) {
    notify.toast((error as Error).message, {
      type: 'error',
      get title() {
        return __t('ui.settings', '撤销失败')
      },
    })
  } finally {
    busy.value = ''
  }
}

async function createInvite() {
  busy.value = 'invite'
  try {
    invite.value = (await distributedApi.createCapabilityInvite()).data ?? null
  } catch (error) {
    notify.toast((error as Error).message, {
      type: 'error',
      get title() {
        return __t('ui.settings', '邀请生成失败')
      },
    })
  } finally {
    busy.value = ''
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

onMounted(() => void refresh())
</script>

<template>
  <div class="distributed-tab">
    <header class="distributed-hero">
      <div class="hero-icon"><PixelIcon name="network" size="xl" /></div>
      <div>
        <h1>{{ __t('ui.settings', '分布式') }}</h1>
        <p>{{ __t('ui.settings', '管理设备、服务器与数据同步') }}</p>
      </div>
      <span class="mode-badge" :class="{ local: isElectronBound && !isElectronRemote }">
        {{
          isElectronBound && !isElectronRemote
            ? __t('ui.settings', '本机服务')
            : __t('ui.settings', '远程连接')
        }}
      </span>
    </header>

    <ClientAccessSettings class="distributed-access" />

    <section class="pixel-card current-card">
      <div class="card-heading">
        <PixelIcon name="home" size="md" />
        <div>
          <h2>{{ __t('ui.settings', '当前服务器') }}</h2>
          <p>{{ __t('ui.settings', '此设备正在使用的业务数据来源') }}</p>
        </div>
      </div>
      <div class="identity-grid">
        <div>
          <span>{{ __t('ui.settings', '名称') }}</span>
          <strong>{{ identity?.displayName ?? __t('ui.settings', '读取中…') }}</strong>
        </div>
        <div>
          <span>Server ID</span>
          <code>{{ identity?.serverId ?? '—' }}</code>
        </div>
        <div>
          <span>{{ __t('ui.settings', '版本') }}</span>
          <strong>{{ identity?.appVersion ?? '—' }}</strong>
        </div>
        <div>
          <span>{{ __t('ui.settings', '入口规则') }}</span>
          <strong>
            {{
              isElectronBound && !isElectronRemote
                ? __t('ui.settings', '使用本机服务')
                : __t('ui.settings', '可切换服务器')
            }}
          </strong>
        </div>
      </div>
      <div v-if="isElectronBound" class="soft-note">
        <PButton size="sm" @click="invoke('client-connection:configure')">
          {{ __t('ui.connection', '选择运行方式') }}
        </PButton>
        {{ __t('ui.connection', '在开屏中切换本地或远程模式，重启客户端后生效。') }}
      </div>
      <div v-if="pendingSync" class="sync-state pending-state">
        <PixelIcon name="clock" size="sm" />
        <span>{{ __t('ui.settings', '数据已就绪，重启服务后应用。') }}</span>
      </div>
      <div v-if="lastSync" class="sync-state">
        <PixelIcon name="check" size="sm" />
        <span>
          {{ __t('ui.settings', '上次完整同步：')
          }}{{ new Date(lastSync.createdAt).toLocaleString() }} ·
          {{ formatBytes(lastSync.totalBytes) }}
        </span>
        <PButton size="sm" variant="ghost" :loading="busy === 'rollback'" @click="rollback">
          {{ __t('ui.settings', '撤销上次同步') }}
        </PButton>
      </div>
    </section>

    <section class="pixel-card">
      <div class="card-heading">
        <PixelIcon name="plus" size="md" />
        <div>
          <h2>{{ __t('ui.settings', '添加服务器') }}</h2>
          <p>{{ __t('ui.settings', '鉴权密码仅用于连接验证，保存后会在本机加密') }}</p>
        </div>
      </div>
      <div class="server-form">
        <PInput
          v-model="endpoint"
          :placeholder="__t('ui.settings', '服务器地址，例如 https://home.example.com')"
        />
        <PInput
          v-model="token"
          type="password"
          :placeholder="__t('ui.settings', '鉴权密码 / Token')"
        />
        <PInput v-model="displayName" :placeholder="__t('ui.settings', '显示名称（可选）')" />
        <div class="form-actions">
          <PButton variant="secondary" :loading="busy === 'probe'" @click="probe">
            {{ __t('ui.settings', '测试连接') }}
          </PButton>
          <PButton :loading="busy === 'save'" :disabled="!endpoint" @click="save">
            {{ __t('ui.settings', '保存到我的服务器') }}
          </PButton>
        </div>
      </div>
      <div v-if="probeResult" class="probe-result">
        <PixelIcon name="check" size="sm" />
        {{ probeResult.displayName }} · {{ probeResult.latencyMs }}ms · {{ probeResult.appVersion }}
      </div>
    </section>

    <section class="pixel-card">
      <div class="card-heading">
        <PixelIcon name="database" size="md" />
        <div>
          <h2>{{ __t('ui.settings', '我的服务器') }}</h2>
          <p>{{ __t('ui.settings', '点击一次即可从指定服务器同步全部用户数据') }}</p>
        </div>
      </div>
      <div v-if="servers.length" class="server-list">
        <article v-for="server in servers" :key="server.serverId" class="server-row">
          <div class="server-orb"><PixelIcon name="server" size="md" /></div>
          <div class="server-copy">
            <strong>{{ server.displayName }}</strong>
            <span>{{ server.endpoint }}</span>
            <code>{{ server.serverId }}</code>
          </div>
          <div class="server-actions">
            <PButton
              v-if="!isElectronBound"
              size="sm"
              variant="secondary"
              @click="switchServer(server)"
            >
              {{ __t('ui.settings', '设为当前服务器') }}
            </PButton>
            <PButton
              size="sm"
              :loading="busy === `sync:${server.serverId}`"
              @click="confirmServer = server"
            >
              {{ __t('ui.settings', '从此服务器上同步最新数据') }}
            </PButton>
            <PButton
              size="sm"
              variant="ghost"
              :loading="busy === `remove:${server.serverId}`"
              @click="remove(server)"
            >
              {{ __t('ui.settings', '删除') }}
            </PButton>
          </div>
        </article>
      </div>
      <div v-else class="empty-state">
        {{ __t('ui.settings', '还没有保存服务器，先从上面添加一台吧。') }}
      </div>
    </section>

    <section class="pixel-card">
      <div class="card-heading">
        <PixelIcon name="cpu" size="md" />
        <div>
          <h2>{{ __t('ui.settings', '能力节点') }}</h2>
          <p>{{ __t('ui.settings', '能力节点主动出站直连当前服务器，无需配置公网入站') }}</p>
        </div>
      </div>
      <div class="invite-form">
        <p>{{ __t('ui.settings', '生成邀请以添加节点。') }}</p>
        <PButton :loading="busy === 'invite'" @click="createInvite">
          {{ __t('ui.settings', '生成一次性配对邀请') }}
        </PButton>
      </div>
      <div v-if="invite" class="invite-ticket">
        <span>PAIRING CODE</span>
        <strong>{{ invite.pairingCode }}</strong>
        <small>
          {{ invite.endpoint }} · {{ new Date(invite.expiresAt).toLocaleString() }}
          {{ __t('ui.settings', '失效') }}
        </small>
      </div>
      <div class="capability-summary">
        <span>{{ __t('ui.settings', '已登记节点') }} {{ capabilities.nodes.length }}</span>
        <span>{{ __t('ui.settings', '在线会话') }} {{ activeSessions.length }}</span>
        <span>
          {{ __t('ui.settings', '可用 Offer') }}
          {{ capabilities.offers.filter((offer) => offer.health === 'available').length }}
        </span>
      </div>
    </section>

    <PDialog
      :model-value="Boolean(confirmServer)"
      :title="__t('ui.settings', '同步全部数据')"
      :message="
        __t('ui.settings', '从“{0}”同步全部用户数据？当前数据会备份，重启服务后生效。', [
          confirmServer?.displayName ?? '',
        ])
      "
      confirm-variant="danger"
      @confirm="sync"
      @cancel="confirmServer = null"
    />
  </div>
</template>

<style scoped>
.distributed-tab {
  min-height: 100%;
  padding: 28px;
  color: var(--ui-text-primary);
  background:
    radial-gradient(
      circle at 90% 5%,
      color-mix(in srgb, var(--ui-accent-purple) 13%, transparent),
      transparent 30%
    ),
    radial-gradient(
      circle at 5% 20%,
      color-mix(in srgb, var(--ui-accent-sky) 12%, transparent),
      transparent 28%
    );
}
.distributed-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  max-width: 1080px;
  margin: 0 auto 22px;
}
.distributed-hero h1,
.card-heading h2 {
  margin: 0;
  font-family: var(--font-pixel);
}
.distributed-hero h1 {
  font-size: 27px;
  letter-spacing: 0.08em;
}
.distributed-hero p,
.card-heading p {
  margin: 5px 0 0;
  color: var(--ui-text-secondary);
}
.hero-icon,
.server-orb {
  display: grid;
  place-items: center;
  color: var(--ui-accent-sky);
  background: var(--dash-panel-soft);
  border: 2px solid var(--ui-border-default);
  box-shadow: 4px 4px 0 color-mix(in srgb, var(--ui-accent-sky) 28%, transparent);
}
.hero-icon {
  width: 54px;
  height: 54px;
}
.mode-badge {
  margin-left: auto;
  padding: 7px 11px;
  border: 1px solid var(--ui-border-default);
  background: var(--dash-panel-soft);
  color: var(--ui-text-secondary);
  font-family: var(--font-pixel);
  font-size: 10px;
}
.mode-badge.local {
  color: var(--ui-accent-purple);
}
.distributed-access {
  max-width: 1080px;
  margin: 0 auto 18px;
}
.pixel-card {
  max-width: 1080px;
  margin: 0 auto 18px;
  padding: 20px;
  border: 2px solid var(--ui-border-default);
  background: var(--dash-panel-elevated);
  box-shadow: 5px 5px 0 color-mix(in srgb, var(--ui-text-primary) 12%, transparent);
}
.card-heading {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 17px;
}
.card-heading h2 {
  font-size: 15px;
}
.card-heading p {
  font-size: 12px;
}
.identity-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.identity-grid > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  background: var(--dash-panel-soft);
  border: 1px solid var(--ui-border-subtle);
}
.identity-grid span,
.server-copy span {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.identity-grid code,
.server-copy code {
  overflow: hidden;
  color: var(--ui-accent-sky);
  font-size: 10px;
  text-overflow: ellipsis;
}
.soft-note,
.probe-result {
  margin-top: 12px;
  padding: 10px 12px;
  color: var(--ui-text-secondary);
  background: color-mix(in srgb, var(--ui-accent-purple) 8%, var(--dash-panel-soft));
  border-left: 3px solid var(--ui-accent-purple);
  font-size: 12px;
}
.sync-state {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 12px;
  padding: 10px 12px;
  color: var(--ui-text-secondary);
  background: var(--dash-panel-soft);
  border: 1px solid var(--ui-border-subtle);
  font-size: 12px;
}
.sync-state span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pending-state {
  color: var(--ui-accent-purple);
  border-color: color-mix(in srgb, var(--ui-accent-purple) 45%, var(--ui-border-subtle));
}
.server-form {
  display: grid;
  grid-template-columns: 2fr 1.3fr 1fr;
  gap: 10px;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  grid-column: 1 / -1;
  gap: 9px;
}
.server-list {
  display: grid;
  gap: 10px;
}
.server-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px;
  background: var(--dash-panel-soft);
  border: 1px solid var(--ui-border-subtle);
}
.server-orb {
  width: 40px;
  height: 40px;
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--ui-accent-sky) 24%, transparent);
}
.server-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.server-copy strong {
  font-family: var(--font-pixel);
  font-size: 12px;
}
.server-actions,
.invite-form {
  display: flex;
  gap: 9px;
  align-items: center;
}
.invite-form p {
  margin: 0;
  flex: 1;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.invite-ticket {
  display: flex;
  margin-top: 14px;
  padding: 15px;
  flex-direction: column;
  align-items: center;
  border: 2px dashed var(--ui-accent-purple);
  background: color-mix(in srgb, var(--ui-accent-purple) 8%, transparent);
}
.invite-ticket span {
  font-family: var(--font-pixel);
  font-size: 9px;
  color: var(--ui-text-tertiary);
}
.invite-ticket strong {
  margin: 7px;
  font-family: var(--font-pixel);
  font-size: 22px;
  letter-spacing: 0.14em;
  color: var(--ui-accent-purple);
}
.invite-ticket small {
  color: var(--ui-text-secondary);
}
.capability-summary {
  display: flex;
  gap: 9px;
  margin-top: 14px;
}
.capability-summary span {
  padding: 7px 10px;
  background: var(--dash-panel-soft);
  border: 1px solid var(--ui-border-subtle);
  font-size: 11px;
}
.empty-state {
  padding: 24px;
  text-align: center;
  color: var(--ui-text-tertiary);
  border: 1px dashed var(--ui-border-default);
}
[data-theme='dark'] .pixel-card {
  box-shadow: 5px 5px 0 rgba(139, 92, 246, 0.15);
}
@media (max-width: 820px) {
  .server-form,
  .identity-grid {
    grid-template-columns: 1fr;
  }
  .server-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .server-actions {
    width: 100%;
  }
  .mode-badge {
    display: none;
  }
}
</style>
