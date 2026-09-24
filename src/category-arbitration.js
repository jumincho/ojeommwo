import crypto from "node:crypto";
import {
  FOOD_CATEGORIES,
  classifyFoodCategoryDecision,
  isExcludedMealCandidate,
  structuralMenuCategories,
} from "./categories.js";
import { normalizeMenuKey, normalizeRestaurantKey } from "./text.js";
import { RECOMMENDATION_LIMITS, isBoundedText } from "./recommendation-limits.js";

export const MODEL_CATEGORY_AUTHORITY = "model-adjudicated";
export const TRUSTED_MODEL_CATEGORY_AUTHORITY = "model-trusted-semantic";
export const MODEL_DETERMINISTIC_AGREEMENT_AUTHORITY = "model-deterministic-agreement";
const LEGACY_MODEL_CATEGORY_AUTHORITIES = new Set(["luna-adjudicated"]);
const HARD_AUTHORITIES = new Set(["structural-menu", "audited-product"]);

export function categoryAdjudicationKey(candidate, category = candidate?.category) {
  const payload = JSON.stringify({
    version: 1,
    restaurant: normalizeRestaurantKey(candidate?.restaurant),
    menu: normalizeMenuKey(candidate?.menu),
    category: String(category || "").trim(),
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function hasValidCategoryAdjudication(candidate) {
  if (candidate?.categoryAuthority !== MODEL_CATEGORY_AUTHORITY
      && !LEGACY_MODEL_CATEGORY_AUTHORITIES.has(candidate?.categoryAuthority)) return false;
  if (!FOOD_CATEGORIES.includes(String(candidate?.category || "").trim())) return false;
  if (!isBoundedText(candidate?.categoryAdjudicatedAt, {
    min: 10,
    max: RECOMMENDATION_LIMITS.timestamp,
  })) return false;
  if (!Number.isFinite(Date.parse(candidate.categoryAdjudicatedAt))) return false;
  if (!/^[0-9a-f]{64}$/u.test(String(candidate?.categoryAdjudicationKey || ""))) return false;
  return candidate.categoryAdjudicationKey === categoryAdjudicationKey(candidate);
}

function hasStructuralConflict(candidate, deterministic) {
  const declared = String(candidate?.category || "").trim();
  return deterministic.authority === "structural-menu"
    && declared !== deterministic.category
    && structuralMenuCategories(candidate?.menu).includes(declared);
}

export function resolveOperationalCategory(candidate = {}) {
  if (isExcludedMealCandidate(candidate)) {
    return { category: null, authority: "excluded", requiresAdjudication: false };
  }
  const deterministic = classifyFoodCategoryDecision(candidate);
  if (HARD_AUTHORITIES.has(deterministic.authority)
      && !hasStructuralConflict(candidate, deterministic)) {
    return {
      category: deterministic.category,
      authority: deterministic.authority,
      requiresAdjudication: false,
    };
  }
  if (hasValidCategoryAdjudication(candidate)) {
    return {
      category: String(candidate.category).trim(),
      authority: MODEL_CATEGORY_AUTHORITY,
      requiresAdjudication: false,
      deterministicCategory: deterministic.category,
    };
  }
  const declaredCategory = FOOD_CATEGORIES.includes(String(candidate?.category || "").trim())
    ? String(candidate.category).trim()
    : null;
  if (declaredCategory && deterministic.category === declaredCategory) {
    return {
      category: declaredCategory,
      authority: MODEL_DETERMINISTIC_AGREEMENT_AUTHORITY,
      requiresAdjudication: false,
    };
  }
  return {
    category: null,
    authority: "unresolved-semantic",
    requiresAdjudication: Boolean(declaredCategory),
    declaredCategory,
    deterministicCategory: deterministic.category,
    deterministicAuthority: deterministic.authority,
  };
}

// Use this only at a boundary where the configured model has already completed a dedicated,
// high-confidence semantic task (for example evidence-backed meal-input
// normalization). Structural dish formats still win, while softer
// keyword and restaurant heuristics are advisory rather than authoritative.
export function resolveTrustedSemanticCategory(candidate = {}) {
  if (isExcludedMealCandidate(candidate)) {
    return { category: null, authority: "excluded" };
  }
  const deterministic = classifyFoodCategoryDecision(candidate);
  if (HARD_AUTHORITIES.has(deterministic.authority)
      && !hasStructuralConflict(candidate, deterministic)) {
    return { category: deterministic.category, authority: deterministic.authority };
  }
  const declaredCategory = FOOD_CATEGORIES.includes(String(candidate?.category || "").trim())
    ? String(candidate.category).trim()
    : null;
  if (declaredCategory) {
    return { category: declaredCategory, authority: TRUSTED_MODEL_CATEGORY_AUTHORITY };
  }
  return {
    category: deterministic.category,
    authority: deterministic.authority,
  };
}

export function stampCategoryAdjudication(candidate, {
  category,
  now = new Date(),
} = {}) {
  const resolvedCategory = String(category || "").trim();
  if (!FOOD_CATEGORIES.includes(resolvedCategory)) {
    throw new Error("Category adjudication returned an unsupported category");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Category adjudication requires a valid timestamp");
  }
  const stamped = {
    ...candidate,
    category: resolvedCategory,
    categoryAuthority: MODEL_CATEGORY_AUTHORITY,
    categoryAdjudicatedAt: now.toISOString(),
  };
  stamped.categoryAdjudicationKey = categoryAdjudicationKey(stamped);
  return stamped;
}

export function auditCategoryArbitrationStores({
  verifiedCandidates = { candidates: [], catalog: [] },
  recommendationHistory = { items: [] },
  candidatePreferences = { responses: [] },
} = {}) {
  const groups = {
    active: verifiedCandidates.candidates || [],
    catalog: verifiedCandidates.catalog || [],
    history: recommendationHistory.items || [],
    preferences: (candidatePreferences.responses || []).flatMap((response) => response.ratings || []),
  };
  const report = {};
  for (const [name, items] of Object.entries(groups)) {
    const unresolved = [];
    const authorities = {};
    for (const item of items) {
      const resolution = resolveOperationalCategory(item);
      authorities[resolution.authority] = (authorities[resolution.authority] || 0) + 1;
      if (!resolution.category) {
        unresolved.push({
          category: String(item?.category || ""),
          restaurant: String(item?.restaurant || ""),
          menu: String(item?.menu || ""),
          reason: resolution.authority,
        });
      }
    }
    report[name] = { total: items.length, unresolved, authorities };
  }
  return report;
}
