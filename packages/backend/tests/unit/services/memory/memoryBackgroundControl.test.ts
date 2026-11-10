import { describe, expect, it } from 'vitest'
import { MemoryBackgroundControl } from '@infos/backend/services/memory/memoryBackgroundControl'
import { MEMORY_BACKGROUND_ENABLED_KEY, memoryBackgroundAgentKey, isMemoryBackgroundSwitchKey } from '@infos/shared'

describe('长记忆后台开关', () => {
  it('只关闭指定角色，重新开启不会复活她的旧任务，也不影响其他角色', () => {
    const policy = new MemoryBackgroundControl()
    const pero = policy.agentSignal('pero')
    const nana = policy.agentSignal('nana')
    policy.setAgentEnabled('pero', false)
    expect(policy.isAgentEnabled('pero')).toBe(false)
    expect(policy.isAgentEnabled('nana')).toBe(true)
    expect(pero.aborted).toBe(true)
    expect(nana.aborted).toBe(false)
    policy.setAgentEnabled('pero', true)
    expect(policy.agentSignal('pero').aborted).toBe(false)
    expect(pero.aborted).toBe(true)
  })

  it('未配置角色保持默认开启，总开关关闭后所有角色暂停，重载保留角色选择', () => {
    const policy = new MemoryBackgroundControl()
    const settings = [{ key: memoryBackgroundAgentKey('pero'), value: 'false' }]
    policy.configure(settings)
    expect(policy.isAgentEnabled('pero')).toBe(false)
    expect(policy.isAgentEnabled('nana')).toBe(true)
    policy.configure([...settings, { key: MEMORY_BACKGROUND_ENABLED_KEY, value: 'false' }])
    expect(policy.isAgentEnabled('nana')).toBe(false)
    policy.configure(settings)
    expect(policy.isAgentEnabled('pero')).toBe(false)
    expect(policy.isAgentEnabled('nana')).toBe(true)
    policy.configure([])
    expect(policy.isAgentEnabled('pero')).toBe(true)
  })

  it('角色开关按独立配置键保存，不将其他记忆参数识别为布尔开关', () => {
    expect(memoryBackgroundAgentKey('pero')).toBe('memory.background.agent.pero.enabled')
    expect(isMemoryBackgroundSwitchKey('memory.background.agent.pero.enabled')).toBe(true)
    expect(isMemoryBackgroundSwitchKey('memory.background.agent.nana.enabled')).toBe(true)
    expect(isMemoryBackgroundSwitchKey('memory.background.interval')).toBe(false)
  })

  it('关闭会中止旧信号，重新开启不能复活旧任务', () => {
    const policy = new MemoryBackgroundControl()
    const original = policy.signal
    policy.setEnabled(false)
    expect(policy.enabled).toBe(false)
    expect(original.aborted).toBe(true)
    policy.setEnabled(true)
    expect(policy.enabled).toBe(true)
    expect(policy.signal).not.toBe(original)
    expect(policy.signal.aborted).toBe(false)
    expect(original.aborted).toBe(true)
  })

  it('重复保存相同值不会打断正在运行的任务', () => {
    const policy = new MemoryBackgroundControl()
    const original = policy.signal
    policy.setEnabled(true)
    expect(policy.signal).toBe(original)
    expect(original.aborted).toBe(false)
  })
})
