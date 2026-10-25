import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { KernelEnvelope, KernelNodeId } from '@infos/shared'
import type { NodeInvokeRequest } from '@infos/node-sdk'
import { LoopbackWebSocketNodeTransport } from '@infos/node-host'

const children: ChildProcess[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'close')
    if (!child.killed) child.kill('SIGTERM')
    await exited
  }
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    )
})

describe('Arca 跨进程联邦 A6', () => {
  // 子进程启动本身允许等待 10 秒，整体预算还需覆盖握手、两次文档调用及关闭。
  it('独立应用进程应发布 Hello/Offer 并完成 Document Invocation', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'infos-arca-process-'))
    directories.push(dataPath)
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../src/main.ts', import.meta.url)),
        '--loopback-port=0',
        '--port=0',
      ],
      {
        cwd: resolve('.'),
        env: { ...process.env, INFOS_ARCA_DATA_PATH: dataPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(child)
    const output = await waitForOutput(child, /ws:\/\/127\.0\.0\.1:(\d+)/)
    const port = Number(output.match(/ws:\/\/127\.0\.0\.1:(\d+)/)![1])
    const kernelNodeId = 'kernel-process-node' as KernelNodeId
    const transport = new LoopbackWebSocketNodeTransport(kernelNodeId, `ws://127.0.0.1:${port}`)
    const hello = await transport.waitForHello()
    expect(hello.descriptor.facets).toEqual(['application', 'capability', 'storage'])
    expect(hello.application).toEqual(
      expect.objectContaining({
        appId: 'infos.arca',
        state: 'ready',
        endpoints: expect.arrayContaining([
          expect.objectContaining({ endpointId: 'document', kind: 'resource' }),
          expect.objectContaining({ endpointId: 'collaboration', kind: 'task' }),
        ]),
      }),
    )
    expect(hello.offers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityType: 'document.semantic' }),
        expect.objectContaining({ capabilityType: 'model.settings' }),
        expect.objectContaining({ capabilityType: 'application.task' }),
      ]),
    )
    const imported = await transport.request(
      invoke(
        kernelNodeId,
        hello.descriptor.nodeId,
        'document.import_markdown',
        {
          documentId: 'process-document',
          authorityNodeId: hello.descriptor.nodeId,
          ownerPrincipalId: 'owner',
          actorPrincipalId: 'agent:writer',
          title: '跨进程',
          markdown: '# 跨进程标题\n\n正文',
          idempotencyKey: 'process-import',
        },
        'process-import',
      ),
    )
    expect(imported.state).toBe('completed')
    const projection = await transport.request(
      invoke(kernelNodeId, hello.descriptor.nodeId, 'document.project_markdown', {
        documentId: 'process-document',
      }),
    )
    expect(projection.output).toEqual(expect.objectContaining({ content: '# 跨进程标题\n\n正文' }))
    await transport.close()
  }, 30_000)
})

function invoke(
  sourceNodeId: KernelNodeId,
  targetNodeId: KernelNodeId,
  operation: string,
  input: unknown,
  idempotencyKey?: string,
  providerId = 'infos.arca.document-authority',
): NodeInvokeRequest {
  const envelope: KernelEnvelope<{ operation: string; input: unknown }> = {
    protocolVersion: 1,
    messageId: randomUUID(),
    principalId: 'principal:test',
    operation,
    sourceNodeId,
    targetNodeId,
    emittedAt: new Date().toISOString(),
    durability: 'durable',
    idempotencyKey,
    payload: { operation, input },
  }
  return {
    protocolVersion: 1,
    type: 'invoke',
    messageId: randomUUID(),
    invocationId: randomUUID(),
    sourceNodeId,
    targetNodeId,
    providerId,
    envelope,
  }
}

async function waitForOutput(child: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`等待 Arca 启动超时: ${output}`)), 10_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (!pattern.test(output)) return
      clearTimeout(timer)
      resolveOutput(output)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Arca 提前退出: ${code}\n${output}`))
    })
  })
}
