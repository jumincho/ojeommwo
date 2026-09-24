param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$SshTarget = "ojeommwo@203.0.113.10",
  [ValidateRange(1, 65535)][int]$SshPort = 7777,
  [string]$RemoteRoot = "/root/ojeommwo-v2",
  [switch]$BotOnly,
  [switch]$ApplyTaxonomyMigration,
  [switch]$RepairCandidateReadiness,
  [string]$PreviousRecommendationsSha256 = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$HashCompatPath = Join-Path $PSScriptRoot "powershell-hash-compat.ps1"
if (-not (Test-Path -LiteralPath $HashCompatPath -PathType Leaf)) {
  throw "PowerShell hash compatibility helper is missing: $HashCompatPath"
}
. $HashCompatPath
$ExpectedRemoteRoot = "/root/ojeommwo-v2"
$DataContainer = "ojeommwo"

# This deploy must never send a test message to Slack. Its capability preflight
# is read-only, and candidate discovery remains on the independently fenced
# production refresh schedule. Any future live Slack delivery test must target
# the operator's personal DM instead of the lunch channel.

function ConvertTo-NativeArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $Builder = [System.Text.StringBuilder]::new()
  [void]$Builder.Append('"')
  $Backslashes = 0
  foreach ($Character in $Value.ToCharArray()) {
    if ($Character -eq '\') {
      $Backslashes += 1
      continue
    }
    if ($Character -eq '"') {
      [void]$Builder.Append(('\' * (($Backslashes * 2) + 1)))
      [void]$Builder.Append('"')
      $Backslashes = 0
      continue
    }
    if ($Backslashes -gt 0) {
      [void]$Builder.Append(('\' * $Backslashes))
      $Backslashes = 0
    }
    [void]$Builder.Append($Character)
  }
  if ($Backslashes -gt 0) {
    [void]$Builder.Append(('\' * ($Backslashes * 2)))
  }
  [void]$Builder.Append('"')
  return $Builder.ToString()
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage,
    [string]$StandardInput
  )
  $Previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($PSBoundParameters.ContainsKey("StandardInput")) {
      $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
      $StartInfo.FileName = $FilePath
      $StartInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument -Value $_ }) -join ' ')
      $StartInfo.UseShellExecute = $false
      $StartInfo.CreateNoWindow = $true
      $StartInfo.RedirectStandardInput = $true
      $StartInfo.RedirectStandardOutput = $true
      $StartInfo.RedirectStandardError = $true
      $Process = [System.Diagnostics.Process]::new()
      $Process.StartInfo = $StartInfo
      try {
        [void]$Process.Start()
        $StandardOutputTask = $Process.StandardOutput.ReadToEndAsync()
        $StandardErrorTask = $Process.StandardError.ReadToEndAsync()
        $InputBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($StandardInput)
        $Process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
        $Process.StandardInput.Close()
        $Process.WaitForExit()
        $StandardOutput = $StandardOutputTask.GetAwaiter().GetResult()
        $StandardError = $StandardErrorTask.GetAwaiter().GetResult()
        if ($StandardOutput) { Write-Host -NoNewline $StandardOutput }
        if ($StandardError) { [Console]::Error.Write($StandardError) }
        $ExitCode = $Process.ExitCode
      } finally {
        $Process.Dispose()
      }
    } else {
      & $FilePath @Arguments | Out-Host
      $ExitCode = $LASTEXITCODE
    }
  } finally {
    $ErrorActionPreference = $Previous
  }
  if ($null -eq $ExitCode -or $ExitCode -ne 0) {
    throw "$FailureMessage (exit code $ExitCode)."
  }
}

function Assert-NoReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  $Items = @(Get-Item -Force -LiteralPath $Path) + @(Get-ChildItem -Force -LiteralPath $Path -Recurse)
  foreach ($Item in $Items) {
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Deployment source cannot contain a reparse point: $($Item.FullName)"
    }
  }
}

function Copy-SourceEntry {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$DestinationRoot
  )
  $Source = Join-Path $SourceRoot $RelativePath
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Deployment source is missing: $Source"
  }
  Assert-NoReparsePoint -Path $Source
  $Destination = Join-Path $DestinationRoot $RelativePath
  $DestinationParent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $DestinationParent -PathType Container)) {
    New-Item -ItemType Directory -Path $DestinationParent | Out-Null
  }
  Copy-Item -Force -Recurse -LiteralPath $Source -Destination $Destination
}

function Assert-SourceOnlyTree {
  param([Parameter(Mandatory = $true)][string]$Root)
  $RootPrefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  foreach ($Item in Get-ChildItem -Force -LiteralPath $Root -Recurse) {
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Staged source cannot contain a reparse point: $($Item.FullName)"
    }
    $FullName = [System.IO.Path]::GetFullPath($Item.FullName)
    if (-not $FullName.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Staged source escaped its root: $FullName"
    }
    $Relative = $FullName.Substring($RootPrefix.Length).Replace('\', '/')
    $Segments = @($Relative -split '/')
    if ($Segments | Where-Object { $_ -in @(".env", "logs", "node_modules", ".next", "out", "runtime", ".git") }) {
      throw "Runtime or generated content entered the source archive: $Relative"
    }
    if ($Relative -match '^(data)(/|$)' -or $Relative -match '^observatory/data(/|$)') {
      throw "Operating data entered the source archive: $Relative"
    }
    if ($Relative -ceq "observatory/public/data/snapshot.json") {
      throw "Generated observatory snapshot entered the source archive: $Relative"
    }
  }
}

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
  throw "ProjectRoot must be an existing directory."
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$ObservatoryRoot = Join-Path $ProjectRoot "observatory"
if (-not $BotOnly -and -not (Test-Path -LiteralPath $ObservatoryRoot -PathType Container)) {
  throw "The integrated observatory source directory is missing: $ObservatoryRoot"
}
if ($SshTarget -cnotmatch '^[A-Za-z0-9._@-]+$') {
  throw "SshTarget contains unsupported characters."
}
if ($RemoteRoot -cne $ExpectedRemoteRoot) {
  throw "RemoteRoot must be exactly $ExpectedRemoteRoot"
}
if ($ApplyTaxonomyMigration) {
  if ($PreviousRecommendationsSha256 -cnotmatch '^[A-Fa-f0-9]{64}$') {
    throw "ApplyTaxonomyMigration requires the exact pre-migration recommendations.json SHA-256."
  }
  $PreviousRecommendationsSha256 = $PreviousRecommendationsSha256.ToLowerInvariant()
} elseif ($PreviousRecommendationsSha256) {
  throw "PreviousRecommendationsSha256 is valid only with ApplyTaxonomyMigration."
}
if (-not $env:TEMP -or -not (Test-Path -LiteralPath $env:TEMP -PathType Container)) {
  throw "A valid TEMP directory is required."
}

$BotSourceEntries = @(
  ".env.example", ".gitignore", "ARCHITECTURE.md", "HANDOFF.md", "package.json",
  "AGENTS.md", "MODEL_EVALUATION.md", "QUALITY_REPORT.md", "README.md", "RELEASES.md", "config", "prompts", "scripts", "src", "test"
)
$Ssh = (Get-Command "ssh.exe" -ErrorAction Stop).Source
$Scp = (Get-Command "scp.exe" -ErrorAction Stop).Source
$Tar = (Get-Command "tar.exe" -ErrorAction Stop).Source
$OperationId = [guid]::NewGuid().ToString("N")
$LocalStage = Join-Path $env:TEMP "ojeommwo-integrated-source-$OperationId"
$Archive = Join-Path $env:TEMP "ojeommwo-integrated-source-$OperationId.tar.gz"
$RemoteArchive = "/tmp/ojeommwo-integrated-source-$OperationId.tar.gz"
$BotSourcePassed = $false
$ExpectedCronPath = Join-Path $ProjectRoot "scripts\pororo-crontab.txt"
if (-not (Test-Path -LiteralPath $ExpectedCronPath -PathType Leaf)) {
  throw "Expected bot crontab contract is missing: $ExpectedCronPath"
}
$ExpectedCronText = (Get-Content -Raw -LiteralPath $ExpectedCronPath).Replace("`r`n", "`n").TrimEnd("`n")
$ExpectedCronBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($ExpectedCronText))
$FixtureNames = @(
  "holiday-skip-dates.json",
  "recommendations.json",
  "recommendations.sample.json"
)
$FixtureManifestLines = foreach ($FixtureName in $FixtureNames) {
  $FixturePath = Join-Path $ProjectRoot ("data\" + $FixtureName)
  if (-not (Test-Path -LiteralPath $FixturePath -PathType Leaf)) {
    throw "Required immutable local fixture is missing: $FixturePath"
  }
  $FixtureItem = Get-Item -LiteralPath $FixturePath
  if (($FixtureItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Immutable local fixture cannot be a reparse point: $FixturePath"
  }
  $FixtureHash = (Get-FileHash -LiteralPath $FixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
  "$FixtureHash  $FixtureName"
}
$FixtureManifestText = ($FixtureManifestLines -join "`n")
$FixtureManifestBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($FixtureManifestText))

try {
  New-Item -ItemType Directory -Path $LocalStage | Out-Null
  foreach ($Entry in $BotSourceEntries) {
    Copy-SourceEntry -SourceRoot $ProjectRoot -RelativePath $Entry -DestinationRoot $LocalStage
  }
  Assert-SourceOnlyTree -Root $LocalStage

  # The integrated transaction is bot-source-only. The verified live
  # observatory subtree is moved by same-filesystem rename during the root swap,
  # and a full deployment promotes new observatory source in its own transaction.
  $ArchiveEntries = @($BotSourceEntries)
  Invoke-NativeChecked -FilePath $Tar -Arguments (@("-czf", $Archive, "-C", $LocalStage) + $ArchiveEntries) `
    -FailureMessage "Integrated source archive creation failed"
  $ArchiveListing = @(& $Tar -tzf $Archive)
  if ($LASTEXITCODE -ne 0) { throw "Integrated source archive validation failed." }
  foreach ($Name in $ArchiveListing) {
    $Normalized = ([string]$Name).Replace('\', '/').TrimEnd('/')
    if (-not $Normalized) { continue }
    $Segments = @($Normalized -split '/')
    if ($Normalized.StartsWith('/') -or $Segments -contains ".." -or $Segments -contains ".") {
      throw "Integrated source archive contains an unsafe path."
    }
    if ($Segments | Where-Object { $_ -in @(".env", "logs", "node_modules", ".next", "out", "runtime", ".git") }) {
      throw "Integrated source archive contains runtime or generated content: $Normalized"
    }
    if ($Normalized -match '^data(/|$)' -or $Normalized -match '^observatory/data(/|$)') {
      throw "Integrated source archive contains operating data: $Normalized"
    }
    if ($Normalized -ceq "observatory/public/data/snapshot.json") {
      throw "Integrated source archive contains a generated observatory snapshot: $Normalized"
    }
    if ($Normalized -match '^observatory(/|$)') {
      throw "Integrated bot source archive contains nested observatory source: $Normalized"
    }
  }

  Invoke-NativeChecked -FilePath $Scp -Arguments @(
    "-q", "-P", [string]$SshPort, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
    $Archive, "${SshTarget}:$RemoteArchive"
  ) -FailureMessage "Integrated source upload failed"

  $ContainerScript = @'
set -eu
umask 077

  root=$1
  archive=$2
  operation_id=$3
  apply_taxonomy=$4
  previous_recommendations_sha=$5
  repair_candidate_readiness=$6
  expected_root=/root/ojeommwo-v2
parent=/root
observatory_runtime_link=../../.ojeommwo-v2-state/observatory
observatory_state=$parent/.ojeommwo-v2-state/observatory

verify_observatory_tree() {
  observatory=$1
  [ -d "$observatory" ] && [ ! -L "$observatory" ] \
    || { echo 'verified live observatory source is missing or unsafe' >&2; return 1; }
  [ -d "$observatory/public" ] && [ ! -L "$observatory/public" ] \
    || { echo 'verified live observatory public assets are missing or unsafe' >&2; return 1; }
  [ -d "$observatory/out" ] && [ ! -L "$observatory/out" ] \
    || { echo 'verified live observatory export is missing or unsafe' >&2; return 1; }
  for required in package.json VERSION run-pororo.sh scripts/deploy-pororo.ps1 out/index.html; do
    [ -f "$observatory/$required" ] && [ ! -L "$observatory/$required" ] \
      || { echo "verified live observatory file is missing or unsafe: $required" >&2; return 1; }
  done
  [ -L "$observatory/runtime" ] \
    && [ "$(readlink "$observatory/runtime")" = "$observatory_runtime_link" ] \
    || { echo 'verified live observatory runtime link is missing or unsafe' >&2; return 1; }
}

[ "$root" = "$expected_root" ] || { echo 'unsafe integrated deployment root' >&2; exit 64; }
case "$apply_taxonomy" in 0|1) ;; *) echo 'invalid taxonomy migration mode' >&2; exit 64 ;; esac
case "$repair_candidate_readiness" in
  0|1) ;;
  *) echo 'invalid candidate-readiness repair mode' >&2; exit 64 ;;
esac
if [ "$apply_taxonomy" -eq 1 ]; then
  case "$previous_recommendations_sha" in
    *[!0-9a-f]*|'') echo 'invalid pre-migration recommendations hash' >&2; exit 64 ;;
  esac
  [ "${#previous_recommendations_sha}" -eq 64 ] \
    || { echo 'invalid pre-migration recommendations hash length' >&2; exit 64; }
else
  [ -z "$previous_recommendations_sha" ] \
    || { echo 'unexpected pre-migration recommendations hash' >&2; exit 64; }
fi
case "$archive" in /tmp/ojeommwo-integrated-source-*.tar.gz) ;; *) echo 'unsafe container archive path' >&2; exit 64 ;; esac
case "$operation_id" in ''|*[!a-f0-9]*) echo 'unsafe operation id' >&2; exit 64 ;; esac
[ -d "$root" ] && [ ! -L "$root" ] || { echo 'integrated project root is unsafe' >&2; exit 64; }
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo 'integrated archive is unsafe' >&2; exit 64; }
command -v node >/dev/null 2>&1 || { echo 'Node.js is required in ojeommwo' >&2; exit 69; }
command -v flock >/dev/null 2>&1 || { echo 'flock is required in ojeommwo' >&2; exit 69; }
command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum is required in ojeommwo' >&2; exit 69; }
[ -d "$observatory_state" ] && [ ! -L "$observatory_state" ] \
  || { echo 'observatory state directory is missing or unsafe' >&2; exit 64; }
exec 4>"$observatory_state/.source-deploy.lock"
flock -n 4 || { echo 'another observatory source deployment is active' >&2; exit 73; }
verify_observatory_tree "$root/observatory" || exit 64
observatory_identity=$(stat -c '%d:%i' "$root/observatory")
expected_fixture_manifest="$(printf '%s' '__EXPECTED_FIXTURES__' | base64 -d)"

stage="$parent/.ojeommwo-v2-stage-$operation_id"
backup="$parent/.ojeommwo-v2-previous-$operation_id"
failed="$parent/.ojeommwo-v2-failed-$operation_id"
listing="$parent/.ojeommwo-v2-archive-$operation_id.list"
  test_log="$parent/.ojeommwo-v2-test-$operation_id.tap"
  operating_backup="$parent/.ojeommwo-v2-operating-backup-$operation_id"
  maintenance="$root/data/.operating-maintenance"
committed=0
root_moved=0
promoted=0
maintenance_owned=0
  listener_stopped=0
  operating_backup_ready=0
  moved_states=''

run_bot_tests() {
  test_root=$1
  rm -f -- "$test_log"
  if (cd "$test_root" && NODE_ENV=test node --import ./scripts/setup-node-environment.js --test test/*.test.js >"$test_log" 2>&1); then
    tail -n 8 "$test_log"
    rm -f -- "$test_log"
    return 0
  fi
  # Keep deployment output bounded while retaining the complete TAP diagnostic
  # block for every failed test.
  awk '
    /^not ok [0-9]+ - / { showing=1 }
    showing { print }
    showing && /^  \.\.\.$/ { showing=0 }
  ' "$test_log" >&2
  tail -n 10 "$test_log" >&2
  return 1
}

verify_static_fixtures() {
  phase=$1
  case "$phase" in pre|post) ;; *) echo 'invalid fixture verification phase' >&2; return 1 ;; esac
  seen=''
  count=0
  while IFS='  ' read -r expected name remainder; do
    [ -z "$remainder" ] || { echo 'invalid immutable fixture manifest row' >&2; return 1; }
    case "$expected" in *[!0-9a-f]*|'') echo 'invalid immutable fixture hash' >&2; return 1 ;; esac
    [ "${#expected}" -eq 64 ] || { echo 'invalid immutable fixture hash length' >&2; return 1; }
    case "$name" in
      holiday-skip-dates.json|recommendations.json|recommendations.sample.json) ;;
      *) echo "unexpected immutable fixture name: $name" >&2; return 1 ;;
    esac
    case " $seen " in *" $name "*) echo "duplicate immutable fixture: $name" >&2; return 1 ;; esac
    seen="$seen $name"
    count=$((count + 1))
    [ -f "$root/data/$name" ] && [ ! -L "$root/data/$name" ] || {
      echo "immutable server fixture is unsafe: $name" >&2; return 1
    }
    actual=$(sha256sum "$root/data/$name" | awk '{print $1}')
    if [ "$phase" = 'pre' ] && [ "$apply_taxonomy" -eq 1 ] && [ "$name" = 'recommendations.json' ]; then
      [ "$actual" = "$expected" ] || [ "$actual" = "$previous_recommendations_sha" ] || {
        echo "pre-migration recommendations hash is neither the audited source nor target" >&2; return 1
      }
    else
      [ "$actual" = "$expected" ] || {
        echo "immutable fixture hash differs from the audited local release: $name" >&2; return 1
      }
    fi
  done <<EOF_FIXTURES
$expected_fixture_manifest
EOF_FIXTURES
  [ "$count" -eq 3 ] || { echo "immutable fixture manifest count is $count, expected 3" >&2; return 1; }
}

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
    if [ "$attempt" -gt 40 ]; then
      pids=$(listener_pids)
      [ -z "$pids" ] || kill -KILL $pids 2>/dev/null || true
    fi
    [ "$attempt" -le 60 ] || return 1
    sleep 0.25
  done
}

start_listener() {
  count=$(listener_count)
  [ "$count" -le 1 ] || return 1
  if [ "$count" -eq 0 ]; then
    (
      cd "$root"
      # The long-running listener must not inherit any deployment lock. In
      # particular, inheriting fd 4 would retain the shared observatory source
      # lock after this deployment process exits.
      exec 4>&- 5>&- 6>&- 7>&- 8>&-
      nohup ./scripts/run-interaction-listener.sh >/dev/null 2>&1 </dev/null &
    )
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

restore_moved_states_from() {
  source_root=$1
  restore_state_failed=0
  # Preflight every destination before the first rename so a logical conflict
  # cannot split operating state across the recovery and live roots.
  for name in $moved_states; do
    if [ -e "$source_root/$name" ] || [ -L "$source_root/$name" ]; then
      if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then
        echo "cannot restore $name because the destination already exists" >&2
        restore_state_failed=1
      fi
    fi
  done
  [ "$restore_state_failed" -eq 0 ] || return "$restore_state_failed"
  for name in $moved_states; do
    if [ -e "$source_root/$name" ] || [ -L "$source_root/$name" ]; then
      mv -- "$source_root/$name" "$root/$name" || restore_state_failed=1
    fi
  done
  return "$restore_state_failed"
}

backup_operating_stores() {
  [ ! -e "$operating_backup" ] || { echo 'operating rollback path already exists' >&2; return 1; }
  mkdir -m 0700 -- "$operating_backup" || return 1
  [ -f "$root/.env" ] && [ ! -L "$root/.env" ] || return 1
  cp -- "$root/.env" "$operating_backup/.env" || return 1
  chmod 0600 "$operating_backup/.env" || return 1
  for name in recommendations.json recommendation-history.json sent-messages.json \
    meal-events.json candidate-preferences.json verified-candidates.json; do
    for suffix in '' '.bak'; do
      source="$root/data/$name$suffix"
      [ -f "$source" ] && [ ! -L "$source" ] \
        || { echo "operating rollback source is missing or unsafe: $name$suffix" >&2; return 1; }
      cp -- "$source" "$operating_backup/$name$suffix" || return 1
      chmod 0600 "$operating_backup/$name$suffix" || return 1
    done
  done
  operating_backup_ready=1
}

restore_operating_stores() {
  [ "$operating_backup_ready" -eq 1 ] || return 0
  [ -d "$root/data" ] && [ ! -L "$root/data" ] || return 1
  [ -f "$operating_backup/.env" ] && [ ! -L "$operating_backup/.env" ] || return 1
  cp -- "$operating_backup/.env" "$root/.env.rollback-$operation_id" || return 1
  chmod 0600 "$root/.env.rollback-$operation_id" || return 1
  mv -f -- "$root/.env.rollback-$operation_id" "$root/.env" || return 1
  for name in recommendations.json recommendation-history.json sent-messages.json \
    meal-events.json candidate-preferences.json verified-candidates.json; do
    for suffix in '' '.bak'; do
      source="$operating_backup/$name$suffix"
      target="$root/data/$name$suffix"
      temporary="$root/data/.deploy-rollback-$operation_id-$name$suffix.tmp"
      [ -f "$source" ] && [ ! -L "$source" ] || return 1
      cp -- "$source" "$temporary" || return 1
      chmod 0600 "$temporary" || return 1
      mv -f -- "$temporary" "$target" || return 1
    done
  done
  rm -rf -- "$root/data/migration-backups/taxonomy-deploy-$operation_id"
}

restore_previous() {
  restore_failed=0
  if [ "$promoted" -eq 1 ]; then
    stop_listener || restore_failed=1
    if ! mv -- "$root" "$failed"; then
      return 1
    fi
    if ! mv -- "$backup" "$root"; then
      restore_failed=1
      # Keep a complete promoted tree at the canonical root if the previous
      # source rename unexpectedly fails. The untouched backup remains for
      # manual recovery; never delete the only tree containing live state.
      if [ ! -e "$root" ]; then mv -- "$failed" "$root" || restore_failed=1; fi
      return "$restore_failed"
    fi
    if restore_moved_states_from "$failed"; then
      rm -rf -- "$failed" || restore_failed=1
    else
      restore_failed=1
    fi
  elif [ "$root_moved" -eq 1 ]; then
    mv -- "$backup" "$root" || restore_failed=1
    restore_moved_states_from "$stage" || restore_failed=1
  else
    restore_moved_states_from "$stage" || restore_failed=1
  fi
  return "$restore_failed"
}

reconcile_swap_state() {
  # Signals can arrive between an atomic rename and its bookkeeping assignment.
  # Reconstruct those two narrow states from the three transaction paths before
  # choosing a rollback branch.
  if [ ! -e "$root" ] && [ -d "$backup" ] && [ -d "$stage" ]; then
    root_moved=1
  fi
  if [ -d "$root" ] && [ -d "$backup" ] && [ ! -e "$stage" ]; then
    root_moved=1
    promoted=1
  fi
}

cleanup() {
  status=$?
  recovery_complete=1
  set +e
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$committed" -ne 1 ]; then
    reconcile_swap_state
    if ! restore_previous; then
      echo 'CRITICAL: integrated source rollback was incomplete' >&2
      status=74
      recovery_complete=0
    elif ! restore_operating_stores; then
      echo 'CRITICAL: operating-store rollback was incomplete' >&2
      status=74
      recovery_complete=0
    fi
    if [ "$maintenance_owned" -eq 1 ]; then rm -f -- "$root/data/.operating-maintenance"; fi
    flock -u 8 2>/dev/null; exec 8>&-
    if [ "$listener_stopped" -eq 1 ] && ! start_listener; then
      echo 'CRITICAL: previous interaction listener could not be restored exactly once' >&2
      status=74
    fi
  fi
  flock -u 5 2>/dev/null; exec 5>&-
  flock -u 6 2>/dev/null; exec 6>&-
  flock -u 7 2>/dev/null; exec 7>&-
  flock -u 8 2>/dev/null; exec 8>&-
  flock -u 4 2>/dev/null; exec 4>&-
  if [ "$recovery_complete" -eq 1 ]; then
    rm -rf -- "$stage"
    rm -rf -- "$operating_backup"
  else
    echo "CRITICAL: recovery paths were retained: $stage $backup $failed $operating_backup" >&2
  fi
  if [ "$committed" -eq 1 ]; then rm -rf -- "$backup"; fi
  rm -f -- "$archive" "$listing" "$test_log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ ! -e "$stage" ] && [ ! -e "$backup" ] && [ ! -e "$failed" ] || { echo 'unique deployment path already exists' >&2; exit 64; }
mkdir -m 0700 -- "$stage"
[ "$(stat -c %d "$root")" = "$(stat -c %d "$stage")" ] || { echo 'stage and live root are not on the same filesystem' >&2; exit 65; }
tar -tzf "$archive" >"$listing"
if grep -Eq '(^/|(^|/)\.\.(/|$)|(^|/)\.(/|$))' "$listing"; then
  echo 'deployment archive contains path traversal' >&2; exit 65
fi
if grep -Eq '(^|/)(\.env|logs|node_modules|\.next|out|runtime|\.git)(/|$)' "$listing"; then
  echo 'deployment archive contains runtime or generated content' >&2; exit 65
fi
if grep -Eq '^(data|observatory/data)(/|$)' "$listing"; then
  echo 'deployment archive contains operating data' >&2; exit 65
fi
if grep -Eq '^observatory/public/data/snapshot\.json/?$' "$listing"; then
  echo 'deployment archive contains a generated observatory snapshot' >&2; exit 65
fi
if grep -Eq '^observatory(/|$)' "$listing"; then
  echo 'integrated bot archive contains nested observatory source' >&2; exit 65
fi
tar -xzf "$archive" -C "$stage"
for required in package.json src/config.js scripts/check-syntax.js scripts/run-interaction-listener.sh test/integrated-deploy.test.js; do
  [ -e "$stage/$required" ] || { echo "staged source is missing $required" >&2; exit 66; }
done
for forbidden in .env data logs node_modules .next out runtime .git observatory; do
  [ ! -e "$stage/$forbidden" ] || { echo "staged source contains forbidden content: $forbidden" >&2; exit 66; }
done

root_uid=$(stat -c %u "$root")
root_gid=$(stat -c %g "$root")
root_mode=$(stat -c %a "$root")
case "$root_mode" in
  700|750) ;;
  *) echo "live source root has unsafe mode $root_mode" >&2; exit 66 ;;
esac
unsafe_entry=$(find "$stage" ! -type d ! -type f -print -quit)
[ -z "$unsafe_entry" ] || { echo "staged source contains a non-regular entry: $unsafe_entry" >&2; exit 66; }
chown -R "$root_uid:$root_gid" "$stage"
find "$stage" -type d -exec chmod 0750 {} +
find "$stage" -type f -exec chmod 0640 {} +
find "$stage/scripts" -type f -name '*.sh' -exec chmod 0750 {} +
chmod "$root_mode" "$stage"
verify_static_fixtures pre

# check-syntax validates the integrated observatory scripts too. Expose the
# locked, verified live subtree to the read-only pre-promotion checks without
# copying or mutating it; remove this validation-only link before the swap.
ln -s "$root/observatory" "$stage/observatory"
[ -L "$stage/observatory" ] && [ "$(readlink "$stage/observatory")" = "$root/observatory" ] \
  || { echo 'validation-only observatory link could not be established' >&2; exit 66; }

# Pre-promotion validation receives server-local read-only copies of the three
# immutable fixtures and seven operating stores. The protected originals stay
# in place; the mode-0700 stage copy is deleted before any source promotion.
mkdir -m 0700 -- "$stage/data"
for fixture in \
  holiday-skip-dates.json recommendations.json recommendations.sample.json \
  recommendation-history.json sent-messages.json meal-events.json verified-candidates.json \
  candidate-preferences.json coffee-participation.json delivery-outbox.json; do
  [ -f "$root/data/$fixture" ] && [ ! -L "$root/data/$fixture" ] || { echo "missing pre-promotion data file: $fixture" >&2; exit 67; }
  cp -- "$root/data/$fixture" "$stage/data/$fixture"
done
chmod 0600 "$stage/data/"*.json
(cd "$stage" && node scripts/check-syntax.js)
run_bot_tests "$stage"
rm -- "$stage/observatory"
[ ! -e "$stage/observatory" ] && [ ! -L "$stage/observatory" ] \
  || { echo 'validation-only observatory link was not removed' >&2; exit 66; }
rm -rf -- "$stage/data"

[ ! -e "$maintenance" ] || { echo 'operating maintenance is already active' >&2; exit 73; }
issued_at=$(date -u --iso-8601=seconds)
(set -C; printf '{"version":1,"operation":"integrated-source-deployment","token":"%s","issuedAt":"%s"}\n' \
  "$operation_id" "$issued_at" >"$maintenance") 2>/dev/null \
  || { echo 'could not acquire operating maintenance marker' >&2; exit 73; }
maintenance_owned=1
[ "$(listener_count)" -le 1 ] || { echo 'multiple exact interaction listeners are active' >&2; exit 73; }
stop_listener || { echo 'exact interaction listener did not stop' >&2; exit 73; }
listener_stopped=1

exec 5>"$root/data/.candidate-refresh.lock"; flock -n 5 || { echo 'candidate refresh is active' >&2; exit 73; }
exec 6>"$root/data/.scheduled-lunch.lock"; flock -n 6 || { echo 'lunch delivery is active' >&2; exit 73; }
exec 7>"$root/data/.scheduled-dinner.lock"; flock -n 7 || { echo 'dinner delivery is active' >&2; exit 73; }
exec 8>"$root/data/.interaction-listener.lock"; flock -n 8 || { echo 'interaction listener lock is active' >&2; exit 73; }
backup_operating_stores || { echo 'operating rollback snapshot could not be created' >&2; exit 73; }

[ -f "$root/.env" ] && [ ! -L "$root/.env" ] || { echo 'live .env is unsafe' >&2; exit 64; }
for directory in data logs; do
  [ -d "$root/$directory" ] && [ ! -L "$root/$directory" ] || { echo "live $directory is unsafe" >&2; exit 64; }
done
verify_observatory_tree "$root/observatory" || exit 64
[ "$(stat -c '%d:%i' "$root/observatory")" = "$observatory_identity" ] \
  || { echo 'verified live observatory subtree changed during bot validation' >&2; exit 73; }

# Record the complete move set before the first rename so signal cleanup can
# discover and restore every state path even between a rename and bookkeeping.
# The observatory rename preserves its source, export, metadata, and managed
# runtime symlink byte-for-byte; no integrated source ever overwrites it.
moved_states='.env data logs observatory'
for name in $moved_states; do
  mv -- "$root/$name" "$stage/$name"
done

mv -- "$root" "$backup"
root_moved=1
mv -- "$stage" "$root"
promoted=1

verify_observatory_tree "$root/observatory" || exit 74
[ "$(stat -c '%d:%i' "$root/observatory")" = "$observatory_identity" ] \
  || { echo 'promoted observatory subtree is not the verified live subtree' >&2; exit 74; }
(cd "$root" && node scripts/check-syntax.js)
run_bot_tests "$root"
# The release pins one model/effort for every model job. Promote these two
# non-secret settings within the same rollback boundary as source and data.
(cd "$root" && node --input-type=module -e 'import { REQUIRED_CODEX_MODEL as model, REQUIRED_CODEX_REASONING_EFFORT as effort, REQUIRED_TASTE_PRIOR_ALPHA as prior, REQUIRED_CANDIDATE_PREFERENCE_WEIGHT as survey } from "./src/config.js"; process.stdout.write(`CODEX_CLI_MODEL=${model}\nCODEX_CLI_REASONING_EFFORT=${effort}\nTASTE_PRIOR_ALPHA=${prior}\nCANDIDATE_PREFERENCE_WEIGHT=${survey}\n`);' | node scripts/merge-operating-env.js)
if [ "$apply_taxonomy" -eq 1 ]; then
  (cd "$root" && OJEOMMWO_MAINTENANCE_TOKEN="$operation_id" \
    node scripts/migrate-food-taxonomy.js --apply --externally-fenced)
fi
(cd "$root" && node scripts/normalize-meal-events.js --reject-invalid --apply)
if [ "$repair_candidate_readiness" -eq 1 ]; then
  # The deployment already owns the maintenance marker and candidate, meal,
  # and interaction locks. Invoke the non-delivery refresh CLI directly so
  # this repair cannot send either a lunch message or any other Slack message.
  (cd "$root" && node scripts/refresh-verified-candidates.js \
    --force --required-ready-sets 2)
fi
(cd "$root" && node src/index.js --validate)
(cd "$root" && node scripts/validate-operating-snapshot.js --data-dir data)
(cd "$root" && node scripts/audit-recommendations.js --strict)
(cd "$root" && OJEOMMWO_MAINTENANCE_TOKEN="$operation_id" node scripts/health-check.js --require-pass)
(cd "$root" && node src/index.js --slack-capability-test)
verify_static_fixtures post

rm -f -- "$root/data/.operating-maintenance"
maintenance_owned=0
flock -u 8; exec 8>&-
start_listener || { echo 'new interaction listener could not be restored exactly once' >&2; exit 74; }
[ "$(listener_count)" -eq 1 ] || { echo 'interaction listener count is not exactly one' >&2; exit 74; }
committed=1
printf '%s\n' 'Integrated bot source deployment passed with exactly one interaction listener.'
'@

  $ContainerScript = $ContainerScript.Replace("__EXPECTED_FIXTURES__", $FixtureManifestBase64)

  $ContainerScriptBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($ContainerScript))
  $ApplyTaxonomyValue = if ($ApplyTaxonomyMigration) { "1" } else { "0" }
  $RepairCandidateReadinessValue = if ($RepairCandidateReadiness) { "1" } else { "0" }
  $HostScript = @'
set -eu
umask 077
archive='__ARCHIVE__'
container_archive='/tmp/ojeommwo-integrated-source-__OPERATION__.tar.gz'
container='ojeommwo'
expected_cron="$(printf '%s' '__EXPECTED_CRON__' | base64 -d)"
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  docker exec "$container" rm -f -- "$container_archive" >/dev/null 2>&1 || true
  rm -f -- "$archive"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" = 'true' ] || {
  echo 'ojeommwo container is not running' >&2; exit 69
}
restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container" 2>/dev/null || true)"
case "$restart_policy" in
  always|unless-stopped) ;;
  *) echo "ojeommwo restart policy is not resilient: $restart_policy" >&2; exit 69 ;;
esac
installed_cron="$(crontab -l 2>/dev/null || true)"
printf '%s\n' "$expected_cron" | while IFS= read -r expected_line; do
  [ -n "$expected_line" ] || continue
  count="$(printf '%s\n' "$installed_cron" | grep -Fxc -- "$expected_line" || true)"
  [ "$count" = '1' ] || {
    echo "bot crontab contract mismatch ($count copies): $expected_line" >&2; exit 78
  }
done
host_offset="$(date +%z)"
if [ "$host_offset" != '+0900' ]; then
  printf '%s\n' "$installed_cron" | grep -Fxq 'CRON_TZ=Asia/Seoul' || {
    echo "cron timezone is not KST: host offset=$host_offset and CRON_TZ is absent" >&2; exit 78
  }
fi
docker cp "$archive" "$container:$container_archive"
printf '%s' '__CONTAINER_SCRIPT__' | base64 -d | docker exec -i "$container" sh -s -- \
  '/root/ojeommwo-v2' "$container_archive" '__OPERATION__' \
  '__APPLY_TAXONOMY__' '__PREVIOUS_RECOMMENDATIONS_SHA__' \
  '__REPAIR_CANDIDATE_READINESS__'
'@
  $HostScript = $HostScript.Replace("__ARCHIVE__", $RemoteArchive).Replace("__OPERATION__", $OperationId).Replace("__CONTAINER_SCRIPT__", $ContainerScriptBase64).Replace("__EXPECTED_CRON__", $ExpectedCronBase64).Replace("__APPLY_TAXONOMY__", $ApplyTaxonomyValue).Replace("__PREVIOUS_RECOMMENDATIONS_SHA__", $PreviousRecommendationsSha256).Replace("__REPAIR_CANDIDATE_READINESS__", $RepairCandidateReadinessValue)
  # Windows PowerShell 5.1 can prepend a UTF-8 BOM to redirected native stdin
  # even when the payload bytes themselves were encoded without a preamble.
  # Remove that exact optional prefix before `set -eu` reaches the host shell.
  $BomSafeRemoteShell = "LC_ALL=C sed '1s/^\xEF\xBB\xBF//' | sh -s"
  Invoke-NativeChecked -FilePath $Ssh -Arguments @(
    "-p", [string]$SshPort, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", $SshTarget,
    $BomSafeRemoteShell
  ) -StandardInput $HostScript -FailureMessage "Integrated bot source deployment failed and was rolled back"
  $BotSourcePassed = $true

  # Keep the currently running public service/tunnel untouched until the bot
  # source transaction succeeds. The nested deploy performs its own server-side
  # pnpm install/build and atomic service promotion.
  if (-not $BotOnly) {
    $ObservatoryDeploy = Join-Path $ObservatoryRoot "scripts\deploy-pororo.ps1"
    if (-not (Test-Path -LiteralPath $ObservatoryDeploy -PathType Leaf)) {
      throw "Bot source passed, but the nested observatory deploy script is missing: $ObservatoryDeploy"
    }
    try {
      & $ObservatoryDeploy -SshTarget $SshTarget -SshPort $SshPort
      if (-not $?) { throw "Nested observatory deployment returned failure." }
    } catch {
      throw "Bot source deployment passed, but nested observatory deployment failed: $($_.Exception.Message)"
    }
  }
} finally {
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $LocalStage -PathType Container) {
    $ResolvedTemp = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $ResolvedStage = [System.IO.Path]::GetFullPath($LocalStage)
    if ($ResolvedStage.StartsWith($ResolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $ResolvedStage) -like "ojeommwo-integrated-source-*") {
      Remove-Item -LiteralPath $ResolvedStage -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if (-not $BotSourcePassed) { throw "Integrated bot source deployment did not complete." }
if ($BotOnly) {
  Write-Output "ojeommwo-v2 bot-only deployment passed; nested observatory deployment was intentionally deferred."
} else {
  Write-Output "Integrated ojeommwo-v2 and nested observatory deployment passed."
}
