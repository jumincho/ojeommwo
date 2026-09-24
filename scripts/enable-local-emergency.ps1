param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$LunchChannel = "",
  [ValidateRange(1, 24)]
  [int]$LeaseHours = 24,
  [ValidateRange(1, 24)]
  [int]$MaxSnapshotAgeHours = 24,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$Runner = Join-Path $ProjectRoot "scripts\run-local-emergency-meal.ps1"
$InteractionRunner = Join-Path $ProjectRoot "scripts\run-local-interaction-listener.ps1"
$Common = Join-Path $ProjectRoot "scripts\local-failover-common.ps1"
$EnvPath = Join-Path $ProjectRoot ".env"
$HolidaySkipPath = Join-Path $ProjectRoot "data\holiday-skip-dates.json"
$MaxCatchUpDelayMinutes = 45
$RequiredLunchChannel = "C0123456789"

if (-not (Test-Path $Runner)) {
  throw "Emergency runner not found: $Runner"
}
if (-not (Test-Path $Common)) {
  throw "Emergency common module not found: $Common"
}
if (-not (Test-Path $InteractionRunner)) {
  throw "Emergency interaction runner not found: $InteractionRunner"
}
if (-not (Test-Path $EnvPath)) {
  throw "Local operating environment not found: $EnvPath"
}
if ($LunchChannel -cne $RequiredLunchChannel) {
  throw "LunchChannel must be the protected lunch channel $RequiredLunchChannel."
}
$EnvText = Get-Content -Raw -LiteralPath $EnvPath
if ($EnvText -notmatch '(?m)^ENABLE_MEAL_FEEDBACK\s*=\s*true\s*$' -or $EnvText -notmatch '(?m)^SLACK_APP_TOKEN\s*=\s*xapp-[^\r\n]+$') {
  throw "Local emergency mode requires ENABLE_MEAL_FEEDBACK=true and a Socket Mode SLACK_APP_TOKEN before tasks can be registered."
}
. $Common
Assert-OjeommwoKstLocalTimezone

$StateTransitionLock = Enter-OjeommwoStateTransitionLock -ProjectRoot $ProjectRoot
try {
$PororoState = Get-PororoDockerState
if ($PororoState -eq "running") {
  throw "pororo-docker is running. Local emergency mode cannot be enabled while the primary service is healthy."
}
if ($PororoState -eq "unreachable" -and -not $Force) {
  throw "pororo-docker state could not be confirmed. After independently confirming the outage, rerun with -Force to issue a time-limited unreachable-confirmed lease."
}
Assert-LocalStandbySnapshot -ProjectRoot $ProjectRoot -MaxAgeHours $MaxSnapshotAgeHours -RequireExactHashes | Out-Null

$ConfirmedState = if ($PororoState -eq "not-running") { "not-running" } else { "unreachable-confirmed" }
$IssuedAt = [DateTimeOffset]::Now
$ExpiresAt = $IssuedAt.AddHours($LeaseHours)
$CurrentMeal = ""
$CatchUpScheduledAt = $null

# A task registered just after 11:25 or 17:25 can run immediately through
# StartWhenAvailable. Include that catch-up send in the activation preflight.
# With a nominal 24-hour lease, clamp expiry to the same slot on the next day
# so the lease can never authorize a third send which was not capacity-tested.
if ($IssuedAt.DayOfWeek -notin @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
  $HolidayChecker = Join-Path $ProjectRoot "scripts\check-holiday-date.js"
  if (-not (Test-Path -LiteralPath $HolidayChecker -PathType Leaf)) {
    throw "Holiday checker is missing: $HolidayChecker"
  }
  $NodeExe = Resolve-OjeommwoNodeExe
  $HolidayResult = @(& $NodeExe $HolidayChecker "--file" $HolidaySkipPath "--date" $IssuedAt.ToString("yyyy-MM-dd") 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Holiday skip file validation failed before emergency activation: $($HolidayResult -join ' ')"
  }
  if (([string]($HolidayResult | Select-Object -Last 1)).Trim() -ceq "send") {
    foreach ($Schedule in @(
      @{ Meal = "lunch"; Hour = 11; Minute = 25 },
      @{ Meal = "dinner"; Hour = 17; Minute = 25 }
    )) {
      $ScheduledAt = [DateTimeOffset]::new(
        $IssuedAt.Year, $IssuedAt.Month, $IssuedAt.Day,
        [int]$Schedule.Hour, [int]$Schedule.Minute, 0,
        $IssuedAt.Offset
      )
      $DelayMinutes = ($IssuedAt - $ScheduledAt).TotalMinutes
      if ($DelayMinutes -ge 0 -and $DelayMinutes -le $MaxCatchUpDelayMinutes) {
        $CurrentMeal = [string]$Schedule.Meal
        $CatchUpScheduledAt = $ScheduledAt
        break
      }
    }
  }
}
if ($CurrentMeal) {
  $NextSameMeal = $CatchUpScheduledAt.AddDays(1)
  if ($ExpiresAt -gt $NextSameMeal) {
    $ExpiresAt = $NextSameMeal
  }
}
try {
  Assert-LocalEmergencyReadiness `
    -ProjectRoot $ProjectRoot `
    -LeaseExpiresAt $ExpiresAt `
    -CurrentMeal $CurrentMeal
} catch {
  throw (
    "The server-synced standby snapshot cannot cover every scheduled meal in this lease. " +
    "Local Windows emergency mode never runs Codex or changes candidate evidence; " +
    "sync a fresh server-prepared reserve and retry. Readiness: $($_.Exception.Message)"
  )
}
$LeasePath = Get-LocalEmergencyLeasePath -ProjectRoot $ProjectRoot
$LeaseTempPath = $LeasePath + ".tmp-" + [guid]::NewGuid().ToString("N")
$Lease = [ordered]@{
  version = 1
  confirmedState = $ConfirmedState
  channel = $LunchChannel
  issuedAt = $IssuedAt.ToString("o")
  expiresAt = $ExpiresAt.ToString("o")
  snapshotMaxAgeHours = $MaxSnapshotAgeHours
  issuedBy = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LeasePath) | Out-Null
try {
  [System.IO.File]::WriteAllText(
    $LeaseTempPath,
    (($Lease | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )
  Move-Item -LiteralPath $LeaseTempPath -Destination $LeasePath -Force
} finally {
  Remove-Item -LiteralPath $LeaseTempPath -Force -ErrorAction SilentlyContinue
}

function Register-LocalEmergencyInteractionTask {
  $TaskName = "ojeommwo-v2 Emergency - Interactions"
  $TaskCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InteractionRunner`""
  schtasks.exe /Create /F /TN $TaskName /SC MINUTE /MO 30 /TR $TaskCommand | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to register the local emergency interaction task."
  }

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
  Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}
Write-Output "pororo-docker preflight state: $PororoState"

function Register-LocalEmergencyTask {
  param(
    [string]$TaskName,
    [string]$Meal,
    [string]$Channel,
    [string]$Time,
    [string]$Days = "MON,TUE,WED,THU,FRI"
  )

  $TaskCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`" -Meal $Meal -Channel $Channel -Mode cache"
  schtasks.exe /Create /F /TN $TaskName /SC WEEKLY /D $Days /ST $Time /TR $TaskCommand | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to register scheduled task: $TaskName"
  }

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null
}

try {
  Register-LocalEmergencyTask -TaskName "ojeommwo-v2 Emergency - Lunch" -Meal "lunch" -Channel $LunchChannel -Time "11:25"
  Register-LocalEmergencyTask -TaskName "ojeommwo-v2 Emergency - Dinner" -Meal "dinner" -Channel $LunchChannel -Time "17:25"
  Register-LocalEmergencyInteractionTask
} catch {
  Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
  throw
}

schtasks.exe /Query /TN "ojeommwo-v2 Emergency - Lunch" /V /FO LIST | Out-Host
schtasks.exe /Query /TN "ojeommwo-v2 Emergency - Dinner" /V /FO LIST | Out-Host
schtasks.exe /Query /TN "ojeommwo-v2 Emergency - Interactions" /V /FO LIST | Out-Host
Write-Output "Local emergency lease expires at $($Lease.expiresAt); live runners will auto-disable on recovery, expiry, state mismatch, or invalid standby data."
} finally {
  Exit-OjeommwoStateTransitionLock -Handle $StateTransitionLock
}
