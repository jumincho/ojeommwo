const DAY_MS = 24 * 60 * 60 * 1000;

// External cron and Slack acknowledgement can move otherwise identical meal
// runs by a few seconds. Do not turn a nominal 7/14-day boundary into a false
// violation solely because the later run started marginally earlier.
export const COOLDOWN_SCHEDULE_JITTER_MS = 5 * 60 * 1000;

export function cooldownAgeDays(previousAt, currentAt) {
  const previous = Date.parse(previousAt || "");
  const current = currentAt instanceof Date ? currentAt.getTime() : Date.parse(currentAt || "");
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return Number.POSITIVE_INFINITY;
  return (current - previous) / DAY_MS;
}

export function isCooldownActive(previousAt, currentAt, cooldownDays, {
  scheduleJitterMs = COOLDOWN_SCHEDULE_JITTER_MS
} = {}) {
  if (!Number.isFinite(cooldownDays) || cooldownDays <= 0
      || !Number.isInteger(scheduleJitterMs) || scheduleJitterMs < 0
      || scheduleJitterMs > 15 * 60 * 1000) return false;
  const ageDays = cooldownAgeDays(previousAt, currentAt);
  if (!Number.isFinite(ageDays) || ageDays < 0) return false;
  const effectiveWindowMs = Math.max(0, cooldownDays * DAY_MS - scheduleJitterMs);
  return ageDays * DAY_MS < effectiveWindowMs;
}
