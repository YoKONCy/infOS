<script setup lang="ts">
import { computed, onActivated, ref, toRef, watch } from 'vue'
import { useThreadPlan } from '../../composables/chat/useThreadPlan'
import { useMainNav } from '../../composables/main/useMainNav'
import { requestTaskNavigation } from '../../composables/main/useTaskNavigation'
import TodoPlanCard from './TodoPlanCard.vue'

const props = defineProps<{ threadId: string; agentId: string }>()
const { plan } = useThreadPlan(toRef(props, 'threadId'), toRef(props, 'agentId'))
const { setTab } = useMainNav()
const dismissed = ref('')
onActivated(() => {
  const id = plan.value?.id
  try {
    dismissed.value = id && localStorage.getItem(`infos:todo-dismissed:${id}`) === '1' ? id : ''
  } catch {
    dismissed.value = ''
  }
})
watch(
  () => plan.value?.id,
  (id) => {
    try {
      dismissed.value = id && localStorage.getItem(`infos:todo-dismissed:${id}`) === '1' ? id : ''
    } catch {
      dismissed.value = ''
    }
  },
)
const visible = computed(
  () => plan.value && (plan.value.status !== 'completed' || dismissed.value !== plan.value.id),
)
function dismiss() {
  if (!plan.value) return
  dismissed.value = plan.value.id
  try {
    localStorage.setItem(`infos:todo-dismissed:${plan.value.id}`, '1')
  } catch {
    /* 本次关闭仍生效。 */
  }
}
function openTask(id: string) {
  requestTaskNavigation(id)
  setTab('tasks')
}
</script>

<template>
  <Transition name="todo-dock" mode="out-in">
    <div v-if="visible && plan" :key="plan.id" class="todo-dock">
      <div class="todo-dock__clip">
        <TodoPlanCard :plan="plan" @dismiss="dismiss" @open-task="openTask" />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.todo-dock {
  display: grid;
  grid-template-rows: 1fr;
  width: min(400px, 100%);
  min-width: 0;
  margin-bottom: 9px;
  transform-origin: left bottom;
}
.todo-dock__clip {
  min-height: 0;
  overflow: hidden;
  padding: 2px 3px 3px 1px;
}
.todo-dock-enter-active,
.todo-dock-leave-active {
  transition:
    grid-template-rows 300ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 200ms,
    transform 300ms cubic-bezier(0.22, 1, 0.36, 1),
    margin-bottom 280ms;
}
.todo-dock-leave-active {
  pointer-events: none;
}
.todo-dock-enter-from,
.todo-dock-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
  margin-bottom: 0;
  transform: translateY(5px) scale(0.98);
}
@media (prefers-reduced-motion: reduce) {
  .todo-dock {
    transition: none !important;
  }
}
</style>
