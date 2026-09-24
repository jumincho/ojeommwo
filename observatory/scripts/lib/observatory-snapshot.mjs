import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CATEGORY_EMOJI,
  FOOD_CATEGORIES,
  algorithmContract,
  canonicalizeMenuForRestaurant,
  canonicalizeRestaurantIdentity,
  resolveOperationalCategory,
  cleanText,
  config,
  expandMealEvents,
  hasCurrentDeterministicEvidence,
  isLearningCandidatePreferenceResponse,
  isLearningMealEvent,
  isLearningRecommendationHistoryItem,
  normalizeKey,
  normalizeMenuKey,
  normalizeVerifiedCandidate,
  tastePosterior,
  validateOperatingSnapshotDirectory,
} from "./bot-contract.mjs";
import { ingredientSearchTagsFor } from "./ingredient-tags.mjs";

export { algorithmContract } from "./bot-contract.mjs";

const CATEGORY_STYLE = Object.freeze({
  "한식": { color: "#f4d35e", glow: "#fff1a8" },
  "치킨": { color: "#f59e0b", glow: "#ffd166" },
  "분식": { color: "#ff5d8f", glow: "#ffabc4" },
  "돈까스": { color: "#b47cff", glow: "#d6b8ff" },
  "족발/보쌈": { color: "#f28482", glow: "#ffb4b2" },
  "찜/탕": { color: "#ef476f", glow: "#ff8ba4" },
  "구이": { color: "#ff6b35", glow: "#ff9b6a" },
  "피자": { color: "#ff4d9d", glow: "#ff9dca" },
  "중식": { color: "#ffd23f", glow: "#ffe888" },
  "일식": { color: "#b8f2e6", glow: "#e4fff9" },
  "회/해물": { color: "#00d9ff", glow: "#79ecff" },
  "양식": { color: "#a78bfa", glow: "#d8ccff" },
  "아시안": { color: "#3ddc97", glow: "#99f6ca" },
  "샌드위치": { color: "#5eead4", glow: "#a7f3e8" },
  "샐러드": { color: "#8be28b", glow: "#c6f6c6" },
  "버거": { color: "#7c6cff", glow: "#afa5ff" },
  "멕시칸": { color: "#ff8c42", glow: "#ffc18d" },
  "도시락": { color: "#72f1a6", glow: "#b2f8cf" },
  "죽": { color: "#e9cfa7", glow: "#fff0d8" },
});

export const TAXONOMY = Object.freeze(FOOD_CATEGORIES.map((id) => Object.freeze({
  id,
  emoji: CATEGORY_EMOJI[id],
  ...CATEGORY_STYLE[id],
})));

export const TASTE_GRAVITY_EASTER_EGGS = Object.freeze([
  Object.freeze({
    id: "taste_easter_egg_subway_cucumber",
    restaurantLabel: "서브웨이",
    menu: "오이샌드위치",
    category: "샌드위치",
    score: 0,
    algorithmImpact: false,
    note: "연구실 공식 금지 메뉴입니다.",
  }),
]);

export const SNAPSHOT_INPUT_FILES = Object.freeze([
  "recommendation-history.json",
  "sent-messages.json",
  "meal-events.json",
  "candidate-preferences.json",
  "verified-candidates.json",
  "recommendations.json",
]);

const DAY_MS = 86_400_000;
export const OBSERVATORY_RECENT_DELIVERY_TTL_DAYS = 30;

export { cleanText, normalizeKey, normalizeMenuKey };

export function stableId(prefix, ...parts) {
  const value = parts.map((item, index) =>
    prefix === "menu" && index === parts.length - 1
      ? normalizeMenuKey(item)
      : normalizeKey(item)
  ).join("\u001f");
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function splitRestaurant(restaurant, explicitBranch = "") {
  const identity = canonicalizeRestaurantIdentity({
    restaurant: cleanText(restaurant).slice(0, 120),
    branch: cleanText(explicitBranch).slice(0, 80)
  });
  return {
    base: cleanText(identity.restaurant).slice(0, 120),
    branch: cleanText(identity.branch).slice(0, 80)
  };
}

function canonicalProjectionRecord(record) {
  const parsed = splitRestaurant(record?.restaurant, record?.branch);
  return {
    ...record,
    restaurant: parsed.base,
    ...(parsed.branch || record?.branch !== undefined ? { branch: parsed.branch } : {}),
    menu: canonicalizeMenuForRestaurant({
      restaurant: parsed.base,
      menu: record?.menu,
    }),
  };
}

function canonicalProjectionMealEvent(event) {
  const canonical = canonicalProjectionRecord(event);
  const menus = Array.isArray(event?.menus)
    ? event.menus.map((menu) => canonicalizeMenuForRestaurant({
        restaurant: canonical.restaurant,
        menu,
      }))
    : null;
  return {
    ...canonical,
    ...(menus ? { menus, menu: menus.join(" · ") } : {}),
  };
}

function canonicalProjectionPreferenceResponse(response) {
  return {
    ...response,
    ratings: Array.isArray(response?.ratings)
      ? response.ratings.map(canonicalProjectionRecord)
      : response?.ratings,
  };
}

export function categoryFor(record) {
  return resolveOperationalCategory(record).category;
}

export function preferredIngredientFamilies(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (Array.isArray(candidate?.ingredientFamilies) && candidate.ingredientFamilies.length) {
      return candidate.ingredientFamilies;
    }
  }
  return [];
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    if (arguments.length >= 2) return structuredClone(fallback);
    throw new Error(`Required observatory input is missing: ${path.basename(filePath)}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readArrayJson(filePath) {
  const value = readJson(filePath);
  if (!Array.isArray(value)) throw new Error(`${path.basename(filePath)} must contain an array`);
  return value;
}

function round(value, digits = 5) {
  return Number(Number(value).toFixed(digits));
}

function roundedPosterior(value) {
  return {
    alpha: round(value.alpha),
    beta: round(value.beta),
    mean: round(value.mean),
    bias: round(value.bias),
    evidenceWeight: round(value.evidenceWeight),
    confidence: round(value.confidence),
    intervalLow: round(value.intervalLow),
    intervalHigh: round(value.intervalHigh),
    sources: Object.fromEntries(Object.entries(value.sources).map(([key, amount]) => [key, round(amount)])),
  };
}

function updateFingerprint(hash, label, value) {
  const labelBuffer = Buffer.from(label, "utf8");
  const valueBuffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32BE(labelBuffer.length, 0);
  lengths.writeUInt32BE(valueBuffer.length, 4);
  hash.update(lengths).update(labelBuffer).update(valueBuffer);
}

export function snapshotSourceFingerprint(dataDir, contract = algorithmContract()) {
  const resolved = path.resolve(dataDir);
  const hash = crypto.createHash("sha256");
  for (const name of SNAPSHOT_INPUT_FILES) {
    const filePath = path.join(resolved, name);
    if (!fs.existsSync(filePath)) throw new Error(`Required fingerprint input is missing: ${name}`);
    updateFingerprint(hash, `input:${name}`, fs.readFileSync(filePath));
  }
  updateFingerprint(hash, "algorithm-contract", JSON.stringify(contract));
  return hash.digest("hex");
}

function learningPreferenceRatings(preferences) {
  const responses = (Array.isArray(preferences) ? preferences : preferences?.responses || [])
    .filter(isLearningCandidatePreferenceResponse);
  const flattened = responses.flatMap((response) => (response.ratings || []).map((rating, index) => ({
    ...rating,
    responseId: response.responseId,
    respondentId: response.respondentId,
    responseRatingIndex: index,
    mealType: response.mealType,
    source: response.source,
    createdAt: response.updatedAt || response.submittedAt || response.createdAt,
  })));
  const unique = new Map();
  for (const rating of flattened) {
    if (!isLearningCandidatePreferenceResponse(rating)) continue;
    const key = `respondent:${rating.respondentId}:${normalizeKey(rating.restaurant)}:${normalizeMenuKey(rating.menu)}`;
    const previous = unique.get(key);
    const previousTime = Date.parse(previous?.createdAt || "");
    const nextTime = Date.parse(rating.createdAt || "");
    if (!previous || !Number.isFinite(previousTime) || !Number.isFinite(nextTime) || nextTime >= previousTime) {
      unique.set(key, rating);
    }
  }
  return [...unique.values()];
}

function formatRestaurant(base, branch) {
  return branch && !normalizeKey(base).endsWith(normalizeKey(branch)) ? `${base} ${branch}` : base;
}

function safeDate(value, fallback) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

export function candidateKey(restaurant, menu, branch = "") {
  const parsed = splitRestaurant(restaurant, branch);
  const canonicalMenu = canonicalizeMenuForRestaurant({ restaurant: parsed.base, menu });
  return [
    normalizeKey(parsed.base),
    normalizeKey(parsed.branch),
    normalizeMenuKey(canonicalMenu),
  ].join(":");
}

export function restaurantBranchKey(restaurant, branch = "") {
  const parsed = splitRestaurant(restaurant, branch);
  return [normalizeKey(parsed.base), normalizeKey(parsed.branch)].join(":");
}

function compareRecordPriority(left, right) {
  const sourcePriority = { preference: 5, verified: 4, meal: 3, history: 2, catalog: 1 };
  const sourceDelta = (sourcePriority[right.sourceKind] || 0) - (sourcePriority[left.sourceKind] || 0);
  if (sourceDelta) return sourceDelta;
  return Date.parse(right.timestamp || "") - Date.parse(left.timestamp || "");
}

function makeRecords({ historyItems, staticRecommendations, activeCandidates, mealEvents, ratings, generatedAt }) {
  return [
    ...historyItems.map((item) => ({ ...item, sourceKind: "history", timestamp: item.recommendedAt || generatedAt })),
    ...staticRecommendations.map((item) => ({ ...item, sourceKind: "catalog", timestamp: generatedAt })),
    ...activeCandidates.map((item) => ({ ...item, sourceKind: "verified", timestamp: item.priceCheckedAt || generatedAt })),
    ...expandMealEvents(mealEvents).map((item) => ({ ...item, sourceKind: "meal", timestamp: item.createdAt || generatedAt })),
    ...ratings.map((item) => ({ ...item, sourceKind: "preference", timestamp: item.createdAt || generatedAt })),
  ].filter((item) => cleanText(item.restaurant) && cleanText(item.menu));
}

function activeCandidate(raw, now) {
  const normalized = normalizeVerifiedCandidate(raw, { now });
  if (!normalized || !hasCurrentDeterministicEvidence(raw, { now })) return null;
  return { ...raw, ...normalized };
}

function candidateEvidencePriority(candidate) {
  return [
    candidate.deliveryStatus === "verified" ? 1 : 0,
    Date.parse(candidate.evidenceVerifiedAt || "") || 0,
    Date.parse(candidate.deliveryCheckedAt || "") || 0,
    Date.parse(candidate.priceCheckedAt || "") || 0,
  ];
}

function isStrongerCandidate(candidate, previous) {
  const nextPriority = candidateEvidencePriority(candidate);
  const previousPriority = candidateEvidencePriority(previous);
  for (let index = 0; index < nextPriority.length; index += 1) {
    if (nextPriority[index] !== previousPriority[index]) {
      return nextPriority[index] > previousPriority[index];
    }
  }
  return false;
}

export function dedupeActiveCandidates(rawCandidates, now = new Date()) {
  const activeByKey = new Map();
  for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const candidate = activeCandidate(raw, now);
    if (!candidate) continue;
    const key = candidateKey(candidate.restaurant, candidate.menu, candidate.branch);
    const previous = activeByKey.get(key);
    if (!previous || isStrongerCandidate(candidate, previous)) activeByKey.set(key, candidate);
  }
  return activeByKey;
}

// A researched catalog row may be newer than the currently selectable pool.
// Reuse only independently verified, still-current exact-menu facts; never
// reinterpret a historical sent message or another dish at the same branch.
export function dedupeCurrentPrices(rawCandidates, now = new Date()) {
  const prices = new Map();
  for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const candidate = activeCandidate(raw, now);
    if (!candidate) continue;
    const key = candidateKey(candidate.restaurant, candidate.menu, candidate.branch);
    const previous = prices.get(key);
    if (!previous || Date.parse(candidate.priceCheckedAt) > Date.parse(previous.priceCheckedAt)
      || (candidate.priceCheckedAt === previous.priceCheckedAt
        && Date.parse(candidate.evidenceVerifiedAt) > Date.parse(previous.evidenceVerifiedAt))) {
      prices.set(key, candidate);
    }
  }
  return prices;
}

function recentDeliveryCandidate(raw, now) {
  return normalizeVerifiedCandidate(raw, {
    now,
    priceTtlDays: 3650,
    deliveryTtlDays: OBSERVATORY_RECENT_DELIVERY_TTL_DAYS,
  });
}

function isNewerStoreDelivery(candidate, previous) {
  const checkedDelta = (Date.parse(candidate.deliveryCheckedAt || "") || 0)
    - (Date.parse(previous.deliveryCheckedAt || "") || 0);
  if (checkedDelta) return checkedDelta > 0;
  if (candidate.deliveryStatus !== previous.deliveryStatus) return candidate.deliveryStatus === "verified";
  return (Date.parse(candidate.evidenceVerifiedAt || "") || 0)
    > (Date.parse(previous.evidenceVerifiedAt || "") || 0);
}

export function dedupeRecentDeliveryByRestaurant(rawCandidates, now = new Date()) {
  const recentByRestaurant = new Map();
  for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const candidate = recentDeliveryCandidate(raw, now);
    if (!candidate) continue;
    const key = restaurantBranchKey(candidate.restaurant, candidate.branch);
    const previous = recentByRestaurant.get(key);
    if (!previous || isNewerStoreDelivery(candidate, previous)) {
      recentByRestaurant.set(key, candidate);
    }
  }
  return recentByRestaurant;
}

function addDays(value, days) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return null;
  return new Date(time + days * DAY_MS).toISOString();
}

function availabilityProjection(candidate, storeDelivery, now) {
  const delivery = storeDelivery ?? candidate;
  if (!delivery) {
    return {
      availableNow: false,
      availabilityCheckedAt: null,
      availabilityExpiresAt: null,
      deliveryStatus: null,
      deliveryFreshness: null,
      priceCheckedAt: null,
      priceExpiresAt: null,
    };
  }
  const deliveryAgeDays = (now.getTime() - Date.parse(delivery.deliveryCheckedAt)) / DAY_MS;
  const deliveryFreshness = deliveryAgeDays <= config.researchDeliveryTtlDays ? "current" : "recent";
  const deliveryExpiresAt = addDays(
    delivery.deliveryCheckedAt,
    deliveryFreshness === "current"
      ? config.researchDeliveryTtlDays
      : OBSERVATORY_RECENT_DELIVERY_TTL_DAYS,
  );
  return {
    availableNow: Boolean(candidate),
    availabilityCheckedAt: safeDate(delivery.deliveryCheckedAt, null),
    availabilityExpiresAt: deliveryExpiresAt,
    deliveryStatus: delivery.deliveryStatus === "verified" ? "verified" : "likely",
    deliveryFreshness,
    priceCheckedAt: candidate ? safeDate(candidate.priceCheckedAt, null) : null,
    priceExpiresAt: candidate ? addDays(candidate.priceCheckedAt, config.researchPriceTtlDays) : null,
  };
}

export function buildSnapshot({ dataDir, generatedAt = new Date().toISOString() } = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  const resolvedDataDir = path.resolve(dataDir);
  const now = new Date(generatedAt);
  if (!Number.isFinite(now.getTime())) throw new Error("generatedAt must be a valid ISO timestamp");

  validateOperatingSnapshotDirectory(resolvedDataDir, { now });

  const historyStore = readJson(path.join(resolvedDataDir, "recommendation-history.json"));
  const sentStore = readJson(path.join(resolvedDataDir, "sent-messages.json"));
  const mealStore = readJson(path.join(resolvedDataDir, "meal-events.json"));
  const preferenceStore = readJson(path.join(resolvedDataDir, "candidate-preferences.json"));
  const verifiedStore = readJson(path.join(resolvedDataDir, "verified-candidates.json"));
  const staticRecommendations = readArrayJson(path.join(resolvedDataDir, "recommendations.json"))
    .map(canonicalProjectionRecord);
  const rawHistoryItems = (historyStore.items || []).filter(isLearningRecommendationHistoryItem);
  const historyGroups = new Map();
  for (const item of rawHistoryItems) {
    const key = `${cleanText(item.channel)}:${cleanText(item.messageTs)}`;
    if (!historyGroups.has(key)) historyGroups.set(key, []);
    historyGroups.get(key).push(item);
  }
  const historyItems = [];
  for (const group of historyGroups.values()) {
    const canonical = group.map((item) => {
      const category = categoryFor(item);
      return category ? canonicalProjectionRecord({ ...item, category }) : null;
    });
    if (canonical.every(Boolean)) historyItems.push(...canonical);
  }
  const sentMessages = (sentStore.messages || []).filter(isLearningRecommendationHistoryItem);
  const mealEvents = (mealStore.events || [])
    .filter(isLearningMealEvent)
    .map(canonicalProjectionMealEvent);
  const preferenceResponses = (preferenceStore.responses || [])
    .filter(isLearningCandidatePreferenceResponse)
    .map(canonicalProjectionPreferenceResponse);
  const ratings = learningPreferenceRatings({ ...preferenceStore, responses: preferenceResponses });
  const activeByKey = dedupeActiveCandidates(verifiedStore.candidates, now);
  const activeCandidates = [...activeByKey.values()];
  const currentPrices = dedupeCurrentPrices([
    ...(Array.isArray(verifiedStore.catalog) ? verifiedStore.catalog : []),
    ...(Array.isArray(verifiedStore.candidates) ? verifiedStore.candidates : []),
  ], now);
  const recentDeliveryByRestaurant = dedupeRecentDeliveryByRestaurant([
    ...(Array.isArray(verifiedStore.catalog) ? verifiedStore.catalog : []),
    ...(Array.isArray(verifiedStore.candidates) ? verifiedStore.candidates : []),
  ], now);
  const records = makeRecords({
    historyItems,
    staticRecommendations,
    activeCandidates,
    mealEvents,
    ratings,
    generatedAt,
  });

  const groups = new Map();
  for (const record of records) {
    const parsed = splitRestaurant(record.restaurant, record.branch);
    const menu = canonicalizeMenuForRestaurant({ restaurant: parsed.base, menu: record.menu });
    const canonicalCategory = categoryFor({
      ...record,
      restaurant: parsed.base,
      menu,
    });
    if (!canonicalCategory) continue;
    const key = candidateKey(parsed.base, menu, parsed.branch);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...record, menu, category: canonicalCategory, parsedRestaurant: parsed });
  }

  const historyCounts = new Map();
  const historyDates = new Map();
  const latestHistory = new Map();
  for (const item of historyItems) {
    const key = candidateKey(item.restaurant, item.menu, item.branch);
    historyCounts.set(key, (historyCounts.get(key) || 0) + 1);
    const date = safeDate(item.recommendedAt, generatedAt);
    if (!historyDates.has(key)) historyDates.set(key, []);
    historyDates.get(key).push(date);
    const previous = latestHistory.get(key);
    if (!previous || Date.parse(date) >= Date.parse(previous.recommendedAt || "")) latestHistory.set(key, item);
  }

  const mealExactCounts = new Map();
  for (const event of expandMealEvents(mealEvents)) {
    const key = candidateKey(event.restaurant, event.menu, event.branch);
    mealExactCounts.set(key, (mealExactCounts.get(key) || 0) + 1);
  }
  const surveyExact = new Map();
  for (const rating of ratings) {
    const key = candidateKey(rating.restaurant, rating.menu, rating.branch);
    if (!surveyExact.has(key)) surveyExact.set(key, []);
    surveyExact.get(key).push(Number(rating.rating));
  }

  const menus = [];
  for (const [key, candidates] of groups) {
    const sorted = [...candidates].sort(compareRecordPriority);
    const preferred = sorted[0];
    const parsed = preferred.parsedRestaurant;
    const historyRepresentative = latestHistory.get(key);
    const active = activeByKey.get(key);
    const storeDelivery = recentDeliveryByRestaurant.get(restaurantBranchKey(parsed.base, parsed.branch));
    const category = categoryFor({
      ...(active || preferred || historyRepresentative),
      restaurant: parsed.base,
      menu: preferred.menu,
    });
    if (!category) continue;
    const dates = (historyDates.get(key) || []).sort();
    const taste = roundedPosterior(tastePosterior({
      category,
      restaurant: parsed.base,
      menu: cleanText(preferred.menu).slice(0, 120),
    }, {
      events: mealEvents,
      preferences: { ...preferenceStore, responses: preferenceResponses },
      halfLifeDays: config.tasteHalfLifeDays,
      preferenceWeight: config.candidatePreferenceWeight,
      now,
    }));
    const menuRatings = surveyExact.get(key) || [];
    const availability = availabilityProjection(active, storeDelivery, now);
    const publicRestaurant = cleanText(parsed.base).slice(0, 120);
    const publicBranch = cleanText(parsed.branch).slice(0, 80);
    const publicMenu = cleanText(preferred.menu).slice(0, 120);
    const publicComment = cleanText(active?.comment || preferred.comment || historyRepresentative?.comment || "").slice(0, 240);
    menus.push({
      id: stableId("menu", parsed.base, parsed.branch, preferred.menu),
      restaurantId: stableId("restaurant", parsed.base),
      restaurant: publicRestaurant,
      branch: publicBranch,
      restaurantLabel: formatRestaurant(publicRestaurant, publicBranch),
      menu: publicMenu,
      category,
      priceText: cleanText(currentPrices.get(key)?.priceText || active?.priceText || preferred.priceText || historyRepresentative?.priceText || "가격 정보 없음").slice(0, 60),
      comment: publicComment,
      ingredientFamilies: ingredientSearchTagsFor({
        category,
        restaurant: publicRestaurant,
        restaurantLabel: formatRestaurant(publicRestaurant, publicBranch),
        menu: publicMenu,
        // Only the curated dish description supplies ingredient prose.
        description: cleanText(active?.comment || sorted.find((item) => ["verified", "history", "catalog"].includes(item.sourceKind) && item.comment)?.comment || "").slice(0, 240),
        // The current active candidate has first authority; otherwise use the
        // highest-priority canonical record. Unioning every historical value
        // would let one stale misclassification persist forever.
        ingredientFamilies: preferredIngredientFamilies([active, ...sorted]),
      }),
      occurrences: historyCounts.get(key) || 0,
      firstRecommendedAt: dates[0] || null,
      lastRecommendedAt: dates.at(-1) || null,
      mealEventCount: mealExactCounts.get(key) || 0,
      surveyCount: menuRatings.length,
      averageSurveyRating: menuRatings.length ? round(menuRatings.reduce((sum, value) => sum + value, 0) / menuRatings.length, 2) : null,
      ...availability,
      sources: [...new Set(candidates.map((item) => item.sourceKind))].sort(),
      taste,
    });
  }
  menus.sort((a, b) => b.occurrences - a.occurrences || a.category.localeCompare(b.category, "ko") || a.menu.localeCompare(b.menu, "ko"));

  const menuIdByKey = new Map(menus.map((menu) => [candidateKey(menu.restaurant, menu.menu, menu.branch), menu.id]));
  const messageGroups = new Map();
  for (const item of historyItems) {
    const privateKey = `${cleanText(item.channel).slice(0, 80)}:${cleanText(item.messageTs).slice(0, 80)}`;
    if (!messageGroups.has(privateKey)) messageGroups.set(privateKey, []);
    messageGroups.get(privateKey).push(item);
  }
  const recommendationEvents = [];
  const edgeCounts = new Map();
  for (const [privateKey, items] of messageGroups) {
    const menuIds = [...new Set(items
      .map((item) => menuIdByKey.get(candidateKey(item.restaurant, item.menu, item.branch)))
      .filter(Boolean))];
    if (!menuIds.length) continue;
    const recommendedAt = items.map((item) => safeDate(item.recommendedAt, generatedAt)).sort()[0];
    recommendationEvents.push({
      id: stableId("recommendation", privateKey),
      recommendedAt,
      mealType: cleanText(items[0]?.mealType || "식사").slice(0, 20),
      menuIds,
    });
    for (let left = 0; left < menuIds.length; left += 1) {
      for (let right = left + 1; right < menuIds.length; right += 1) {
        const pair = [menuIds[left], menuIds[right]].sort();
        const edgeKey = pair.join(":");
        edgeCounts.set(edgeKey, { source: pair[0], target: pair[1], count: (edgeCounts.get(edgeKey)?.count || 0) + 1 });
      }
    }
  }
  recommendationEvents.sort((a, b) => Date.parse(a.recommendedAt) - Date.parse(b.recommendedAt));

  const restaurantGroups = new Map();
  for (const menu of menus) {
    if (!restaurantGroups.has(menu.restaurantId)) restaurantGroups.set(menu.restaurantId, []);
    restaurantGroups.get(menu.restaurantId).push(menu);
  }
  const restaurants = [...restaurantGroups.entries()].map(([id, restaurantMenus]) => ({
    id,
    name: restaurantMenus[0].restaurant,
    branches: [...new Set(restaurantMenus.map((item) => item.branch).filter(Boolean))].sort(),
    menuCount: restaurantMenus.length,
    occurrences: restaurantMenus.reduce((sum, item) => sum + item.occurrences, 0),
    categories: [...new Set(restaurantMenus.map((item) => item.category))].sort(),
  })).sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name, "ko"));

  const categoryCounts = Object.fromEntries(TAXONOMY.map((category) => [
    category.id,
    menus.filter((menu) => menu.category === category.id).length,
  ]));
  const ratingDistribution = Object.fromEntries([1, 2, 3, 4, 5].map((rating) => [
    String(rating),
    ratings.filter((item) => Number(item.rating) === rating).length,
  ]));
  const contract = algorithmContract();

  return {
    schemaVersion: 2,
    generatedAt,
    source: {
      project: "ojeommwo-v2",
      releaseVersion: readJson(path.resolve(resolvedDataDir, "..", "package.json"), { version: "unknown" }).version || "unknown",
      sourceFingerprint: snapshotSourceFingerprint(resolvedDataDir, contract),
      privacy: "sanitized-aggregate-only",
    },
    algorithm: {
      posterior: contract.posterior,
      priorAlpha: contract.priorAlpha,
      priorBeta: contract.priorBeta,
      tasteHalfLifeDays: contract.tasteHalfLifeDays,
      candidatePreferenceWeight: contract.candidatePreferenceWeight,
      explorationRate: contract.explorationRate,
      displayUsesStablePosteriorMean: true,
      contractFingerprint: contract.contractFingerprint,
    },
    displayOnly: {
      tasteGravity: TASTE_GRAVITY_EASTER_EGGS.map((item) => ({ ...item })),
    },
    taxonomy: TAXONOMY,
    stats: {
      recommendationItems: historyItems.length,
      recommendationMessages: recommendationEvents.length,
      sentMessages: sentMessages.length,
      restaurants: restaurants.length,
      menus: menus.length,
      mealEvents: mealEvents.length,
      preferenceResponses: preferenceResponses.length,
      preferenceRatings: ratings.length,
      freshCandidates: menus.filter((menu) => menu.availableNow).length,
      categoryCounts,
      ratingDistribution,
      timelineStart: recommendationEvents[0]?.recommendedAt || generatedAt,
      timelineEnd: recommendationEvents.at(-1)?.recommendedAt || generatedAt,
    },
    menus,
    restaurants,
    recommendationEvents,
    cooccurrenceEdges: [...edgeCounts.values()].sort((a, b) => b.count - a.count),
  };
}

export function writeSnapshotAtomic(snapshot, outputPath) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
  fs.renameSync(temporary, resolved);
  return resolved;
}
