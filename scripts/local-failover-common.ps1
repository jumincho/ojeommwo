$ErrorActionPreference = "Stop"
$HashCompatPath = Join-Path $PSScriptRoot "powershell-hash-compat.ps1"
if (-not (Test-Path -LiteralPath $HashCompatPath -PathType Leaf)) {
  throw "PowerShell hash compatibility helper is missing: $HashCompatPath"
}
. $HashCompatPath

function Get-PororoDockerState {
  param(
    [string]$PororoHost = "203.0.113.10",
    [string]$PororoUser = "ojeommwo",
    [string]$PororoPort = "7777",
    [string]$PororoContainer = "ojeommwo",
    [int]$Attempts = 3,
    [int]$RetryDelayMilliseconds = 350
  )

  if ($Attempts -lt 1 -or $Attempts -gt 5) {
    throw "Attempts must be between 1 and 5."
  }
  if ($RetryDelayMilliseconds -lt 0 -or $RetryDelayMilliseconds -gt 5000) {
    throw "RetryDelayMilliseconds must be between 0 and 5000."
  }

  $SshCommand = Get-Command "ssh.exe" -ErrorAction SilentlyContinue
  if ($null -eq $SshCommand) {
    return "unreachable"
  }

  $SshArgs = @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=6",
    "-p", $PororoPort,
    "$PororoUser@$PororoHost",
    "docker inspect $PororoContainer --format '{{.State.Status}}' 2>/dev/null"
  )

  $SawNotRunning = $false
  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt += 1) {
    try {
      $StatusLines = @(& $SshCommand.Source @SshArgs 2>$null)
      $SshExitCode = $LASTEXITCODE
      if ($SshExitCode -eq 0) {
        $NormalizedStatus = ([string]($StatusLines | Select-Object -First 1)).Trim().ToLowerInvariant()
        if ($NormalizedStatus -eq "running") {
          return "running"
        }
        if ($NormalizedStatus -in @("created", "restarting", "removing", "paused", "exited", "dead")) {
          $SawNotRunning = $true
        }
      }
    } catch {
      # A later attempt may distinguish a transient SSH failure from an outage.
    }

    if ($Attempt -lt $Attempts -and $RetryDelayMilliseconds -gt 0) {
      Start-Sleep -Milliseconds $RetryDelayMilliseconds
    }
  }

  if ($SawNotRunning) {
    return "not-running"
  }
  return "unreachable"
}

function Resolve-OjeommwoNodeExe {
  if ($env:OJEOMMWO_NODE_EXE -and (Test-Path -LiteralPath $env:OJEOMMWO_NODE_EXE -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $env:OJEOMMWO_NODE_EXE).Path
  }
  $NodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($null -ne $NodeCommand) {
    return $NodeCommand.Source
  }
  $BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $BundledNode -PathType Leaf) {
    return $BundledNode
  }
  throw "Node.js was not found. Set OJEOMMWO_NODE_EXE to a stable Node 22+ executable."
}

function ConvertFrom-OjeommwoJson {
  param([Parameter(Mandatory = $true)][string]$Json)

  $ConvertCommand = Get-Command "ConvertFrom-Json" -ErrorAction Stop
  if ($ConvertCommand.Parameters.ContainsKey("DateKind")) {
    return $Json | ConvertFrom-Json -DateKind String
  }
  return $Json | ConvertFrom-Json
}

function Assert-OjeommwoExactPropertySet {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$ExpectedNames,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if ($null -eq $Value) {
    throw "$Description is missing."
  }
  $ActualNames = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
  if ($ActualNames.Count -ne $ExpectedNames.Count -or
      @($ExpectedNames | Where-Object { $_ -notin $ActualNames }).Count -gt 0 -or
      @($ActualNames | Select-Object -Unique).Count -ne $ActualNames.Count) {
    throw "$Description has an invalid schema."
  }
}

function Test-OjeommwoJsonInteger {
  param($Value)
  if ($null -eq $Value) { return $false }
  return $Value.GetType().Name -in @(
    "Byte", "SByte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64"
  )
}

function Assert-OjeommwoSourceSealSchema {
  param(
    [Parameter(Mandatory = $true)]$Seal,
    [Parameter(Mandatory = $true)][string]$Description
  )

  Assert-OjeommwoExactPropertySet -Value $Seal `
    -ExpectedNames @("version", "release", "sourceSeal") -Description $Description
  Assert-OjeommwoExactPropertySet -Value $Seal.release `
    -ExpectedNames @("version", "date", "implementationModel", "label") `
    -Description "$Description release metadata"
  Assert-OjeommwoExactPropertySet -Value $Seal.sourceSeal `
    -ExpectedNames @("algorithm", "sha256", "fileCount") `
    -Description "$Description source identity"

  if (-not (Test-OjeommwoJsonInteger -Value $Seal.version) -or $Seal.version -ne 1 -or
      @(@("version", "date", "implementationModel", "label") | Where-Object {
        $PropertyValue = $Seal.release.PSObject.Properties[$_].Value
        $PropertyValue -isnot [string] -or [string]::IsNullOrWhiteSpace($PropertyValue)
      }).Count -gt 0 -or
      $Seal.sourceSeal.algorithm -isnot [string] -or [string]$Seal.sourceSeal.algorithm -cne "sha256" -or
      $Seal.sourceSeal.sha256 -isnot [string] -or [string]$Seal.sourceSeal.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      -not (Test-OjeommwoJsonInteger -Value $Seal.sourceSeal.fileCount) -or
      [uint64]$Seal.sourceSeal.fileCount -lt 1 -or [uint64]$Seal.sourceSeal.fileCount -gt 2048) {
    throw "$Description has invalid release or SHA-256 metadata."
  }
}

function Get-OjeommwoLocalSourceSeal {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$OutputPath = ""
  )

  $GeneratorPath = Join-Path $ProjectRoot "scripts\generate-source-seal.js"
  if (-not (Test-Path -LiteralPath $GeneratorPath -PathType Leaf)) {
    throw "Local source-seal generator is missing: $GeneratorPath"
  }
  $NodeExe = Resolve-OjeommwoNodeExe
  $Arguments = @($GeneratorPath, "--root", $ProjectRoot)
  if ($OutputPath) {
    $Arguments += @("--output", $OutputPath)
  }

  $PreviousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $OutputLines = @()
  $ExitCode = $null
  try {
    if ($OutputPath) {
      & $NodeExe @Arguments | Out-Host
    } else {
      $OutputLines = @(& $NodeExe @Arguments)
    }
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
  if ($null -eq $ExitCode -or $ExitCode -ne 0) {
    throw "Local application release/source seal could not be generated (exit code $ExitCode)."
  }
  if ($OutputPath) {
    if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
      throw "Local source-seal generator did not create its requested output."
    }
    $SealJson = Get-Content -Raw -LiteralPath $OutputPath
  } else {
    $SealJson = $OutputLines -join [Environment]::NewLine
  }
  try {
    $Seal = ConvertFrom-OjeommwoJson -Json $SealJson
  } catch {
    throw "Local application release/source seal is invalid JSON: $($_.Exception.Message)"
  }
  Assert-OjeommwoSourceSealSchema -Seal $Seal -Description "Local application release/source seal"
  return $Seal
}

function Assert-OjeommwoManifestReleaseSourceSeal {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)]$Manifest,
    $CurrentSeal
  )

  Assert-OjeommwoExactPropertySet -Value $Manifest `
    -ExpectedNames @("version", "source", "syncedAt", "release", "sourceSeal", "stores") `
    -Description "Local standby manifest"
  if (-not (Test-OjeommwoJsonInteger -Value $Manifest.version) -or $Manifest.version -ne 2) {
    throw "Local standby manifest must use version 2 release/source identity. Run a fresh server sync."
  }
  if ($Manifest.source -isnot [string] -or [string]::IsNullOrWhiteSpace($Manifest.source) -or
      $Manifest.syncedAt -isnot [string] -or [string]::IsNullOrWhiteSpace($Manifest.syncedAt)) {
    throw "Local standby manifest provenance fields have an invalid schema."
  }
  $ExpectedStores = @(
    "recommendation-history.json",
    "sent-messages.json",
    "meal-events.json",
    "verified-candidates.json",
    "candidate-preferences.json",
    "coffee-participation.json",
    "delivery-outbox.json"
  )
  $ManifestStores = @($Manifest.stores)
  $ManifestNames = @($ManifestStores | ForEach-Object { [string]$_.name })
  if ($ManifestStores.Count -ne $ExpectedStores.Count -or
      @($ExpectedStores | Where-Object { $_ -notin $ManifestNames }).Count -gt 0 -or
      @($ManifestNames | Select-Object -Unique).Count -ne $ManifestNames.Count) {
    throw "Local standby manifest does not cover the exact operating store set. Run a fresh server sync."
  }
  foreach ($Store in $ManifestStores) {
    Assert-OjeommwoExactPropertySet -Value $Store -ExpectedNames @("name", "sha256") `
      -Description "Local standby manifest store entry"
    if ($Store.name -isnot [string] -or [string]$Store.name -notin $ExpectedStores -or
        $Store.sha256 -isnot [string] -or [string]$Store.sha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw "Local standby manifest store entry has invalid name or SHA-256 metadata."
    }
  }
  $ManifestSeal = [pscustomobject][ordered]@{
    version = 1
    release = $Manifest.release
    sourceSeal = $Manifest.sourceSeal
  }
  Assert-OjeommwoSourceSealSchema -Seal $ManifestSeal -Description "Local standby manifest release/source seal"
  if ($null -eq $CurrentSeal) {
    $CurrentSeal = Get-OjeommwoLocalSourceSeal -ProjectRoot $ProjectRoot
  } else {
    Assert-OjeommwoSourceSealSchema -Seal $CurrentSeal -Description "Current local application release/source seal"
  }

  foreach ($Name in @("version", "date", "implementationModel", "label")) {
    if ([string]$Manifest.release.$Name -cne [string]$CurrentSeal.release.$Name) {
      throw "Local application release does not match the server-synced standby manifest. Run a fresh server sync with the exact deployed source."
    }
  }
  if ([string]$Manifest.sourceSeal.algorithm -cne [string]$CurrentSeal.sourceSeal.algorithm -or
      [string]$Manifest.sourceSeal.sha256 -cne [string]$CurrentSeal.sourceSeal.sha256 -or
      [uint64]$Manifest.sourceSeal.fileCount -ne [uint64]$CurrentSeal.sourceSeal.fileCount) {
    throw "Local application source seal does not match the server-synced standby manifest. Run a fresh server sync with the exact deployed source."
  }
  return $CurrentSeal
}

function Assert-OjeommwoKstLocalTimezone {
  $Expected = "Korea Standard Time"
  $Actual = [System.TimeZoneInfo]::Local.Id
  if ($Actual -cne $Expected) {
    throw "Local emergency scheduling requires Windows timezone '$Expected'; current timezone is '$Actual'."
  }
}

function Enter-OjeommwoStateTransitionLock {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "State transition lock requires an existing project root."
  }
  if (-not $env:TEMP -or -not (Test-Path -LiteralPath $env:TEMP -PathType Container)) {
    throw "State transition lock requires a valid TEMP directory."
  }
  $LockPath = Join-Path $env:TEMP "ojeommwo-v2-state-transition.lock"
  try {
    # The zero-length file is intentionally persistent. FileShare.None is the
    # OS-owned mutex; retaining the pathname avoids a release/delete/recreate
    # race between server sync and local-emergency activation.
    return [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  } catch [System.IO.IOException] {
    throw "Another ojeommwo-v2 state transition is active; server sync and local emergency activation cannot overlap."
  }
}

function Exit-OjeommwoStateTransitionLock {
  param($Handle)
  if ($null -ne $Handle) { $Handle.Dispose() }
}

function Get-LocalEmergencyLeasePath {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)
  return (Join-Path $ProjectRoot "data\local-emergency-lease.json")
}

function Assert-LocalEmergencyCandidateSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)]$Manifest
  )

  $CandidateEntries = @($Manifest.stores | Where-Object { [string]$_.name -eq "verified-candidates.json" })
  if ($CandidateEntries.Count -ne 1 -or [string]$CandidateEntries[0].sha256 -cnotmatch '^[0-9a-fA-F]{64}$') {
    throw "Local standby manifest has no unique valid verified-candidates hash."
  }
  $CandidatePath = Join-Path $ProjectRoot "data\verified-candidates.json"
  if (-not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) {
    throw "Local verified candidate store is missing."
  }
  $BaseHash = ([string]$CandidateEntries[0].sha256).ToLowerInvariant()
  $LocalHash = (Get-FileHash -LiteralPath $CandidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($LocalHash -cne $BaseHash) {
    throw "Local verified candidates differ from the server-synced standby snapshot. Run a fresh server sync; Windows local emergency mode never runs Codex or mutates candidate evidence."
  }
  return $LocalHash
}

function Assert-LocalEmergencyReadiness {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][DateTimeOffset]$LeaseExpiresAt,
    [ValidateSet("", "lunch", "dinner")]
    [string]$CurrentMeal = ""
  )

  $ReadinessScript = Join-Path $ProjectRoot "scripts\check-local-emergency-readiness.js"
  if (-not (Test-Path -LiteralPath $ReadinessScript -PathType Leaf)) {
    throw "Local emergency readiness checker is missing: $ReadinessScript"
  }
  $NodeExe = Resolve-OjeommwoNodeExe
  $Arguments = @($ReadinessScript, "--lease-expires-at", $LeaseExpiresAt.ToString("o"))
  if ($CurrentMeal) {
    $Arguments += @("--current-meal", $CurrentMeal)
  }

  $PreviousErrorActionPreference = $ErrorActionPreference
  $ExitCode = $null
  $ErrorActionPreference = "Continue"
  try {
    & $NodeExe @Arguments | Out-Host
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
  if ($null -eq $ExitCode -or $ExitCode -ne 0) {
    throw "Local emergency cache cannot safely cover every scheduled meal in the remaining lease. Sync a newly prepared server snapshot before retrying."
  }
}

function Split-OjeommwoWindowsCommandLine {
  param([AllowEmptyString()][string]$CommandLine)

  # Win32_Process exposes one Windows command-line string rather than argv.
  # Parse the quoting/backslash rules needed by the runners so classification
  # is based on argument position, not on an arbitrary filename substring.
  $Arguments = [System.Collections.Generic.List[string]]::new()
  $Length = $CommandLine.Length
  $Index = 0
  while ($Index -lt $Length) {
    while ($Index -lt $Length -and [char]::IsWhiteSpace($CommandLine[$Index])) {
      $Index += 1
    }
    if ($Index -ge $Length) { break }

    $Builder = [System.Text.StringBuilder]::new()
    $InQuotes = $false
    while ($Index -lt $Length) {
      $Character = $CommandLine[$Index]
      if (-not $InQuotes -and [char]::IsWhiteSpace($Character)) { break }

      if ($Character -eq '\') {
        $SlashStart = $Index
        while ($Index -lt $Length -and $CommandLine[$Index] -eq '\') {
          $Index += 1
        }
        $SlashCount = $Index - $SlashStart
        if ($Index -lt $Length -and $CommandLine[$Index] -eq '"') {
          [void]$Builder.Append(('\' * [Math]::Floor($SlashCount / 2)))
          if (($SlashCount % 2) -eq 0) {
            $InQuotes = -not $InQuotes
          } else {
            [void]$Builder.Append('"')
          }
          $Index += 1
        } else {
          [void]$Builder.Append(('\' * $SlashCount))
        }
        continue
      }

      if ($Character -eq '"') {
        $InQuotes = -not $InQuotes
        $Index += 1
        continue
      }

      [void]$Builder.Append($Character)
      $Index += 1
    }
    $Arguments.Add($Builder.ToString())
    while ($Index -lt $Length -and [char]::IsWhiteSpace($CommandLine[$Index])) {
      $Index += 1
    }
  }
  return $Arguments.ToArray()
}

function Test-OjeommwoLocalRuntimeProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [switch]$IncludeMealRunner
  )

  $ProcessName = ([string]$Process.Name).Trim().ToLowerInvariant()
  $CommandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $Arguments = @(Split-OjeommwoWindowsCommandLine -CommandLine $CommandLine)
  if ($Arguments.Count -lt 2) { return $false }

  if ($ProcessName -eq 'node.exe') {
    # The listener runner starts Node with this script as argv[1]. A Node
    # diagnostic such as `node -e "...run-interaction-listener.js..."` is not
    # the listener and must never block a sync or be terminated as failover.
    $ScriptArgument = $Arguments[1].Replace('/', '\')
    if ($ScriptArgument.StartsWith('.\')) {
      $ScriptArgument = $ScriptArgument.Substring(2)
    }
    return $ScriptArgument -ieq 'scripts\run-interaction-listener.js'
  }

  if ($ProcessName -notin @('powershell.exe', 'pwsh.exe')) { return $false }

  # Only a real PowerShell -File invocation is a managed wrapper. In
  # particular, -Command/-EncodedCommand diagnostics may contain any of these
  # filenames as text without becoming an emergency runner.
  for ($ArgumentIndex = 1; $ArgumentIndex -lt $Arguments.Count; $ArgumentIndex += 1) {
    $Argument = ([string]$Arguments[$ArgumentIndex]).ToLowerInvariant()
    if ($Argument -in @(
      '-command', '-c', '-commandwithargs', '-cwa',
      '-encodedcommand', '-e', '-ec', '-enc'
    )) {
      return $false
    }
    if ($Argument -notin @('-file', '-f')) { continue }
    if ($ArgumentIndex + 1 -ge $Arguments.Count) { return $false }

    $ScriptName = [System.IO.Path]::GetFileName([string]$Arguments[$ArgumentIndex + 1]).ToLowerInvariant()
    if ($ScriptName -eq 'run-local-interaction-listener.ps1') { return $true }
    if ($IncludeMealRunner -and $ScriptName -eq 'run-local-emergency-meal.ps1') { return $true }
    return $false
  }
  return $false
}

function Disable-OjeommwoLocalEmergency {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [int]$ExcludeProcessId = $PID
  )
  $EmergencyTaskNames = @(
    "ojeommwo-v2 Emergency - Lunch",
    "ojeommwo-v2 Emergency - Dinner",
    "ojeommwo-v2 Emergency - Interactions",
    "ojeommwo-v2 - Lunch",
    "ojeommwo-v2 - Dinner",
    "ojeommwo-v2 - DM Proof"
  )
  if ($null -eq (Get-Command "Get-ScheduledTask" -ErrorAction SilentlyContinue) -or
      $null -eq (Get-Command "Unregister-ScheduledTask" -ErrorAction SilentlyContinue)) {
    throw "Windows scheduled-task cmdlets are unavailable; local emergency tasks could not be disabled."
  }
  foreach ($TaskName in $EmergencyTaskNames) {
    $ExistingTasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
    foreach ($Task in $ExistingTasks) {
      $Task | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop
    }
  }
  $ProcessError = $null
  try {
    if ($null -eq (Get-Command "Get-CimInstance" -ErrorAction SilentlyContinue)) {
      throw "Get-CimInstance is unavailable; local emergency processes could not be verified."
    }
    $Processes = @(
      Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
        Where-Object {
          [int]$_.ProcessId -ne $ExcludeProcessId -and
          (Test-OjeommwoLocalRuntimeProcess -Process $_ -IncludeMealRunner)
        }
    )
    foreach ($Process in $Processes) {
      Stop-Process -Id ([int]$Process.ProcessId) -Force -ErrorAction Stop
    }
    if ($Processes.Count -gt 0) {
      Start-Sleep -Milliseconds 250
      $RemainingIds = @(
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
          Where-Object {
            [int]$_.ProcessId -ne $ExcludeProcessId -and
            (Test-OjeommwoLocalRuntimeProcess -Process $_ -IncludeMealRunner)
          } |
          ForEach-Object { [int]$_.ProcessId }
      )
      if ($RemainingIds.Count -gt 0) {
        throw "Local emergency processes remain after disable: $($RemainingIds -join ', ')."
      }
    }
  } catch {
    $ProcessError = $_.Exception.Message
  }
  $LeasePath = Get-LocalEmergencyLeasePath -ProjectRoot $ProjectRoot
  Remove-Item -LiteralPath $LeasePath -Force -ErrorAction SilentlyContinue
  if ($ProcessError) {
    throw $ProcessError
  }
}

function Invoke-OjeommwoFailClosedAuthorityValidation {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][scriptblock]$Validation
  )

  try {
    return (& $Validation)
  } catch {
    $ValidationError = $_.Exception.Message
    try {
      Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
    } catch {
      throw "Local emergency authority validation failed closed and the lease was removed, but emergency process shutdown was incomplete: $ValidationError; $($_.Exception.Message)"
    }
    throw "Local emergency authority validation failed closed and all local tasks and the lease were removed: $ValidationError"
  }
}

function Get-LocalEmergencyLease {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)
  $LeasePath = Get-LocalEmergencyLeasePath -ProjectRoot $ProjectRoot
  if (-not (Test-Path -LiteralPath $LeasePath -PathType Leaf)) {
    throw "Local emergency authorization lease is missing. Re-enable emergency mode after confirming the outage."
  }
  try {
    $Lease = ConvertFrom-OjeommwoJson -Json (Get-Content -Raw -LiteralPath $LeasePath)
  } catch {
    throw "Local emergency authorization lease is invalid JSON."
  }
  if ($Lease.version -ne 1 -or $Lease.confirmedState -notin @("not-running", "unreachable-confirmed") -or
      $Lease.channel -cnotmatch '^[CGD][A-Z0-9]+$' -or [int]$Lease.snapshotMaxAgeHours -lt 1 -or
      [int]$Lease.snapshotMaxAgeHours -gt 24) {
    throw "Local emergency authorization lease has an invalid schema."
  }
  try {
    $IssuedAt = [DateTimeOffset]::Parse([string]$Lease.issuedAt)
    $ExpiresAt = [DateTimeOffset]::Parse([string]$Lease.expiresAt)
  } catch {
    throw "Local emergency authorization lease has invalid timestamps."
  }
  $Now = [DateTimeOffset]::Now
  if ($IssuedAt -gt $Now.AddMinutes(5) -or $ExpiresAt -le $IssuedAt -or
      $ExpiresAt -gt $IssuedAt.AddHours(24) -or $Now -ge $ExpiresAt) {
    Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot
    throw "Local emergency authorization lease expired or exceeded its 24-hour safety limit; all local tasks were removed."
  }
  return $Lease
}

function Assert-LocalStandbySnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [int]$MaxAgeHours = 24,
    [switch]$RequireExactHashes
  )
  if ($MaxAgeHours -lt 1 -or $MaxAgeHours -gt 24) {
    throw "MaxAgeHours must be between 1 and 24."
  }
  $ManifestPath = Join-Path $ProjectRoot "data\local-standby-manifest.json"
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Local standby manifest is missing. Run sync-operating-data-from-server.ps1 before enabling emergency mode."
  }
  try {
    $Manifest = ConvertFrom-OjeommwoJson -Json (Get-Content -Raw -LiteralPath $ManifestPath)
    $SyncedAt = [DateTimeOffset]::Parse([string]$Manifest.syncedAt)
  } catch {
    throw "Local standby manifest is invalid. Run a fresh server sync."
  }
  $Now = [DateTimeOffset]::Now
  Assert-OjeommwoManifestReleaseSourceSeal -ProjectRoot $ProjectRoot -Manifest $Manifest | Out-Null
  if ([string]::IsNullOrWhiteSpace([string]$Manifest.source) -or
      $SyncedAt -gt $Now.AddMinutes(5) -or $Now - $SyncedAt -gt [TimeSpan]::FromHours($MaxAgeHours)) {
    throw "Local standby snapshot is older than $MaxAgeHours hours. Run a fresh server sync."
  }
  if ($RequireExactHashes) {
    $ExpectedStores = @(
      "recommendation-history.json",
      "sent-messages.json",
      "meal-events.json",
      "verified-candidates.json",
      "candidate-preferences.json",
      "coffee-participation.json",
      "delivery-outbox.json"
    )
    $ManifestStores = @($Manifest.stores)
    $ManifestNames = @($ManifestStores | ForEach-Object { [string]$_.name })
    if ($ManifestStores.Count -ne $ExpectedStores.Count -or
        @($ExpectedStores | Where-Object { $_ -notin $ManifestNames }).Count -gt 0 -or
        @($ManifestNames | Select-Object -Unique).Count -ne $ManifestNames.Count) {
      throw "Local standby manifest does not cover the exact operating store set. Run a fresh server sync."
    }
    foreach ($Store in $ManifestStores) {
      if ([string]$Store.sha256 -cnotmatch '^[0-9a-fA-F]{64}$') {
        throw "Local standby snapshot has an invalid hash for $($Store.name)."
      }
      $StorePath = Join-Path $ProjectRoot ("data\" + [string]$Store.name)
      if (-not (Test-Path -LiteralPath $StorePath -PathType Leaf)) {
        throw "Local standby snapshot is missing $($Store.name)."
      }
      $StoreItem = Get-Item -LiteralPath $StorePath
      if (($StoreItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Local standby snapshot contains a reparse-point primary: $($Store.name)."
      }
      $ActualHash = (Get-FileHash -LiteralPath $StorePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($ActualHash -ne ([string]$Store.sha256).ToLowerInvariant()) {
        throw "Local standby snapshot hash mismatch: $($Store.name). Run a fresh server sync."
      }
      $BackupPath = $StorePath + ".bak"
      if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
        throw "Local standby snapshot is missing the same-revision recovery copy: $($Store.name).bak."
      }
      $BackupItem = Get-Item -LiteralPath $BackupPath
      if (($BackupItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Local standby snapshot contains a reparse-point recovery copy: $($Store.name).bak."
      }
      $BackupHash = (Get-FileHash -LiteralPath $BackupPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($BackupHash -ne ([string]$Store.sha256).ToLowerInvariant()) {
        throw "Local standby recovery-copy hash mismatch: $($Store.name).bak. Run a fresh server sync."
      }
    }
  } else {
    # Recommendation/history stores legitimately evolve while emergency mode
    # is active. Candidate evidence is immutable on Windows and must remain the
    # exact server-synced revision for the lifetime of the lease.
    Assert-LocalEmergencyCandidateSnapshot -ProjectRoot $ProjectRoot -Manifest $Manifest | Out-Null
  }
  $NodeExe = Resolve-OjeommwoNodeExe
  & $NodeExe (Join-Path $ProjectRoot "scripts\validate-operating-snapshot.js") --data-dir (Join-Path $ProjectRoot "data") | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Local standby snapshot failed deep operating-data validation."
  }
  return $Manifest
}

function Test-PororoStatePermitsLease {
  param(
    [Parameter(Mandatory = $true)]$Lease,
    [Parameter(Mandatory = $true)][string]$PororoState
  )
  if ($PororoState -eq "not-running") {
    return $true
  }
  if ($PororoState -eq "unreachable" -and $Lease.confirmedState -eq "unreachable-confirmed") {
    return $true
  }
  return $false
}
