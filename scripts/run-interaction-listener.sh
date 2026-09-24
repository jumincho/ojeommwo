#!/usr/bin/env bash
set -euo pipefail
umask 077

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
lock_path="$project_root/data/.interaction-listener.lock"
maintenance_path="$project_root/data/.operating-maintenance"
mkdir -p "$project_root/logs"
if [ -e "$maintenance_path" ]; then
  if (cd "$project_root" && node scripts/check-operating-maintenance.js --path "$maintenance_path"); then
    exit 0
  fi
  printf '[interaction-listener] unsafe maintenance marker; refusing a silent maintenance skip\n' >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  printf '[interaction-listener] required overlap-lock command is unavailable: flock\n' >&2
  exit 1
fi
exec 9>"$lock_path"
if ! flock -n 9; then exit 0; fi
cd "$project_root"
if [ -e "$maintenance_path" ]; then
  if node scripts/check-operating-maintenance.js --path "$maintenance_path"; then
    exit 0
  fi
  printf '[interaction-listener] unsafe maintenance marker after lock acquisition\n' >&2
  exit 1
fi
export OJEOMMWO_MANAGED_INTERACTION_LOG=1
exec node scripts/run-interaction-listener.js >/dev/null 2>&1
