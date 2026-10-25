// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskDetail } from '../../src/composables/main/useTaskDetail'
import { toolTaskTarget } from '../../src/components/tools/toolTaskTarget'
import { taskElapsed } from '../../src/components/taskCenter/taskPresentation'
import type { BackgroundTaskInfo } from '../../src/api/modules/backgroundTasksApi'

const api = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock('../../src/api/modules/backgroundTasksApi', () => ({ backgroundTasksApi: api }))
const task = (id: string, revision = 1) =>
  ({
    id,
    revision,
    status: 'running',
    createdAt: '2026-01-01 10:00:00',
    startedAt: null,
    completedAt: null,
  }) as BackgroundTaskInfo
let wrapper: ReturnType<typeof mount>
function setup() {
  let detail!: ReturnType<typeof useTaskDetail>
  wrapper = mount(
    defineComponent({
      setup() {
        detail = useTaskDetail()
        return () => null
      },
    }),
  )
  return detail
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
})
afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
})

describe('任务详情导航与刷新', () => {
  it('关闭详情后，迟到的请求不能重新打开面板', async () => {
    let resolve!: (value: unknown) => void
    api.detail.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const detail = setup()
    const opening = detail.open('a')
    detail.close()
    resolve({ data: task('a') })
    await opening
    expect(detail.task.value).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.detail).toHaveBeenCalledTimes(1)
  })
  it('切换任务时忽略旧响应，并定时刷新当前任务', async () => {
    let resolve!: (value: unknown) => void
    api.detail.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    api.detail.mockResolvedValueOnce({ data: task('b') })
    const detail = setup()
    const old = detail.open('a')
    await detail.open('b')
    resolve({ data: task('a') })
    await old
    expect(detail.task.value?.id).toBe('b')
    api.detail.mockResolvedValueOnce({
      data: { ...task('b', 2), status: 'completed', result: '报告完成' },
    })
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(detail.task.value?.result).toBe('报告完成')
  })
  it('刷新失败保留快照，旧版本响应不覆盖新状态', async () => {
    api.detail.mockRejectedValueOnce(new Error('连接中断'))
    const detail = setup()
    await detail.open(task('a', 3))
    expect(detail.task.value?.revision).toBe(3)
    expect(detail.error.value).toBe('连接中断')
    api.detail.mockResolvedValueOnce({ data: task('a', 2) })
    await detail.refresh()
    expect(detail.task.value?.revision).toBe(3)
  })
})

describe('结构化任务入口', () => {
  it('不从普通工具、错误、列表或未完成结果推测任务 ID', () => {
    for (const tool of [
      { name: 'terminal_execute', args: '{}', result: '{"taskId":"spoof"}' },
      { name: 'manage_task', args: '{}', result: '{"items":[{"id":"a"}]}' },
      { name: 'manage_task', args: '{}', result: '{"id":"a","success":false}' },
      { name: 'manage_task', args: '{}', result: '{"id":"a"}', interrupted: true },
      { name: 'manage_task', args: '{}', result: 'invalid' },
    ])
      expect(toolTaskTarget(tool)).toBeNull()
  })
  it('本地时间的耗时不经过 UTC 字符串二次解析', () => {
    const now = new Date('2026-01-01T10:01:00').getTime()
    expect(taskElapsed(task('a'), now)).toBe('1 分 0 秒')
  })
})
