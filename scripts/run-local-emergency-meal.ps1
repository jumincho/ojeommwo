param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("lunch", "dinner")]
  [string]$Meal,
  [string]$Channel = "",
  [ValidateSet("cache")]
  [string]$Mode = "cache",
  [switch]$DryRun,
  [int]$MaxStartDelayMinutes = 45,
  [switch]$AllowStaleStart
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectRoot "logs"
$HolidaySkipPath = Join-Path $ProjectRoot "data\holiday-skip-dates.json"
$Common = Join-Path $ProjectRoot "scripts\local-failover-common.ps1"

if ($MaxStartDelayMinutes -lt 0) {
  throw "MaxStartDelayMinutes must be non-negative."
}
if ($Channel -and $Channel -cnotmatch '^[CGD][A-Z0-9]+$') {
  throw "Channel must be a Slack channel or conversation ID."
}
if ((-not $DryRun) -and (-not $Channel)) {
  throw "Channel is required for a live local emergency delivery."
}
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) {
  throw "Emergency common module not found: $Common"
}
. $Common
Assert-OjeommwoKstLocalTimezone
$NodeExe = Resolve-OjeommwoNodeExe

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogDir "local-emergency-$Meal-$Timestamp.log"
$Today = Get-Date -Format "yyyy-MM-dd"
$LockPath = Join-Path $env:TEMP "ojeommwo-v2-$Meal.lock"
$LockHandle = $null

function Write-LocalEmergencyLog {
  param(
    [string]$Message,
    [switch]$Append
  )

  $Line = "[$(Get-Date -Format o)] $Message"
  if ($Append) {
    $Line | Out-File -FilePath $LogPath -Encoding utf8 -Append
  } else {
    $Line | Out-File -FilePath $LogPath -Encoding utf8
  }
}

function Get-ScheduledStartForMeal {
  param(
    [string]$MealName,
    [datetime]$Now
  )

  switch ($MealName) {
    "lunch" { return $Now.Date.AddHours(11).AddMinutes(25) }
    "dinner" { return $Now.Date.AddHours(17).AddMinutes(25) }
    default { return $null }
  }
}

function Assert-LiveFailoverAuthority {
  $Lease = Invoke-OjeommwoFailClosedAuthorityValidation -ProjectRoot $ProjectRoot -Validation {
    $Lease = Get-LocalEmergencyLease -ProjectRoot $ProjectRoot
    Assert-LocalStandbySnapshot -ProjectRoot $ProjectRoot -MaxAgeHours ([int]$Lease.snapshotMaxAgeHours) | Out-Null
    return $Lease
  }
  if ([string]$Lease.channel -cne $Channel) {
    Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
    throw "Live channel does not match the authorized local emergency lease; all local tasks were removed."
  }
  $PororoState = Get-PororoDockerState
  if ($PororoState -eq "running") {
    Write-LocalEmergencyLog "skipped local emergency meal because pororo-docker recovered: meal=$Meal channel=$Channel"
    Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
    return $null
  }
  if (-not (Test-PororoStatePermitsLease -Lease $Lease -PororoState $PororoState)) {
    Write-LocalEmergencyLog "disabled local emergency mode because server state no longer matches its lease: state=$PororoState meal=$Meal channel=$Channel"
    Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
    throw "pororo-docker state no longer matches the authorized local emergency lease."
  }
  return [pscustomobject]@{ Lease = $Lease; PororoState = $PororoState }
}

try {
  try {
    $LockHandle = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  } catch [System.IO.IOException] {
    Write-LocalEmergencyLog "skipped overlapping local emergency meal: meal=$Meal channel=$Channel"
    exit 0
  }

  if (-not $DryRun) {
    $Authority = Assert-LiveFailoverAuthority
    if ($null -eq $Authority) { exit 0 }
    Write-LocalEmergencyLog "pororo-docker preflight state permits local failover: state=$($Authority.PororoState) meal=$Meal channel=$Channel"
  }

  if (-not $DryRun -and (Get-Date).DayOfWeek -in @("Saturday", "Sunday")) {
    Write-LocalEmergencyLog "skipped local emergency meal on weekend: meal=$Meal channel=$Channel"
    exit 0
  }

  if (-not $AllowStaleStart) {
    $Now = Get-Date
    $ScheduledStart = Get-ScheduledStartForMeal -MealName $Meal -Now $Now
    if ($null -ne $ScheduledStart) {
      $StartDelayMinutes = ($Now - $ScheduledStart).TotalMinutes
      if (($StartDelayMinutes -lt 0) -or ($StartDelayMinutes -gt $MaxStartDelayMinutes)) {
        $RoundedDelay = [Math]::Round($StartDelayMinutes, 1)
        Write-LocalEmergencyLog "skipped stale local emergency meal: meal=$Meal channel=$Channel scheduled=$($ScheduledStart.ToString("o")) delayMinutes=$RoundedDelay maxStartDelayMinutes=$MaxStartDelayMinutes"
        exit 0
      }
    }
  }

  $HolidayChecker = Join-Path $ProjectRoot "scripts\check-holiday-date.js"
  if (-not (Test-Path -LiteralPath $HolidayChecker -PathType Leaf)) {
    throw "Holiday checker is missing: $HolidayChecker"
  }
  $HolidayResult = @(& $NodeExe $HolidayChecker "--file" $HolidaySkipPath "--date" $Today 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Holiday skip file validation failed: $HolidaySkipPath; $($HolidayResult -join ' ')"
  }
  if (([string]($HolidayResult | Select-Object -Last 1)).Trim() -ceq "skip") {
    Write-LocalEmergencyLog "skipped local emergency meal on holiday: date=$Today meal=$Meal channel=$Channel"
    exit 0
  }

  if (-not $DryRun) {
    try {
      Assert-LocalEmergencyReadiness `
        -ProjectRoot $ProjectRoot `
        -LeaseExpiresAt ([DateTimeOffset]::Parse([string]$Authority.Lease.expiresAt)) `
        -CurrentMeal $Meal
      Write-LocalEmergencyLog "verified deterministic cache capacity for every remaining emergency meal: meal=$Meal channel=$Channel" -Append
    } catch {
      Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
      throw "Local emergency readiness failed closed and all local tasks were removed: $($_.Exception.Message)"
    }
    $Authority = Assert-LiveFailoverAuthority
    if ($null -eq $Authority) { exit 0 }
    Write-LocalEmergencyLog "final pre-send failover fence passed: state=$($Authority.PororoState) meal=$Meal channel=$Channel" -Append
  }

  $Arguments = @(
    "scripts\send-scheduled-meal.js",
    "--meal", $Meal,
    "--mode", $Mode
  )
  if ($Channel) {
    $Arguments += @("--channel", $Channel)
  }
  if ($DryRun) {
    $Arguments += "--dry-run"
  }

  Push-Location $ProjectRoot
  try {
    $PreviousObservatoryLink = [Environment]::GetEnvironmentVariable("ENABLE_OBSERVATORY_LINK", "Process")
    try {
      # The public observatory lives on the primary server. A local emergency
      # delivery must not publish a button that is known to be unavailable.
      $env:ENABLE_OBSERVATORY_LINK = "false"
      Write-LocalEmergencyLog "starting local emergency meal: meal=$Meal channel=$Channel mode=$Mode dryRun=$DryRun observatoryLink=false"
      $PreviousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        & $NodeExe @Arguments 2>&1 | Out-File -FilePath $LogPath -Encoding utf8 -Append
        $ExitCode = $LASTEXITCODE
        & $NodeExe "scripts\prune-runtime-artifacts.js" 2>&1 | Out-File -FilePath $LogPath -Encoding utf8 -Append
      } finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
      }
    } finally {
      if ($null -eq $PreviousObservatoryLink) {
        Remove-Item Env:\ENABLE_OBSERVATORY_LINK -ErrorAction SilentlyContinue
      } else {
        $env:ENABLE_OBSERVATORY_LINK = $PreviousObservatoryLink
      }
    }
    Write-LocalEmergencyLog "finished with exit code $ExitCode" -Append
    exit $ExitCode
  } finally {
    Pop-Location
  }
} finally {
  if ($null -ne $LockHandle) {
    $LockHandle.Dispose()
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }
}
