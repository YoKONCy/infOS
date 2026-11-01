<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import Icon from './PictoriaIcon.vue'
import type { CanvasProposal } from '../../../src/canvasDocument'
import type { Project, Step } from '../types'
const props = defineProps<{ proposal: CanvasProposal; project: Project; steps: Step[] }>()
const label = (source: string) => t('apps.pictoria.studio', source)
const rows = computed(() => {
  const names = new Map(
    props.project.items.map((item) => [
      item.id,
      item.content.name || item.content.text?.slice(0, 32),
    ]),
  )
  for (const operation of props.proposal.operations) {
    if (operation.type === 'group') names.set(operation.id, operation.name)
    if (operation.type === 'note') names.set(operation.id, operation.text.slice(0, 32))
    if (operation.type === 'draft')
      names.set(operation.id, props.steps.find((step) => step.id === operation.stepId)?.name)
  }
  const name = (id: string) => names.get(id) || label('未命名节点')
  const valueCaption = (value: unknown): string => {
    if (
      value &&
      typeof value === 'object' &&
      'assetId' in value &&
      typeof value.assetId === 'string'
    )
      return (
        props.project.items.find((item) => item.content.assetId === value.assetId)?.content.name ||
        label('原始素材')
      )
    if (Array.isArray(value)) return value.map(valueCaption).join(' · ')
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  }
  return props.proposal.operations.map((operation) => {
    switch (operation.type) {
      case 'update_draft':
        return {
          icon: 'edit',
          title: label('修改草稿输入'),
          detail: `${name(operation.id)}\n${Object.entries(operation.inputs)
            .map(([field, value]) => `${field}: ${valueCaption(value)}`)
            .join('\n')}`,
        }
      case 'note':
        return { icon: 'note', title: label('添加便签'), detail: operation.text }
      case 'move':
        return {
          icon: 'hand',
          title: label('移动节点'),
          detail: `${name(operation.id)} · ${Math.round(operation.x)}, ${Math.round(operation.y)}`,
        }
      case 'resize':
        return {
          icon: 'fit',
          title: label('调整尺寸'),
          detail: `${name(operation.id)} · ${operation.width} × ${operation.height}`,
        }
      case 'rename':
        return {
          icon: 'edit',
          title: label('重命名节点'),
          detail: `${name(operation.id)} → ${operation.name}`,
        }
      case 'remove':
        return {
          icon: 'trash',
          title: label('删除节点'),
          detail: operation.ids.map(name).join(' · '),
        }
      case 'group':
        return {
          icon: 'group',
          title: label('创建分组'),
          detail: `${operation.name} · ${t('apps.pictoria.studio', '{0} 个节点', [operation.ids.length])}\n${operation.ids.map(name).join(' · ')}`,
        }
      case 'ungroup':
        return { icon: 'ungroup', title: label('解散分组'), detail: name(operation.id) }
      case 'select':
        return {
          icon: 'select',
          title: label('选择节点'),
          detail: operation.ids.map(name).join(' · '),
        }
      case 'viewport':
        return {
          icon: 'map',
          title: label('调整视图'),
          detail: `${Math.round(operation.x)}, ${Math.round(operation.y)} · ${Math.round(operation.scale * 100)}%`,
        }
      case 'connect':
        return {
          icon: 'link',
          title: label('连接节点'),
          detail: `${name(operation.source)} → ${name(operation.target)} · ${props.project.items.find((item) => item.id === operation.target)?.content.step?.inputSchema.properties?.[operation.field]?.title || operation.field}`,
        }
      case 'disconnect': {
        const edge = props.project.edges?.find((edge) => edge.id === operation.id)
        return {
          icon: 'link',
          title: label('断开连线'),
          detail: edge ? `${name(edge.source)} → ${name(edge.target)}` : '',
        }
      }
      case 'draft': {
        const step = props.steps.find((step) => step.id === operation.stepId)
        return {
          icon: 'sparkle',
          title: label('建立编辑草稿'),
          detail: [
            step?.name || label('创作步骤'),
            ...Object.entries(operation.inputs).map(
              ([key, value]) =>
                `${step?.inputSchema.properties?.[key]?.title || key}: ${valueCaption(value)}`,
            ),
          ].join('\n'),
        }
      }
    }
  })
})
</script>
<template>
  <details v-if="rows.length" class="studio-proposal">
    <summary>
      <Icon name="layers" :size="14" />
      <span>{{ label('查看修改方案') }}</span>
      <small>{{ rows.length }}</small>
      <Icon class="proposal-chevron" name="down" :size="12" />
    </summary>
    <div class="studio-proposal-list">
      <div
        v-for="(row, index) in rows"
        :key="index"
        class="studio-proposal-row"
        :class="{ 'is-removal': row.icon === 'trash' }"
      >
        <Icon :name="row.icon" :size="15" />
        <div>
          <strong>{{ row.title }}</strong>
          <span v-if="row.detail">{{ row.detail }}</span>
        </div>
      </div>
    </div>
  </details>
</template>
