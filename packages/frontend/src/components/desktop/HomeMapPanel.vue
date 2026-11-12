<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import type { HomeMapEntry, HomeScope } from '@infos/shared'
import { t } from '../../i18n'
import { useHomeCollection } from '../../composables/useHomeCollection'
import { MotionCollapse, MotionList, MotionSkeleton } from '../motion'
import { PixelIcon } from '../pixel'

const props = defineProps<{ scope: HomeScope | null; refreshKey?: number }>()
const emit = defineEmits<{ changed: [] }>()
const { items, busy, error, execute, refresh, key } = useHomeCollection<HomeMapEntry>(
  () => props.scope,
  'map',
)
const query = ref(''),
  editing = ref(''),
  selected = shallowRef<HomeMapEntry | null>(null)
const recycled = ref(false)
const adding = ref(false)
const form = reactive({
  kind: 'folder' as HomeMapEntry['kind'],
  name: '',
  location: '',
  purpose: '',
})
const disabled = computed(() => !props.scope || busy.value)
const visible = computed(() =>
  items.value.filter(
    (item) =>
      (item.deletedAt !== undefined) === recycled.value &&
      `${item.name}\n${item.location}\n${item.purpose}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
)
const tr = (source: string) => t('home.map', source)
function clear() {
  editing.value = ''
  adding.value = false
  form.kind = 'folder'
  form.name = ''
  form.location = ''
  form.purpose = ''
}
watch(key, () => {
  clear()
  recycled.value = false
  selected.value = null
  query.value = ''
})
watch(
  () => props.refreshKey,
  () => void refresh(),
)
/** 「添加地点」开关：编辑中点它会放弃编辑、换成空白表单。 */
function toggleAdd() {
  if (adding.value && !editing.value) return clear()
  clear()
  adding.value = true
}
function edit(item: HomeMapEntry) {
  editing.value = item.id
  Object.assign(form, {
    kind: item.kind,
    name: item.name,
    location: item.location,
    purpose: item.purpose,
  })
  selected.value = null
  adding.value = true
}
async function changed() {
  await refresh()
  emit('changed')
}
async function save() {
  if (disabled.value) return
  const result = await execute<HomeMapEntry>({
    action: 'put',
    ...form,
    ...(editing.value ? { id: editing.value } : {}),
  })
  if (result) {
    clear()
    await changed()
  }
}
async function remove(item: HomeMapEntry) {
  const result = await execute({ action: 'delete', id: item.id })
  if (!result) return
  if (editing.value === item.id) clear()
  if (selected.value?.id === item.id) selected.value = null
  await changed()
}
async function restore(item: HomeMapEntry) {
  if (disabled.value) return
  const result = await execute<HomeMapEntry>({
    action: 'restore',
    id: item.id,
  })
  if (result) {
    await changed()
  }
}
function kindName(kind: HomeMapEntry['kind']) {
  return tr({ app: '应用', folder: '文件夹', window: '窗口' }[kind])
}
function kindIcon(kind: HomeMapEntry['kind']): string {
  return { app: 'cpu', folder: 'folder', window: 'desktop' }[kind]
}
</script>

<template>
  <section class="home-panel home-map">
    <header>
      <div class="panel-brand">
        <span class="panel-emblem panel-emblem--map" aria-hidden="true">
          <PixelIcon name="map-pin" size="sm" />
        </span>
        <div>
          <div class="panel-title-row">
            <h4>{{ tr('家的地图') }}</h4>
            <span v-if="scope" class="panel-count">{{ visible.length }}</span>
          </div>
          <p class="home-muted">{{ tr('她记住的常用地方，以及每个地方是做什么的。') }}</p>
        </div>
      </div>
      <div class="home-filters">
        <button
          type="button"
          class="mech-btn mech-btn--split mech-btn--purple"
          :disabled="disabled"
          @click="toggleAdd"
        >
          <span class="mech-btn__chamber" aria-hidden="true">
            <PixelIcon :name="adding && !editing ? 'chevron-up' : 'plus'" size="xs" />
          </span>
          <span class="mech-btn__label">{{ adding && !editing ? tr('收起') : tr('添加地点') }}</span>
        </button>
        <button type="button" class="mech-btn" :disabled="disabled" @click="refresh">
          <PixelIcon name="refresh" size="xs" :animation="busy ? 'spin' : ''" />
          <span>{{ tr('刷新') }}</span>
        </button>
      </div>
    </header>

    <div v-if="!scope" class="home-empty-state">
      <span class="home-empty-state__icon" aria-hidden="true">
        <PixelIcon name="chat" size="sm" />
      </span>
      <p>{{ tr('先在上面选一段对话。') }}</p>
    </div>

    <MotionCollapse :open="adding">
      <form class="map-form" @submit.prevent="save">
        <div class="fields">
          <label>
            {{ tr('类型') }}
            <select v-model="form.kind" :disabled="disabled">
              <option value="app">{{ tr('应用') }}</option>
              <option value="folder">{{ tr('文件夹') }}</option>
              <option value="window">{{ tr('窗口') }}</option>
            </select>
          </label>
          <label>
            {{ tr('名称') }}
            <input v-model="form.name" maxlength="1000" required :disabled="disabled" />
          </label>
        </div>
        <label>
          {{ tr('位置') }}
          <input v-model="form.location" maxlength="1000" required :disabled="disabled" />
        </label>
        <label>
          {{ tr('用途') }}
          <textarea v-model="form.purpose" maxlength="1000" rows="2" :disabled="disabled" />
        </label>
        <p class="home-muted">
          {{ tr('这里只记地方和用途。含密码、联系方式或禁存词的内容不会被记下。') }}
        </p>
        <div class="actions">
          <button
            type="submit"
            class="mech-btn mech-btn--split mech-btn--purple"
            :disabled="disabled || !form.name.trim() || !form.location.trim()"
          >
            <span class="mech-btn__chamber" aria-hidden="true">
              <PixelIcon :name="editing ? 'save' : 'plus'" size="xs" />
            </span>
            <span class="mech-btn__label">{{ editing ? tr('保存修改') : tr('添加地点') }}</span>
          </button>
          <button type="button" class="mech-btn" :disabled="busy" @click="clear">
            <PixelIcon name="close" size="xs" />
            <span>{{ editing ? tr('取消编辑') : tr('取消') }}</span>
          </button>
        </div>
      </form>
    </MotionCollapse>

    <Transition name="motion-rise">
      <p v-if="error" role="alert" class="home-error">{{ error }}</p>
    </Transition>

    <div v-if="scope" class="toolbar">
      <label class="mech-search">
        <PixelIcon name="search" size="xs" class="mech-search__icon" />
        <input
          v-model="query"
          type="search"
          class="search"
          :placeholder="tr('搜索地图')"
          :aria-label="tr('搜索地图')"
        />
        <button
          v-if="query"
          type="button"
          class="mech-search__clear"
          :aria-label="tr('取消')"
          @click="query = ''"
        >
          <PixelIcon name="close" size="xs" />
        </button>
      </label>
      <label class="check" :class="{ 'is-checked': recycled }">
        <input v-model="recycled" type="checkbox" />
        <span class="check-box" aria-hidden="true">
          <PixelIcon v-if="recycled" name="check" size="xs" />
        </span>
        <PixelIcon name="trash" size="xs" />
        <span>{{ tr('看已删除的') }}</span>
      </label>
    </div>

    <MotionSkeleton v-if="scope && busy && !items.length" :rows="2" />
    <div v-else-if="scope && !visible.length" class="home-empty-state">
      <span class="home-empty-state__icon" aria-hidden="true">
        <PixelIcon :name="query ? 'search' : recycled ? 'trash' : 'map-pin'" size="sm" />
      </span>
      <p>
        {{
          query
            ? tr('没有找到相关的地点。')
            : recycled
              ? tr('没有删掉的地点。')
              : tr('还没有记住任何地点。')
        }}
      </p>
    </div>

    <MotionList tag="ul" class="home-list">
      <li v-for="item in visible" :key="item.id" class="item">
        <span class="item-badge item-badge--purple" aria-hidden="true">
          <PixelIcon :name="kindIcon(item.kind)" size="xs" />
        </span>
        <div class="item-name">
          <strong>{{ item.name }}</strong>
          <small class="item-meta">
            <span class="item-chip">{{ kindName(item.kind) }}</span>
            <span>{{ item.location }}</span>
          </small>
        </div>
        <span class="home-row-actions">
          <button
            type="button"
            class="mech-btn mech-btn--sm"
            :disabled="disabled"
            @click="selected = item"
          >
            <PixelIcon name="eye" size="xs" />
            <span>{{ tr('查看') }}</span>
          </button>
          <button
            v-if="!recycled"
            type="button"
            class="mech-btn mech-btn--sm"
            :disabled="disabled"
            @click="edit(item)"
          >
            <PixelIcon name="edit" size="xs" />
            <span>{{ tr('编辑') }}</span>
          </button>
          <button
            v-if="!recycled"
            type="button"
            class="mech-btn mech-btn--sm mech-btn--danger"
            :disabled="disabled"
            @click="remove(item)"
          >
            <PixelIcon name="trash" size="xs" />
            <span>{{ tr('删除') }}</span>
          </button>
          <button
            v-if="recycled"
            type="button"
            class="mech-btn mech-btn--sm"
            :disabled="disabled"
            @click="restore(item)"
          >
            <PixelIcon name="repeat" size="xs" />
            <span>{{ tr('恢复地点') }}</span>
          </button>
        </span>
      </li>
    </MotionList>

    <Transition name="motion-rise">
      <section v-if="selected" class="preview">
        <header>
          <strong>{{ selected.name }}</strong>
          <button type="button" class="mech-btn mech-btn--sm" @click="selected = null">
            <PixelIcon name="close" size="xs" />
            <span>{{ tr('关闭') }}</span>
          </button>
        </header>
        <p>{{ selected.location }}</p>
        <pre>{{ selected.purpose }}</pre>
      </section>
    </Transition>
    <p v-if="recycled" class="home-muted">
      {{ tr('删掉的地点在「改动备份留多久」的期限内都能找回，找回后编号不变。') }}
    </p>
  </section>
</template>

<style scoped src="./home/homePanel.css"></style>
<style scoped src="./homePanels.css"></style>
