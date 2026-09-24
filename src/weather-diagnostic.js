import { MEAL_TYPES, normalizeMealType } from "./meal-types.js";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const UV_MEAL_WINDOW_MISSING = /KMA UV unavailable:.*KMA UV response has no value for the meal window/iu;
const AIRKOREA_OFF_HOURS_NO_MEASUREMENT = /AirKorea returned no station measurement/iu;

function kstMinuteOfDay(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error("weather diagnostic clock is invalid");
  const kst = new Date(value.getTime() + KST_OFFSET_MS);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

export function weatherDiagnosticUvRequirement({
  mealType,
  now = new Date(),
  uvStatus,
  uvError,
} = {}) {
  if (uvStatus === "ok") return { satisfied: true, status: "ok" };
  const normalizedMealType = normalizeMealType(mealType, { allowGeneric: false });
  const firstMinuteAfterWindow = normalizedMealType === MEAL_TYPES.dinner
    ? 21 * 60
    : 15 * 60;
  const pastMealWindow = kstMinuteOfDay(now) >= firstMinuteAfterWindow;
  if (pastMealWindow && UV_MEAL_WINDOW_MISSING.test(String(uvError || ""))) {
    return {
      satisfied: true,
      status: "not-applicable-past-window",
    };
  }
  return { satisfied: false, status: "required" };
}

export function weatherDiagnosticAirQualityRequirement({
  now = new Date(),
  airQualityStatus,
  airQualityError,
} = {}) {
  if (airQualityStatus === "ok") return { satisfied: true, status: "ok" };
  const minute = kstMinuteOfDay(now);
  if (minute < 6 * 60 && AIRKOREA_OFF_HOURS_NO_MEASUREMENT.test(String(airQualityError || ""))) {
    return { satisfied: true, status: "not-applicable-off-hours" };
  }
  return { satisfied: false, status: "required" };
}
