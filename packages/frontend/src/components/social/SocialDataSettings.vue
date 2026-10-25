<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { PixelIcon, PDialog } from '../pixel'
import { useCompositorStore, useNotificationStore } from '../../stores'
import {
  socialApi,
  type SocialContactImpression,
  type SocialClearScope,
  type SocialConnection,
} from '../../api/modules/socialApi'
import { t as __t } from '../../i18n'
import { logger } from '../../lib/logger'
import PrivacyCleanupPanel from '../dashboard/PrivacyCleanupPanel.vue'
import IndexMaintenancePanel from '../dashboard/IndexMaintenancePanel.vue'
const props = withDefaults(
  defineProps<{
    agentId: string
    agentName: string
    section: 'contacts' | 'data'
    platform?: string
    connections: SocialConnection[]
    allowGroups?: boolean
  }>(),
  { platform: '', allowGroups: true },
)
const notification = useNotificationStore()
const compositor = useCompositorStore()
const allContacts = ref<SocialContactImpression[]>([])
const contacts = computed(() =>
  allContacts.value.filter((item) => !props.platform || item.platform === props.platform),
)
const selectedContactId = ref('')
const contactKey = (item: SocialContactImpression) => JSON.stringify([item.platform, item.userId])
const selectedContact = computed(
  () => contacts.value.find((item) => contactKey(item) === selectedContactId.value) ?? null,
)
const dataScope = ref<SocialClearScope>('channel')
const dataChannelType = ref<'private' | 'group'>('private')
const dataPlatform = ref(props.platform || props.connections[0]?.platform || '')
const dataAccountId = ref(
  props.connections.find((c) => c.platform === dataPlatform.value)?.accounts[0] ?? '',
)
const dataTargetId = ref('')
const confirmAgentName = ref('')
const confirmDialogVisible = ref(false)
const dataBusy = ref(false)
const requiresStrongConfirmation = computed(() =>
  ['all_messages', 'long_memory', 'all_social_data'].includes(dataScope.value),
)
let generation = 0
async function loadContacts() {
  const current = ++generation
  if (!props.agentId) return
  try {
    const [response, projection] = await Promise.all([
      socialApi.getContacts(props.agentId),
      socialApi.getProjection(props.agentId),
    ])
    if (current !== generation) return
    allContacts.value = response.data?.contacts ?? []
    if (projection.data) compositor.replaceProjection(projection.data)
    if (!contacts.value.some((item) => contactKey(item) === selectedContactId.value))
      selectedContactId.value = contacts.value[0] ? contactKey(contacts.value[0]) : ''
  } catch (error) {
    logger.error('SocialDataSettings', __t('logs.frontend.settings', '加载联系人印象失败'), error)
  }
}
function openClearDialog(scope: SocialClearScope, targetId = '') {
  if (props.platform && !['channel', 'contact_impression'].includes(scope)) return
  if (scope === 'contact_impression' && selectedContact.value)
    dataPlatform.value = selectedContact.value.platform
  dataScope.value = scope
  dataTargetId.value = targetId
  confirmAgentName.value = ''
  confirmDialogVisible.value = true
}
async function clearSocialData(): Promise<void> {
  const agentId = props.agentId
  if (!agentId) return
  if (dataBusy.value) return
  dataBusy.value = true
  try {
    await socialApi.clearData({
      agentId,
      scope: dataScope.value,
      platform: dataPlatform.value,
      accountId: dataAccountId.value,
      channelType: dataScope.value === 'channel' ? dataChannelType.value : undefined,
      channelId: dataScope.value === 'channel' ? dataTargetId.value.trim() : undefined,
      userId: dataScope.value === 'contact_impression' ? dataTargetId.value.trim() : undefined,
      confirmAgentName: confirmAgentName.value,
    })
    dataTargetId.value = ''
    confirmAgentName.value = ''
    confirmDialogVisible.value = false
    await loadContacts()
  } catch (error) {
    logger.error('SocialTab', __t('logs.frontend.settings', '清理社交数据失败'), error)
    notification.toast((error as Error).message, 'error')
  } finally {
    dataBusy.value = false
  }
}

watch(() => props.agentId, loadContacts)
onMounted(loadContacts)
onUnmounted(() => {
  generation++
})
</script>
<template>
  <section>
    <div v-if="section === 'contacts'" class="sp-contact-master">
      <aside class="sp-contact-sidebar">
        <div class="sp-block-header">
          <PixelIcon name="users" size="xs" />
          <span>{{ __t('ui.settings', '联系人 ·') }} {{ contacts.length }}</span>
        </div>
        <button
          v-for="contact in contacts"
          :key="contactKey(contact)"
          :class="['sp-contact-row', selectedContactId === contactKey(contact) && 'is-active']"
          @click="selectedContactId = contactKey(contact)"
        >
          <span class="sp-contact-avatar">
            {{ (contact.displayName || contact.userId).slice(0, 1) }}
          </span>
          <span>
            <strong>{{ contact.displayName || contact.userId }}</strong>
            <small>{{ contact.platform }} · {{ contact.userId }}</small>
          </span>
        </button>
        <div v-if="!contacts.length" class="sp-empty">
          {{ __t('ui.settings', '还没有保存印象') }}
        </div>
      </aside>
      <section class="sp-contact-detail">
        <template v-if="selectedContact">
          <div class="sp-contact-head">
            <div>
              <small>{{ __t('ui.settings', '联系人') }}</small>
              <h3>{{ selectedContact.displayName || selectedContact.userId }}</h3>
              <span>{{ selectedContact.platform }} · {{ selectedContact.userId }}</span>
            </div>
            <button
              class="sp-soft-action sp-soft-danger"
              @click="openClearDialog('contact_impression', selectedContact.userId)"
            >
              <PixelIcon name="trash" size="xs" />
              {{ __t('ui.settings', '清除印象') }}
            </button>
          </div>
          <div v-if="selectedContact.identity" class="sp-impression-box">
            <span>{{ __t('ui.settings', '身份信息') }}</span>
            <p>{{ selectedContact.identity }}</p>
          </div>
          <div class="sp-impression-box">
            <span>{{ __t('ui.settings', '当前印象') }}</span>
            <p>{{ selectedContact.impression }}</p>
          </div>
          <dl class="sp-contact-meta">
            <div>
              <dt>{{ __t('ui.settings', '更新时间') }}</dt>
              <dd>{{ selectedContact.updatedAt }}</dd>
            </div>
            <div>
              <dt>{{ __t('ui.settings', '来源频道') }}</dt>
              <dd>{{ selectedContact.sourceChannelId || __t('ui.settings', '未记录') }}</dd>
            </div>
          </dl>
        </template>
        <div v-else class="sp-empty sp-empty-detail">
          {{ __t('ui.settings', '从左侧选择一位联系人吧') }}
        </div>
      </section>
    </div>
    <div v-else-if="section === 'data'" class="sp-danger-zone">
      <IndexMaintenancePanel v-if="!platform" :social-agent-id="agentId" />
      <PrivacyCleanupPanel v-if="!platform" />
      <header class="sp-danger-head">
        <div>
          <span>{{ __t('ui.settings', '数据管理') }}</span>
          <h3>
            {{
              platform
                ? __t('ui.social', '当前平台的会话数据')
                : __t('ui.settings', '当前 Agent 的社交数据')
            }}
          </h3>
          <p>{{ __t('ui.settings', '选择要清理的数据。') }}</p>
        </div>
        <PixelIcon name="alert" size="md" />
      </header>
      <div class="sp-danger-list">
        <article>
          <div>
            <strong>{{ __t('ui.settings', '指定会话记录') }}</strong>
            <span>
              {{
                allowGroups
                  ? __t('ui.settings', '删除某位用户的私聊，或某个群的全部聊天记录。')
                  : __t('ui.social', '删除当前平台指定私聊的聊天记录。')
              }}
            </span>
          </div>
          <div class="sp-inline-target">
            <select
              v-if="!platform"
              v-model="dataPlatform"
              class="sp-pixel-select"
              :aria-label="__t('ui.settings', '平台')"
              @change="
                dataAccountId =
                  connections.find((item) => item.platform === dataPlatform)?.accounts[0] ?? ''
              "
            >
              <option v-for="item in connections" :key="item.id" :value="item.platform">
                {{ item.name }}
              </option>
            </select>
            <input
              v-model="dataAccountId"
              class="sp-pixel-input"
              :placeholder="__t('ui.settings', '平台账号标识')"
            />
            <select v-model="dataChannelType" class="sp-pixel-select">
              <option value="private">{{ __t('ui.settings', '私聊') }}</option>
              <option v-if="allowGroups" value="group">{{ __t('ui.settings', '群聊') }}</option>
            </select>
            <input
              v-model="dataTargetId"
              class="sp-pixel-input"
              :placeholder="__t('ui.settings', '用户或会话标识')"
            />
            <button class="sp-soft-action" @click="openClearDialog('channel', dataTargetId)">
              {{ __t('ui.settings', '选择清理') }}
            </button>
          </div>
        </article>
        <article v-if="!platform">
          <div>
            <strong>{{ __t('ui.settings', '全部聊天记录') }}</strong>
            <span>{{ __t('ui.settings', '保留联系人印象和社交长记忆，只删除消息流水。') }}</span>
          </div>
          <button class="sp-soft-action sp-soft-danger" @click="openClearDialog('all_messages')">
            {{ __t('ui.settings', '清除消息') }}
          </button>
        </article>
        <article v-if="!platform">
          <div>
            <strong>{{ __t('ui.settings', '全部社交长记忆') }}</strong>
            <span>{{ __t('ui.settings', '删除社交长记忆，保留聊天和联系人印象。') }}</span>
          </div>
          <button class="sp-soft-action sp-soft-danger" @click="openClearDialog('long_memory')">
            {{ __t('ui.settings', '清空长记忆') }}
          </button>
        </article>
        <article v-if="!platform" class="is-critical">
          <div>
            <strong>{{ __t('ui.settings', '彻底清除社交数据') }}</strong>
            <span>{{ __t('ui.settings', '同时删除消息、联系人印象和社交长记忆。') }}</span>
          </div>
          <button class="sp-soft-action sp-soft-danger" @click="openClearDialog('all_social_data')">
            {{ __t('ui.settings', '彻底清除') }}
          </button>
        </article>
      </div>
    </div>
    <PDialog
      v-model="confirmDialogVisible"
      :title="__t('ui.settings', '确认清理社交数据')"
      :message="
        requiresStrongConfirmation
          ? __t('ui.settings', '此操作影响社交角色 {0}，请输入角色名后继续。', [agentName])
          : __t('ui.settings', '此操作不可撤销，请确认目标无误。')
      "
      :mode="requiresStrongConfirmation ? 'prompt' : 'confirm'"
      :placeholder="requiresStrongConfirmation ? agentName : ''"
      :confirm-text="__t('ui.settings', '确认清理')"
      confirm-variant="danger"
      :loading="dataBusy"
      :auto-close="false"
      @confirm="
        (value?: string) => {
          if (value !== undefined) confirmAgentName = value
          clearSocialData()
        }
      "
    />
  </section>
</template>
<style scoped src="./socialPanel.css"></style>
<style scoped>
.sp-contact-master,
.sp-danger-zone {
  margin: 0 0 16px;
}
.sp-inline-target {
  flex-wrap: wrap;
}
@media (max-width: 650px) {
  .sp-contact-master {
    grid-template-columns: 1fr;
  }
  .sp-contact-sidebar {
    max-height: 240px;
    overflow-y: auto;
    border-right: 0;
    border-bottom: 1px solid var(--sp-border);
  }
  .sp-contact-detail {
    padding: 16px;
  }
}
</style>
