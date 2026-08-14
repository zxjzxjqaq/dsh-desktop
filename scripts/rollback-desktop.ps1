[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([IO.Path]::GetExtension($resolved) -ne '.exe') {
  throw 'InstallerPath must point to an .exe installer.'
}

$actual = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
if ($actual -ne $ExpectedSha256.ToUpperInvariant()) {
  throw "Installer SHA-256 mismatch. Expected $ExpectedSha256, received $actual."
}

Write-Host "Verified prior installer: $resolved"
Write-Host "SHA-256: $actual"
$process = Start-Process -FilePath $resolved -PassThru -Wait
if ($process.ExitCode -ne 0) {
  throw "Installer exited with status $($process.ExitCode)."
}
Write-Host 'Desktop rollback installer completed successfully.'
