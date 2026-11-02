export type DownloadPlatform = 'windows' | 'android'

interface ReleaseAsset {
  name: string
  browser_download_url: string
  state: string
}

const repositories: Record<DownloadPlatform, string> = {
  windows: 'YoKONCy/infOS',
  android: 'YoKONCy/Peroperochat',
}

/** 从最新正式版中选择对应的安装包，版本号由 Release 决定。 */
export async function latestInstaller(platform: DownloadPlatform): Promise<string> {
  const repository = repositories[platform]
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error('获取发布信息失败')

  const release: { assets?: ReleaseAsset[] } = await response.json()
  const assets = Array.isArray(release.assets)
    ? release.assets.filter((asset) => asset.state === 'uploaded' && typeof asset.name === 'string')
    : []
  let selected: ReleaseAsset | undefined
  if (platform === 'windows') {
    const installers = assets.filter((asset) => /setup.*\.exe$/i.test(asset.name))
    selected = installers.find((asset) => /(?:x64|amd64)/i.test(asset.name)) ?? installers[0]
  } else {
    const installers = assets.filter((asset) => /\.apk$/i.test(asset.name))
    selected =
      installers.find((asset) => /universal/i.test(asset.name)) ??
      installers.find((asset) => /arm64|aarch64/i.test(asset.name)) ??
      installers.find((asset) => !/x86|armeabi|armv7/i.test(asset.name))
  }

  if (!selected || typeof selected.browser_download_url !== 'string')
    throw new Error('未找到安装包')
  const url = new URL(selected.browser_download_url)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    !url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/releases/download/`)
  ) {
    throw new Error('安装包地址无效')
  }
  return url.href
}
