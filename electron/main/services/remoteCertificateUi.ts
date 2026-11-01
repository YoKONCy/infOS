import { app, dialog, session } from 'electron'
import { X509Certificate } from 'node:crypto'
import { clientConnection } from './clientConnection'
import {
  certificateFingerprint,
  configureCertificateConfirmation,
  trustedCertificateFor,
} from './remoteCertificates'
import { t } from '../utils/i18n'

const scope = 'electron.ui.connection'

/** 只为当前远程服务器主机接受已确认的叶证书，其他站点沿用 Chromium 验证。 */
export function installRemoteCertificateTrust(): void {
  const install = (target: Electron.Session) =>
    target.setCertificateVerifyProc((request, callback) => {
      const profile = clientConnection().current
      // Chromium 页面只访问业务入口；独立能力端口由 Node WSS 按完整入口校验。
      const selected =
        profile?.mode === 'remote' && profile.origin
          ? trustedCertificateFor(profile.origin, profile.certificates)
          : undefined
      const certificates = selected ? [selected] : []
      const candidates = certificates.filter(
        (item) =>
          new URL(item.origin).hostname.replace(/^\[|\]$/g, '') ===
          request.hostname.replace(/^\[|\]$/g, ''),
      )
      if (!candidates.length) {
        callback(-3)
        return
      }
      try {
        const certificate = new X509Certificate(request.certificate.data)
        callback(
          candidates.some(
            (item) => item.fingerprint === certificateFingerprint(request.certificate.data),
          ) &&
            Date.now() >= Date.parse(certificate.validFrom) &&
            Date.now() <= Date.parse(certificate.validTo)
            ? 0
            : -2,
        )
      } catch {
        callback(-2)
      }
    })
  install(session.defaultSession)
  app.on('session-created', install)
  configureCertificateConfirmation(async (certificate, signal) => {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: t(scope, certificate.previousFingerprint ? '服务器证书已变化' : '确认服务器证书'),
      message: t(
        scope,
        certificate.previousFingerprint
          ? '服务器 {0} 的证书与上次不同，请核对后重新确认。'
          : '服务器 {0} 使用未受系统信任的证书。确认指纹后，可仅为此服务器保存信任。',
        [certificate.origin],
      ),
      detail: t(
        scope,
        'SHA-256 指纹：\n{0}\n\n上次指纹：\n{1}\n\n主题：{2}\n签发者：{3}\n有效期：{4} — {5}\n\n请通过服务器管理端核对指纹；无法确认时请选择取消。',
        [
          certificate.fingerprint,
          certificate.previousFingerprint ?? t(scope, '首次连接'),
          certificate.subject,
          certificate.issuer,
          certificate.validFrom,
          certificate.validTo,
        ],
      ),
      buttons: [t(scope, '取消'), t(scope, '信任此证书并连接')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal,
    })
    return result.response === 1
  })
}

/** 在展示边界分类，不用本地化文案判断连接状态，也不输出令牌。 */
export function connectionErrorSource(error: unknown): string {
  const codes: string[] = []
  let value: unknown = error
  for (let index = 0; index < 6 && value && typeof value === 'object'; index++) {
    const item = value as { code?: string; message?: string; name?: string; cause?: unknown }
    codes.push(item.code ?? '', item.message ?? '', item.name ?? '')
    value = item.cause
  }
  const code = codes.join(' ')
  if (/CONNECTION_ENCRYPTION_UNAVAILABLE/.test(code))
    return '无法安全保存凭据，请检查系统密钥服务。'
  if (/REMOTE_AUTH_FAILED/.test(code)) return '服务器拒绝访问，请检查访问令牌及权限。'
  if (/REMOTE_IDENTITY_CHANGED/.test(code))
    return '服务器身份与上次不同，请确认地址及服务端数据是否变化。'
  if (/REMOTE_CERTIFICATE_REJECTED/.test(code)) return '已取消证书信任，连接配置未保存。'
  if (/REMOTE_CERTIFICATE_CHANGED/.test(code))
    return '服务器证书已变化，请重新打开连接设置并核对新指纹。'
  if (/EXPIRED|NOT_YET_VALID/.test(code)) return '服务器证书不在有效期内，请检查证书及设备时间。'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))
    return '服务器证书未受信任，请打开连接设置并确认指纹。'
  if (/CONNECTION_(URL_INVALID|TLS_REQUIRED)/.test(code))
    return '连接地址无效，请使用完整的 HTTP／HTTPS 地址，并为 HTTPS 配置 WSS 能力通道。'
  if (/CONNECTION_TOKEN_REQUIRED/.test(code)) return '请填写服务器访问令牌。'
  if (/REMOTE_SERVER_FAILED|REMOTE_REDIRECT_REJECTED|SyntaxError/.test(code))
    return '服务器响应异常，请检查反向代理、接口地址及服务状态。'
  if (/Timeout|ETIMEDOUT/.test(code)) return '连接超时，请检查服务器地址、端口及防火墙。'
  if (/ECONNREFUSED/.test(code)) return '服务器拒绝连接，请检查服务是否启动及端口映射。'
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return '无法解析服务器地址，请检查域名及网络。'
  return '连接失败，请检查地址、令牌和网络。'
}

export function localizedConnectionError(error: unknown): string {
  return t(scope, connectionErrorSource(error))
}
