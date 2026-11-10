import { onMounted, onScopeDispose, watch, type Ref } from 'vue'
import { listen } from '../../utils/ipcAdapter'
import { HOME_PET_CHANNEL, isHomePetSignal, type HomePetPreset } from '@infos/shared/homePet'

/** 短动作叠在模型容器上，结束即还原，不覆盖模型自己的持续动画与口型。 */
const PRESETS: Record<HomePetPreset, Keyframe[]> = {
  greeting: [{ rotate: '0deg' }, { rotate: '-3deg' }, { rotate: '3deg' }, { rotate: '0deg' }],
  notice: [{ translate: '0 0' }, { translate: '0 -7px' }, { translate: '0 0' }],
  acknowledge: [
    { scale: '1 1' },
    { scale: '1 .96', translate: '0 3px' },
    { scale: '1 1', translate: '0 0' },
  ],
}

export function useHomeCardReaction(options: {
  agentId: Ref<string>
  visible: Ref<boolean>
  busy: () => boolean
  element: () => HTMLElement | undefined
}): void {
  let animation: Animation | undefined
  let cancel = () => {}
  let disposed = false
  const stop = () => {
    animation?.cancel()
    animation = undefined
  }
  onMounted(async () => {
    const remove = await listen(HOME_PET_CHANNEL, (value) => {
      if (
        !isHomePetSignal(value) ||
        value.agentId !== options.agentId.value ||
        !options.visible.value ||
        options.busy() ||
        document.hidden ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
        return
      const element = options.element()
      if (!element?.animate) return
      stop()
      animation = element.animate(PRESETS[value.preset], {
        duration: 650,
        easing: 'ease-in-out',
        iterations: 1,
      })
    })
    if (disposed) remove()
    else cancel = remove
  })
  watch([options.agentId, options.visible], stop)
  onScopeDispose(() => {
    disposed = true
    cancel()
    stop()
  })
}
