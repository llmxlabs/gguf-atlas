param(
    [ValidateSet('start', 'stop', 'status')][string]$Action = 'start',
    [switch]$Open
)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path $PSScriptRoot -Parent
$stateDir = Join-Path $repoPath '.runtime'
$statePath = Join-Path $stateDir 'gguf-viewer.json'
$viewerUrl = 'http://127.0.0.1:18040'

function Get-ViewerHealth {
    try {
        $health = Invoke-RestMethod "$viewerUrl/api/health" -TimeoutSec 2
        return $health.application -eq 'gguf-observatory'
    } catch { return $false }
}

if ($Action -eq 'status') {
    if (Get-ViewerHealth) { Write-Host "GGUF Observatory is ready: $viewerUrl" }
    else { Write-Host 'GGUF Observatory is stopped.' }
    exit 0
}

if ($Action -eq 'stop') {
    if (Get-ViewerHealth) {
        $currentHealth = Invoke-RestMethod "$viewerUrl/api/health" -TimeoutSec 2
        if ($currentHealth.active_jobs -gt 0) {
            throw 'A candidate copy is being created. Let the experiment finish before stopping GGUF Atlas.'
        }
    }
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-Host 'No launcher-owned viewer process is recorded.'
        exit 0
    }
    $record = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
    if ($process) {
        $started = (Get-Process -Id $record.pid).StartTime.ToUniversalTime()
        $recordedStart = ([datetime]$record.started).ToUniversalTime()
        if ($started.Ticks -ne $recordedStart.Ticks -or $process.CommandLine -notmatch '-m viewer\.server(?:\s|$)') {
            throw 'Recorded PID no longer identifies this viewer. Refusing to stop it.'
        }
        Stop-Process -Id $record.pid
    }
    Remove-Item -LiteralPath $statePath
    Write-Host 'GGUF Observatory stopped.'
    exit 0
}

if (Get-ViewerHealth) {
    Write-Host "GGUF Observatory is already ready: $viewerUrl"
    if ($Open) { Start-Process $viewerUrl }
    exit 0
}
if (Get-NetTCPConnection -LocalPort 18040 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 18040 belongs to another process. Use python -m viewer.server --port <free port>.'
}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$pythonPath = (Get-Command python -ErrorAction Stop).Source
$process = Start-Process -FilePath $pythonPath -ArgumentList '-m', 'viewer.server', '--port', '18040' -WorkingDirectory $repoPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stateDir 'gguf-viewer.out.log') -RedirectStandardError (Join-Path $stateDir 'gguf-viewer.err.log')
@{ pid = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o'); url = $viewerUrl } | ConvertTo-Json | Set-Content -LiteralPath $statePath
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Get-ViewerHealth) {
        Write-Host "GGUF Observatory is ready: $viewerUrl"
        if ($Open) { Start-Process $viewerUrl }
        exit 0
    }
    $process.Refresh()
    if ($process.HasExited) { throw "Viewer exited. See $stateDir\gguf-viewer.err.log" }
    Start-Sleep -Milliseconds 300
}
throw "Viewer is still starting. See $stateDir\gguf-viewer.err.log"
