import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { KernelCallContext, KernelNodeId } from '@infos/shared'
import type { TtsResult } from '../voice/ttsService'
import type { AssetFileAuthority } from '../../kernel/assetFileAuthority'
import type { KernelAssetRepository } from '../../kernel/kernelAssetRepository'
import type { CapabilityDirectory } from '../../kernel/capabilityDirectory'
import type { CapabilityHandleRegistry } from '../../kernel/capabilityHandleRegistry'
import { LifecycleScope } from '../../kernel/lifecycleScope'

export interface AudioPlaybackReceipt {
  playbackId: string
  assetId: string
  targetNodeId: KernelNodeId
  state: 'completed' | 'cancelled'
}

/** TTS 结果转 Audio Asset，并通过目标 Node 的 audio.output Capability 播放。 */
export class AudioDeliveryService {
  private readonly activePlaybacks = new Map<
    string,
    { playbackId: string; stop(): Promise<void> }
  >()

  constructor(
    private readonly assetRoot: string,
    private readonly assets: AssetFileAuthority,
    private readonly assetRepository: KernelAssetRepository,
    private readonly directory: CapabilityDirectory,
    private readonly handles: CapabilityHandleRegistry,
    private readonly localNodeId: KernelNodeId,
  ) {}

  canDeliverTo(targetNodeId?: KernelNodeId): boolean {
    return this.directory
      .listOffers({
        requirementId: 'audio-output-playback',
        capabilityType: 'audio.output',
        contractVersion: '1.0',
        operations: ['play', 'stop', 'status'],
        required: true,
        binding: 'lazy',
        cardinality: 'one',
      })
      .some(
        (candidate) =>
          candidate.health === 'available' &&
          (!targetNodeId || candidate.placement?.providerNodeId === targetNodeId),
      )
  }

  async deliver(
    audio: TtsResult,
    context: KernelCallContext,
    targetNodeId?: KernelNodeId,
    presentation?: { caption?: string; threadId?: string; isCurrent?: () => boolean },
  ): Promise<AudioPlaybackReceipt> {
    await this.cancel(context.principalId)
    mkdirSync(this.assetRoot, { recursive: true })
    const extension = (
      {
        'audio/ogg': 'ogg',
        'audio/wav': 'wav',
        'audio/flac': 'flac',
        'audio/aac': 'aac',
        'audio/mpeg': 'mp3',
      } as Record<string, string>
    )[audio.mimeType]
    if (!extension) throw new Error('AUDIO_FORMAT_UNSUPPORTED')
    const filePath = path.join(this.assetRoot, `${randomUUID()}.${extension}`)
    writeFileSync(filePath, Buffer.from(audio.audio))
    const asset = this.assets.registerFile({
      ownerPrincipalId: context.principalId,
      filePath,
      kind: 'audio.tts',
      mimeType: audio.mimeType,
      source: 'generated',
      retention: 'temporary',
    })
    await this.assetRepository.save(asset, filePath)
    const playbackId = randomUUID()
    if (presentation?.isCurrent && !presentation.isCurrent()) {
      return {
        playbackId,
        assetId: asset.assetId,
        targetNodeId: targetNodeId ?? this.localNodeId,
        state: 'cancelled',
      }
    }

    const offer = this.directory
      .listOffers({
        requirementId: 'audio-output-playback',
        capabilityType: 'audio.output',
        contractVersion: '1.0',
        operations: ['play', 'stop', 'status'],
        required: true,
        binding: 'lazy',
        cardinality: 'one',
      })
      .find(
        (candidate) =>
          candidate.health === 'available' &&
          (!targetNodeId || candidate.placement?.providerNodeId === targetNodeId),
      )
    if (!offer?.placement?.providerNodeId) {
      throw new Error('AUDIO_OUTPUT_UNAVAILABLE: 没有目标音频输出节点')
    }

    const scope = new LifecycleScope(`audio-playback:${asset.assetId}`)
    try {
      const handle = this.handles.issue({
        subjectId: 'kernel.audio-delivery',
        issuerNodeId: this.localNodeId,
        subjectNodeId: this.localNodeId,
        providerNodeId: offer.placement.providerNodeId,
        revocationEpoch: 1,
        resource: offer.provider,
        operations: ['play', 'stop', 'status'],
        scope: { assetId: asset.assetId, mimeType: asset.mimeType },
        revocable: true,
      })
      scope.defer(() => {
        this.handles.revoke(handle.handleId)
      })
      const port = this.directory.bind({
        requirement: {
          requirementId: 'audio-output-playback',
          capabilityType: 'audio.output',
          contractVersion: '1.0',
          operations: ['play', 'stop', 'status'],
          required: true,
          binding: 'lazy',
          cardinality: 'one',
          placement: { preferredNodeId: offer.placement.providerNodeId },
        },
        handleId: handle.handleId,
        scope,
        principalId: context.principalId,
      })
      const assetHandle = this.assets.issueHandle(
        {
          subjectId: `node:${offer.placement.providerNodeId}`,
          assetRef: asset.ref,
          operations: ['read'],
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          maxUses: 1,
          mimeScope: [asset.mimeType],
          sizeLimit: asset.sizeBytes,
        },
        scope,
      )
      const invokeContext = {
        ...context,
        sourceNodeId: context.sourceNodeId ?? this.localNodeId,
        targetNodeId: offer.placement.providerNodeId,
      }
      this.activePlaybacks.set(context.principalId, {
        playbackId,
        stop: async () => {
          await port.invoke(
            'stop',
            { playbackId },
            { ...invokeContext, idempotencyKey: `audio-stop:${playbackId}` },
          )
        },
      })
      const result = await port.invoke<
        Record<string, unknown>,
        { playbackId: string; state: 'completed' | 'cancelled' }
      >(
        'play',
        {
          playbackId,
          caption: presentation?.caption,
          agentId: context.principalId,
          threadId: presentation?.threadId,
          assetId: asset.assetId,
          mimeType: asset.mimeType,
          sha256: asset.sha256,
          assetUrl: `/api/assets/audio/${assetHandle.handleId}?subject=${encodeURIComponent(assetHandle.subjectId)}`,
        },
        {
          ...invokeContext,
          idempotencyKey: context.idempotencyKey ?? `audio:${asset.assetId}`,
        },
      )
      const active = this.activePlaybacks.get(context.principalId)
      if (active?.playbackId === playbackId) this.activePlaybacks.delete(context.principalId)
      return {
        playbackId: result.playbackId,
        assetId: asset.assetId,
        targetNodeId: offer.placement.providerNodeId,
        state: result.state,
      }
    } finally {
      await scope.dispose()
    }
  }

  async cancel(principalId: string): Promise<boolean> {
    const active = this.activePlaybacks.get(principalId)
    if (!active) return false
    this.activePlaybacks.delete(principalId)
    await active.stop()
    return true
  }
}
