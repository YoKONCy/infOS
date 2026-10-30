import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export interface UpdateInstallReceipt {
  format: 1
  id: string
  version: string
  status: 'waiting' | 'installing' | 'installed' | 'failed' | 'cancelled'
  logPath: string
  errorCode?: string
  exitCode?: number
}

export interface UpdateInstallInput {
  version: string
  deployment: 'installed' | 'portable'
  downloadPath: string
  executable: string
  stagingPath?: string
  temporaryRoot: string
  receiptPath: string
  logDirectory: string
  parentPid: number
  messages: {
    started: string
    finished: string
    failed: string
    failedNotice: string
    failedTitle: string
  }
}

export interface PreparedUpdateInstall {
  id: string
  child: ChildProcess
  cancelPath: string
  receiptPath: string
  logPath: string
}

// 路径全部通过 JSON 数据传递，不把用户目录插入 PowerShell 命令正文。
// 助手位于程序目录之外；覆盖便携程序时只排除业务 data，并检查原生复制退出码。
const installerScript = String.raw`
$ErrorActionPreference = 'Stop'
$settings = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SETTINGS__')) | ConvertFrom-Json
$utf8 = [Text.UTF8Encoding]::new($false)
$receipt = [ordered]@{ format = 1; id = $settings.id; version = $settings.version; status = 'waiting'; logPath = $settings.logPath }
function Save-Receipt([string] $status) {
  if ([IO.File]::ReadAllText($settings.ownerPath) -ne $settings.id) { throw 'UPDATE_INSTALL_SUPERSEDED' }
  $receipt.status = $status
  $temporary = $settings.receiptPath + '.' + $settings.id + '.tmp'
  [IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json -Compress), $utf8)
  if ([IO.File]::Exists($settings.receiptPath)) {
    [IO.File]::Replace($temporary, $settings.receiptPath, [NullString]::Value)
  } else {
    [IO.File]::Move($temporary, $settings.receiptPath)
  }
}
function Write-Diagnostic([string] $code) {
  [IO.File]::AppendAllText($settings.logPath, ([DateTime]::UtcNow.ToString('o') + ' ' + $code + [Environment]::NewLine), $utf8)
}
function Full-Path([string] $value) {
  if (![IO.Path]::IsPathRooted($value)) { throw 'UPDATE_PATH_INVALID' }
  return [IO.Path]::GetFullPath($value).TrimEnd('\')
}
try {
  $target = Full-Path ([IO.Path]::GetDirectoryName($settings.executable))
  if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\')) { throw 'UPDATE_PATH_INVALID' }
  if (!(Test-Path -LiteralPath $settings.downloadPath -PathType Leaf)) { throw 'UPDATE_PACKAGE_MISSING' }
  if ($settings.deployment -eq 'portable') {
    $source = Full-Path $settings.stagingPath
    if ($source -eq $target -or $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'UPDATE_PATH_INVALID' }
    if (!(Test-Path -LiteralPath (Join-Path $source '.portable') -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $target '.portable') -PathType Leaf)) { throw 'UPDATE_PATH_INVALID' }
  }
  $parent = [Diagnostics.Process]::GetProcessById($settings.parentPid)
  $null = $parent.Handle
  if (Test-Path -LiteralPath $settings.cancelPath) { exit 0 }
  Save-Receipt 'waiting'
  [IO.File]::WriteAllText($settings.readyPath, $settings.id, $utf8)
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while (!$parent.WaitForExit(250)) {
    if (Test-Path -LiteralPath $settings.cancelPath) { Save-Receipt 'cancelled'; exit 0 }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'UPDATE_EXIT_TIMEOUT' }
  }
  if (Test-Path -LiteralPath $settings.cancelPath) { Save-Receipt 'cancelled'; exit 0 }
  Save-Receipt 'installing'
  Write-Diagnostic $settings.messages.started
  if ($settings.deployment -eq 'installed') {
    $scope = ''
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
      foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
        $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        try { $location = if ($entry.InstallLocation) { Full-Path $entry.InstallLocation } else { '' } } catch { continue }
        if ($location -eq $target) {
          if ($root.StartsWith('HKCU:')) { $scope = '/currentuser' } else { $scope = '/allusers' }
          break
        }
      }
      if ($scope) { break }
    }
    # NSIS 的 /D 必须位于最后，不能给目录额外加引号；整个参数串由原生进程接口传递。
    $arguments = '/S --updated --force-run ' + $scope + ' /D=' + $target
    $installer = Start-Process -FilePath $settings.downloadPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    $receipt['exitCode'] = $installer.ExitCode
    if ($installer.ExitCode -ne 0) { throw 'UPDATE_INSTALLER_FAILED' }
  } else {
    & (Join-Path $env:SystemRoot 'System32\robocopy.exe') $source $target /MIR /R:3 /W:1 /XJ /XD (Join-Path $target 'data') (Join-Path $source 'data') *>> $settings.logPath
    $receipt['exitCode'] = $LASTEXITCODE
    if ($LASTEXITCODE -ge 8) { throw 'UPDATE_COPY_FAILED' }
  }
  if (!(Test-Path -LiteralPath $settings.executable -PathType Leaf)) { throw 'UPDATE_EXECUTABLE_MISSING' }
  $observed = [Diagnostics.FileVersionInfo]::GetVersionInfo($settings.executable).ProductVersion
  if (!$observed -or $observed.Split('+')[0] -ne $settings.version.Split('+')[0]) { throw 'UPDATE_VERSION_UNCHANGED' }
  Save-Receipt 'installed'
  Write-Diagnostic $settings.messages.finished
  if ($settings.deployment -eq 'portable') {
    Start-Process -FilePath $settings.executable -WorkingDirectory $target -WindowStyle Hidden | Out-Null
  }
} catch {
  $receipt['errorCode'] = $_.Exception.Message
  try { Write-Diagnostic ($settings.messages.failed.Replace('{0}', $_.Exception.ToString())); Save-Receipt 'failed' } catch { }
  # 宿主已退出后也须告知用户失败；宿主仍运行时由更新中心展示错误。
  try {
    if ($parent -and $parent.HasExited) {
      Add-Type -AssemblyName System.Windows.Forms
      [Windows.Forms.MessageBox]::Show($settings.messages.failedNotice.Replace('{0}', $settings.logPath), $settings.messages.failedTitle) | Out-Null
    }
  } catch { }
  exit 1
}
`

/** 助手写入就绪凭据之前不允许退出宿主；启动失败仍保留下载与诊断文件。 */
export async function prepareUpdateInstall(input: UpdateInstallInput): Promise<PreparedUpdateInstall> {
  const id = randomUUID()
  const directory = path.join(input.temporaryRoot, `install-${id}`)
  const target = path.dirname(path.resolve(input.executable))
  const relative = path.relative(target, path.resolve(directory))
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new Error('UPDATE_PATH_INVALID')
  await mkdir(directory, { recursive: true })
  await mkdir(input.logDirectory, { recursive: true })
  await mkdir(path.dirname(input.receiptPath), { recursive: true })
  const logPath = path.join(input.logDirectory, `client-update-${id}.log`)
  const bootstrapPath = path.join(input.logDirectory, `client-update-${id}-helper.log`)
  const readyPath = path.join(directory, 'ready')
  const cancelPath = path.join(directory, 'cancel')
  const helperPath = path.join(directory, 'install.ps1')
  const ownerPath = input.receiptPath + '.owner'
  const settings = Buffer.from(
    JSON.stringify({ ...input, id, logPath, readyPath, cancelPath, ownerPath }),
  ).toString('base64')
  const script = installerScript.replace('__SETTINGS__', settings)
  await writeFile(helperPath, '\uFEFF' + script, 'utf16le')
  await writeFile(ownerPath, id, 'utf8')
  const output = openSync(bootstrapPath, 'a', 0o600)
  let child: ChildProcess
  try {
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    const bootstrap = Buffer.from(`& '${helperPath.replace(/'/g, "''")}'`, 'utf16le').toString('base64')
    // 只把系统程序路径与 base64 引导交给 cmd，不在命令文本中放用户路径。
    // cmd 脱离 Node 作业后等待 PowerShell；PowerShell 本身不能使用 DETACHED_PROCESS。
    const command = `""${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${bootstrap}"`
    child = spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        cwd: directory,
        detached: true,
        windowsVerbatimArguments: true,
        stdio: ['ignore', output, output],
        windowsHide: true,
      },
    )
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('UPDATE_HELPER_FAILED'), {
      logPath: bootstrapPath,
      installId: id,
    })
  } finally {
    closeSync(output)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const ready = (await readFile(readyPath, 'utf8').catch(() => '')) === id
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('UPDATE_HELPER_EXITED')
      if (ready) {
        child.unref()
        return { id, child, cancelPath, receiptPath: input.receiptPath, logPath }
      }
      await delay(100)
    }
    throw new Error('UPDATE_HELPER_TIMEOUT')
  } catch (error) {
    await writeFile(cancelPath, '').catch(() => {})
    await writeFile(ownerPath, id + '.cancelled', 'utf8').catch(() => {})
    child.unref()
    throw Object.assign(error instanceof Error ? error : new Error('UPDATE_HELPER_FAILED'), {
      logPath: bootstrapPath,
      installId: id,
    })
  }
}
