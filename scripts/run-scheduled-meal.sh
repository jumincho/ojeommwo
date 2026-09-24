#!/usr/bin/env bash
set -euo pipefail
umask 077

meal=""
channel=""
mode="cache"
dry_run=0
meal_explicit=0
channel_explicit=0
max_start_delay_minutes=45
allow_stale_start=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --meal)
      meal="${2:?missing value for --meal}"
      meal_explicit=1
      shift 2
      ;;
    --channel)
      channel="${2:?missing value for --channel}"
      channel_explicit=1
      shift 2
      ;;
    --mode)
      mode="${2:?missing value for --mode}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --max-start-delay-minutes)
      max_start_delay_minutes="${2:?missing value for --max-start-delay-minutes}"
      shift 2
      ;;
    --allow-stale-start)
      allow_stale_start=1
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$meal_explicit" -ne 1 ]; then
  echo "--meal is required; use lunch or dinner for live delivery" >&2
  exit 2
fi

case "$meal" in
  lunch|dinner|meal) ;;
  *)
    echo "--meal must be lunch, dinner, or meal" >&2
    exit 2
    ;;
esac

if [ "$dry_run" -eq 0 ] && [ "$meal" = "meal" ]; then
  echo "live scheduled delivery requires --meal lunch or --meal dinner" >&2
  exit 2
fi

if [ "$dry_run" -eq 0 ] && { [ "$channel_explicit" -ne 1 ] || [ -z "$channel" ]; }; then
  echo "live scheduled delivery requires an explicit --channel" >&2
  exit 2
fi

if [ "$dry_run" -eq 0 ] && [ "$mode" != "cache" ]; then
  echo "live scheduled delivery requires --mode cache; model and static modes are dry-run diagnostics only" >&2
  exit 2
fi

case "$mode" in
  codex-cli|cache|static) ;;
  *)
    echo "--mode must be codex-cli, cache, or static" >&2
    exit 2
    ;;
esac

case "$max_start_delay_minutes" in
  ''|*[!0-9]*)
    echo "--max-start-delay-minutes must be a non-negative integer" >&2
    exit 2
    ;;
esac

if [ -n "$channel" ] && ! [[ "$channel" =~ ^[CGD][A-Z0-9]+$ ]]; then
  echo "--channel must be a Slack channel or conversation ID" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
log_dir="$project_root/logs"
holiday_skip_path="$project_root/data/holiday-skip-dates.json"
maintenance_path="$project_root/data/.operating-maintenance"
production_timezone="Asia/Seoul"
node_exe="${NODE_EXE:-node}"

mkdir -p "$log_dir"

if ! command -v "$node_exe" >/dev/null 2>&1 && [ ! -x "$node_exe" ]; then
  echo "Node.js executable not found: $node_exe" >&2
  exit 1
fi

if ! timezone="$(
  cd "$project_root"
  "$node_exe" --input-type=module -e '
    import { config, PRODUCTION_TIMEZONE } from "./src/config.js";
    if (config.timezone !== PRODUCTION_TIMEZONE) {
      throw new Error(`TIMEZONE must be ${PRODUCTION_TIMEZONE} for production scheduling`);
    }
    process.stdout.write(config.timezone);
  '
)"; then
  echo "could not validate the production scheduling timezone" >&2
  exit 1
fi
if [ "$timezone" != "$production_timezone" ]; then
  echo "production scheduling timezone must be $production_timezone" >&2
  exit 1
fi

timestamp="$(TZ="$timezone" date +%Y%m%d-%H%M%S)"
log_path="$log_dir/scheduled-$meal-$timestamp.log"

log() {
  printf '[%s] %s\n' "$(TZ="$timezone" date --iso-8601=seconds)" "$*" | tee -a "$log_path"
}

maintenance_guard() {
  if [ ! -e "$maintenance_path" ]; then return 1; fi
  local detail
  if detail="$(cd "$project_root" && "$node_exe" scripts/check-operating-maintenance.js --path "$maintenance_path" 2>&1)"; then
    log "$detail; scheduled delivery did not start"
    return 0
  fi
  log "unsafe maintenance marker: $detail"
  (cd "$project_root" && "$node_exe" scripts/send-operations-alert.js \
    --job "예약 발송 유지보수 잠금 검증" \
    --detail "$detail") >>"$log_path" 2>&1 || true
  return 2
}

if maintenance_guard; then exit 0; else maintenance_code=$?; [ "$maintenance_code" -eq 1 ] || exit 1; fi

lock_path="$project_root/data/.scheduled-$meal.lock"
exec 9>"$lock_path"
if ! command -v flock >/dev/null 2>&1; then
  log "required overlap-lock command is unavailable: flock"
  exit 1
fi
if ! flock -n 9; then
  log "skipped overlapping scheduled meal: meal=$meal channel=$channel"
  exit 0
fi

scheduled_time=""
case "$meal" in
  lunch) scheduled_time="11:25:00" ;;
  dinner) scheduled_time="17:25:00" ;;
esac

weekday="$(TZ="$timezone" date +%u)"
if [ "$dry_run" -eq 0 ] && [ -n "$scheduled_time" ] && [ "$weekday" -gt 5 ]; then
  log "skipped scheduled meal on weekend: meal=$meal channel=$channel weekday=$weekday"
  exit 0
fi

if [ "$allow_stale_start" -eq 0 ] && [ -n "$scheduled_time" ]; then
  today="$(TZ="$timezone" date +%Y-%m-%d)"
  now_epoch="$(TZ="$timezone" date +%s)"
  scheduled_epoch="$(TZ="$timezone" date -d "$today $scheduled_time" +%s)"
  delay_seconds=$((now_epoch - scheduled_epoch))
  max_delay_seconds=$((max_start_delay_minutes * 60))
  if [ "$delay_seconds" -lt 0 ] || [ "$delay_seconds" -gt "$max_delay_seconds" ]; then
    log "skipped stale scheduled meal: meal=$meal channel=$channel delaySeconds=$delay_seconds maxDelaySeconds=$max_delay_seconds"
    exit 0
  fi
fi

if [ ! -f "$holiday_skip_path" ]; then
  log "holiday skip file is missing: $holiday_skip_path"
  exit 1
fi

today="$(TZ="$timezone" date +%Y-%m-%d)"
set +e
holiday_result="$(
  cd "$project_root"
  "$node_exe" --input-type=module -e '
    import { loadHolidayDates } from "./src/scheduler.js";
    const file = process.argv[1];
    const today = process.argv[2];
    const dates = loadHolidayDates(file, { requiredYear: today.slice(0, 4) });
    process.stdout.write(dates.includes(today) ? "skip" : "run");
  ' "$holiday_skip_path" "$today" 2>>"$log_path")"
holiday_exit=$?
set -e
if [ "$holiday_exit" -ne 0 ]; then
  log "holiday skip file validation failed: $holiday_skip_path"
  exit "$holiday_exit"
fi
if [ "$holiday_result" = "skip" ]; then
  log "skipped scheduled meal on holiday: date=$today meal=$meal channel=$channel"
  exit 0
fi

args=("scripts/send-scheduled-meal.js" "--meal" "$meal" "--mode" "$mode")
if [ -n "$channel" ]; then
  args+=("--channel" "$channel")
fi
if [ "$dry_run" -eq 1 ]; then
  args+=("--dry-run")
fi

cd "$project_root"
if maintenance_guard; then exit 0; else maintenance_code=$?; [ "$maintenance_code" -eq 1 ] || exit 1; fi
log "starting scheduled meal: meal=$meal channel=$channel mode=$mode dryRun=$dry_run"
set +e
"$node_exe" "${args[@]}" >>"$log_path" 2>&1
exit_code=$?
set -e
if ! "$node_exe" scripts/prune-runtime-artifacts.js >>"$log_path" 2>&1; then
  log "runtime artifact maintenance failed; meal result is preserved"
fi
log "finished with exit code $exit_code"
exit "$exit_code"
