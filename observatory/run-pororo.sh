#!/bin/sh
set -eu

EXPECTED_ROOT=/home/ojeommwo/docker1/root/ojeommwo-v2/observatory
STATE_ROOT=/home/ojeommwo/docker1/root/.ojeommwo-v2-state/observatory
RUNTIME_LINK=../../.ojeommwo-v2-state/observatory
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION_FILE="$ROOT/VERSION"
PUBLIC_URL_FILE="$STATE_ROOT/public-url.txt"
PUSH_TOKEN_FILE="$STATE_ROOT/sites-push-token"
LEGACY_APP_CONTAINER=ojeommwo-observatory
LEGACY_TUNNEL_CONTAINER=ojeommwo-observatory-tunnel
LEGACY_NETWORK=ojeommwo-observatory-edge-network
SNAPSHOT_MAX_AGE_SECONDS=1200

[ "$ROOT" = "$EXPECTED_ROOT" ] || { echo "observatory source must be deployed at $EXPECTED_ROOT" >&2; exit 64; }
[ -L "$ROOT/runtime" ] && [ "$(readlink "$ROOT/runtime")" = "$RUNTIME_LINK" ] \
    || { echo "runtime must be the managed state symlink: $ROOT/runtime -> $RUNTIME_LINK" >&2; exit 64; }
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
    || { echo "observatory state directory is missing or unsafe: $STATE_ROOT" >&2; exit 64; }
for required in "$VERSION_FILE" "$PUBLIC_URL_FILE" "$PUSH_TOKEN_FILE" "$ROOT/.openai/hosting.json"; do
    [ -f "$required" ] && [ ! -L "$required" ] \
        || { echo "Sites observatory file is missing or unsafe: $required" >&2; exit 66; }
done

RELEASE_VERSION=$(tr -d '\r\n' < "$VERSION_FILE")
case "$RELEASE_VERSION" in
    ''|*[!0-9A-Za-z.+-]*) echo "invalid release version: $RELEASE_VERSION" >&2; exit 65 ;;
esac
EXPECTED_RELEASE=$(docker exec ojeommwo node --input-type=module -e 'import { SERVICE_VERSION } from "/root/ojeommwo-v2/src/version.js"; process.stdout.write(SERVICE_VERSION);')
[ "$RELEASE_VERSION" = "$EXPECTED_RELEASE" ] || { echo "Sites observatory release must match the running bot ($EXPECTED_RELEASE)" >&2; exit 65; }

exec 9>"$STATE_ROOT/.deploy.lock"
flock -n 9 || { echo "another observatory deployment is already running" >&2; exit 73; }

# The new public route is considered committed only after a fresh sanitized
# snapshot is accepted by Sites and reads back byte-for-byte.
"$ROOT/scripts/refresh-snapshot-host.sh"
"$ROOT/scripts/refresh-snapshot-host.sh" --health --max-age-seconds "$SNAPSHOT_MAX_AGE_SECONDS"
"$ROOT/scripts/install-snapshot-cron.sh" >/dev/null

PUBLIC_URL=$(tr -d '\r\n' < "$PUBLIC_URL_FILE")
case "$PUBLIC_URL" in https://*/) ;; *) echo "Sites public URL is invalid" >&2; exit 65 ;; esac
health=$(curl --fail --silent --show-error --connect-timeout 8 --max-time 20 "${PUBLIC_URL}healthz")
printf '%s' "$health" | grep -q '"status":"ok"' \
    || { echo "Sites health response is not OK" >&2; exit 69; }

# Retire only the old presentation edge. The bot, operating stores, snapshot
# generator, and local emergency viewer remain untouched.
for container in "$LEGACY_TUNNEL_CONTAINER" "$LEGACY_APP_CONTAINER"; do
    if docker container inspect "$container" >/dev/null 2>&1; then
        docker rm -f "$container" >/dev/null
    fi
done
docker network rm "$LEGACY_NETWORK" >/dev/null 2>&1 || true

echo "ojeommwo-observatory Sites handoff passed: $RELEASE_VERSION"
echo "Public URL: $PUBLIC_URL"
