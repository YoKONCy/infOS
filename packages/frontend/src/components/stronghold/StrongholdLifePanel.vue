<script setup lang="ts">
import { computed, ref } from 'vue'
import type { StrongholdActivity, StrongholdLifeSnapshot } from '@infos/shared'
import { strongholdApi, type StrongholdActivityCommand } from '../../api/modules/strongholdApi'
import { createClientUuid } from '../../lib/clientPlatform'
import { t } from '../../i18n'

const props = defineProps<{
  roomId: string
  life: StrongholdLifeSnapshot
  agents: Array<{ agentId: string; name: string }>
}>()
const emit = defineEmits<{ refresh: [] }>()
const title = ref('')
const pending = ref(false)
const error = ref('')
const invitees = ref<Record<string, string>>({})
const invitations = computed(() => props.life.invitations.filter((item) =>
  item.recipient.agentId === 'user' || item.inviterId === 'user'))
const names = computed(() => new Map(props.agents.map((agent) => [agent.agentId, agent.name])))
const name = (id: string) => id === 'user' ? t('ui.stronghold', '你') : names.value.get(id) ?? id
const member = (activity: StrongholdActivity) => activity.members.find((item) => item.agentId === 'user')
const participating = (activity: StrongholdActivity) => member(activity)?.status === 'participating'

async function perform(command?: StrongholdActivityCommand): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    const operationId = createClientUuid()
    if (command) await strongholdApi.activity(props.roomId, command, operationId)
    else await strongholdApi.setPresence(props.roomId, !props.life.userPresent, operationId)
    if (command?.action === 'create') title.value = ''
    emit('refresh')
  } catch {
    error.value = t('ui.stronghold', '操作未完成，请刷新现场后重试')
    emit('refresh')
  } finally {
    pending.value = false
  }
}

function change(activity: StrongholdActivity, action: StrongholdActivityCommand['action']): void {
  void perform({ action, id: activity.id, revision: activity.revision })
}
</script>

<template>
  <section class="life-panel" :aria-label="t('ui.stronghold', '共同活动')">
    <header>
      <h3>{{ t('ui.stronghold', '共同活动') }}</h3>
      <button :disabled="pending" @click="perform()">
        {{ t('ui.stronghold', life.userPresent ? '暂时离开' : '进入房间') }}
      </button>
    </header>
    <form class="life-create" @submit.prevent="perform({ action: 'create', title: title.trim() })">
      <input v-model="title" :aria-label="t('ui.stronghold', '想一起做什么？')" :placeholder="t('ui.stronghold', '想一起做什么？')" maxlength="120" />
      <button :disabled="pending || !title.trim()" type="submit">{{ t('ui.stronghold', '发起') }}</button>
    </form>
    <p v-if="error" role="alert" class="life-error">{{ error }}</p>
    <article v-for="invitation in invitations" :key="invitation.id" class="life-invitation">
      <p>{{ t('ui.stronghold', '{0} 邀请 {1} 一起{2}', [name(invitation.inviterId), name(invitation.recipient.agentId), life.activities.find((item) => item.id === invitation.activityId)?.title ?? '']) }}</p>
      <div class="life-actions">
        <template v-if="invitation.recipient.agentId === 'user'">
          <button v-for="response in (['accepted', 'declined', 'later'] as const)" :key="response" :disabled="pending"
            @click="perform({ action: 'respond', id: invitation.id, revision: invitation.revision, response })">
            {{ t('ui.stronghold', { accepted: '一起', declined: '不了', later: '稍后' }[response]) }}
          </button>
        </template>
        <button v-else :disabled="pending" @click="perform({ action: 'respond', id: invitation.id, revision: invitation.revision, response: 'cancelled' })">{{ t('ui.stronghold', '取消邀请') }}</button>
      </div>
    </article>
    <article v-for="activity in life.activities" :key="activity.id" class="life-activity">
      <div class="life-title"><h4>{{ activity.title }}</h4><span v-if="activity.status === 'paused'">{{ t('ui.stronghold', '已暂停') }}</span></div>
      <p v-if="activity.description">{{ activity.description }}</p>
      <p v-if="activity.progress" class="life-progress">{{ activity.progress }}</p>
      <ul>
        <li v-for="person in activity.members.filter((item) => item.status !== 'left')" :key="person.agentId">
          {{ name(person.agentId) }}<span>{{ t('ui.stronghold', { participating: '参与中', observing: '围观中', away: '已离开', left: '已退出' }[person.status]) }}</span>
        </li>
      </ul>
      <div class="life-actions">
        <button v-if="!participating(activity)" :disabled="pending" @click="change(activity, 'join')">{{ t('ui.stronghold', '加入') }}</button>
        <template v-else>
          <button :disabled="pending" @click="change(activity, activity.status === 'paused' ? 'resume' : 'pause')">{{ t('ui.stronghold', activity.status === 'paused' ? '继续' : '暂停') }}</button>
          <button :disabled="pending" @click="change(activity, 'leave')">{{ t('ui.stronghold', '退出') }}</button>
          <button :disabled="pending" @click="change(activity, 'end')">{{ t('ui.stronghold', '结束') }}</button>
        </template>
      </div>
      <form v-if="participating(activity)" class="life-invite" @submit.prevent="perform({ action: 'invite', id: activity.id, revision: activity.revision, agentIds: [invitees[activity.id]!] })">
        <select v-model="invitees[activity.id]" :aria-label="t('ui.stronghold', '邀请伙伴')">
          <option disabled :value="undefined">{{ t('ui.stronghold', '邀请伙伴') }}</option>
          <option v-for="agent in agents.filter((item) => !activity.members.some((entry) => entry.agentId === item.agentId && entry.status === 'participating'))" :key="agent.agentId" :value="agent.agentId">{{ agent.name }}</option>
        </select>
        <button type="submit" :disabled="pending || !invitees[activity.id]">{{ t('ui.stronghold', '邀请') }}</button>
      </form>
    </article>
    <p v-if="!life.activities.length" class="life-empty">{{ t('ui.stronghold', '还没有共同活动') }}</p>
  </section>
</template>

<style scoped>
.life-panel {
  display: grid;
  gap: 12px;
  border-top: 1px solid var(--ui-border-default);
  padding-top: 16px;
  color: var(--ui-text-primary);
}
header, .life-title, .life-actions, .life-create, .life-invite {
  display: flex;
  align-items: center;
  gap: 8px;
}
header, .life-title { justify-content: space-between; }
h3, h4, p { margin: 0; }
h3 { font-size: 13px; }
h4 { font-size: 14px; }
button, input, select {
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-surface-soft);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 7px 9px;
}
button {
  cursor: pointer;
  white-space: nowrap;
}
button:hover:enabled {
  border-color: var(--ui-accent-primary);
  color: var(--ui-accent-primary);
}
button:disabled {
  opacity: .45;
  cursor: default;
}
input, select {
  min-width: 0;
  flex: 1;
  width: 0;
}
.life-activity, .life-invitation {
  display: grid;
  gap: 10px;
  border-left: 2px solid var(--ui-accent-primary);
  background: var(--ui-bg-surface);
  padding: 12px;
}
p, li, .life-title span {
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
li span, .life-empty, .life-title span { color: var(--ui-text-secondary); }
.life-progress {
  border-top: 1px solid var(--ui-border-default);
  padding-top: 8px;
}
.life-error { color: var(--ui-danger); }
.life-actions { flex-wrap: wrap; }
</style>
