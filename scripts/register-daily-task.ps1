<#
.SYNOPSIS
  Register (or refresh) the Windows Task Scheduler job that runs the daily
  Riftbound Elo maintenance.

.DESCRIPTION
  Creates a scheduled task named "RiftboundElo Daily Update" that runs
  scripts/daily-update.ps1 once a day. It runs as the current user, only
  needs standard (non-admin) rights, and uses -StartWhenAvailable so a run
  missed while the machine was off/asleep is caught up the next time you log on.

  Re-running this script updates the existing task in place.

  Usage:
      powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1
      powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1 -At 09:30
      powershell -ExecutionPolicy Bypass -File scripts\register-daily-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
  # Local time of day to run, HH:mm (24h).
  [string]$At = '04:00',
  # Remove the task instead of creating it.
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$TaskName  = 'RiftboundElo Daily Update'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Script    = Join-Path $RepoRoot 'scripts\daily-update.ps1'

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  return
}

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`"" `
  -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew

# Run as the current user, interactively (no stored password needed).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Incremental carde.io ingest + Glicko-2 recompute for the Riftbound Elo tracker.' `
  -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' to run daily at $At."
Write-Host "Run now to test:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove it later:  powershell -File scripts\register-daily-task.ps1 -Unregister"
