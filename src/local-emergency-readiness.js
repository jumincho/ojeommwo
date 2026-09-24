import { config } from "./config.js";
import { hasChoiceDiverseSet } from "./choice-diversity.js";
import { findCooldownConflicts } from "./recommender.js";
import { getKstParts, isWeekday, SCHEDULES } from "./scheduler.js";
import { normalizeMenuKey, normalizeRestaurantKey } from "./text.js";
import {
  filterEligibleVerifiedCandidates,
  hasCurrentDeterministicEvidence
} from "./verified-candidates.js";

const MAX_LOCAL_EMERGENCY_HOURS = 24;

function assertDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}

function dateKeyAfter(dateKey, offsetDays) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + offsetDays, 12));
  return next.toISOString().slice(0, 10);
}

function scheduledAt(dateKey, schedule) {
  const hour = String(schedule.hour).padStart(2, "0");
  const minute = String(schedule.minute).padStart(2, "0");
  return new Date(`${dateKey}T${hour}:${minute}:00+09:00`);
}

function scheduleKey(slot) {
  return `${getKstParts(slot.at).dateKey}:${slot.mealType}`;
}

export function localEmergencyMealSlots({
  now = new Date(),
  expiresAt,
  holidayDates = [],
  currentMeal = ""
} = {}) {
  assertDate(now, "Local emergency start");
  assertDate(expiresAt, "Local emergency expiry");
  const durationMs = expiresAt.getTime() - now.getTime();
  if (durationMs <= 0 || durationMs > MAX_LOCAL_EMERGENCY_HOURS * 60 * 60 * 1000 + 1000) {
    throw new Error(`Local emergency readiness supports a positive lease of at most ${MAX_LOCAL_EMERGENCY_HOURS} hours`);
  }
  if (!Array.isArray(holidayDates) || !holidayDates.every((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))) {
    throw new Error("Local emergency readiness requires a valid holiday date list");
  }
  if (currentMeal && !["lunch", "dinner"].includes(currentMeal)) {
    throw new Error("Current local emergency meal must be lunch or dinner");
  }

  const holidaySet = new Set(holidayDates);
  const coveredYears = new Set(holidayDates.map((date) => date.slice(0, 4)));
  const slots = [];
  if (currentMeal) {
    slots.push({
      meal: currentMeal,
      mealType: currentMeal === "lunch" ? "점심" : "저녁",
      at: new Date(now)
    });
  }

  const startDateKey = getKstParts(now).dateKey;
  for (let offset = 0; offset <= 2; offset += 1) {
    const dateKey = dateKeyAfter(startDateKey, offset);
    const potentialSlots = SCHEDULES
      .map((schedule) => ({ schedule, at: scheduledAt(dateKey, schedule) }))
      .filter(({ at }) => at > now && at < expiresAt);
    if (potentialSlots.length === 0) continue;
    if (!coveredYears.has(dateKey.slice(0, 4))) {
      throw new Error(`Holiday skip data does not cover ${dateKey.slice(0, 4)}`);
    }
    const day = getKstParts(new Date(`${dateKey}T12:00:00+09:00`));
    if (!isWeekday(day.weekday) || holidaySet.has(dateKey)) continue;
    for (const { schedule, at } of potentialSlots) {
      slots.push({
        meal: schedule.mealType === "점심" ? "lunch" : "dinner",
        mealType: schedule.mealType,
        at
      });
    }
  }

  const unique = new Map();
  for (const slot of slots.sort((left, right) => left.at - right.at)) {
    unique.set(scheduleKey(slot), slot);
  }
  const result = [...unique.values()].sort((left, right) => left.at - right.at);
  if (result.length > 2) {
    throw new Error("A 24-hour local emergency lease unexpectedly contains more than two scheduled meals");
  }
  return result;
}

function* diverseSelections(candidates, limit, start = 0, picked = []) {
  if (picked.length === limit) {
    if (hasChoiceDiverseSet(picked, limit)) yield picked;
    return;
  }
  const remainingNeeded = limit - picked.length;
  for (let index = start; index <= candidates.length - remainingNeeded; index += 1) {
    yield* diverseSelections(candidates, limit, index + 1, [...picked, candidates[index]]);
  }
}

export function hasSequentialLocalEmergencyReadiness(candidates, sendCount, {
  recommendationCount = config.recommendationCount
} = {}) {
  if (!Number.isInteger(sendCount) || sendCount < 0 || sendCount > 2) return false;
  if (sendCount === 0) return true;
  const pool = Array.isArray(candidates) ? candidates : [];
  if (pool.length < sendCount * recommendationCount) return false;

  let sawFirstSelection = false;
  for (const selected of diverseSelections(pool, recommendationCount)) {
    sawFirstSelection = true;
    if (sendCount === 1) return true;
    const selectedIds = new Set(selected.map((candidate) => candidate.candidateId));
    const selectedRestaurants = new Set(selected.map((candidate) => normalizeRestaurantKey(candidate.restaurant)));
    const selectedMenus = new Set(selected.map((candidate) => normalizeMenuKey(candidate.menu)));
    const remaining = pool.filter((candidate) =>
      !selectedIds.has(candidate.candidateId)
      && !selectedRestaurants.has(normalizeRestaurantKey(candidate.restaurant))
      && !selectedMenus.has(normalizeMenuKey(candidate.menu))
    );
    if (!diverseSelections(remaining, recommendationCount).next().value) return false;
  }
  return sawFirstSelection;
}

export function assessLocalEmergencyReadiness({
  now = new Date(),
  expiresAt,
  holidayDates = [],
  currentMeal = "",
  verifiedCandidates = [],
  history = { version: 1, items: [] },
  mealEvents = { version: 1, events: [] }
} = {}) {
  const slots = localEmergencyMealSlots({ now, expiresAt, holidayDates, currentMeal });
  if (slots.length === 0) {
    return {
      ready: true,
      scheduledSendCount: 0,
      eligibleCandidateCount: 0,
      slots: [],
      detail: "no scheduled meal falls within the emergency lease"
    };
  }

  const firstSendAt = slots[0].at;
  const lastSendAt = slots.at(-1).at;
  // Emergency mode never extends production freshness policy. A stale local
  // reserve fails closed and must be replaced with a freshly prepared server
  // snapshot before activation.
  const evidenceMaxAgeDays = Math.min(
    config.researchPriceTtlDays,
    config.researchDeliveryTtlDays
  );
  const currentIds = new Set(
    filterEligibleVerifiedCandidates(verifiedCandidates, {
      now,
      deliveryTtlDays: config.researchDeliveryTtlDays
    })
      .filter((candidate) => hasCurrentDeterministicEvidence(candidate, {
        now,
        maxAgeDays: evidenceMaxAgeDays
      }))
      .map((candidate) => candidate.candidateId)
  );
  const validThroughLastSend = filterEligibleVerifiedCandidates(verifiedCandidates, {
    now: lastSendAt,
    deliveryTtlDays: config.researchDeliveryTtlDays
  })
    .filter((candidate) => currentIds.has(candidate.candidateId))
    .filter((candidate) => hasCurrentDeterministicEvidence(candidate, {
      now: lastSendAt,
      maxAgeDays: evidenceMaxAgeDays
    }));
  const eligible = validThroughLastSend.filter((candidate) =>
    findCooldownConflicts([candidate], history, {
      now: firstSendAt,
      mealEvents,
      restaurantCooldownDays: config.restaurantCooldownDays,
      menuCooldownDays: config.menuCooldownDays
    }).length === 0
  );
  const ready = hasSequentialLocalEmergencyReadiness(eligible, slots.length);
  return {
    ready,
    scheduledSendCount: slots.length,
    eligibleCandidateCount: eligible.length,
    slots: slots.map((slot) => ({ meal: slot.meal, mealType: slot.mealType, at: slot.at.toISOString() })),
    detail: ready
      ? `${eligible.length} deterministic candidates can safely cover ${slots.length} scheduled emergency meal(s) through ${lastSendAt.toISOString()}`
      : `${eligible.length} deterministic candidates cannot safely cover ${slots.length} scheduled emergency meal(s) through ${lastSendAt.toISOString()}`
  };
}
