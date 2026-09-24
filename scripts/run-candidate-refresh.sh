#!/usr/bin/env bash
set -euo pipefail
umask 077

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
lock_path="$project_root/data/.candidate-refresh.lock"
maintenance_path="$project_root/data/.operating-maintenance"
timestamp="$(TZ="${TIMEZONE:-Asia/Seoul}" date +%Y%m%d-%H%M%S)"
kst_clock="$(TZ="${TIMEZONE:-Asia/Seoul}" date +%H%M)"
log_path="$project_root/logs/candidate-refresh-$timestamp.log"
mkdir -p "$project_root/logs"
maintenance_guard() {
  if [ ! -e "$maintenance_path" ]; then return 1; fi
  local detail
  if detail="$(cd "$project_root" && node scripts/check-operating-maintenance.js --path "$maintenance_path" 2>&1)"; then
    printf '%s\n' "$detail" >>"$log_path"
    return 0
  fi
  printf '[candidate-refresh] unsafe maintenance marker: %s\n' "$detail" | tee -a "$log_path" >&2
  (cd "$project_root" && node scripts/send-operations-alert.js \
    --job "운영 유지보수 잠금 검증" \
    --detail "$detail") >>"$log_path" 2>&1 || true
  return 2
}
if maintenance_guard; then exit 0; else maintenance_code=$?; [ "$maintenance_code" -eq 1 ] || exit 1; fi
exec 9>"$lock_path"
if ! command -v flock >/dev/null 2>&1; then
  printf '[candidate-refresh] required overlap-lock command is unavailable: flock\n' >&2
  exit 1
fi
if ! flock -n 9; then exit 0; fi
cd "$project_root"
if maintenance_guard; then exit 0; else maintenance_code=$?; [ "$maintenance_code" -eq 1 ] || exit 1; fi
set +e
node scripts/refresh-verified-candidates.js "$@" >>"$log_path" 2>&1
exit_code=$?
set -e

# Every scheduled refresh requests two independently usable sets. Only the
# 08:50 run may degrade to one set, and only inside the same 20-minute grace
# window used by health: preserving an imminent lunch is safer than failing the
# send, while the 15:00 run must retain the strict post-dinner standby reserve.
# Manual/forced calls and structural failures never receive this fallback.
morning_refresh_window=0
case "$kst_clock" in
  085[0-9]|090[0-9]|0910) morning_refresh_window=1 ;;
esac
scheduled_two_set_request=0
if [ "$#" -eq 0 ]; then
  scheduled_two_set_request=1
elif [ "$#" -eq 2 ] && [ "$1" = '--required-ready-sets' ] && [ "$2" = '2' ]; then
  scheduled_two_set_request=1
fi
if [ "$exit_code" -ne 0 ] \
    && [ "$morning_refresh_window" -eq 1 ] \
    && [ "$scheduled_two_set_request" -eq 1 ] \
    && grep -Eq 'required sets=2|requires 2 viable set' "$log_path"; then
  printf '[candidate-refresh] two-set morning reserve unavailable; verifying one-set send readiness\n' >>"$log_path"
  set +e
  node scripts/refresh-verified-candidates.js --required-ready-sets 1 >>"$log_path" 2>&1
  fallback_exit_code=$?
  set -e
  if [ "$fallback_exit_code" -eq 0 ]; then
    exit_code=0
    printf '[candidate-refresh] degraded-ready: one complete set is safe for the imminent send; the 15:00 refresh remains the dinner replenishment boundary\n' >>"$log_path"
  fi
fi

node scripts/prune-runtime-artifacts.js >>"$log_path" 2>&1 || true
if [ "$exit_code" -ne 0 ]; then
  error_detail="$(sed -n 's/^Error: //p' "$log_path" | tail -n 1)"
  if [ -z "$error_detail" ]; then error_detail="exit code $exit_code"; fi
  # Keep the preserved-store note and full log path inside the operations-alert
  # formatter's 300-character detail budget.
  error_detail="${error_detail:0:180}"
  node scripts/send-operations-alert.js \
    --job "메뉴 후보 갱신" \
    --detail "$error_detail; 기존 후보 저장소 보존됨; 로그: $log_path" >>"$log_path" 2>&1 || true
fi
exit "$exit_code"
