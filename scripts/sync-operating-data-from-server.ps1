param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$SshTarget = "pororo-docker",
  [string]$RemoteRoot = "/root/ojeommwo-v2",
  [switch]$DryRun,
  [System.IO.FileStream]$ExistingStateTransitionLock
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$HashCompatPath = Join-Path $PSScriptRoot "powershell-hash-compat.ps1"
if (-not (Test-Path -LiteralPath $HashCompatPath -PathType Leaf)) {
  throw "PowerShell hash compatibility helper is missing: $HashCompatPath"
}
. $HashCompatPath

$Stores = @(
  @{ Name = "recommendation-history.json"; Property = "items"; Required = $true },
  @{ Name = "sent-messages.json"; Property = "messages"; Required = $true },
  @{ Name = "meal-events.json"; Property = "events"; Required = $true },
  @{ Name = "verified-candidates.json"; Property = "candidates"; Required = $true },
  @{ Name = "candidate-preferences.json"; Property = "responses"; Required = $true },
  @{ Name = "coffee-participation.json"; Property = "messages"; Required = $true },
  @{ Name = "delivery-outbox.json"; Property = "deliveries"; Required = $false }
)

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  $PreviousErrorActionPreference = $ErrorActionPreference
  $ExitCode = $null
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments | Out-Host
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
  if ($null -eq $ExitCode -or $ExitCode -ne 0) {
    throw "$FailureMessage (exit code $ExitCode)."
  }
}

function Invoke-NativeQuietly {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $PreviousErrorActionPreference = $ErrorActionPreference
  $ExitCode = -1
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments *> $null
    $ExitCode = $LASTEXITCODE
  } catch {
    $ExitCode = -1
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
  return $ExitCode
}

function Resolve-NodeExecutable {
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

function Assert-DownloadedHashes {
  param(
    [Parameter(Mandatory = $true)][string]$StageDirectory,
    [Parameter(Mandatory = $true)]$StoreDefinitions
  )

  $ManifestPath = Join-Path $StageDirectory "SHA256SUMS"
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Remote snapshot hash manifest is missing."
  }

  $ExpectedNames = @($StoreDefinitions | ForEach-Object { [string]$_.Name }) + @("SOURCE-SEAL.json")
  $Lines = @(Get-Content -LiteralPath $ManifestPath)
  if ($Lines.Count -ne $ExpectedNames.Count) {
    throw "Remote snapshot hash manifest must contain exactly $($ExpectedNames.Count) stores."
  }

  $ExpectedHashes = @{}
  foreach ($Line in $Lines) {
    if ([string]$Line -cnotmatch '^([0-9a-fA-F]{64})  ([A-Za-z0-9.-]+)$') {
      throw "Remote snapshot hash manifest contains an invalid line."
    }
    $Hash = $Matches[1].ToLowerInvariant()
    $Name = $Matches[2]
    if ($Name -notin $ExpectedNames -or $ExpectedHashes.ContainsKey($Name)) {
      throw "Remote snapshot hash manifest contains an unexpected or duplicate store: $Name"
    }
    $ExpectedHashes[$Name] = $Hash
  }

  foreach ($Name in $ExpectedNames) {
    $StorePath = Join-Path $StageDirectory $Name
    if (-not (Test-Path -LiteralPath $StorePath -PathType Leaf)) {
      throw "Downloaded operating snapshot is missing $Name."
    }
    $ActualHash = (Get-FileHash -LiteralPath $StorePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -cne $ExpectedHashes[$Name]) {
      throw "Downloaded operating snapshot hash mismatch: $Name"
    }
  }
}

function Assert-LocalPromotionAllowed {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$SkipLockCheck
  )

  $EmergencyLease = Join-Path $Root "data\local-emergency-lease.json"
  if (Test-Path -LiteralPath $EmergencyLease) {
    throw "A local emergency lease exists; disable and reconcile emergency mode before server data promotion."
  }

  if ($null -eq (Get-Command "Get-ScheduledTask" -ErrorAction SilentlyContinue)) {
    throw "Cannot verify local scheduled-task state; operating data promotion is blocked."
  }
  try {
    $ActiveTasks = @(
      Get-ScheduledTask -TaskName "ojeommwo-v2*" -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.State -ne "Disabled" }
    )
  } catch {
    throw "Cannot verify local scheduled-task state; operating data promotion is blocked: $($_.Exception.Message)"
  }
  if ($ActiveTasks.Count -gt 0) {
    $TaskSummary = ($ActiveTasks | ForEach-Object { "$($_.TaskName)=$($_.State)" }) -join ", "
    throw "Local ojeommwo-v2 scheduled tasks are active; operating data promotion is blocked: $TaskSummary"
  }

  if (-not $SkipLockCheck) {
    foreach ($LockName in @("ojeommwo-v2-interactions.lock", "ojeommwo-v2-lunch.lock", "ojeommwo-v2-dinner.lock")) {
    $LockPath = Join-Path $env:TEMP $LockName
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
      continue
    }
    $Handle = $null
    try {
      $Handle = [System.IO.File]::Open($LockPath, 'Open', 'ReadWrite', 'None')
    } catch [System.IO.IOException] {
      throw "A local ojeommwo-v2 runner lock is active; operating data promotion is blocked: $LockName"
    } finally {
      if ($null -ne $Handle) {
        $Handle.Dispose()
      }
    }
    }
  }

  if ($null -eq (Get-Command "Get-CimInstance" -ErrorAction SilentlyContinue)) {
    throw "Cannot verify the local interaction-listener process state; operating data promotion is blocked."
  }
  try {
    $ListenerProcesses = @(
      Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
        Where-Object {
          Test-OjeommwoLocalRuntimeProcess -Process $_
        }
    )
  } catch {
    throw "Cannot verify the local interaction-listener process state; operating data promotion is blocked: $($_.Exception.Message)"
  }
  if ($ListenerProcesses.Count -gt 0) {
    $ProcessIds = ($ListenerProcesses | ForEach-Object { [string]$_.ProcessId }) -join ", "
    throw "A local ojeommwo-v2 interaction listener is active; operating data promotion is blocked: PID $ProcessIds"
  }
}

function Write-StandbyManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$StageDirectory,
    [Parameter(Mandatory = $true)]$StoreDefinitions,
    [Parameter(Mandatory = $true)]$SourceSeal
  )

  $StoreHashes = @(
    foreach ($Store in $StoreDefinitions) {
      $StorePath = Join-Path $StageDirectory $Store.Name
      [ordered]@{
        name = $Store.Name
        sha256 = (Get-FileHash -LiteralPath $StorePath -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
  $Manifest = [ordered]@{
    version = 2
    source = $Source
    syncedAt = [DateTimeOffset]::UtcNow.ToString("o")
    release = [ordered]@{
      version = [string]$SourceSeal.release.version
      date = [string]$SourceSeal.release.date
      implementationModel = [string]$SourceSeal.release.implementationModel
      label = [string]$SourceSeal.release.label
    }
    sourceSeal = [ordered]@{
      algorithm = [string]$SourceSeal.sourceSeal.algorithm
      sha256 = [string]$SourceSeal.sourceSeal.sha256
      fileCount = [uint64]$SourceSeal.sourceSeal.fileCount
    }
    stores = @($StoreHashes)
  }
  $Json = $Manifest | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($Path, $Json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-TransactionalPromotion {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$StageDirectory,
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [Parameter(Mandatory = $true)]$StoreDefinitions,
    [Parameter(Mandatory = $true)][string]$ManifestStagePath,
    [Parameter(Mandatory = $true)][string]$AclProtectorPath
  )

  $DestinationDirectory = Join-Path $Root "data"
  if (-not (Test-Path -LiteralPath $DestinationDirectory -PathType Container)) {
    throw "Local data directory is missing; operating data promotion is blocked: $DestinationDirectory"
  }
  if (-not (Test-Path -LiteralPath $AclProtectorPath -PathType Leaf)) {
    throw "Local data ACL protector is missing: $AclProtectorPath"
  }

  Assert-LocalPromotionAllowed -Root $Root
  New-Item -ItemType Directory -Path $BackupDirectory | Out-Null
  $TransactionId = [guid]::NewGuid().ToString("N")
  $Definitions = @(
    foreach ($Store in $StoreDefinitions) {
      @{ Name = $Store.Name; StagePath = (Join-Path $StageDirectory $Store.Name) }
      # Keep the recovery copy at the same validated snapshot revision. A
      # stale pre-sync .bak could otherwise silently resurrect a cross-store
      # inconsistent state after a later primary parse failure.
      @{ Name = ($Store.Name + ".bak"); StagePath = (Join-Path $StageDirectory $Store.Name) }
    }
    @{ Name = "local-standby-manifest.json"; StagePath = $ManifestStagePath }
  )
  $Items = @()
  $Attempted = @()
  $RunnerLockHandles = @()

  try {
    foreach ($LockName in @("ojeommwo-v2-interactions.lock", "ojeommwo-v2-lunch.lock", "ojeommwo-v2-dinner.lock")) {
      $LockPath = Join-Path $env:TEMP $LockName
      try {
        $RunnerLockHandles += [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
      } catch [System.IO.IOException] {
        throw "A local runner acquired $LockName during promotion setup; operating data promotion is blocked."
      }
    }
    foreach ($Definition in $Definitions) {
      $Destination = Join-Path $DestinationDirectory $Definition.Name
      $Existed = Test-Path -LiteralPath $Destination -PathType Leaf
      if ((Test-Path -LiteralPath $Destination) -and -not $Existed) {
        throw "Operating data destination is not a regular file: $($Definition.Name)"
      }
      if ($Existed) {
        $DestinationItem = Get-Item -LiteralPath $Destination
        if (($DestinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "Operating data destination cannot be a reparse point: $($Definition.Name)"
        }
      }

      $BackupPath = Join-Path $BackupDirectory $Definition.Name
      $PromotionPath = Join-Path $DestinationDirectory (".ojeommwo-sync-$TransactionId-$($Definition.Name).tmp")
      $ReplacementDiscardPath = Join-Path $DestinationDirectory (".ojeommwo-replaced-$TransactionId-$($Definition.Name).bak")
      $RollbackDiscardPath = Join-Path $DestinationDirectory (".ojeommwo-rollback-replaced-$TransactionId-$($Definition.Name).bak")
      foreach ($TransactionPath in @($PromotionPath, $ReplacementDiscardPath, $RollbackDiscardPath)) {
        if (Test-Path -LiteralPath $TransactionPath) {
          throw "A unique operating-data transaction path already exists: $TransactionPath"
        }
      }
      $StageHash = (Get-FileHash -LiteralPath $Definition.StagePath -Algorithm SHA256).Hash
      $Items += [pscustomobject]@{
        Name = $Definition.Name
        Destination = $Destination
        BackupPath = $BackupPath
        PromotionPath = $PromotionPath
        ReplacementDiscardPath = $ReplacementDiscardPath
        RollbackDiscardPath = $RollbackDiscardPath
        ExpectedHash = $StageHash
        Existed = $Existed
      }

      if ($Existed) {
        Copy-Item -LiteralPath $Destination -Destination $BackupPath
        $OriginalHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
        $BackupHash = (Get-FileHash -LiteralPath $BackupPath -Algorithm SHA256).Hash
        if ($OriginalHash -cne $BackupHash) {
          throw "Failed to create a verified transaction backup: $($Definition.Name)"
        }
      }

      Copy-Item -LiteralPath $Definition.StagePath -Destination $PromotionPath
      $PromotionHash = (Get-FileHash -LiteralPath $PromotionPath -Algorithm SHA256).Hash
      if ($StageHash -cne $PromotionHash) {
        throw "Failed to create a verified same-volume promotion stage: $($Definition.Name)"
      }

    }

    try {
      Assert-LocalPromotionAllowed -Root $Root -SkipLockCheck
      foreach ($Item in $Items) {
        Assert-LocalPromotionAllowed -Root $Root -SkipLockCheck
        if ($Item.Existed) {
          if (-not (Test-Path -LiteralPath $Item.Destination -PathType Leaf)) {
            throw "Operating data destination disappeared after backup: $($Item.Name)"
          }
          $CurrentHash = (Get-FileHash -LiteralPath $Item.Destination -Algorithm SHA256).Hash
          $BackupHash = (Get-FileHash -LiteralPath $Item.BackupPath -Algorithm SHA256).Hash
          if ($CurrentHash -cne $BackupHash) {
            throw "Operating data destination changed after backup: $($Item.Name)"
          }
        } elseif (Test-Path -LiteralPath $Item.Destination) {
          throw "Operating data destination appeared after staging: $($Item.Name)"
        }

        $Attempted += $Item
        if ($Item.Existed) {
          [System.IO.File]::Replace(
            $Item.PromotionPath,
            $Item.Destination,
            $Item.ReplacementDiscardPath,
            $true
          )
          if (-not (Test-Path -LiteralPath $Item.ReplacementDiscardPath -PathType Leaf)) {
            throw "Atomic replacement did not preserve its discard backup: $($Item.Name)"
          }
          $DiscardHash = (Get-FileHash -LiteralPath $Item.ReplacementDiscardPath -Algorithm SHA256).Hash
          $BackupHash = (Get-FileHash -LiteralPath $Item.BackupPath -Algorithm SHA256).Hash
          if ($DiscardHash -cne $BackupHash) {
            throw "Atomic replacement discard backup does not match the verified transaction backup: $($Item.Name)"
          }
        } else {
          [System.IO.File]::Move($Item.PromotionPath, $Item.Destination)
        }
        $PromotedHash = (Get-FileHash -LiteralPath $Item.Destination -Algorithm SHA256).Hash
        if ($PromotedHash -cne $Item.ExpectedHash) {
          throw "Promoted operating data hash mismatch: $($Item.Name)"
        }
      }
      foreach ($Store in $StoreDefinitions) {
        $PrimaryPath = Join-Path $DestinationDirectory $Store.Name
        $RecoveryPath = $PrimaryPath + ".bak"
        $PrimaryHash = (Get-FileHash -LiteralPath $PrimaryPath -Algorithm SHA256).Hash
        $RecoveryHash = (Get-FileHash -LiteralPath $RecoveryPath -Algorithm SHA256).Hash
        if ($PrimaryHash -cne $RecoveryHash) {
          throw "Promoted recovery copy does not match its primary store: $($Store.Name)"
        }
      }
      # ACL hardening and exact verification are part of the content
      # transaction and run before the runner handles are released.
      & $AclProtectorPath -ProjectRoot $Root -DataDir $DestinationDirectory | Out-Null
    } catch {
      $OriginalMessage = $_.Exception.Message
      $RollbackErrors = @()
      for ($Index = $Attempted.Count - 1; $Index -ge 0; $Index -= 1) {
        $Item = $Attempted[$Index]
        try {
          if ($Item.Existed) {
            $RollbackPath = Join-Path $DestinationDirectory (".ojeommwo-rollback-$TransactionId-$($Item.Name).tmp")
            Copy-Item -LiteralPath $Item.BackupPath -Destination $RollbackPath -Force
            if (Test-Path -LiteralPath $Item.Destination -PathType Leaf) {
              [System.IO.File]::Replace(
                $RollbackPath,
                $Item.Destination,
                $Item.RollbackDiscardPath,
                $true
              )
            } else {
              [System.IO.File]::Move($RollbackPath, $Item.Destination)
            }
            $RestoredHash = (Get-FileHash -LiteralPath $Item.Destination -Algorithm SHA256).Hash
            $BackupHash = (Get-FileHash -LiteralPath $Item.BackupPath -Algorithm SHA256).Hash
            if ($RestoredHash -cne $BackupHash) {
              throw "restored hash does not match the transaction backup"
            }
          } elseif (Test-Path -LiteralPath $Item.Destination) {
            Remove-Item -LiteralPath $Item.Destination -Force
          }
        } catch {
          $RollbackErrors += "$($Item.Name): $($_.Exception.Message)"
        }
      }
      foreach ($Item in $Items) {
        Remove-Item -LiteralPath $Item.PromotionPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $Item.ReplacementDiscardPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $Item.RollbackDiscardPath -Force -ErrorAction SilentlyContinue
        $RollbackPath = Join-Path $DestinationDirectory (".ojeommwo-rollback-$TransactionId-$($Item.Name).tmp")
        Remove-Item -LiteralPath $RollbackPath -Force -ErrorAction SilentlyContinue
      }
      try {
        & $AclProtectorPath -ProjectRoot $Root -DataDir $DestinationDirectory | Out-Null
      } catch {
        $RollbackErrors += "ACL: $($_.Exception.Message)"
      }
      if ($RollbackErrors.Count -gt 0) {
        throw "Operating data promotion failed and rollback was incomplete. Original error: $OriginalMessage. Rollback errors: $($RollbackErrors -join '; ')"
      }
      throw "Operating data promotion failed and was fully rolled back: $OriginalMessage"
    }
  } finally {
    foreach ($Item in $Items) {
      Remove-Item -LiteralPath $Item.PromotionPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $Item.ReplacementDiscardPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $Item.RollbackDiscardPath -Force -ErrorAction SilentlyContinue
      $RollbackPath = Join-Path $DestinationDirectory (".ojeommwo-rollback-$TransactionId-$($Item.Name).tmp")
      Remove-Item -LiteralPath $RollbackPath -Force -ErrorAction SilentlyContinue
    }
    foreach ($Handle in $RunnerLockHandles) {
      $Handle.Dispose()
    }
    foreach ($LockName in @("ojeommwo-v2-interactions.lock", "ojeommwo-v2-lunch.lock", "ojeommwo-v2-dinner.lock")) {
      Remove-Item -LiteralPath (Join-Path $env:TEMP $LockName) -Force -ErrorAction SilentlyContinue
    }
  }
}

# Dot-sourcing is supported for the executable Windows transaction tests below.
# Normal script invocation continues into the remote snapshot workflow.
if ($MyInvocation.InvocationName -eq '.') {
  return
}

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
  throw "ProjectRoot must be an existing directory."
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$FailoverCommonPath = Join-Path $ProjectRoot "scripts\local-failover-common.ps1"
if (-not (Test-Path -LiteralPath $FailoverCommonPath -PathType Leaf)) {
  throw "Local failover process classifier is missing: $FailoverCommonPath"
}
. $FailoverCommonPath
if ($SshTarget -cnotmatch '^[A-Za-z0-9._@-]+$') {
  throw "SshTarget contains unsupported characters."
}
$RemoteRoot = $RemoteRoot.TrimEnd('/')
if ($RemoteRoot -cnotmatch '^/[A-Za-z0-9._/-]+$' -or $RemoteRoot -match '(^|/)\.\.?(/|$)') {
  throw "RemoteRoot must be a simple absolute POSIX path without dot segments."
}
if (-not $env:TEMP -or -not (Test-Path -LiteralPath $env:TEMP -PathType Container)) {
  throw "A valid TEMP directory is required."
}

$SshCommand = Get-Command "ssh.exe" -ErrorAction Stop
$ScpCommand = Get-Command "scp.exe" -ErrorAction Stop
$NodeExe = Resolve-NodeExecutable
$ValidatorPath = Join-Path $ProjectRoot "scripts\validate-operating-snapshot.js"
if (-not (Test-Path -LiteralPath $ValidatorPath -PathType Leaf)) {
  throw "Operating snapshot validator is missing: $ValidatorPath"
}
$ReadinessPath = Join-Path $ProjectRoot "scripts\check-local-emergency-readiness.js"
if (-not (Test-Path -LiteralPath $ReadinessPath -PathType Leaf)) {
  throw "Local emergency readiness checker is missing: $ReadinessPath"
}
$SourceSealGenerator = Join-Path $ProjectRoot "scripts\generate-source-seal.js"
if (-not (Test-Path -LiteralPath $SourceSealGenerator -PathType Leaf)) {
  throw "Application source-seal generator is missing: $SourceSealGenerator"
}
$AclProtector = Join-Path $ProjectRoot "scripts\protect-local-data-acl.ps1"
if (-not (Test-Path -LiteralPath $AclProtector -PathType Leaf)) {
  throw "Local data ACL protector is missing: $AclProtector"
}

$OperationId = [guid]::NewGuid().ToString("N")
$StageRoot = Join-Path $env:TEMP ("ojeommwo-operating-sync-$OperationId")
$BackupRoot = Join-Path $StageRoot "transaction-backups"
$RemoteSnapshotDir = "/tmp/ojeommwo-operating-snapshot-$OperationId"
$RemoteDataDir = $RemoteRoot + "/data"

$RemoteScript = @'
set -eu
umask 077
root='__ROOT__'
src='__SOURCE__'
dst='__SNAPSHOT__'
required='recommendation-history.json sent-messages.json meal-events.json verified-candidates.json candidate-preferences.json coffee-participation.json'
seal_generator="$root/scripts/generate-source-seal.js"

rm -rf -- "$dst"
mkdir -m 700 -- "$dst"
trap 'status=$?; if [ "$status" -ne 0 ]; then rm -rf -- "$dst"; fi' 0
trap 'exit 130' 1 2 15

[ -f "$seal_generator" ] && [ ! -L "$seal_generator" ] || {
  echo 'deployed source-seal generator is missing or unsafe' >&2
  exit 19
}
node "$seal_generator" --root "$root" --output "$dst/SOURCE-SEAL.before.json"

: > "$dst/.source-before"
for name in $required; do
  if [ ! -f "$src/$name" ]; then
    echo "missing required operating store: $name" >&2
    exit 20
  fi
  hash=$(sha256sum -- "$src/$name" | awk '{print $1}')
  printf '%s  %s\n' "$hash" "$name" >> "$dst/.source-before"
done

outbox_present=0
if [ -e "$src/delivery-outbox.json" ]; then
  if [ ! -f "$src/delivery-outbox.json" ]; then
    echo "delivery-outbox.json exists but is not a regular file" >&2
    exit 21
  fi
  outbox_present=1
  hash=$(sha256sum -- "$src/delivery-outbox.json" | awk '{print $1}')
  printf '%s  %s\n' "$hash" 'delivery-outbox.json' >> "$dst/.source-before"
fi

for name in $required; do
  cp -- "$src/$name" "$dst/$name"
done
if [ "$outbox_present" -eq 1 ]; then
  cp -- "$src/delivery-outbox.json" "$dst/delivery-outbox.json"
else
  printf '%s\n' '{"version":1,"deliveries":[]}' > "$dst/delivery-outbox.json"
fi

: > "$dst/.source-after"
for name in $required; do
  if [ ! -f "$src/$name" ]; then
    echo "required operating store changed type during snapshot: $name" >&2
    exit 22
  fi
  hash=$(sha256sum -- "$src/$name" | awk '{print $1}')
  printf '%s  %s\n' "$hash" "$name" >> "$dst/.source-after"
done
if [ "$outbox_present" -eq 1 ]; then
  if [ ! -f "$src/delivery-outbox.json" ]; then
    echo "delivery-outbox.json disappeared during snapshot" >&2
    exit 23
  fi
  hash=$(sha256sum -- "$src/delivery-outbox.json" | awk '{print $1}')
  printf '%s  %s\n' "$hash" 'delivery-outbox.json' >> "$dst/.source-after"
elif [ -e "$src/delivery-outbox.json" ]; then
  echo "delivery-outbox.json appeared during snapshot" >&2
  exit 24
fi

if ! cmp -s -- "$dst/.source-before" "$dst/.source-after"; then
  echo "operating stores changed while the snapshot was being created" >&2
  exit 25
fi

while read -r expected name; do
  actual=$(sha256sum -- "$dst/$name" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    echo "snapshot copy hash mismatch: $name" >&2
    exit 26
  fi
done < "$dst/.source-before"

node "$seal_generator" --root "$root" --output "$dst/SOURCE-SEAL.after.json"
if ! cmp -s -- "$dst/SOURCE-SEAL.before.json" "$dst/SOURCE-SEAL.after.json"; then
  echo 'application source changed while the operating snapshot was being created' >&2
  exit 27
fi
mv -- "$dst/SOURCE-SEAL.before.json" "$dst/SOURCE-SEAL.json"
rm -f -- "$dst/SOURCE-SEAL.after.json"

: > "$dst/SHA256SUMS"
for name in $required delivery-outbox.json SOURCE-SEAL.json; do
  hash=$(sha256sum -- "$dst/$name" | awk '{print $1}')
  printf '%s  %s\n' "$hash" "$name" >> "$dst/SHA256SUMS"
done
rm -f -- "$dst/.source-before" "$dst/.source-after"
trap - 0 1 2 15
'@
$RemoteScript = $RemoteScript.Replace("__ROOT__", $RemoteRoot).Replace("__SOURCE__", $RemoteDataDir).Replace("__SNAPSHOT__", $RemoteSnapshotDir)
$RemoteScriptBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($RemoteScript))
$RemoteCommand = "printf '%s' '$RemoteScriptBase64' | base64 -d | sh"

$OwnsStateTransitionLock = $null -eq $ExistingStateTransitionLock
$StateTransitionLock = if ($OwnsStateTransitionLock) {
  Enter-OjeommwoStateTransitionLock -ProjectRoot $ProjectRoot
} else {
  if ($ExistingStateTransitionLock.SafeFileHandle.IsInvalid -or $ExistingStateTransitionLock.SafeFileHandle.IsClosed) {
    throw "ExistingStateTransitionLock must be a live state-transition lock handle."
  }
  $ExistingStateTransitionLock
}
try {
  New-Item -ItemType Directory -Path $StageRoot | Out-Null
  $SshArguments = @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    $SshTarget,
    $RemoteCommand
  )
  Invoke-NativeChecked -FilePath $SshCommand.Source -Arguments $SshArguments `
    -FailureMessage "Failed to create a hash-stable remote operating snapshot"

  foreach ($Name in @($Stores | ForEach-Object { $_.Name }) + @("SOURCE-SEAL.json", "SHA256SUMS")) {
    $RemotePath = "${SshTarget}:$RemoteSnapshotDir/$Name"
    $StagePath = Join-Path $StageRoot $Name
    $ScpArguments = @(
      "-q",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      $RemotePath,
      $StagePath
    )
    Invoke-NativeChecked -FilePath $ScpCommand.Source -Arguments $ScpArguments `
      -FailureMessage "Failed to copy remote operating snapshot file $Name"
  }

  Assert-DownloadedHashes -StageDirectory $StageRoot -StoreDefinitions $Stores
  $RemoteSourceSealPath = Join-Path $StageRoot "SOURCE-SEAL.json"
  $LocalSourceSealPath = Join-Path $StageRoot "LOCAL-SOURCE-SEAL.json"
  $LocalSourceSeal = Get-OjeommwoLocalSourceSeal -ProjectRoot $ProjectRoot -OutputPath $LocalSourceSealPath
  $RemoteSourceSealHash = (Get-FileHash -LiteralPath $RemoteSourceSealPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $LocalSourceSealHash = (Get-FileHash -LiteralPath $LocalSourceSealPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($RemoteSourceSealHash -cne $LocalSourceSealHash) {
    throw "Deployed server application release/source seal does not match this local emergency copy. Deploy or restore the exact same source before syncing operating data."
  }
  Invoke-NativeChecked -FilePath $NodeExe `
    -Arguments @($ValidatorPath, "--data-dir", $StageRoot) `
    -FailureMessage "Downloaded operating snapshot failed deep validation"
  $ReadinessNow = [DateTimeOffset]::Now
  $ReadinessExpiresAt = $ReadinessNow.AddHours(24)
  Invoke-NativeChecked -FilePath $NodeExe `
    -Arguments @(
      $ReadinessPath,
      "--data-dir", $StageRoot,
      "--now", $ReadinessNow.ToString("o"),
      "--lease-expires-at", $ReadinessExpiresAt.ToString("o")
    ) `
    -FailureMessage "Downloaded operating snapshot cannot cover a fresh 24-hour local emergency lease"

  if ($DryRun) {
    Write-Output "Operating data sync dry-run passed; the deployed release/source seal matches locally, the remote snapshot is hash-stable, deep-valid, and ready for a fresh 24-hour emergency lease; no local operating files were changed."
  } else {
    Assert-LocalPromotionAllowed -Root $ProjectRoot
    $ManifestStagePath = Join-Path $StageRoot "local-standby-manifest.json"
    Write-StandbyManifest `
      -Path $ManifestStagePath `
      -Source "${SshTarget}:$RemoteDataDir" `
      -StageDirectory $StageRoot `
      -StoreDefinitions $Stores `
      -SourceSeal $LocalSourceSeal
    Invoke-TransactionalPromotion `
      -Root $ProjectRoot `
      -StageDirectory $StageRoot `
      -BackupDirectory $BackupRoot `
      -StoreDefinitions $Stores `
      -ManifestStagePath $ManifestStagePath `
      -AclProtectorPath $AclProtector
    $CandidateProvenancePath = Join-Path $ProjectRoot "data\local-emergency-candidate-provenance.json"
    Remove-Item -LiteralPath $CandidateProvenancePath -Force -ErrorAction SilentlyContinue
    Write-Output "Operating data sync passed: $($Stores.Count) stores were atomically promoted from a hash-stable snapshot at $SshTarget."
  }
} finally {
  try {
    $RemoteCleanupArguments = @(
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      $SshTarget,
      "rm -rf -- '$RemoteSnapshotDir'"
    )
    $CleanupExitCode = Invoke-NativeQuietly -FilePath $SshCommand.Source -Arguments $RemoteCleanupArguments
    if ($CleanupExitCode -ne 0) {
      Write-Warning "Remote temporary snapshot cleanup could not be confirmed: $RemoteSnapshotDir"
    }

    $ResolvedTemp = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $ResolvedStage = [System.IO.Path]::GetFullPath($StageRoot)
    if ($ResolvedStage.StartsWith($ResolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $ResolvedStage) -like "ojeommwo-operating-sync-*") {
      Remove-Item -LiteralPath $ResolvedStage -Recurse -Force -ErrorAction SilentlyContinue
    }
  } finally {
    if ($OwnsStateTransitionLock) {
      Exit-OjeommwoStateTransitionLock -Handle $StateTransitionLock
    }
  }
}
