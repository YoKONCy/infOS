import type { CreationPreferences, ReferenceUse } from '../types'
import { referencePurposes } from '../../../src/creativeInputs'

/** 本地草稿可能不完整，不能让损坏的创作参数阻断整个画布挂载。 */
export function normalizeCreationPreferences(value: unknown): CreationPreferences {
  const record = (input: unknown): input is Record<string, unknown> =>
    Boolean(input && typeof input === 'object' && !Array.isArray(input))
  const source = record(value) ? value : {}
  return {
    stepId: typeof source.stepId === 'string' ? source.stepId : '',
    text: typeof source.text === 'string' ? source.text : '',
    referenceUsesByStep: Object.fromEntries(
      Object.entries(record(source.referenceUsesByStep) ? source.referenceUsesByStep : {}).flatMap(
        ([stepId, entries]) =>
          Array.isArray(entries)
            ? [
                [
                  stepId,
                  entries.filter(
                    (entry): entry is ReferenceUse =>
                      record(entry) &&
                      typeof entry.field === 'string' &&
                      typeof entry.assetId === 'string' &&
                      referencePurposes.includes(entry.purpose as ReferenceUse['purpose']),
                  ),
                ],
              ]
            : [],
      ),
    ),
    inputsByStep: Object.fromEntries(
      Object.entries(record(source.inputsByStep) ? source.inputsByStep : {}).filter(
        (entry): entry is [string, Record<string, unknown>] => record(entry[1]),
      ),
    ),
  }
}
