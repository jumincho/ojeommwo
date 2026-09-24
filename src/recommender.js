import fs from "node:fs";
import path from "node:path";
import { config, DATA_DIR, assertRecommendationMode } from "./config.js";
import { FOOD_CATEGORIES, PLATFORM_BADGES } from "./categories.js";
import { getCandidatePreferences, getMealEvents, getRecommendationHistory, readJson } from "./storage.js";
import { logWarn } from "./logger.js";
import { LOOSE_FALLBACK_CANDIDATES } from "./loose-fallback.js";
import {
  canonicalizeMenuForRestaurant,
  cleanText as clean,
  daysSince,
  normalizeKey,
  normalizeMenuKey,
  normalizeRestaurantKey,
} from "./text.js";
import { tasteScore } from "./taste-profile.js";
import {
  candidateIdFor,
  filterEligibleVerifiedCandidates,
  hasCurrentDeterministicEvidence
} from "./verified-candidates.js";
import {
  isLearningMealEvent,
  isLearningRecommendationHistoryItem
} from "./history-policy.js";
import { expandMealEvents } from "./meal-event-items.js";
import { recommendationCommentForDisplay } from "./recommendation-comment.js";
import { cooldownAgeDays, isCooldownActive } from "./cooldown.js";
import {
  blockingIngredientFamilies,
  hasChoiceDiverseSet,
  ingredientFamiliesFor,
  normalizeIngredientFamilies
} from "./choice-diversity.js";
import {
  MODEL_CATEGORY_AUTHORITY,
  resolveOperationalCategory,
} from "./category-arbitration.js";
import {
  RECOMMENDATION_LIMITS,
  hasBoundedRecommendationFields,
  isBoundedText
} from "./recommendation-limits.js";

const PLACEHOLDER_PATTERNS = [/검증된\s*식당명/, /검증된\s*메뉴명/, /상호명/, /메뉴명/];
const GENERIC_COMMENT_PATTERN = /무난|후보|선택하기 좋|만족도가 높은 편|실패 확률|손색없는/;
const BROAD_MENU_PATTERN = /^(버거|치킨|도시락|샐러드|샌드위치|떡볶이|라멘|돈카츠|돈까스|피자)$/;

function hasPlaceholder(candidate) {
  const joined = `${candidate.restaurant} ${candidate.menu} ${candidate.comment || ""}`;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(joined));
}

export function sanitizeRecommendations(rawCandidates) {
  if (!Array.isArray(rawCandidates)) return [];

  const candidates = [];
  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (!hasBoundedRecommendationFields(raw)) continue;
    if (raw.evidence !== undefined) {
      const evidenceIsValid = Array.isArray(raw.evidence)
        ? raw.evidence.length <= RECOMMENDATION_LIMITS.evidenceCount
          && raw.evidence.every((value) => isBoundedText(value, { min: 1, max: RECOMMENDATION_LIMITS.evidenceUrl }))
        : isBoundedText(raw.evidence, { min: 1, max: RECOMMENDATION_LIMITS.evidenceUrl });
      if (!evidenceIsValid) continue;
    }
    const restaurant = clean(raw.restaurant);
    const menu = canonicalizeMenuForRestaurant({ restaurant: raw.restaurant, menu: raw.menu });
    // Re-evaluate authority at the final display boundary. A structural rule
    // wins; otherwise only agreement or a valid model adjudication stamp passes.
    const categoryResolution = resolveOperationalCategory({
      ...raw,
      category: clean(raw.category),
      restaurant,
      menu,
    });
    const category = categoryResolution.category;
    const priceText = clean(raw.priceText || raw.price || "가격 확인 필요");
    const comment = clean(raw.comment || "오늘 선택으로 손색없는 메뉴입니다.");
    const platforms = Array.isArray(raw.platforms)
      ? [...new Set(raw.platforms.map(clean).filter((platform) => PLATFORM_BADGES.includes(platform)))]
      : [];
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.map(clean).filter(Boolean)
      : clean(raw.evidence);
    const sourceRank = Number.isFinite(Number(raw.sourceRank)) ? Number(raw.sourceRank) : 0;
    const explicitIngredientFamilies = normalizeIngredientFamilies(raw.ingredientFamilies);
    const ingredientFamilies = ingredientFamiliesFor({
      ...raw,
      category,
      restaurant,
      menu,
      ingredientFamilies: explicitIngredientFamilies
    });

    const candidate = {
      category, restaurant, menu, priceText, platforms, comment, evidence, sourceRank,
      ingredientFamilies,
      ...Object.fromEntries([
        "candidateId", "branch", "address", "latitude", "longitude", "distanceKm",
        "priceChannel", "priceCheckedAt", "deliveryStatus", "deliveryCheckedAt",
        "priceEvidenceUrl", "deliveryEvidenceUrl", "evidenceVerifiedAt", "evidenceVerification",
        ...(categoryResolution.authority === MODEL_CATEGORY_AUTHORITY
          ? ["categoryAuthority", "categoryAdjudicatedAt", "categoryAdjudicationKey"]
          : [])
      ].filter((key) => raw[key] !== undefined).map((key) => [key,
        key === "categoryAuthority" ? MODEL_CATEGORY_AUTHORITY : raw[key]
      ]))
    };
    if (!category) continue;
    if (!restaurant || !menu) continue;
    if (hasPlaceholder(candidate)) continue;
    candidates.push(candidate);
  }

  return candidates;
}

function readStaticRecommendations() {
  const filePath = path.join(DATA_DIR, "recommendations.json");
  if (!fs.existsSync(filePath)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return sanitizeRecommendations(data);
  } catch (error) {
    logWarn("[recommender] Failed to read static recommendations:", error.message);
    return [];
  }
}

function readCandidateFile(fileName) {
  try {
    const data = readJson(fileName, { version: 1, candidates: [] });
    if (Array.isArray(data)) return { candidates: sanitizeRecommendations(data), invalidatedCandidateIds: [] };
    return {
      candidates: sanitizeRecommendations(data.candidates || data.recommendations),
      invalidatedCandidateIds: Array.isArray(data.invalidatedCandidateIds)
        ? [...data.invalidatedCandidateIds]
        : []
    };
  } catch (error) {
    logWarn(`[recommender] Failed to read ${fileName}:`, error.message);
    return { candidates: [], invalidatedCandidateIds: [] };
  }
}

function verifiedCandidateStoreParts(data) {
  if (Array.isArray(data)) return { candidates: data, invalidatedCandidateIds: [] };
  if (!data || typeof data !== "object") return { candidates: [], invalidatedCandidateIds: [] };
  return {
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
    invalidatedCandidateIds: Array.isArray(data.invalidatedCandidateIds)
      ? data.invalidatedCandidateIds
      : []
  };
}

function excludeInvalidatedFallbacks(candidates, invalidatedCandidateIds, activeCandidateIds) {
  const invalidated = new Set(invalidatedCandidateIds.filter((candidateId) =>
    typeof candidateId === "string"
    && candidateId.length > 0
    && candidateId.length <= RECOMMENDATION_LIMITS.candidateId
  ));
  return candidates.filter((candidate) => {
    const candidateId = candidate.candidateId || candidateIdFor(candidate);
    return !invalidated.has(candidateId) || activeCandidateIds.has(candidateId);
  });
}

function applySourceRank(candidates, sourceRank) {
  return candidates.map((candidate) => ({ ...candidate, sourceRank }));
}

function combinedHistoryItems(history, mealEvents = { events: [] }) {
  return [
    ...(history.items || []).filter(isLearningRecommendationHistoryItem).map((item) => ({
    restaurant: item.restaurant,
    menu: item.menu,
    at: item.recommendedAt,
    source: "recommended"
    })),
    ...expandMealEvents((mealEvents.events || []).filter(isLearningMealEvent)).map((event) => ({
      restaurant: event.restaurant,
      menu: event.menu,
      at: event.createdAt || event.eatenAt,
      source: "eaten"
    }))
  ];
}

function historyCandidates(history, {
  now = new Date(),
  maxAgeDays = config.cacheHistoryMaxAgeDays
} = {}) {
  return sanitizeRecommendations((history.items || [])
    .filter(isLearningRecommendationHistoryItem)
    .filter((item) => {
      const ageDays = daysSince(item.recommendedAt, now);
      return ageDays >= 0 && ageDays <= maxAgeDays;
    })
    .map((item) => ({
    category: item.category,
    restaurant: item.restaurant,
    menu: item.menu,
    priceText: item.priceText || "가격 확인 필요",
    platforms: [],
    comment: recommendationCommentForDisplay(item),
    evidence: item.evidence || ["recommendation history"],
    sourceRank: 2,
    candidateId: item.candidateId,
    branch: item.branch,
    address: item.address,
    latitude: item.latitude,
    longitude: item.longitude,
    distanceKm: item.distanceKm,
    priceChannel: item.priceChannel,
    priceCheckedAt: item.priceCheckedAt,
    deliveryStatus: item.deliveryStatus,
    deliveryCheckedAt: item.deliveryCheckedAt,
    priceEvidenceUrl: item.priceEvidenceUrl,
    deliveryEvidenceUrl: item.deliveryEvidenceUrl,
    evidenceVerifiedAt: item.evidenceVerifiedAt,
    evidenceVerification: item.evidenceVerification,
    ingredientFamilies: item.ingredientFamilies
  })));
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of sanitizeRecommendations(candidates)) {
    const key = `${normalizeKey(candidate.category)}:${normalizeRestaurantKey(candidate.restaurant)}:${normalizeMenuKey(candidate.menu)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

function recentKeys(history, mealEvents, now, { restaurantDays, menuDays }) {
  const restaurants = new Set();
  const menus = new Set();

  for (const item of combinedHistoryItems(history, mealEvents)) {
    if (isCooldownActive(item.at, now, restaurantDays)) restaurants.add(normalizeRestaurantKey(item.restaurant));
    if (isCooldownActive(item.at, now, menuDays)) menus.add(normalizeMenuKey(item.menu));
  }

  return { restaurants, menus };
}

export function findCooldownConflicts(candidates, history, {
  now = new Date(),
  mealEvents = { events: [] },
  restaurantCooldownDays = 14,
  menuCooldownDays = 7
} = {}) {
  const historyItems = combinedHistoryItems(history, mealEvents);
  const conflicts = [];

  for (const candidate of sanitizeRecommendations(candidates)) {
    const restaurantKey = normalizeRestaurantKey(candidate.restaurant);
    const menuKey = normalizeMenuKey(candidate.menu);

    for (const item of historyItems) {
      const ageDays = cooldownAgeDays(item.at, now);
      if (!Number.isFinite(ageDays) || ageDays < 0) continue;

      if (
        restaurantKey &&
        restaurantKey === normalizeRestaurantKey(item.restaurant) &&
        isCooldownActive(item.at, now, restaurantCooldownDays)
      ) {
        conflicts.push({
          kind: "restaurant",
          value: candidate.restaurant,
          ageDays,
          previous: item
        });
      }

      if (
        menuKey &&
        menuKey === normalizeMenuKey(item.menu) &&
        isCooldownActive(item.at, now, menuCooldownDays)
      ) {
        conflicts.push({
          kind: "menu",
          value: candidate.menu,
          ageDays,
          previous: item
        });
      }
    }
  }

  return conflicts;
}

export function deliveryDistanceRiskPenalty(candidate) {
  if (candidate?.deliveryStatus !== "likely") return 0;
  const distanceKm = Number(candidate?.distanceKm);
  if (!Number.isFinite(distanceKm) || distanceKm <= 3) return 0;
  // `likely` proves that the branch currently runs delivery, not that the
  // JBNU destination passed checkout. Beyond the close-delivery radius, make
  // that uncertainty capable of outweighing a taste advantage while still
  // leaving a distant candidate available when diversity has no alternative.
  return Math.min(18, (distanceKm - 3) * 6);
}

function scoreCandidate(candidate, rng, { mealEvents, candidatePreferences, mealType, now }) {
  const sourceScore = Math.min(Math.max(candidate.sourceRank || 0, 0), 4) * 100;
  const verificationScore = candidate.sourceRank >= 4
    ? (candidate.deliveryStatus === "verified" ? 12 : 4)
      + (candidate.priceChannel === "official-delivery" ? 6 : candidate.priceChannel === "store" ? 2 : 0)
    : 0;
  const preferenceScore = tasteScore(candidate, {
    events: mealEvents.events || [],
    preferences: candidatePreferences.responses || [],
    mealType,
    now,
    rng
  }) * 10;
  const categoryOrderScore = (FOOD_CATEGORIES.length - FOOD_CATEGORIES.indexOf(candidate.category)) / 100;
  return sourceScore + verificationScore + preferenceScore + categoryOrderScore + rng() / 100
    - deliveryDistanceRiskPenalty(candidate);
}

function tryPick(candidates, history, options) {
  const now = options.now || new Date();
  const rng = options.rng || Math.random;
  const mealEvents = options.mealEvents || { events: [] };
  const candidatePreferences = options.candidatePreferences || { responses: [] };
  const { restaurants, menus } = recentKeys(history, mealEvents, now, options);
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, rng, {
      mealEvents,
      candidatePreferences,
      mealType: options.mealType,
      now
    }) }))
    .map((entry) => ({
      ...entry,
      restaurantKey: normalizeRestaurantKey(entry.candidate.restaurant),
      menuKey: normalizeMenuKey(entry.candidate.menu),
      ingredientFamilies: blockingIngredientFamilies(entry.candidate)
    }))
    .filter((entry) => !restaurants.has(entry.restaurantKey) && !menus.has(entry.menuKey))
    .sort((a, b) => b.score - a.score);

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const picked = [];
  const usedCategories = new Set();
  const usedRestaurants = new Set();
  const usedMenus = new Set();
  const usedIngredientFamilies = new Set();

  const visit = (index, totalScore) => {
    if (picked.length === options.limit) {
      if (totalScore > bestScore) {
        bestScore = totalScore;
        best = picked.map((entry) => entry.candidate);
      }
      return;
    }
    const needed = options.limit - picked.length;
    if (ranked.length - index < needed) return;
    const optimisticScore = totalScore
      + ranked.slice(index, index + needed).reduce((sum, entry) => sum + entry.score, 0);
    if (optimisticScore <= bestScore) return;

    for (let i = index; i < ranked.length; i += 1) {
      const entry = ranked[i];
      if (usedCategories.has(entry.candidate.category)) continue;
      if (usedRestaurants.has(entry.restaurantKey) || usedMenus.has(entry.menuKey)) continue;
      if (entry.ingredientFamilies.some((family) => usedIngredientFamilies.has(family))) continue;

      picked.push(entry);
      usedCategories.add(entry.candidate.category);
      usedRestaurants.add(entry.restaurantKey);
      usedMenus.add(entry.menuKey);
      for (const family of entry.ingredientFamilies) usedIngredientFamilies.add(family);

      visit(i + 1, totalScore + entry.score);

      picked.pop();
      usedCategories.delete(entry.candidate.category);
      usedRestaurants.delete(entry.restaurantKey);
      usedMenus.delete(entry.menuKey);
      for (const family of entry.ingredientFamilies) usedIngredientFamilies.delete(family);
    }
  };

  visit(0, 0);
  return best || [];
}

export function selectRecommendations(candidates, {
  history = { items: [] },
  mealEvents = { events: [] },
  candidatePreferences = { responses: [] },
  mealType,
  limit = 3,
  now = new Date(),
  rng = Math.random,
  restaurantCooldownDays = 14,
  menuCooldownDays = 7
} = {}) {
  const sanitized = sanitizeRecommendations(candidates);
  const stages = [{ restaurantDays: restaurantCooldownDays, menuDays: menuCooldownDays }];

  for (const stage of stages) {
    const picked = tryPick(sanitized, history, {
      ...stage, limit, now, rng, mealEvents, candidatePreferences, mealType
    });
    if (picked.length === limit) return picked;
  }

  throw new Error(
    `Not enough valid recommendations. Need ${limit} unique categories/restaurants/menus `
    + "with non-overlapping main ingredient families."
  );
}

export function validateStaticFallback() {
  const candidates = readStaticRecommendations();
  if (candidates.length < config.recommendationCount) {
    return {
      ok: false,
      message: `data/recommendations.json needs at least ${config.recommendationCount} valid non-placeholder candidates`
    };
  }

  const categories = new Set(candidates.map((candidate) => candidate.category));
  if (categories.size < config.recommendationCount) {
    return {
      ok: false,
      message: `data/recommendations.json needs at least ${config.recommendationCount} different categories`
    };
  }

  if (!hasChoiceDiverseSet(candidates, config.recommendationCount)) {
    return {
      ok: false,
      message: `data/recommendations.json cannot form ${config.recommendationCount} meaningfully diverse recommendations`
    };
  }

  const weakCandidate = candidates.find((candidate) =>
    candidate.priceText === "가격 확인 필요" ||
    GENERIC_COMMENT_PATTERN.test(candidate.comment) ||
    BROAD_MENU_PATTERN.test(candidate.menu)
  );
  if (weakCandidate) {
    return {
      ok: false,
      message: `data/recommendations.json contains a weak fallback candidate: ${weakCandidate.restaurant} - ${weakCandidate.menu}`
    };
  }

  return { ok: true, message: "static fallback is valid" };
}

export function getCacheCandidates({
  history = getRecommendationHistory(),
  now = new Date(),
  allowUnverifiedFallback = config.allowUnverifiedFallback,
  verifiedCandidateData = readCandidateFile("verified-candidates.json"),
  staticCandidateData = readStaticRecommendations()
} = {}) {
  const verifiedStore = verifiedCandidateStoreParts(verifiedCandidateData);
  const verifiedCandidates = filterEligibleVerifiedCandidates(
    verifiedStore.candidates,
    { now }
  ).filter((candidate) => hasCurrentDeterministicEvidence(candidate, { now }));
  const activeCandidateIds = new Set(verifiedCandidates.map((candidate) => candidate.candidateId));
  const evidenceBackedHistory = excludeInvalidatedFallbacks(filterEligibleVerifiedCandidates(
    historyCandidates(history, { now }),
    { now }
  ).filter((candidate) => hasCurrentDeterministicEvidence(candidate, { now })),
  verifiedStore.invalidatedCandidateIds, activeCandidateIds);
  let candidates = uniqueCandidates([
    ...applySourceRank(verifiedCandidates, 4),
    ...applySourceRank(evidenceBackedHistory, 2)
  ]);

  if (allowUnverifiedFallback) {
    candidates = uniqueCandidates([
      ...candidates,
      ...applySourceRank(excludeInvalidatedFallbacks(
        sanitizeRecommendations(staticCandidateData),
        verifiedStore.invalidatedCandidateIds,
        activeCandidateIds
      ), 0)
    ]);
  }

  if (allowUnverifiedFallback && candidates.length < config.cacheFallbackMinCandidates) {
    candidates = uniqueCandidates([
      ...candidates,
      ...excludeInvalidatedFallbacks(
        LOOSE_FALLBACK_CANDIDATES,
        verifiedStore.invalidatedCandidateIds,
        activeCandidateIds
      )
    ]);
  }

  return candidates;
}

export function getCachedRecommendations({
  history = getRecommendationHistory(),
  mealEvents = getMealEvents(),
  candidatePreferences = getCandidatePreferences(),
  mealType,
  now = new Date(),
  rng = Math.random
} = {}) {
  const selectorOptions = {
    history,
    limit: config.recommendationCount,
    restaurantCooldownDays: config.restaurantCooldownDays,
    menuCooldownDays: config.menuCooldownDays
  };
  return selectRecommendations(getCacheCandidates({ history, now }), {
    ...selectorOptions, mealEvents, candidatePreferences, mealType, now, rng
  });
}

export async function getRecommendations({
  mealType,
  mode = config.recommendationMode,
  rng = Math.random
} = {}) {
  assertRecommendationMode(mode);
  const history = getRecommendationHistory();
  const mealEvents = getMealEvents();
  const candidatePreferences = getCandidatePreferences();
  const selectorOptions = {
    history,
    limit: config.recommendationCount,
    restaurantCooldownDays: config.restaurantCooldownDays,
    menuCooldownDays: config.menuCooldownDays,
    mealEvents,
    candidatePreferences,
    mealType
  };

  if (mode === "cache") {
    return getCachedRecommendations({ history, mealEvents, candidatePreferences, mealType, rng });
  }

  const staticCandidates = readStaticRecommendations();
  return selectRecommendations(staticCandidates, { ...selectorOptions, rng });
}
