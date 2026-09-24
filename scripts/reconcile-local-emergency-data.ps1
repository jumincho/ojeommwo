param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$SshTarget = "pororo-docker",
  [string]$RemoteRoot = "/root/ojeommwo-v2",
  [ValidateRange(1, 168)]
  [int]$MaxManifestAgeHours = 72,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$LocalSourceSealPath = $null
$StoreNames = @(
  "recommendation-history.json",
  "sent-messages.json",
  "meal-events.json",
  "verified-candidates.json",
  "candidate-preferences.json",
  "coffee-participation.json",
  "delivery-outbox.json"
)

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )
  $Previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments | Out-Host
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $Previous
  }
  if ($ExitCode -ne 0) { throw "$FailureMessage (exit code $ExitCode)." }
}

function Invoke-NativeQuietly {
  param([string]$FilePath, [string[]]$Arguments)
  $Previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments *> $null
    return $LASTEXITCODE
  } catch {
    return -1
  } finally {
    $ErrorActionPreference = $Previous
  }
}

function Get-RemoteListenerShellFunctions {
  return @'
listener_pids() {
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    cmdline=$(tr '\000' '\n' <"$proc/cmdline" 2>/dev/null) || continue
    cmd0=$(printf '%s\n' "$cmdline" | sed -n '1p')
    cmd1=$(printf '%s\n' "$cmdline" | sed -n '2p')
    case "${cmd0##*/}" in node|nodejs) ;; *) continue ;; esac
    [ "$cmd1" = 'scripts/run-interaction-listener.js' ] || continue
    [ "$(readlink -f "$proc/cwd" 2>/dev/null || true)" = "$root" ] || continue
    printf '%s\n' "${proc##*/}"
  done
}
listener_count() {
  count=0
  for pid in $(listener_pids); do count=$((count + 1)); done
  printf '%s\n' "$count"
}
stop_listener() {
  pids=$(listener_pids)
  [ -z "$pids" ] || kill -TERM $pids 2>/dev/null || true
  attempt=0
  while [ "$(listener_count)" -ne 0 ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 20 ]; then
      pids=$(listener_pids)
      [ -z "$pids" ] || kill -KILL $pids 2>/dev/null || true
    fi
    [ "$attempt" -le 40 ] || return 1
    sleep 0.25
  done
}
start_listener() {
  count=$(listener_count)
  [ "$count" -le 1 ] || return 1
  if [ "$count" -eq 0 ]; then
    (cd "$root" && exec 5>&- 6>&- 7>&- 8>&- && nohup ./scripts/run-interaction-listener.sh >/dev/null 2>&1 </dev/null &)
  fi
  attempt=0
  while :; do
    count=$(listener_count)
    [ "$count" -eq 1 ] && return 0
    [ "$count" -le 1 ] || return 1
    attempt=$((attempt + 1)); [ "$attempt" -le 40 ] || return 1
    sleep 0.25
  done
}
'@
}

function Ensure-RemoteInteractionListener {
  param(
    [Parameter(Mandatory = $true)][string]$SshExecutable,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $Script = @'
set -eu
root='__ROOT__'
__LISTENER_FUNCTIONS__
start_listener || { echo 'interaction listener did not become healthy exactly once' >&2; exit 42; }
'@
  $Script = $Script.Replace("__ROOT__", $Root).Replace("__LISTENER_FUNCTIONS__", (Get-RemoteListenerShellFunctions))
  $Base64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Script))
  Invoke-NativeChecked -FilePath $SshExecutable -Arguments @(
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", $Target,
    "printf '%s' '$Base64' | base64 -d | sh"
  ) -FailureMessage "The remote interaction listener could not be restored to exactly one process"
}

function Resolve-NodeExecutable {
  if ($env:OJEOMMWO_NODE_EXE -and (Test-Path -LiteralPath $env:OJEOMMWO_NODE_EXE -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $env:OJEOMMWO_NODE_EXE).Path
  }
  $Node = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($Node) { return $Node.Source }
  $Bundled = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $Bundled -PathType Leaf) { return $Bundled }
  throw "Node.js was not found. Set OJEOMMWO_NODE_EXE to a stable Node 22+ executable."
}

function Assert-NoLocalEmergencyRuntime {
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot "data\local-emergency-lease.json")) {
    throw "Local emergency lease still exists. Disable local emergency mode before reconciliation."
  }
  if ($null -eq (Get-Command "Get-ScheduledTask" -ErrorAction SilentlyContinue)) {
    throw "Cannot verify local scheduled tasks; reconciliation is blocked."
  }
  $Tasks = @(Get-ScheduledTask -TaskName "ojeommwo-v2*" -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.State -ne "Disabled" })
  if ($Tasks.Count -gt 0) {
    throw "Local ojeommwo-v2 scheduled tasks are still active; reconciliation is blocked."
  }
  $Processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
    Where-Object {
      [int]$_.ProcessId -ne $PID -and
      (Test-OjeommwoLocalRuntimeProcess -Process $_ -IncludeMealRunner)
    })
  if ($Processes.Count -gt 0) {
    throw "Local emergency processes are still running; reconciliation is blocked: $((@($Processes.ProcessId) -join ', '))."
  }
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
if ($SshTarget -cnotmatch '^[A-Za-z0-9._@-]+$') { throw "SshTarget contains unsupported characters." }
$RemoteRoot = $RemoteRoot.TrimEnd('/')
if ($RemoteRoot -cnotmatch '^/[A-Za-z0-9._/-]+$' -or $RemoteRoot -match '(^|/)\.\.?(/|$)') {
  throw "RemoteRoot must be a simple absolute POSIX path without dot segments."
}
if (-not $env:TEMP -or -not (Test-Path -LiteralPath $env:TEMP -PathType Container)) {
  throw "A valid TEMP directory is required."
}

$StateTransitionLock = Enter-OjeommwoStateTransitionLock -ProjectRoot $ProjectRoot
try {
Assert-NoLocalEmergencyRuntime
$DataDir = Join-Path $ProjectRoot "data"
$ManifestPath = Join-Path $DataDir "local-standby-manifest.json"
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Local standby provenance is missing. Reconciliation cannot prove that local data originated from the server."
}
try {
  $Manifest = ConvertFrom-OjeommwoJson -Json (Get-Content -Raw -LiteralPath $ManifestPath)
  $SyncedAt = [DateTimeOffset]::Parse([string]$Manifest.syncedAt)
} catch {
  throw "Local standby provenance is invalid: $($_.Exception.Message)"
}
$ExpectedSource = "${SshTarget}:$RemoteRoot/data"
if ($Manifest.version -ne 2) {
  throw "Local standby provenance must use version 2 release/source identity. Run a fresh server sync."
}
if ([string]$Manifest.source -cne $ExpectedSource -or
    $SyncedAt -gt [DateTimeOffset]::Now.AddMinutes(5) -or
    [DateTimeOffset]::Now - $SyncedAt -gt [TimeSpan]::FromHours($MaxManifestAgeHours)) {
  throw "Local standby provenance is stale or does not match $ExpectedSource."
}
Assert-LocalEmergencyCandidateSnapshot -ProjectRoot $ProjectRoot -Manifest $Manifest | Out-Null
foreach ($Name in $StoreNames) {
  if (-not (Test-Path -LiteralPath (Join-Path $DataDir $Name) -PathType Leaf)) {
    throw "Local emergency snapshot is missing $Name."
  }
}

$NodeExe = Resolve-NodeExecutable
$Validator = Join-Path $ProjectRoot "scripts\validate-operating-snapshot.js"
Invoke-NativeChecked -FilePath $NodeExe -Arguments @($Validator, "--data-dir", $DataDir) `
  -FailureMessage "Local emergency operating data failed deep validation"

$Ssh = Get-Command "ssh.exe" -ErrorAction Stop
$Scp = Get-Command "scp.exe" -ErrorAction Stop
$OperationId = [guid]::NewGuid().ToString("N")
$LocalSourceSealPath = Join-Path $env:TEMP ("ojeommwo-reconcile-source-seal-$OperationId.json")
$CurrentSourceSeal = Get-OjeommwoLocalSourceSeal -ProjectRoot $ProjectRoot -OutputPath $LocalSourceSealPath
Assert-OjeommwoManifestReleaseSourceSeal `
  -ProjectRoot $ProjectRoot -Manifest $Manifest -CurrentSeal $CurrentSourceSeal | Out-Null
$RemoteWork = "/tmp/ojeommwo-emergency-reconcile-$OperationId"
$RemoteData = "$RemoteRoot/data"
$DryRunValue = if ($DryRun) { "1" } else { "0" }
$RemoteMutationAttempted = $false
$RemoteListenerHealthy = [bool]$DryRun

$SetupScript = "set -eu; umask 077; rm -rf -- '$RemoteWork'; mkdir -m 700 -p -- '$RemoteWork/local'"
$SetupBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($SetupScript))
Invoke-NativeChecked -FilePath $Ssh.Source -Arguments @(
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", $SshTarget,
  "printf '%s' '$SetupBase64' | base64 -d | sh"
) -FailureMessage "Failed to prepare remote reconciliation staging"

try {
  foreach ($Name in $StoreNames) {
    Invoke-NativeChecked -FilePath $Scp.Source -Arguments @(
      "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
      (Join-Path $DataDir $Name), "${SshTarget}:$RemoteWork/local/$Name"
    ) -FailureMessage "Failed to upload local emergency store $Name"
  }
  Invoke-NativeChecked -FilePath $Scp.Source -Arguments @(
    "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
    $LocalSourceSealPath, "${SshTarget}:$RemoteWork/local/SOURCE-SEAL.json"
  ) -FailureMessage "Failed to upload the local application release/source seal"

  $RemoteScript = @'
set -eu
umask 077
root='__ROOT__'
work='__WORK__'
data="$root/data"
dry_run='__DRYRUN__'
stores='recommendation-history.json sent-messages.json meal-events.json verified-candidates.json candidate-preferences.json coffee-participation.json delivery-outbox.json'
maintenance="$data/.operating-maintenance"
seal_generator="$root/scripts/generate-source-seal.js"
__LISTENER_FUNCTIONS__
backup=''
promoted=''
committed=0
maintenance_owned=0

rollback() {
  [ -n "$backup" ] || return 0
  restore_failed=0
  for name in $stores; do
    if [ ! -f "$backup/$name.primary" ]; then
      restore_failed=1
      continue
    fi
    cp -- "$backup/$name.primary" "$data/.reconcile-rollback-$name.primary.tmp" || restore_failed=1
    chmod 600 "$data/.reconcile-rollback-$name.primary.tmp" || restore_failed=1
    mv -f -- "$data/.reconcile-rollback-$name.primary.tmp" "$data/$name" || restore_failed=1
    cmp -s -- "$backup/$name.primary" "$data/$name" || restore_failed=1
    if [ -f "$backup/$name.bak" ] && [ ! -e "$backup/$name.bak.absent" ]; then
      cp -- "$backup/$name.bak" "$data/.reconcile-rollback-$name.bak.tmp" || restore_failed=1
      chmod 600 "$data/.reconcile-rollback-$name.bak.tmp" || restore_failed=1
      mv -f -- "$data/.reconcile-rollback-$name.bak.tmp" "$data/$name.bak" || restore_failed=1
      cmp -s -- "$backup/$name.bak" "$data/$name.bak" || restore_failed=1
    elif [ -f "$backup/$name.bak.absent" ] && [ ! -e "$backup/$name.bak" ]; then
      rm -f -- "$data/$name.bak" || restore_failed=1
    else
      restore_failed=1
    fi
    rm -f -- "$data/.reconcile-$name.primary.tmp" "$data/.reconcile-$name.bak.tmp" \
      "$data/.reconcile-rollback-$name.primary.tmp" "$data/.reconcile-rollback-$name.bak.tmp" || restore_failed=1
  done
  return "$restore_failed"
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$committed" -ne 1 ]; then
    rollback || printf '%s\n' 'WARNING: reconciliation rollback was incomplete' >&2
  fi
  if [ "$maintenance_owned" -eq 1 ]; then rm -f -- "$maintenance"; fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup 0
trap 'exit 130' 1 2 15

for name in $stores; do
  [ -f "$work/local/$name" ] || { echo "missing uploaded local store: $name" >&2; exit 20; }
done
[ -f "$work/local/SOURCE-SEAL.json" ] && [ ! -L "$work/local/SOURCE-SEAL.json" ] || {
  echo 'uploaded local application release/source seal is missing or unsafe' >&2
  exit 20
}
[ -f "$seal_generator" ] && [ ! -L "$seal_generator" ] || {
  echo 'deployed source-seal generator is missing or unsafe' >&2
  exit 20
}
node "$seal_generator" --root "$root" --output "$work/server-source-seal.before.json"
cmp -s -- "$work/local/SOURCE-SEAL.json" "$work/server-source-seal.before.json" || {
  echo 'local emergency application release/source seal differs from the deployed server' >&2
  exit 20
}
node "$root/scripts/validate-operating-snapshot.js" --data-dir "$work/local"

if [ "$dry_run" -ne 1 ]; then
  if [ -e "$maintenance" ]; then echo 'operating maintenance is already active' >&2; exit 21; fi
  issued_at=$(date -u --iso-8601=seconds)
  ( set -C; printf '{"version":1,"operation":"local-emergency-reconciliation","token":"%s","issuedAt":"%s"}\n' \
    '__ID__' "$issued_at" > "$maintenance" ) 2>/dev/null || { echo 'could not acquire operating maintenance marker' >&2; exit 22; }
  maintenance_owned=1
  stop_listener || { echo 'exact interaction listener did not stop' >&2; exit 23; }
  command -v flock >/dev/null 2>&1 || { echo 'flock is required for reconciliation' >&2; exit 24; }
  exec 5>"$data/.candidate-refresh.lock"; flock -n 5 || { echo 'candidate refresh is active' >&2; exit 25; }
  exec 6>"$data/.scheduled-lunch.lock"; flock -n 6 || { echo 'lunch delivery is active' >&2; exit 26; }
  exec 7>"$data/.scheduled-dinner.lock"; flock -n 7 || { echo 'dinner delivery is active' >&2; exit 27; }
  exec 8>"$data/.interaction-listener.lock"; flock -n 8 || { echo 'interaction listener lock is active' >&2; exit 28; }
fi

node "$seal_generator" --root "$root" --output "$work/server-source-seal.after.json"
cmp -s -- "$work/local/SOURCE-SEAL.json" "$work/server-source-seal.after.json" || {
  echo 'deployed application source changed before reconciliation' >&2
  exit 28
}
cmp -s -- "$work/server-source-seal.before.json" "$work/server-source-seal.after.json" || {
  echo 'deployed application source was not stable during reconciliation setup' >&2
  exit 28
}

mkdir -m 700 -- "$work/server"
: > "$work/source-before"
for name in $stores; do
  [ -f "$data/$name" ] || { echo "server is missing required store: $name" >&2; exit 29; }
  hash=$(sha256sum -- "$data/$name" | awk '{print $1}')
  printf '%s  %s\n' "$hash" "$name" >> "$work/source-before"
  cp -- "$data/$name" "$work/server/$name"
done
: > "$work/source-after"
for name in $stores; do
  hash=$(sha256sum -- "$data/$name" | awk '{print $1}')
  printf '%s  %s\n' "$hash" "$name" >> "$work/source-after"
done
cmp -s -- "$work/source-before" "$work/source-after" || { echo 'server stores changed during snapshot' >&2; exit 30; }
while read -r expected name; do
  actual=$(sha256sum -- "$work/server/$name" | awk '{print $1}')
  [ "$actual" = "$expected" ] || { echo "server snapshot copy mismatch: $name" >&2; exit 31; }
done < "$work/source-before"
node "$root/scripts/validate-operating-snapshot.js" --data-dir "$work/server"
node "$root/scripts/merge-operating-snapshots.js" \
  --server-dir "$work/server" --local-dir "$work/local" --output-dir "$work/merged"

if [ "$dry_run" -eq 1 ]; then
  node "$seal_generator" --root "$root" --output "$work/server-source-seal.dry-run-final.json"
  cmp -s -- "$work/local/SOURCE-SEAL.json" "$work/server-source-seal.dry-run-final.json" || {
    echo 'deployed application source changed while the dry-run merge was being validated' >&2
    exit 31
  }
  echo 'Local emergency reconciliation dry-run passed; server data was not changed.'
  committed=1
  exit 0
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/root/ojeommwo-v2-backups/emergency-reconcile-$timestamp-__ID__"
mkdir -m 700 -p -- "$backup"
for name in $stores; do
  [ -f "$data/$name" ] && [ ! -L "$data/$name" ] || { echo "unsafe primary before reconciliation: $name" >&2; exit 32; }
  cp -- "$data/$name" "$backup/$name.primary"
  [ "$(sha256sum -- "$data/$name" | awk '{print $1}')" = "$(sha256sum -- "$backup/$name.primary" | awk '{print $1}')" ] \
    || { echo "primary backup verification failed: $name" >&2; exit 32; }
  if [ -e "$data/$name.bak" ]; then
    [ -f "$data/$name.bak" ] && [ ! -L "$data/$name.bak" ] || { echo "unsafe recovery copy before reconciliation: $name.bak" >&2; exit 32; }
    cp -- "$data/$name.bak" "$backup/$name.bak"
    [ "$(sha256sum -- "$data/$name.bak" | awk '{print $1}')" = "$(sha256sum -- "$backup/$name.bak" | awk '{print $1}')" ] \
      || { echo "recovery-copy backup verification failed: $name.bak" >&2; exit 32; }
  else
    : > "$backup/$name.bak.absent"
  fi
  cp -- "$work/merged/$name" "$data/.reconcile-$name.primary.tmp"
  cp -- "$work/merged/$name" "$data/.reconcile-$name.bak.tmp"
  chmod 600 "$data/.reconcile-$name.primary.tmp" "$data/.reconcile-$name.bak.tmp"
done
node "$seal_generator" --root "$root" --output "$work/server-source-seal.pre-promote.json"
cmp -s -- "$work/local/SOURCE-SEAL.json" "$work/server-source-seal.pre-promote.json" || {
  echo 'deployed application source changed before operating-data promotion' >&2
  exit 33
}
cmp -s -- "$work/server-source-seal.after.json" "$work/server-source-seal.pre-promote.json" || {
  echo 'deployed application source was not stable through reconciliation preparation' >&2
  exit 33
}
for name in $stores; do
  promoted="$name $promoted"
  mv -f -- "$data/.reconcile-$name.primary.tmp" "$data/$name"
  mv -f -- "$data/.reconcile-$name.bak.tmp" "$data/$name.bak"
  cmp -s -- "$data/$name" "$data/$name.bak" || { echo "promoted primary/recovery mismatch: $name" >&2; exit 33; }
done
node "$root/scripts/validate-operating-snapshot.js" --data-dir "$data"
committed=1
printf 'Local emergency data reconciled successfully; backup=%s\n' "$backup"
'@
  $RemoteScript = $RemoteScript.Replace("__ROOT__", $RemoteRoot).Replace("__WORK__", $RemoteWork).Replace("__DRYRUN__", $DryRunValue).Replace("__ID__", $OperationId).Replace("__LISTENER_FUNCTIONS__", (Get-RemoteListenerShellFunctions))
  $RemoteBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($RemoteScript))
  if (-not $DryRun) { $RemoteMutationAttempted = $true }
  Invoke-NativeChecked -FilePath $Ssh.Source -Arguments @(
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", $SshTarget,
    "printf '%s' '$RemoteBase64' | base64 -d | sh"
  ) -FailureMessage "Remote local-emergency reconciliation failed"

  if (-not $DryRun) {
    # Restore service availability before the optional local refresh. If the
    # refresh fails, the authoritative server must still remain operational.
    Ensure-RemoteInteractionListener -SshExecutable $Ssh.Source -Target $SshTarget -Root $RemoteRoot
    $RemoteListenerHealthy = $true
    $SyncScript = Join-Path $ProjectRoot "scripts\sync-operating-data-from-server.ps1"
    & $SyncScript -ProjectRoot $ProjectRoot -SshTarget $SshTarget -RemoteRoot $RemoteRoot `
      -ExistingStateTransitionLock $StateTransitionLock
  }
} finally {
  $ListenerRestoreError = $null
  if ($RemoteMutationAttempted -and -not $RemoteListenerHealthy) {
    # The remote transaction may have stopped the listener before failing.
    # Always make a final restoration attempt, while still letting a failure
    # surface as a hard operational error.
    try {
      Ensure-RemoteInteractionListener -SshExecutable $Ssh.Source -Target $SshTarget -Root $RemoteRoot
      $RemoteListenerHealthy = $true
    } catch {
      $ListenerRestoreError = $_
    }
  }
  $CleanupCode = Invoke-NativeQuietly -FilePath $Ssh.Source -Arguments @(
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", $SshTarget,
    "rm -rf -- '$RemoteWork'"
  )
  if ($CleanupCode -ne 0) { Write-Warning "Remote reconciliation staging cleanup could not be confirmed: $RemoteWork" }
  if ($ListenerRestoreError) {
    throw "Remote reconciliation failed and the interaction listener could not be restored: $($ListenerRestoreError.Exception.Message)"
  }
}
} finally {
  if ($LocalSourceSealPath) {
    Remove-Item -LiteralPath $LocalSourceSealPath -Force -ErrorAction SilentlyContinue
  }
  Exit-OjeommwoStateTransitionLock -Handle $StateTransitionLock
}
