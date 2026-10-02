import { config, PRODUCTION_TIMEZONE } from "./config.js";
import { getKstParts, isHoliday, isWeekday, SCHEDULES } from "./scheduler.js";
import { inspectOperatingMaintenanceMarker } from "./maintenance-marker.js";

export const SCHEDULED_ENTRY_ENV = "OJEOMMWO_SCHEDULED_ENTRY";
export const MAX_SCHEDULED_START_DELAY_MS = 45 * 60 * 1000;

// The origin is an accident-prevention fence, not an authentication secret.
// Platform wrappers still own their overlap lock and (on Windows) failover
// lease/server-recovery checks. Rechecking here closes direct CLI bypasses.
export function assertScheduledDeliveryAuthority({
  mealType,
  now = new Date(),
  entry = process.env[SCHEDULED_ENTRY_ENV],
  platform = process.platform,
  timezone = config.timezone,
  holidayCheck = isHoliday,
  maintenanceCheck = inspectOperatingMaintenanceMarker,
} = {}) {
  const requiredEntry = platform === "win32" ? "local-emergency" : "server-cron";
  if (!["linux", "win32"].includes(platform) || entry !== requiredEntry) {
    throw new Error("Live scheduled delivery requires the fenced platform wrapper; use the operator DM preview for tests");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Live scheduled delivery requires a valid current time");
  }
  if (timezone !== PRODUCTION_TIMEZONE) {
    throw new Error(`Live scheduled delivery timezone must be ${PRODUCTION_TIMEZONE}`);
  }
  const maintenance = maintenanceCheck({ now });
  if (maintenance?.state !== "absent") {
    throw new Error("Live scheduled delivery is blocked by an active or unsafe maintenance marker");
  }
  const parts = getKstParts(now);
  if (!isWeekday(parts.weekday) || holidayCheck(parts.dateKey)) {
    throw new Error("Live scheduled delivery is limited to non-holiday weekdays in Asia/Seoul");
  }
  const schedule = SCHEDULES.find((item) => item.mealType === mealType);
  if (!schedule) throw new Error("Live scheduled delivery requires a lunch or dinner meal type");
  const scheduledAt = Date.parse(`${parts.dateKey}T${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}:00+09:00`);
  const delayMs = now.getTime() - scheduledAt;
  if (delayMs < 0 || delayMs > MAX_SCHEDULED_START_DELAY_MS) {
    throw new Error("Live scheduled delivery is outside its protected 45-minute meal window; use the operator DM preview for tests");
  }
  return { dateKey: parts.dateKey, mealType, scheduledAt: new Date(scheduledAt).toISOString(), delayMs };
}
