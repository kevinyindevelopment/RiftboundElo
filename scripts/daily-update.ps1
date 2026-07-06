<#
.SYNOPSIS
  Daily maintenance for the Riftbound Elo tracker.

.DESCRIPTION
  Runs the incremental data ingest from carde.io and then recomputes the
  Glicko-2 ratings, logging everything to logs/daily-update-*.log.

  This is intended to be driven by Windows Task Scheduler (see
  scripts/register-daily-task.ps1) but can also be run by hand:

      powershell -ExecutionPolicy Bypass -File scripts\daily-update.ps1

  Requires CARDE_TOKEN (or CARDE_EMAIL/PASSWORD) in .env to pull auth-gated
  match results. Without it the ingest still refreshes public metadata.
#>
[CmdletBinding()]
param(
  # Extra args forwarded to `npm run ingest:stores -- ...` (e.g. --discover).
  [string[]]$IngestArgs = @()
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's folder.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# --- logging -------------------------------------------------------------
$LogDir = Join-Path $RepoRoot 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$Stamp   = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$LogFile = Join-Path $LogDir "daily-update-$Stamp.log"

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

# Resolve npm (system install lives in PATH; fall back to the default path
# in case the scheduler runs with a trimmed environment).
$Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $Npm) { $Npm = 'C:\Program Files\nodejs\npm.cmd' }

function Invoke-Step {
  param([string]$Name, [string[]]$Arguments)
  Write-Log "START $Name :: npm $($Arguments -join ' ')"
  # Tee child output into the same log file.
  & $Npm @Arguments 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value $_ -Encoding utf8; Write-Host $_ }
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Log "FAIL  $Name (exit $code)"
    throw "$Name failed with exit code $code"
  }
  Write-Log "OK    $Name"
}

Write-Log "=== Riftbound Elo daily update :: $RepoRoot ==="
try {
  $ingest = @('run', 'ingest:stores')
  if ($IngestArgs.Count -gt 0) { $ingest += '--'; $ingest += $IngestArgs }
  Invoke-Step -Name 'ingest:stores'  -Arguments $ingest
  Invoke-Step -Name 'elo:recompute'  -Arguments @('run', 'elo:recompute')
  Write-Log "=== DONE (success) ==="
}
catch {
  Write-Log "=== ABORTED: $($_.Exception.Message) ==="
  exit 1
}
finally {
  # Keep only the 14 most recent logs.
  Get-ChildItem $LogDir -Filter 'daily-update-*.log' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 14 |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
