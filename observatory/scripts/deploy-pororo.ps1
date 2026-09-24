param(
  [string]$SshTarget = "ojeommwo@203.0.113.10",
  [ValidateRange(1, 65535)][int]$SshPort = 7777,
  [string]$RemoteRoot = "/home/ojeommwo/docker1/root/ojeommwo-v2/observatory"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ExpectedRemoteRoot = "/home/ojeommwo/docker1/root/ojeommwo-v2/observatory"
$Ssh = (Get-Command "ssh.exe" -ErrorAction Stop).Source
$Scp = (Get-Command "scp.exe" -ErrorAction Stop).Source
$Tar = (Get-Command "tar.exe" -ErrorAction Stop).Source

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

if ($SshTarget -notmatch '^[A-Za-z0-9._@-]+$') {
  throw "Unsafe SSH target: $SshTarget"
}
if ($RemoteRoot -cne $ExpectedRemoteRoot) {
  throw "Remote root must be exactly $ExpectedRemoteRoot"
}

$RequiredSource = @(
  ".gitattributes", ".gitignore", ".openai", "ARCHITECTURE.md", "build",
  "DESIGN.md", "HANDOFF.md", "README.md", "SECURITY.md", "VERSION",
  "app", "eslint.config.mjs", "next.config.ts", "package.json", "patches", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "public", "run-pororo.sh", "scripts", "tests", "tsconfig.json",
  "vite.config.ts", "worker"
)
foreach ($Entry in $RequiredSource) {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $Entry))) {
    throw "Deployment source is missing: $Entry"
  }
}

$OperationId = [guid]::NewGuid().ToString("N")
$Archive = Join-Path $env:TEMP ("ojeommwo-observatory-source-$OperationId.tar.gz")
$RemoteArchive = "/tmp/ojeommwo-observatory-source-$OperationId.tar.gz"
try {
  # Upload source only. Dependency installation, verification, snapshot
  # generation, and the static build all run inside the ojeommwo server container.
  Push-Location $ProjectRoot
  try {
    $TarArguments = @("-czf", $Archive, "--exclude=public/data/snapshot.json") + $RequiredSource
    & $Tar @TarArguments
    if ($LASTEXITCODE -ne 0) { throw "Source archive creation failed." }
  } finally {
    Pop-Location
  }

  $ArchiveListing = @(& $Tar -tzf $Archive)
  if ($LASTEXITCODE -ne 0) { throw "Source archive validation failed." }
  foreach ($Name in $ArchiveListing) {
    $Normalized = ([string]$Name).Replace('\', '/').TrimEnd('/')
    if (-not $Normalized) { continue }
    $Segments = @($Normalized -split '/')
    if ($Normalized.StartsWith('/') -or $Segments -contains ".." -or $Segments -contains ".") {
      throw "Source archive contains an unsafe path: $Normalized"
    }
    if ($Segments | Where-Object { $_ -in @("runtime", "out", "node_modules", ".next") }) {
      throw "Source archive contains runtime or generated content: $Normalized"
    }
    if ($Normalized -ceq "public/data/snapshot.json") {
      throw "Source archive contains the DB-derived public snapshot: $Normalized"
    }
  }

  & $Scp -q -P $SshPort -o BatchMode=yes -o ConnectTimeout=8 $Archive "${SshTarget}:$RemoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "Deployment source upload failed." }

  $RemoteScript = @'
set -eu

ROOT=$1
ARCHIVE=$2
OPERATION_ID=$3
EXPECTED_ROOT=/home/ojeommwo/docker1/root/ojeommwo-v2/observatory
HOST_PARENT=/home/ojeommwo/docker1/root/ojeommwo-v2
HOST_STATE=/home/ojeommwo/docker1/root/.ojeommwo-v2-state/observatory
LEGACY_ROOT=/home/ojeommwo/docker1/root/ojeommwo-observatory
LEGACY_RUNTIME=/home/ojeommwo/docker1/root/ojeommwo-observatory/runtime
CONTAINER_PARENT=/root/ojeommwo-v2
CONTAINER_ROOT=/root/ojeommwo-v2/observatory
CONTAINER_BACKUP="$CONTAINER_PARENT/.observatory-previous-$OPERATION_ID"
CONTAINER_STATE=/root/.ojeommwo-v2-state/observatory
DATA_DIR=/root/ojeommwo-v2/data
DATA_CONTAINER=ojeommwo
RUNTIME_LINK=../../.ojeommwo-v2-state/observatory
CANONICAL_PUBLIC_URL=https://ojeommwo-observatory.jumincho.chatgpt.site/
PUBLIC_URL_FILE="$HOST_STATE/public-url.txt"
PUBLIC_URL_CANDIDATE="$HOST_STATE/.public-url-$OPERATION_ID.candidate"
PUBLIC_URL_BACKUP="$HOST_STATE/.public-url-$OPERATION_ID.previous"

[ "$ROOT" = "$EXPECTED_ROOT" ] || { echo "unsafe deployment root" >&2; exit 64; }
case "$ARCHIVE" in /tmp/ojeommwo-observatory-source-*.tar.gz) ;; *) echo "unsafe archive path" >&2; exit 64 ;; esac
case "$OPERATION_ID" in ''|*[!a-f0-9]*) echo "unsafe operation id" >&2; exit 64 ;; esac

STAGE="$HOST_PARENT/.observatory-stage-$OPERATION_ID"
BACKUP="$HOST_PARENT/.observatory-previous-$OPERATION_ID"
FAILED="$HOST_PARENT/.observatory-failed-$OPERATION_ID"
CONTAINER_STAGE="$CONTAINER_PARENT/.observatory-stage-$OPERATION_ID"
COMPLETE=0
ROOT_MOVED=0
PROMOTED=0
PROMOTION_STARTED=0
PARENT_RELAXED=0
PUBLIC_URL_PROMOTED=0
PUBLIC_URL_PREEXISTED=0
HOST_UID=$(id -u)
HOST_GID=$(id -g)

mkdir -p -- "$HOST_STATE"
[ -d "$HOST_STATE" ] && [ ! -L "$HOST_STATE" ] || { echo "observatory state path is unsafe" >&2; exit 64; }
chmod 0700 "$HOST_STATE"
for state_file in snapshot.json public-url.txt sites-push-token; do
    if [ -e "$HOST_STATE/$state_file" ] && { [ ! -f "$HOST_STATE/$state_file" ] || [ -L "$HOST_STATE/$state_file" ]; }; then
        echo "observatory state file is unsafe: $state_file" >&2
        exit 64
    fi
done
exec 8>"$HOST_STATE/.source-deploy.lock"
flock -n 8 || { echo "another observatory source deployment is active" >&2; exit 73; }

restore_source() {
    restore_failed=0
    previous_restored=0
    if [ "$PROMOTED" -eq 1 ] && [ -e "$ROOT" ]; then
        mv -- "$ROOT" "$FAILED" || restore_failed=1
    fi
    if [ "$ROOT_MOVED" -eq 1 ] && [ -d "$BACKUP" ] && [ ! -L "$BACKUP" ]; then
        if mv -- "$BACKUP" "$ROOT"; then
            previous_restored=1
        else
            restore_failed=1
        fi
    fi
    if [ "$PROMOTED" -eq 1 ] && [ -d "$FAILED" ] && [ ! -L "$FAILED" ]; then
        if [ "$previous_restored" -eq 1 ]; then
            rm -rf -- "$FAILED" || restore_failed=1
        elif [ ! -e "$ROOT" ]; then
            # If restoring the previous rename unexpectedly fails, retain a
            # complete source tree at ROOT and leave BACKUP untouched for
            # manual recovery instead of destroying either version.
            mv -- "$FAILED" "$ROOT" || restore_failed=1
        fi
    fi
    return "$restore_failed"
}
reconcile_source_state() {
    if [ ! -e "$ROOT" ] && [ -d "$BACKUP" ] && [ -d "$STAGE" ]; then
        ROOT_MOVED=1
    fi
    if [ "$PROMOTION_STARTED" -eq 1 ] && [ -d "$ROOT" ] && [ ! -L "$ROOT" ] && [ ! -e "$STAGE" ]; then
        PROMOTED=1
    fi
}
restore_parent_permissions() {
    if [ "$PARENT_RELAXED" -eq 0 ]; then
        return 0
    fi
    if ! docker exec "$DATA_CONTAINER" chown "root:$HOST_GID" "$CONTAINER_PARENT"; then
        return 1
    fi
    if ! docker exec "$DATA_CONTAINER" chmod 0750 "$CONTAINER_PARENT"; then
        return 1
    fi
    PARENT_RELAXED=0
}
restore_public_url() {
    if [ "$PUBLIC_URL_PROMOTED" -eq 0 ]; then
        return 0
    fi
    if [ "$PUBLIC_URL_PREEXISTED" -eq 1 ]; then
        [ -f "$PUBLIC_URL_BACKUP" ] && [ ! -L "$PUBLIC_URL_BACKUP" ] || return 1
        mv -f -- "$PUBLIC_URL_BACKUP" "$PUBLIC_URL_FILE" || return 1
    else
        rm -f -- "$PUBLIC_URL_FILE" || return 1
    fi
    PUBLIC_URL_PROMOTED=0
}
cleanup() {
    status=$?
    set +e
    trap - EXIT HUP INT TERM
    if [ "$COMPLETE" -ne 1 ]; then
        if ! restore_public_url; then
            echo "CRITICAL: previous observatory public URL could not be restored" >&2
            if [ "$status" -eq 0 ]; then status=74; fi
        fi
        reconcile_source_state
        if ! restore_source; then
            echo "CRITICAL: previous observatory source could not be fully restored" >&2
            if [ "$status" -eq 0 ]; then status=74; fi
        fi
    fi
    if ! rm -rf -- "$STAGE"; then
        echo "WARNING: observatory staging directory cleanup failed: $STAGE" >&2
        if [ "$status" -eq 0 ]; then status=74; fi
    fi
    rm -f -- "$HOST_STATE/.legacy-snapshot-$OPERATION_ID.candidate"
    rm -f -- "$PUBLIC_URL_CANDIDATE"
    rm -f -- "$ARCHIVE"
    if ! restore_parent_permissions; then
        echo "CRITICAL: integrated project root permissions could not be restored to root:$HOST_GID 0750" >&2
        if [ "$status" -eq 0 ]; then status=74; fi
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(docker inspect --format '{{.State.Running}}' "$DATA_CONTAINER" 2>/dev/null || true)" != "true" ]; then
    echo "server build container is not running: $DATA_CONTAINER" >&2
    exit 69
fi
# The integrated bot root is normally root:<host-gid> 0750. Temporarily grant
# group write only on that directory for the same-filesystem stage/swap, then
# restore 0750 in the EXIT cleanup on both success and failure. No child file,
# .env, or data-store permission is changed.
docker exec "$DATA_CONTAINER" chown "root:$HOST_GID" "$CONTAINER_PARENT"
PARENT_RELAXED=1
docker exec "$DATA_CONTAINER" chmod 0770 "$CONTAINER_PARENT"
[ -d "$HOST_PARENT" ] && [ ! -L "$HOST_PARENT" ] || { echo "integrated project root is unsafe" >&2; exit 64; }

[ ! -e "$STAGE" ] && [ ! -e "$BACKUP" ] && [ ! -e "$FAILED" ] \
    || { echo "unique observatory deployment path already exists" >&2; exit 64; }
mkdir -m 0700 -- "$STAGE"
if tar -tzf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "deployment archive contains an unsafe path" >&2
    exit 65
fi
if tar -tzf "$ARCHIVE" | grep -Eq '(^|/)(runtime|out|node_modules|\.next)(/|$)'; then
    echo "deployment archive must contain source only" >&2
    exit 65
fi
if tar -tzf "$ARCHIVE" | grep -Eq '(^|/)public/data/snapshot\.json/?$'; then
    echo "deployment archive contains the DB-derived public snapshot" >&2
    exit 65
fi
tar -xzf "$ARCHIVE" -C "$STAGE"
for required in package.json pnpm-lock.yaml VERSION run-pororo.sh \
    .openai/hosting.json build/sites-vite-plugin.ts vite.config.ts worker/index.ts \
    scripts/deploy-pororo.ps1; do
    [ -e "$STAGE/$required" ] || { echo "staged source is missing $required" >&2; exit 66; }
done
ln -s "$RUNTIME_LINK" "$STAGE/runtime"
chmod 0755 \
    "$STAGE/run-pororo.sh" \
    "$STAGE/scripts/refresh-snapshot-host.sh" \
    "$STAGE/scripts/install-snapshot-cron.sh"

# One-time integrated-layout migration. Copy only regular non-symlink files to
# candidate paths, validate them there, and never remove the legacy sibling.
if [ -d "$LEGACY_ROOT" ] && [ ! -L "$LEGACY_ROOT" ] \
    && [ -d "$LEGACY_RUNTIME" ] && [ ! -L "$LEGACY_RUNTIME" ]; then
    if [ ! -e "$HOST_STATE/snapshot.json" ] \
        && [ -f "$LEGACY_RUNTIME/snapshot.json" ] && [ ! -L "$LEGACY_RUNTIME/snapshot.json" ]; then
        LEGACY_SNAPSHOT_CANDIDATE="$HOST_STATE/.legacy-snapshot-$OPERATION_ID.candidate"
        cp -- "$LEGACY_RUNTIME/snapshot.json" "$LEGACY_SNAPSHOT_CANDIDATE"
        [ "$(sha256sum -- "$LEGACY_RUNTIME/snapshot.json" | awk '{print $1}')" \
          = "$(sha256sum -- "$LEGACY_SNAPSHOT_CANDIDATE" | awk '{print $1}')" ] \
          || { echo "legacy snapshot copy verification failed" >&2; exit 68; }
        if docker exec "$DATA_CONTAINER" node \
            "$CONTAINER_STAGE/scripts/validate-snapshot.mjs" \
            "$CONTAINER_STATE/.legacy-snapshot-$OPERATION_ID.candidate" >/dev/null 2>&1; then
            chmod 0644 "$LEGACY_SNAPSHOT_CANDIDATE"
            mv -f -- "$LEGACY_SNAPSHOT_CANDIDATE" "$HOST_STATE/snapshot.json"
        else
            # The standalone v1 snapshot is intentionally incompatible with
            # the integrated v2 schema. Discard only the candidate and let the
            # post-promotion refresh generate a new snapshot from live DBs.
            rm -f -- "$LEGACY_SNAPSHOT_CANDIDATE"
            echo "legacy snapshot was incompatible and will be regenerated" >&2
        fi
    fi
fi
docker exec \
    -e CI=1 \
    -e OJEOMMWO_DATA_DIR="$DATA_DIR" \
    -e COREPACK_HOME="/tmp/ojeommwo-corepack-$OPERATION_ID" \
    "$DATA_CONTAINER" sh -eu -c '
        stage=$1
        cache=$2
        cleanup_build() {
            rm -rf -- "$stage/node_modules" "$stage/.next" "$cache"
            rm -f -- "$stage/tsconfig.tsbuildinfo"
        }
        trap cleanup_build EXIT
        trap "exit 129" HUP
        trap "exit 130" INT
        trap "exit 143" TERM
        cd "$stage"
        printf "observatory server build stage: %s\n" "$stage" >&2
        corepack pnpm install --frozen-lockfile
        corepack pnpm audit --prod --audit-level low
        corepack pnpm audit --audit-level low
        corepack pnpm verify
        [ -f "$stage/out/index.html" ] || { echo "server build did not create out/index.html" >&2; exit 70; }
        stat -c "server build produced %F %s bytes %n" "$stage/out/index.html" >&2
        trap - EXIT HUP INT TERM
        cleanup_build
        [ -f "$stage/out/index.html" ] || { echo "server build cleanup removed out/index.html" >&2; exit 70; }
        stat -c "server build cleanup retained %F %s bytes %n" "$stage/out/index.html" >&2
    ' sh "$CONTAINER_STAGE" "/tmp/ojeommwo-corepack-$OPERATION_ID"

# The build runs as container root so it can read the protected bot database.
# Return the immutable source/export tree to the deploying host identity, and
# ensure dependency/build caches can never be promoted.
docker exec "$DATA_CONTAINER" chown -R "$HOST_UID:$HOST_GID" "$CONTAINER_STAGE"
rm -rf -- "$STAGE/node_modules" "$STAGE/.next"
rm -f -- "$STAGE/tsconfig.tsbuildinfo"
[ ! -e "$STAGE/node_modules" ] && [ ! -e "$STAGE/.next" ] && [ ! -e "$STAGE/tsconfig.tsbuildinfo" ] || {
    echo "transient server build artifacts were not removed" >&2
    exit 70
}
if [ ! -f "$STAGE/out/index.html" ]; then
    echo "verified static export is missing after server build cleanup" >&2
    ls -ld -- "$STAGE" "$STAGE/out" "$STAGE/out/index.html" 2>&1 >&2 || true
    docker exec "$DATA_CONTAINER" sh -c 'ls -ld -- "$1" "$1/out" "$1/out/index.html"' sh "$CONTAINER_STAGE" >&2 || true
    exit 70
fi

if [ -e "$ROOT" ]; then
    [ -d "$ROOT" ] && [ ! -L "$ROOT" ] || { echo "existing source root is unsafe" >&2; exit 64; }
    ROOT_MOVED=1
    mv -- "$ROOT" "$BACKUP"
fi
PROMOTION_STARTED=1
mv -- "$STAGE" "$ROOT"
PROMOTED=1

# Switch the state pointer only for the duration of the verified Sites handoff.
# A failed upload or health gate restores both the previous source and URL, so
# the still-running legacy edge remains reachable until Sites is proven ready.
[ ! -e "$PUBLIC_URL_CANDIDATE" ] && [ ! -e "$PUBLIC_URL_BACKUP" ] \
    || { echo "unique public URL transaction path already exists" >&2; exit 64; }
if [ -e "$PUBLIC_URL_FILE" ]; then
    [ -f "$PUBLIC_URL_FILE" ] && [ ! -L "$PUBLIC_URL_FILE" ] \
        || { echo "existing public URL state is unsafe" >&2; exit 64; }
    cp -- "$PUBLIC_URL_FILE" "$PUBLIC_URL_BACKUP"
    cmp -s -- "$PUBLIC_URL_FILE" "$PUBLIC_URL_BACKUP" \
        || { echo "public URL backup verification failed" >&2; exit 68; }
    chmod 0600 "$PUBLIC_URL_BACKUP"
    PUBLIC_URL_PREEXISTED=1
fi
printf '%s\n' "$CANONICAL_PUBLIC_URL" > "$PUBLIC_URL_CANDIDATE"
chmod 0644 "$PUBLIC_URL_CANDIDATE"
mv -f -- "$PUBLIC_URL_CANDIDATE" "$PUBLIC_URL_FILE"
PUBLIC_URL_PROMOTED=1

if sh "$ROOT/run-pororo.sh"; then
    PUBLIC_URL_PROMOTED=0
    rm -f -- "$PUBLIC_URL_BACKUP"
    # Previous builds can contain root-owned artifacts produced inside the
    # ojeommwo container. Remove this exact, operation-scoped backup through that
    # container instead of letting a host-side permission error turn a
    # successful Sites handoff into a misleading failed deployment.
    docker exec "$DATA_CONTAINER" rm -rf -- "$CONTAINER_BACKUP"
    [ ! -e "$BACKUP" ] || { echo "previous observatory source cleanup failed" >&2; exit 74; }
    COMPLETE=1
    exit 0
else
    status=$?
fi
echo "new observatory failed health checks; restoring previous source" >&2
if ! restore_public_url; then
    echo "CRITICAL: previous observatory public URL could not be restored" >&2
    exit 74
fi
if ! restore_source; then
    echo "CRITICAL: previous observatory source could not be fully restored" >&2
    exit 74
fi
PROMOTED=0
ROOT_MOVED=0
PROMOTION_STARTED=0
exit "$status"
'@
  # Stream the large shell program over stdin so it never approaches the
  # Windows command-line limit. Serialize the payload as no-preamble UTF-8
  # bytes. Windows PowerShell 5.1's Process.StandardInput StreamWriter can
  # still add EF BB BF before those bytes, so the tiny remote sed guard strips
  # exactly one optional BOM before the first `set -eu` reaches sh.
  $BomSafeRemoteShell = "LC_ALL=C sed '1s/^\xEF\xBB\xBF//' | sh -s -- '$RemoteRoot' '$RemoteArchive' '$OperationId'"
  Invoke-NativeChecked -FilePath $Ssh -Arguments @(
    "-p", [string]$SshPort, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", $SshTarget,
    $BomSafeRemoteShell
  ) -StandardInput ($RemoteScript + "`n") -FailureMessage "Remote deployment failed; staged source was discarded and the previous source/container were restored"
} finally {
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
}

Write-Output "ojeommwo-observatory source and Sites snapshot handoff passed; canonical URL is stored in observatory/runtime/public-url.txt"
