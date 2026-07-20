param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ChromeExtensionId,

  [ValidatePattern('^[a-p]{32}$')]
  [string]$EdgeExtensionId = '',

  [string]$InstallDir = (Resolve-Path "$PSScriptRoot\..\dist\desktop\douyin-hybrid").Path
)

$ErrorActionPreference = 'Stop'
if (-not $EdgeExtensionId) { $EdgeExtensionId = $ChromeExtensionId }

$hostExe = Join-Path $InstallDir 'VideoAnalysisRuntimeHost.exe'
if (-not (Test-Path -LiteralPath $hostExe)) {
  throw "找不到 Native Host：$hostExe。请先执行 npm run build:desktop"
}

$manifestDir = Join-Path $InstallDir 'native-host'
$manifestPath = Join-Path $manifestDir 'com.videoanalysis.runtime.json'
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null

$manifest = @{
  name = 'com.videoanalysis.runtime'
  description = 'Video Analysis Runtime Host'
  path = $hostExe
  type = 'stdio'
  allowed_origins = @(
    "chrome-extension://$ChromeExtensionId/"
    "chrome-extension://$EdgeExtensionId/"
  )
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  $manifestPath,
  ($manifest | ConvertTo-Json -Depth 4),
  $utf8NoBom
)
[System.IO.File]::WriteAllLines(
  (Join-Path $manifestDir 'allowed-origins.txt'),
  @(
    "chrome-extension://$ChromeExtensionId/"
    "chrome-extension://$EdgeExtensionId/"
  ),
  $utf8NoBom
)

$chromeKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.videoanalysis.runtime'
$edgeKey = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.videoanalysis.runtime'
foreach ($key in @($chromeKey, $edgeKey)) {
  New-Item -Force -Path $key | Out-Null
  Set-Item -Path $key -Value $manifestPath
}

Write-Host "Native Host 已注册：$manifestPath"
