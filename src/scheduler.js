import fs from "node:fs";
import path from "node:path";
import { config, DATA_DIR, PRODUCTION_TIMEZONE } from "./config.js";
import { getSchedulerState, saveSchedulerState } from "./storage.js";

export const SCHEDULES = Object.freeze([
  Object.freeze({ hour: 11, minute: 25, mealType: "점심" }),
  Object.freeze({ hour: 17, minute: 25, mealType: "저녁" })
]);

export function getKstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    dateKey: `${value.year}-${value.month}-${value.day}`,
    weekday: value.weekday,
    hour: Number(value.hour),
    minute: Number(value.minute)
  };
}

export function isWeekday(weekday) {
  return !["Sat", "Sun"].includes(weekday);
}

export function loadHolidayDates(
  filePath = path.join(DATA_DIR, "holiday-skip-dates.json"),
  {
    requiredYear = getKstParts().dateKey.slice(0, 4),
    expectedTimezone = PRODUCTION_TIMEZONE
  } = {}
) {
  if (!fs.existsSync(filePath)) throw new Error(`Holiday skip file is missing: ${filePath}`);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1) {
    throw new Error(`Holiday skip file must use schema version 1: ${filePath}`);
  }
  if (data.timezone !== expectedTimezone) {
    throw new Error(`Holiday skip file timezone must be ${expectedTimezone}: ${filePath}`);
  }
  if (!/^\d{4}$/u.test(requiredYear)) {
    throw new Error("Holiday coverage year must use YYYY format");
  }
  if (!Array.isArray(data.dates)) {
    throw new Error(`Holiday skip file has an invalid dates array: ${filePath}`);
  }
  const seen = new Set();
  let previous = "";
  for (const date of data.dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      throw new Error(`Holiday skip file has an invalid dates array: ${filePath}`);
    }
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Holiday skip file contains an invalid calendar date: ${date}`);
    }
    if (seen.has(date)) throw new Error(`Holiday skip file contains a duplicate date: ${date}`);
    if (previous && date < previous) {
      throw new Error(`Holiday skip file dates must be sorted in ascending order: ${filePath}`);
    }
    seen.add(date);
    previous = date;
  }
  if (!data.dates.some((date) => date.startsWith(`${requiredYear}-`))) {
    throw new Error(`Holiday skip file does not cover ${requiredYear}: ${filePath}`);
  }
  return data.dates;
}

export function isHoliday(dateKey) {
  return loadHolidayDates().includes(dateKey);
}

export async function runSchedulerTick(sendMeal, {
  date = new Date(),
  maxCatchUpMinutes = 45,
  holidayCheck = isHoliday,
  getState = getSchedulerState,
  saveState = saveSchedulerState
} = {}) {
  const now = getKstParts(date);
  if (!isWeekday(now.weekday)) return { status: "weekend", dateKey: now.dateKey };
  if (holidayCheck(now.dateKey)) return { status: "holiday", dateKey: now.dateKey };

  const nowMinutes = now.hour * 60 + now.minute;
  const schedule = [...SCHEDULES].reverse().find((item) => {
    const delay = nowMinutes - (item.hour * 60 + item.minute);
    return delay >= 0 && delay <= maxCatchUpMinutes;
  });
  if (!schedule) return { status: "not-due", dateKey: now.dateKey };

  const state = getState();
  const sentKeys = Array.isArray(state.sentKeys) ? state.sentKeys : [];
  const key = `${now.dateKey}:${schedule.mealType}`;
  if (sentKeys.includes(key)) return { status: "already-sent", key };

  await sendMeal({
    channel: config.lunchChannelId,
    mealType: schedule.mealType,
    source: "scheduled-internal"
  });
  saveState({ ...state, sentKeys: [...sentKeys, key].slice(-60) });
  return { status: "sent", key };
}

export function startScheduler(sendMeal, {
  intervalMs = 30 * 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (!config.enableSchedule) {
    console.log("[scheduler] internal scheduler disabled; fenced pororo cron remains the production delivery authority.");
    return () => {};
  }

  console.log("[scheduler] enabled for weekdays 11:25 and 17:25 Asia/Seoul with a 45-minute catch-up window.");
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSchedulerTick(sendMeal);
    } catch (error) {
      console.error("[scheduler] send failed:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setIntervalFn(tick, intervalMs);
  return () => clearIntervalFn(timer);
}
