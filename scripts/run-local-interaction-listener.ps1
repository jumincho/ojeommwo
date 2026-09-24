param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$ServerPollSeconds = 30
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Common = Join-Path $ProjectRoot "scripts\local-failover-common.ps1"
$EnvPath = Join-Path $ProjectRoot ".env"
$LogDir = Join-Path $ProjectRoot "logs"
$LockPath = Join-Path $env:TEMP "ojeommwo-v2-interactions.lock"
$LockHandle = $null
$ListenerProcess = $null

if ($ServerPollSeconds -lt 15 -or $ServerPollSeconds -gt 300) {
  throw "ServerPollSeconds must be between 15 and 300."
}
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) {
  throw "Emergency common module not found: $Common"
}
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  throw "Local operating environment not found: $EnvPath"
}
. $Common
$NodeExe = Resolve-OjeommwoNodeExe

$EnvText = Get-Content -Raw -LiteralPath $EnvPath
if ($EnvText -notmatch '(?m)^ENABLE_MEAL_FEEDBACK\s*=\s*true\s*$') {
  throw "Local emergency interactions require ENABLE_MEAL_FEEDBACK=true."
}
if ($EnvText -notmatch '(?m)^SLACK_APP_TOKEN\s*=\s*xapp-[^\r\n]+$') {
  throw "Local emergency interactions require a Socket Mode SLACK_APP_TOKEN."
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$StdoutPath = Join-Path $LogDir "local-emergency-interactions-$Timestamp.log"
$StderrPath = Join-Path $LogDir "local-emergency-interactions-$Timestamp.err.log"

function Write-InteractionFailoverLog {
  param([string]$Message)
  "[$(Get-Date -Format o)] $Message" | Out-File -FilePath $StdoutPath -Encoding utf8 -Append
}

try {
  try {
    $LockHandle = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  } catch [System.IO.IOException] {
    Write-InteractionFailoverLog "skipped overlapping local emergency interaction listener"
    exit 0
  }

  $Lease = Get-LocalEmergencyLease -ProjectRoot $ProjectRoot
  Assert-LocalStandbySnapshot -ProjectRoot $ProjectRoot -MaxAgeHours ([int]$Lease.snapshotMaxAgeHours) | Out-Null
  $PororoState = Get-PororoDockerState
  if ($PororoState -eq "running") {
    Write-InteractionFailoverLog "skipped local interaction listener because pororo-docker is running"
    Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
    exit 0
  }
  if (-not (Test-PororoStatePermitsLease -Lease $Lease -PororoState $PororoState)) {
    Write-InteractionFailoverLog "disabled local interaction listener because server state no longer matches its lease: state=$PororoState"
    Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
    throw "pororo-docker state no longer matches the authorized local emergency lease."
  }
  Write-InteractionFailoverLog "starting local emergency interaction listener: pororoState=$PororoState"

  $PreviousObservatoryLink = [Environment]::GetEnvironmentVariable("ENABLE_OBSERVATORY_LINK", "Process")
  try {
    # The emergency listener may update old Slack messages, but it must never
    # advertise a primary-server observatory while that server is unavailable.
    $env:ENABLE_OBSERVATORY_LINK = "false"
    $ListenerProcess = Start-Process `
      -FilePath $NodeExe `
      -ArgumentList @("scripts\run-interaction-listener.js") `
      -WorkingDirectory $ProjectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru
  } finally {
    if ($null -eq $PreviousObservatoryLink) {
      Remove-Item Env:\ENABLE_OBSERVATORY_LINK -ErrorAction SilentlyContinue
    } else {
      $env:ENABLE_OBSERVATORY_LINK = $PreviousObservatoryLink
    }
  }
  Write-InteractionFailoverLog "local emergency interaction listener started with observatoryLink=false"

  $LastSnapshotValidation = Get-Date
  while (-not $ListenerProcess.HasExited) {
    Start-Sleep -Seconds $ServerPollSeconds
    $ListenerProcess.Refresh()
    if ($ListenerProcess.HasExited) {
      break
    }
    $Lease = Get-LocalEmergencyLease -ProjectRoot $ProjectRoot
    if (((Get-Date) - $LastSnapshotValidation).TotalMinutes -ge 10) {
      Assert-LocalStandbySnapshot -ProjectRoot $ProjectRoot -MaxAgeHours ([int]$Lease.snapshotMaxAgeHours) | Out-Null
      $LastSnapshotValidation = Get-Date
    }
    $PororoState = Get-PororoDockerState
    if ($PororoState -eq "running") {
      Write-InteractionFailoverLog "pororo-docker recovered; stopping local emergency interaction listener"
      Stop-Process -Id $ListenerProcess.Id -Force -ErrorAction SilentlyContinue
      $ListenerProcess.WaitForExit(5000) | Out-Null
      Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
      exit 0
    }
    if (-not (Test-PororoStatePermitsLease -Lease $Lease -PororoState $PororoState)) {
      Write-InteractionFailoverLog "server state no longer matches the lease; stopping local emergency interaction listener: state=$PororoState"
      Stop-Process -Id $ListenerProcess.Id -Force -ErrorAction SilentlyContinue
      $ListenerProcess.WaitForExit(5000) | Out-Null
      Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
      exit 1
    }
  }

  $ListenerProcess.Refresh()
  $ExitCode = $ListenerProcess.ExitCode
  Write-InteractionFailoverLog "local emergency interaction listener exited: code=$ExitCode"
  exit $ExitCode
} catch {
  Write-InteractionFailoverLog "local emergency interaction listener failed closed: $($_.Exception.Message)"
  Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
  throw
} finally {
  if ($null -ne $ListenerProcess -and -not $ListenerProcess.HasExited) {
    Stop-Process -Id $ListenerProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $LockHandle) {
    $LockHandle.Dispose()
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }
}
