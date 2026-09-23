param(
    [Parameter(Mandatory=$true)][string]$Payload,
    [Parameter(Mandatory=$true)][string]$SevenZip,
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$TemporaryDirectory
)
$ErrorActionPreference = 'Stop'
$Payload = (Resolve-Path -LiteralPath $Payload).Path
$SevenZip = (Resolve-Path -LiteralPath $SevenZip).Path
$Output = [IO.Path]::GetFullPath($Output)
# This launcher embeds the Desktop 2.0.13 online payload built by build-payload.ps1.
$expected = 'a272f20b3f1f5b15d2b8b05d22259e7e97597f47dfc01ee79291e34479d5cea4'
if ((Get-FileHash -LiteralPath $Payload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Unexpected payload. Review and update the launcher runtime version before changing the payload.'
}
$directory = Split-Path -Parent $Output
New-Item -ItemType Directory -Force $directory | Out-Null
$buildTemp = if ($TemporaryDirectory) { [IO.Path]::GetFullPath($TemporaryDirectory) } else { Join-Path $directory 'build-temp' }
New-Item -ItemType Directory -Force $buildTemp | Out-Null
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
try {
    $env:TEMP = $buildTemp; $env:TMP = $buildTemp
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $patch = Join-Path $PSScriptRoot 'patch-runtime.cjs'
    $packageHelper = Join-Path $PSScriptRoot '../../bin/desktop-package-manager.mjs'
    & $compiler /nologo /target:winexe /platform:x64 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Xml.Linq.dll "/out:$Output" "/resource:$Payload,payload" "/resource:$SevenZip,seven" "/resource:$patch,runtimePatch" "/resource:$packageHelper,packageHelper" "/resource:$PSScriptRoot/setup-upgrade.mjs,setupUpgrade" "/resource:$PSScriptRoot/../../install.ps1,powershellInstaller" (Join-Path $PSScriptRoot 'Launcher.cs') (Join-Path $PSScriptRoot 'SetupDialog.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed' }
    Get-FileHash -LiteralPath $Output -Algorithm SHA256
} finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
    # Delete only an empty compiler temp directory, never arbitrary build files.
    if ([IO.Directory]::Exists($buildTemp) -and [IO.Directory]::GetFileSystemEntries($buildTemp).Length -eq 0) { [IO.Directory]::Delete($buildTemp) }
}
