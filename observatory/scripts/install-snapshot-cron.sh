#!/bin/sh
set -eu

EXPECTED_ROOT=/home/ojeommwo/docker1/root/ojeommwo-v2/observatory
HOST_STATE=/home/ojeommwo/docker1/root/.ojeommwo-v2-state/observatory
RUNTIME_LINK=../../.ojeommwo-v2-state/observatory
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BEGIN='# BEGIN ojeommwo-observatory snapshot'
END='# END ojeommwo-observatory snapshot'
SNAPSHOT_LINE="*/10 * * * * $ROOT/scripts/refresh-snapshot-host.sh 2>&1 | logger -t ojeommwo-observatory-refresh"
# Health runs two minutes after each five-minute boundary. Running it on */5
# made every ten-minute refresh compete for the same nonblocking lock, so a
# health process could repeatedly starve the authoritative snapshot writer.
HEALTH_MINUTES='2,7,12,17,22,27,32,37,42,47,52,57'
HEALTH_LINE="$HEALTH_MINUTES * * * * $ROOT/scripts/refresh-snapshot-host.sh --health --max-age-seconds 1200 2>&1 | logger -t ojeommwo-observatory-health"
CURRENT=$(mktemp)
TEMP=$(mktemp)
trap 'rm -f "$CURRENT" "$TEMP"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$ROOT" != "$EXPECTED_ROOT" ]; then
    echo "snapshot cron must be installed from $EXPECTED_ROOT" >&2
    exit 64
fi
if [ ! -L "$ROOT/runtime" ] || [ "$(readlink "$ROOT/runtime")" != "$RUNTIME_LINK" ]; then
    echo "runtime state symlink is missing or unsafe" >&2
    exit 64
fi
if [ ! -d "$HOST_STATE" ] || [ -L "$HOST_STATE" ]; then
    echo "observatory state directory is missing or unsafe" >&2
    exit 64
fi

if ! crontab -l >"$CURRENT" 2>/dev/null; then
    : >"$CURRENT"
fi
BEGIN_COUNT=$(grep -Fxc -- "$BEGIN" "$CURRENT" || true)
END_COUNT=$(grep -Fxc -- "$END" "$CURRENT" || true)
if [ "$BEGIN_COUNT" -ne "$END_COUNT" ] || [ "$BEGIN_COUNT" -gt 1 ]; then
    echo "existing observatory cron block markers are malformed" >&2
    exit 65
fi
if [ "$BEGIN_COUNT" -eq 1 ]; then
    BEGIN_LINE=$(grep -nFx -- "$BEGIN" "$CURRENT" | cut -d: -f1)
    END_LINE=$(grep -nFx -- "$END" "$CURRENT" | cut -d: -f1)
    if [ "$BEGIN_LINE" -ge "$END_LINE" ]; then
        echo "existing observatory cron block marker order is malformed" >&2
        exit 65
    fi
fi

{
    awk -v begin="$BEGIN" -v end="$END" '
        $0 == begin { skipping = 1; next }
        $0 == end { skipping = 0; next }
        !skipping { print }
    ' "$CURRENT"
    echo "$BEGIN"
    echo "$SNAPSHOT_LINE"
    echo "$HEALTH_LINE"
    echo "$END"
} > "$TEMP"

crontab "$TEMP"
echo "snapshot cron installed: refresh every 10 minutes, health every 5 minutes at a two-minute offset"
