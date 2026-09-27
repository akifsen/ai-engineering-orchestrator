$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 20 or newer is required."
    exit 1
}
& node (Join-Path $PSScriptRoot "scripts\aeo.mjs") @args
exit $LASTEXITCODE
