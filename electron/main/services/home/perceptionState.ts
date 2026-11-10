import { homeSettings } from './homeSettings'
import { PerceptionControl } from './perceptionControl'

export const perceptionControl = new PerceptionControl(
  () => homeSettings.section('perception'),
  (patch) => { homeSettings.update('perception', patch) },
)
