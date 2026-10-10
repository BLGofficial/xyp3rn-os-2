# XYP3RN OS startup (Windows PowerShell 5.1+). Safe to re-run: a service that is already up is left alone.
#   scripts\start-xyp3rn.ps1            start everything
#   scripts\start-xyp3rn.ps1 -Stop      stop what this script starts (web, Galaxy, watcher); containers stay up
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$logs = Join-Path $repo '.logs'
New-Item -ItemType Directory -Force $logs | Out-Null

$services = @(
  @{ Name = 'web';    Port = 3100; Cmd = 'pnpm --filter ./apps/web dev' },
  @{ Name = 'galaxy'; Port = 4700; Cmd = 'python galaxy/server.py' },
  @{ Name = 'watcher'; Port = 0;    Cmd = 'pnpm obsidian:watch'; Match = 'watcher-cli' }
)

function Get-ServicePids($svc) {
  if ($svc.Port) {
    return @(Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
  }
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $svc.Match } | ForEach-Object { $_.ProcessId })
}

if ($Stop) {
  foreach ($svc in $services) {
    foreach ($id in (Get-ServicePids $svc)) { Stop-Process -Id $id -Force; Write-Host "stopped $($svc.Name) ($id)" }
  }
  return
}

Write-Host 'Initializing XYP3RN OS Engine...' -ForegroundColor Cyan

# The database the app uses lives in apps/web/.env.local; every service below must see the same URL
# (the repo-root default points at a different Postgres). The value is never printed.
$envFile = Join-Path $repo 'apps\web\.env.local'
$line = Get-Content $envFile -ErrorAction Stop | Where-Object { $_ -match '^XYP_DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { throw "XYP_DATABASE_URL is not set in $envFile" }
$env:XYP_DATABASE_URL = $line.Substring('XYP_DATABASE_URL='.Length).Trim()

# Containers: Postgres (published on 5433) and the Kokoro voice. Docker Desktop must be running.
$ErrorActionPreference = 'Continue' # docker writes progress to stderr; check exit codes instead
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not running. Start it, wait for the engine, then run this again.' }
docker start xyp3rn-pg xyp3rn-kokoro 2>&1 | Out-Null
for ($i = 0; $i -lt 30; $i++) { docker exec xyp3rn-pg pg_isready -U postgres -q 2>&1 | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
if ($LASTEXITCODE -ne 0) { throw 'xyp3rn-pg did not become ready.' }
$ErrorActionPreference = 'Stop'

foreach ($svc in $services) {
  if (Get-ServicePids $svc) { Write-Host "$($svc.Name): already running"; continue }
  $out = Join-Path $logs "$($svc.Name).log"
  Start-Process cmd.exe -ArgumentList "/c $($svc.Cmd) > `"$out`" 2>&1" -WindowStyle Hidden
  Write-Host "$($svc.Name): started (log .logs\$($svc.Name).log)"
}

Write-Host 'XYP3RN OS up: web http://127.0.0.1:3100 | Galaxy http://127.0.0.1:4700' -ForegroundColor Green
Write-Host 'Talk to Jarvis Core: pnpm jarvis "run monday review"' -ForegroundColor Green
