$ErrorActionPreference = "Stop"

if (-not $env:WINDOWS_PFX_PATH -or -not (Test-Path $env:WINDOWS_PFX_PATH)) {
  Write-Error "Set WINDOWS_PFX_PATH to your .pfx code signing certificate."
}
if (-not $env:WINDOWS_PFX_PASSWORD) {
  Write-Error "Set WINDOWS_PFX_PASSWORD to your .pfx password."
}
if (-not $env:WINDOWS_SIGN_TARGET -or -not (Test-Path $env:WINDOWS_SIGN_TARGET)) {
  Write-Error "Set WINDOWS_SIGN_TARGET to the .exe or .msi you want to sign."
}

$signtool = "signtool.exe"

& $signtool sign `
  /fd SHA256 `
  /tr http://timestamp.digicert.com `
  /td SHA256 `
  /f $env:WINDOWS_PFX_PATH `
  /p $env:WINDOWS_PFX_PASSWORD `
  $env:WINDOWS_SIGN_TARGET

Write-Host "Signed: $env:WINDOWS_SIGN_TARGET"
