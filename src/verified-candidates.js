import { config } from "./config.js";
import { isIP } from "node:net";
import {
  canonicalizeMenuForRestaurant,
  canonicalizeRestaurantIdentity,
  normalizeKey,
  normalizeMenuKey
} from "./text.js";
import { isExcludedMealCandidate } from "./categories.js";
import {
  isPoliteRecommendationComment,
  recommendationCommentForDisplay,
} from "./recommendation-comment.js";
import { ingredientFamiliesFor, normalizeIngredientFamilies } from "./choice-diversity.js";
import {
  RECOMMENDATION_LIMITS,
  hasBoundedRecommendationFields,
  isBoundedText
} from "./recommendation-limits.js";
import { currentTimeMs, timestampMs } from "./time-integrity.js";
import { enrichAuditedLocationBranch } from "./audited-location-branches.js";
import {
  MODEL_CATEGORY_AUTHORITY,
  resolveOperationalCategory,
} from "./category-arbitration.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_RESEARCH_DISTANCE_KM = 0.05;
const BANNED_EVIDENCE_HOSTS = ["wikipedia.org", "wikimedia.org", "namu.wiki"];
// Siksin pages are useful for store/menu discovery, but they do not establish
// that a specific branch currently accepts delivery orders.
const BANNED_DELIVERY_EVIDENCE_HOSTS = ["siksinhot.com"];
const INDIRECT_DELIVERY_EVIDENCE_HOSTS = ["diningcode.com"];
const GENERIC_RESTAURANTS = new Set(["전주비빔밥", "콩나물국밥", "짜장면집", "탕수육집", "초밥집", "한식집", "중식집", "일식집"]);

export function isSubstantialMealCandidate(candidate) {
  const menu = normalizeKey(candidate?.menu);
  const comment = String(candidate?.comment || "");
  if (!menu) return false;
  if (isExcludedMealCandidate(candidate)) return false;
  if (/^(?:수제|모둠|모듬)?(?:주먹밥|공기밥|감자튀김|웨지감자|치즈볼|오뎅|어묵\d*개|소스|토핑|콜라|사이다)$/u.test(menu)) return false;
  if (/(?:곁들이기\s*좋|사이드\s*메뉴|추가\s*메뉴)/u.test(comment)) return false;
  return true;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (degrees) => degrees * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ageDays(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return (currentTimeMs(now, "candidate evidence") - timestamp) / DAY_MS;
}

export function hasCurrentDeterministicEvidence(candidate, {
  now = new Date(),
  maxAgeDays = Math.min(config.researchPriceTtlDays, config.researchDeliveryTtlDays)
} = {}) {
  if (candidate?.evidenceVerification !== "deterministic-html") return false;
  try {
    timestampMs(candidate.evidenceVerifiedAt, { label: "candidate evidence verification", now });
    const evidenceAgeDays = ageDays(candidate.evidenceVerifiedAt, now);
    return evidenceAgeDays >= -(5 * 60 * 1000 / DAY_MS) && evidenceAgeDays <= maxAgeDays;
  } catch {
    return false;
  }
}

export function isSafeEvidenceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    if (isIP(hostname)) return false;
    if (hostname === "localhost" || hostname.endsWith(".local")) return false;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/u.test(hostname)) return false;
    const private172 = hostname.match(/^172\.(\d{1,3})\./u);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return false;
    return true;
  } catch {
    return false;
  }
}

function evidenceHostAllowed(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return !BANNED_EVIDENCE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function deliveryEvidenceHostAllowed(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return !BANNED_DELIVERY_EVIDENCE_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

function directDeliveryEvidenceHost(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return !INDIRECT_DELIVERY_EVIDENCE_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

export function candidateIdFor(candidate) {
  const identity = canonicalizeRestaurantIdentity(candidate || {});
  const menu = canonicalizeMenuForRestaurant({
    restaurant: identity.restaurant,
    menu: candidate?.menu,
  });
  return [
    normalizeKey(identity.restaurant),
    normalizeKey(identity.branch),
    normalizeMenuKey(menu),
  ]
    .filter(Boolean)
    .join(":");
}

export function normalizeVerifiedCandidate(raw, {
  now = new Date(),
  targetLatitude = config.targetLatitude,
  targetLongitude = config.targetLongitude,
  maxDistanceKm = config.researchDistanceKm,
  priceTtlDays = config.researchPriceTtlDays,
  deliveryTtlDays = config.researchDeliveryTtlDays
} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let checkedNow;
  try {
    checkedNow = new Date(currentTimeMs(now, "verified candidate validation"));
  } catch {
    return null;
  }
  if (!hasBoundedRecommendationFields(raw, { requireAddress: true })) return null;
  if (!isBoundedText(raw.priceCheckedAt, { min: 10, max: RECOMMENDATION_LIMITS.timestamp })
    || !isBoundedText(raw.deliveryCheckedAt, { min: 10, max: RECOMMENDATION_LIMITS.timestamp })
    || !isBoundedText(raw.priceEvidenceUrl, { min: 8, max: RECOMMENDATION_LIMITS.evidenceUrl })
    || !isBoundedText(raw.deliveryEvidenceUrl, { min: 8, max: RECOMMENDATION_LIMITS.evidenceUrl })) return null;
  if (raw.evidence !== undefined && (
    !Array.isArray(raw.evidence)
    || raw.evidence.length > RECOMMENDATION_LIMITS.evidenceCount
    || raw.evidence.some((value) => !isBoundedText(value, { min: 8, max: RECOMMENDATION_LIMITS.evidenceUrl }))
  )) return null;
  let explicitIngredientFamilies = [];
  if (raw.ingredientFamilies !== undefined) {
    explicitIngredientFamilies = normalizeIngredientFamilies(raw.ingredientFamilies);
    if (
      !Array.isArray(raw.ingredientFamilies)
      || raw.ingredientFamilies.length < 1
      || raw.ingredientFamilies.length > 3
      || explicitIngredientFamilies.length !== raw.ingredientFamilies.length
      || (explicitIngredientFamilies.includes("other") && explicitIngredientFamilies.length > 1)
    ) return null;
  }
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const distanceKm = haversineKm(targetLatitude, targetLongitude, latitude, longitude);
  if (distanceKm < MIN_RESEARCH_DISTANCE_KM || distanceKm > maxDistanceKm) return null;
  let priceCheckedAt;
  let deliveryCheckedAt;
  try {
    priceCheckedAt = timestampMs(raw.priceCheckedAt, { label: "candidate price check", now: checkedNow });
    deliveryCheckedAt = timestampMs(raw.deliveryCheckedAt, { label: "candidate delivery check", now: checkedNow });
  } catch {
    return null;
  }
  const priceAgeDays = (checkedNow.getTime() - priceCheckedAt) / DAY_MS;
  const deliveryAgeDays = (checkedNow.getTime() - deliveryCheckedAt) / DAY_MS;
  const allowedFutureDays = 5 * 60 * 1000 / DAY_MS;
  if (priceAgeDays < -allowedFutureDays || priceAgeDays > priceTtlDays) return null;
  if (deliveryAgeDays < -allowedFutureDays || deliveryAgeDays > deliveryTtlDays) return null;
  if (!["verified", "likely"].includes(raw.deliveryStatus)) return null;
  if (!isSafeEvidenceUrl(raw.priceEvidenceUrl) || !isSafeEvidenceUrl(raw.deliveryEvidenceUrl)) return null;
  if (!evidenceHostAllowed(raw.priceEvidenceUrl) || !evidenceHostAllowed(raw.deliveryEvidenceUrl)) return null;
  if (!deliveryEvidenceHostAllowed(raw.deliveryEvidenceUrl)) return null;
  if (raw.deliveryStatus === "verified" && !directDeliveryEvidenceHost(raw.deliveryEvidenceUrl)) return null;
  const locationEnrichedRaw = enrichAuditedLocationBranch(raw);
  const identity = canonicalizeRestaurantIdentity(locationEnrichedRaw);
  const canonicalMenu = canonicalizeMenuForRestaurant({
    restaurant: identity.restaurant,
    menu: locationEnrichedRaw.menu,
  });
  const canonicalRaw = {
    ...locationEnrichedRaw,
    restaurant: identity.restaurant,
    branch: identity.branch,
    menu: canonicalMenu
  };
  // Structural formats remain deterministic. Ambiguous semantics may use a
  // separately stamped model adjudication; unstamped disagreement fails closed.
  const categoryResolution = resolveOperationalCategory(canonicalRaw);
  const category = categoryResolution.category;
  if (!category) return null;
  if (!isSubstantialMealCandidate(canonicalRaw)) return null;
  if (!isPoliteRecommendationComment(raw.comment)) return null;
  if (!/^\d{1,3}(?:,\d{3})+원$/.test(raw.priceText)) return null;
  if (GENERIC_RESTAURANTS.has(normalizeKey(identity.restaurant))) return null;
  if (/^(?:전주\s*)?지역점$|^지점$/u.test(identity.branch)) return null;
  if (!/전주/u.test(raw.address) || !/\d/u.test(raw.address)) return null;

  const computedCandidateId = candidateIdFor(canonicalRaw);
  const acceptedRawCandidateIds = new Set([
    [
      normalizeKey(raw.restaurant),
      normalizeKey(raw.branch),
      normalizeMenuKey(raw.menu),
    ].filter(Boolean).join(":"),
    [
      normalizeKey(raw.restaurant),
      normalizeKey(raw.branch),
      normalizeKey(raw.menu),
    ].filter(Boolean).join(":"),
  ]);
  if (!computedCandidateId || computedCandidateId.length > RECOMMENDATION_LIMITS.candidateId) return null;
  if (raw.candidateId !== undefined
    && raw.candidateId !== computedCandidateId
    && !acceptedRawCandidateIds.has(raw.candidateId)) return null;
  if (raw.evidenceVerification !== undefined
    && !["deterministic-html"].includes(raw.evidenceVerification)) return null;
  if (raw.evidenceVerifiedAt !== undefined
    && !isBoundedText(raw.evidenceVerifiedAt, { min: 10, max: RECOMMENDATION_LIMITS.timestamp })) return null;
  const hasEvidenceVerification = raw.evidenceVerification !== undefined;
  const hasEvidenceVerifiedAt = raw.evidenceVerifiedAt !== undefined;
  if (hasEvidenceVerification !== hasEvidenceVerifiedAt) return null;
  if (hasEvidenceVerifiedAt) {
    let evidenceVerifiedAt;
    try {
      evidenceVerifiedAt = timestampMs(raw.evidenceVerifiedAt, {
        label: "candidate evidence verification",
        now: checkedNow
      });
    } catch {
      return null;
    }
    if (evidenceVerifiedAt < priceCheckedAt || evidenceVerifiedAt < deliveryCheckedAt) return null;
  }
  if (!['store', 'official-delivery', 'unknown'].includes(raw.priceChannel || "unknown")) return null;

  const evidence = [...new Set([
    raw.priceEvidenceUrl,
    raw.deliveryEvidenceUrl,
    ...(Array.isArray(raw.evidence) ? raw.evidence.filter(isSafeEvidenceUrl) : [])
  ])].slice(0, RECOMMENDATION_LIMITS.evidenceCount);
  const candidate = {
    category,
    restaurant: identity.restaurant,
    branch: identity.branch,
    address: raw.address.trim(),
    latitude,
    longitude,
    menu: canonicalMenu,
    priceText: raw.priceText.trim(),
    priceChannel: raw.priceChannel || "unknown",
    priceCheckedAt: raw.priceCheckedAt,
    deliveryStatus: raw.deliveryStatus,
    deliveryCheckedAt: raw.deliveryCheckedAt,
    priceEvidenceUrl: raw.priceEvidenceUrl,
    deliveryEvidenceUrl: raw.deliveryEvidenceUrl,
    comment: recommendationCommentForDisplay(raw),
    distanceKm: Number(distanceKm.toFixed(2)),
    candidateId: computedCandidateId,
    ingredientFamilies: ingredientFamiliesFor({
      ...raw,
      category,
      ingredientFamilies: explicitIngredientFamilies
    }),
    evidence,
    ...(raw.evidenceVerifiedAt ? { evidenceVerifiedAt: raw.evidenceVerifiedAt } : {}),
    ...(raw.evidenceVerification ? { evidenceVerification: raw.evidenceVerification } : {}),
    ...(categoryResolution.authority === MODEL_CATEGORY_AUTHORITY ? {
      categoryAuthority: MODEL_CATEGORY_AUTHORITY,
      categoryAdjudicatedAt: raw.categoryAdjudicatedAt,
      categoryAdjudicationKey: raw.categoryAdjudicationKey,
    } : {})
  };
  return candidate;
}

export function filterEligibleVerifiedCandidates(rawCandidates, options) {
  const seen = new Set();
  const coordinateCounts = new Map();
  return (Array.isArray(rawCandidates) ? rawCandidates : [])
    .map((candidate) => normalizeVerifiedCandidate(candidate, options))
    .filter((candidate) => {
      if (!candidate || seen.has(candidate.candidateId)) return false;
      const coordinateKey = `${candidate.latitude.toFixed(5)}:${candidate.longitude.toFixed(5)}`;
      const coordinateCount = coordinateCounts.get(coordinateKey) || 0;
      if (coordinateCount >= 3) return false;
      seen.add(candidate.candidateId);
      coordinateCounts.set(coordinateKey, coordinateCount + 1);
      return true;
    });
}
