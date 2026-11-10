import { sameSignature, type SettingsSigner } from './settingsSigner'

interface AcceptedSettings<T = unknown> {
  revision: number
  payload: string
  value: T
  confirmed: boolean
}

/** 主进程的版本水位及最后受信内容；历史签名不能自行推进或回退当前许可。 */
const accepted = new Map<string, AcceptedSettings>()

export function lastAccepted<T>(key: string): AcceptedSettings<T> | undefined {
  return accepted.get(key) as AcceptedSettings<T> | undefined
}

export function versionedPayload(domain: string, revision: number, value: unknown): string {
  return JSON.stringify({ domain, revision, value })
}

export function verifyVersioned(
  key: string,
  domain: string,
  revision: unknown,
  value: unknown,
  signature: unknown,
  signer: SettingsSigner,
): boolean {
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) return false
  const payload = versionedPayload(domain, revision as number, value)
  const previous = accepted.get(key)
  // 已有水位时只接受完全相同的快照；新版本只能由本进程确认后的 persist 推进。
  if (previous && (revision !== previous.revision || payload !== previous.payload)) return false
  return sameSignature(signature, signer.sign(payload))
}

export function rememberAccepted(
  key: string,
  domain: string,
  revision: number,
  value: unknown,
  confirmed = true,
): void {
  const payload = versionedPayload(domain, revision, value)
  const previous = accepted.get(key)
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (previous &&
      (revision < previous.revision ||
        (revision === previous.revision && payload !== previous.payload)))
  )
    throw new Error('SETTINGS_ROLLBACK')
  accepted.set(key, {
    revision,
    payload,
    value: structuredClone(value),
    confirmed: confirmed || !!(previous?.revision === revision && previous.confirmed),
  })
}
