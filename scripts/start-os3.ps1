$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CandidateUiPaths = @(
  $(if ($env:XYP_UI_REPO_PATH) { $env:XYP_UI_REPO_PATH }),
  (Join-Path (Split-Path -Parent $RepoRoot) "UI-xyp3rn"),
  (Join-Path (Split-Path -Parent (Split-Path -Parent $RepoRoot)) "building-agentic-systems\XYP3RNOS\UI-xyp3rn")
) | Where-Object { $_ -and (Test-Path $_) }

$UiRoot = $CandidateUiPaths | Select-Object -First 1
$Port = if ($env:XYP_GATEWAY_PORT) { $env:XYP_GATEWAY_PORT } else { "8077" }

Write-Host "=== XYP3RN OS 3.0 — Local-First Launcher ===" -ForegroundColor Cyan
Write-Host "1. Ensuring Canonical Vault & SQLite Index..." -ForegroundColor Yellow
Push-Location $RepoRoot
$gatewayProc = $null
try {
  & pnpm.cmd vault:os3 scan
  if ($LASTEXITCODE -ne 0) { throw "vault:os3 scan failed with exit code $LASTEXITCODE" }

  Write-Host "2. Starting OS 3.0 Gateway Daemon on http://127.0.0.1:$Port ..." -ForegroundColor Green
  $gatewayProc = Start-Process -FilePath "node" -ArgumentList "--env-file-if-exists=.env.local", "core/gateway/cli.ts" -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
  Write-Host "   Gateway PID: $($gatewayProc.Id)" -ForegroundColor Gray

  $healthy = $false
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 1
      if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $healthy) {
    Write-Warning "Gateway health check timed out on http://127.0.0.1:$Port/api/health"
  }

  if ($UiRoot) {
    Write-Host "3. Starting UI-xyp3rn from $UiRoot on http://127.0.0.1:3000 ..." -ForegroundColor Green
    Set-Location $UiRoot
    if (Test-Path (Join-Path $UiRoot ".next\BUILD_ID")) {
      & npm.cmd run start -- -H 127.0.0.1 -p 3000
    } else {
      & npm.cmd run dev -- -H 127.0.0.1 -p 3000
    }
  } else {
    Write-Host "UI-xyp3rn directory not found (set XYP_UI_REPO_PATH to launch UI). Keeping Gateway running..." -ForegroundColor Yellow
    Wait-Process -Id $gatewayProc.Id
  }
} finally {
  if ($null -ne $gatewayProc -and -not $gatewayProc.HasExited) {
    Write-Host "Stopping OS 3.0 Gateway Daemon (PID $($gatewayProc.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $gatewayProc.Id -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
