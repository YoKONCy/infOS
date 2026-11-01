import type { ReferencePurpose, ReferenceUse } from '../types'
import { referencePurposes } from '../../../src/creativeInputs'
export const referencePurposeNames: Record<ReferencePurpose, string> = {
  subject: '主体身份',
  style: '视觉风格',
  composition: '构图',
  scene: '场景',
  costume: '服装',
}
export function setReferenceUse(
  uses: readonly ReferenceUse[],
  field: string,
  assetId: string,
  purpose: string,
): ReferenceUse[] {
  const next = uses.filter((entry) => entry.field !== field || entry.assetId !== assetId)
  if (referencePurposes.includes(purpose as ReferencePurpose))
    next.push({ field, assetId, purpose: purpose as ReferencePurpose })
  return next
}
