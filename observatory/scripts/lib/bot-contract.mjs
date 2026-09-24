import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const observatoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BOT_ROOT = path.resolve(observatoryRoot, "..");

export const BOT_CONTRACT_SOURCE_FILES = Object.freeze([
  "src/taste-profile.js",
  "src/choice-diversity.js",
  "src/history-policy.js",
  "src/meal-event-items.js",
  "src/categories.js",
  "src/category-arbitration.js",
  "prompts/category-adjudication.schema.json",
  "src/verified-candidates.js",
  "src/recommendation-comment.js",
  "src/audited-location-branches.js",
  "src/operating-snapshot.js",
  "src/text.js",
  "src/config.js",
]);

async function botModule(relativePath) {
  return import(pathToFileURL(path.join(BOT_ROOT, relativePath)).href);
}

const [
  tasteModule,
  historyPolicyModule,
  mealItemsModule,
  categoryModule,
  arbitrationModule,
  candidateModule,
  snapshotModule,
  textModule,
  configModule,
] = await Promise.all([
  botModule("src/taste-profile.js"),
  botModule("src/history-policy.js"),
  botModule("src/meal-event-items.js"),
  botModule("src/categories.js"),
  botModule("src/category-arbitration.js"),
  botModule("src/verified-candidates.js"),
  botModule("src/operating-snapshot.js"),
  botModule("src/text.js"),
  botModule("src/config.js"),
]);

export const { tastePosterior } = tasteModule;
export const {
  isLearningRecommendationHistoryItem,
  isLearningMealEvent,
  isLearningCandidatePreferenceResponse,
} = historyPolicyModule;
export const { expandMealEvents } = mealItemsModule;
export const {
  FOOD_CATEGORIES,
  CATEGORY_EMOJI,
  classifyFoodCategory,
  isExcludedMealCandidate,
} = categoryModule;
export const { resolveOperationalCategory } = arbitrationModule;
export const { normalizeVerifiedCandidate, hasCurrentDeterministicEvidence } = candidateModule;
export const { validateOperatingSnapshotDirectory } = snapshotModule;
export const {
  canonicalizeMenuForRestaurant,
  canonicalizeRestaurantIdentity,
  cleanText,
  normalizeKey,
  normalizeMenuKey
} = textModule;
export const { config } = configModule;

function digestBotSource(relativePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(BOT_ROOT, relativePath))).digest("hex");
}

export function algorithmContract() {
  const neutral = tastePosterior({ category: "", restaurant: "", menu: "" }, {
    events: [],
    preferences: [],
    halfLifeDays: config.tasteHalfLifeDays,
    preferenceWeight: config.candidatePreferenceWeight,
    now: new Date(0),
  });
  const contract = {
    schemaVersion: 2,
    posterior: "beta",
    priorAlpha: neutral.alpha,
    priorBeta: neutral.beta,
    tasteHalfLifeDays: config.tasteHalfLifeDays,
    candidatePreferenceWeight: config.candidatePreferenceWeight,
    explorationRate: config.tasteExplorationRate,
    displayUsesStablePosteriorMean: true,
    categories: [...FOOD_CATEGORIES],
    sourceFiles: Object.fromEntries(BOT_CONTRACT_SOURCE_FILES.map((name) => [name, digestBotSource(name)])),
  };
  return {
    ...contract,
    contractFingerprint: crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
  };
}
