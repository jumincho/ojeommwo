#!/bin/sh
set -eu

EXPECTED_ROOT=/home/ojeommwo/docker1/root/ojeommwo-v2/observatory
HOST_STATE=/home/ojeommwo/docker1/root/.ojeommwo-v2-state/observatory
RUNTIME_LINK=../../.ojeommwo-v2-state/observatory
CONTAINER_ROOT=/root/ojeommwo-v2/observatory
CONTAINER_STATE=/root/.ojeommwo-v2-state/observatory
SOURCE_DATA=/root/ojeommwo-v2/data
OPERATING_VALIDATOR=/root/ojeommwo-v2/scripts/validate-operating-snapshot.js
DATA_CONTAINER=${OBSERVATORY_DATA_CONTAINER:-ojeommwo}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODE=refresh
MAX_AGE_SECONDS=1200
PUBLIC_URL_FILE="$HOST_STATE/public-url.txt"
PUSH_TOKEN_FILE="$HOST_STATE/sites-push-token"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --health) MODE=health; shift ;;
        --max-age-seconds)
            [ "$#" -ge 2 ] || { echo "--max-age-seconds requires a value" >&2; exit 64; }
            MAX_AGE_SECONDS=$2
            shift 2
            ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
done

case "$MAX_AGE_SECONDS" in
    ''|*[!0-9]*) echo "max snapshot age must be an integer" >&2; exit 64 ;;
esac
[ "$MAX_AGE_SECONDS" -ge 60 ] && [ "$MAX_AGE_SECONDS" -le 86400 ] \
    || { echo "max snapshot age must be between 60 and 86400 seconds" >&2; exit 64; }
case "$DATA_CONTAINER" in
    ''|*[!A-Za-z0-9_.-]*) echo "unsafe data container name" >&2; exit 64 ;;
esac
[ "$ROOT" = "$EXPECTED_ROOT" ] || { echo "snapshot refresher must run from $EXPECTED_ROOT" >&2; exit 64; }
[ -L "$ROOT/runtime" ] && [ "$(readlink "$ROOT/runtime")" = "$RUNTIME_LINK" ] \
    || { echo "runtime state symlink is missing or unsafe" >&2; exit 64; }
[ -d "$HOST_STATE" ] && [ ! -L "$HOST_STATE" ] \
    || { echo "observatory state directory is missing or unsafe" >&2; exit 64; }

for state_file in "$PUBLIC_URL_FILE" "$PUSH_TOKEN_FILE"; do
    [ -f "$state_file" ] && [ ! -L "$state_file" ] \
        || { echo "Sites state file is missing or unsafe: $state_file" >&2; exit 64; }
done
[ "$(stat -c '%a' "$PUSH_TOKEN_FILE")" = 600 ] \
    || { echo "Sites push token permissions must be 600" >&2; exit 64; }

PUBLIC_URL=$(tr -d '\r\n' < "$PUBLIC_URL_FILE")
case "$PUBLIC_URL" in
    https://*/)
        case "$PUBLIC_URL" in *[!A-Za-z0-9:/._~-]*) echo "Sites public URL contains unsafe characters" >&2; exit 64 ;; esac
        ;;
    *) echo "Sites public URL must be one canonical HTTPS origin ending in /" >&2; exit 64 ;;
esac
PUSH_TOKEN=$(tr -d '\r\n' < "$PUSH_TOKEN_FILE")
[ "${#PUSH_TOKEN}" -ge 32 ] && [ "${#PUSH_TOKEN}" -le 512 ] \
    || { echo "Sites push token length is invalid" >&2; exit 64; }
case "$PUSH_TOKEN" in *[!A-Za-z0-9_.~-]*) echo "Sites push token contains unsafe characters" >&2; exit 64 ;; esac

LOCK_FILE="$HOST_STATE/.refresh.lock"
exec 9>"$LOCK_FILE"
# Let a scheduled refresh finish before a deployment or health probe.
if ! flock -w 60 9; then
    echo "snapshot refresh lock remained busy for 60 seconds" >&2
    exit 75
fi

[ "$(docker inspect --format '{{.State.Running}}' "$DATA_CONTAINER" 2>/dev/null || true)" = true ] \
    || { echo "data container is not running: $DATA_CONTAINER" >&2; exit 69; }

validate_local_snapshot() {
    docker exec "$DATA_CONTAINER" sh -eu -c '
        snapshot=$1
        validator=$2
        max_age=$3
        [ -f "$snapshot" ] && [ ! -L "$snapshot" ] || { echo "runtime snapshot is missing or unsafe" >&2; exit 70; }
        node "$validator" "$snapshot" >/dev/null
        now=$(date +%s)
        modified=$(stat -c %Y "$snapshot")
        age=$((now - modified))
        [ "$age" -ge 0 ] && [ "$age" -le "$max_age" ] \
            || { echo "runtime snapshot is stale: age=${age}s max=${max_age}s" >&2; exit 71; }
    ' sh "$CONTAINER_STATE/snapshot.json" "$CONTAINER_ROOT/scripts/validate-snapshot.mjs" "$MAX_AGE_SECONDS"
}

verify_remote_snapshot() {
    remote_candidate="$HOST_STATE/.sites-remote.$$.candidate"
    cleanup_remote() { rm -f -- "$remote_candidate"; }
    trap cleanup_remote EXIT HUP INT TERM
    curl --fail --silent --show-error --location --max-redirs 0 \
        --connect-timeout 8 --max-time 20 \
        -H 'Accept: application/json' \
        "${PUBLIC_URL}api/snapshot/current" -o "$remote_candidate"
    chmod 0600 "$remote_candidate"
    docker exec "$DATA_CONTAINER" node "$CONTAINER_ROOT/scripts/validate-snapshot.mjs" \
        "$CONTAINER_STATE/.sites-remote.$$.candidate" >/dev/null
    local_hash=$(sha256sum "$HOST_STATE/snapshot.json" | cut -d' ' -f1)
    remote_hash=$(sha256sum "$remote_candidate" | cut -d' ' -f1)
    [ "$local_hash" = "$remote_hash" ] \
        || { echo "Sites snapshot hash does not match the authoritative sanitized snapshot" >&2; exit 71; }
    cleanup_remote
    trap - EXIT HUP INT TERM
}

if [ "$MODE" = health ]; then
    validate_local_snapshot
    verify_remote_snapshot
    if [ "${OBSERVATORY_VERBOSE:-0}" = 1 ]; then echo "ojeommwo-observatory Sites health passed"; fi
    exit 0
fi

# The operating stores are validated before generating a unique candidate.
# Only the final rename promotes the local last-known-good snapshot.
docker exec "$DATA_CONTAINER" sh -eu -c '
    project=$1
    state=$2
    data=$3
    operating_validator=$4
    snapshot="$state/snapshot.json"
    candidate="$state/.snapshot.$$.candidate"
    cleanup() { rm -f -- "$candidate" "$candidate".*.tmp; }
    trap cleanup EXIT HUP INT TERM
    [ -d "$project" ] && [ ! -L "$project" ] || { echo "container source path is unsafe" >&2; exit 72; }
    [ -d "$state" ] && [ ! -L "$state" ] || { echo "container state path is unsafe" >&2; exit 72; }
    [ -d "$data" ] && [ ! -L "$data" ] || { echo "operating data path is unsafe" >&2; exit 72; }
    [ -f "$operating_validator" ] || { echo "operating snapshot validator is missing" >&2; exit 72; }
    if [ -e "$snapshot" ] && { [ ! -f "$snapshot" ] || [ -L "$snapshot" ]; }; then
        echo "runtime snapshot destination is unsafe" >&2
        exit 72
    fi
    node "$operating_validator" --data-dir "$data" >/dev/null
    node "$project/scripts/export-snapshot.mjs" --data-dir "$data" --output "$candidate" >/dev/null
    node "$project/scripts/validate-snapshot.mjs" "$candidate" >/dev/null
    chmod 0644 "$candidate"
    mv -f -- "$candidate" "$snapshot"
    trap - EXIT HUP INT TERM
' sh "$CONTAINER_ROOT" "$CONTAINER_STATE" "$SOURCE_DATA" "$OPERATING_VALIDATOR"

validate_local_snapshot
# The public Sites dispatch layer permits GET/HEAD from the pororo egress ASN.
# Stream bounded authenticated chunks through GET headers; the Worker assembles,
# validates, and atomically commits only the exact SHA-256 snapshot.
docker exec "$DATA_CONTAINER" node "$CONTAINER_ROOT/scripts/push-snapshot-sites.mjs"
verify_remote_snapshot

if [ "${OBSERVATORY_VERBOSE:-0}" = 1 ]; then
    echo "ojeommwo-observatory snapshot refreshed and verified on Sites"
fi
