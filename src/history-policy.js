const NON_LEARNING_NORMALIZATION_STATUSES = new Set([
  "pending", "normalizing", "failed", "unresolved", "unverified", "local-only", "rejected-input"
]);
const VERIFIED_MEAL_STATUSES = new Set(["verified", "verified-source"]);

function hasProductionLearningSource(item) {
  return String(item?.source || "").startsWith("scheduled-");
}

function isNotPrivateTest(item) {
  return String(item?.source || "") !== "manual-private-test";
}

export function isLearningRecommendationHistoryItem(item) {
  return isNotPrivateTest(item);
}

export function isLearningMealEvent(item) {
  return hasProductionLearningSource(item)
    && Boolean(String(item?.respondentId || "").trim())
    && VERIFIED_MEAL_STATUSES.has(String(item?.normalizationStatus || ""));
}

export function isLearningCandidatePreferenceResponse(item) {
  return hasProductionLearningSource(item) && Boolean(String(item?.respondentId || "").trim());
}

// Backward-compatible mixed-record policy for modules that use meal events only
// as conservative cooldown exclusions rather than preference-learning signals.
export function isLearningHistoryItem(item) {
  return isNotPrivateTest(item)
    && !NON_LEARNING_NORMALIZATION_STATUSES.has(String(item?.normalizationStatus || ""));
}

// A DM rehearsal and a real meal are distinct submissions. Keep this key shared
// by UI duplicate checks, storage validation, and emergency snapshot recovery.
export function mealSubmissionSlotKey(event) {
  if (!event?.respondentId || !event?.date) return "";
  const scope = isNotPrivateTest(event) ? "production" : "private-test";
  return `${event.respondentId}:${event.date}:${event.mealType}:${scope}`;
}
