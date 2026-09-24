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
