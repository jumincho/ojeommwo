export const RECOMMENDATION_LIMITS = Object.freeze({
  category: 20,
  restaurant: 100,
  branch: 80,
  address: 200,
  menu: 120,
  priceText: 32,
  comment: 120,
  evidenceUrl: 2048,
  evidenceCount: 6,
  timestamp: 64,
  candidateId: 320,
  activeCandidates: 12,
  candidateCatalog: 120,
  slackFallbackText: 12000,
  slackBlocks: 50,
  slackBlockText: 3000,
  slackBlockValue: 2000,
  slackBlocksBytes: 50000
});

export function isBoundedText(value, { min = 0, max, optional = false } = {}) {
  if (value === undefined || value === null) return optional;
  if (typeof value !== "string") return false;
  if (!Number.isInteger(max) || max < 0 || value.length > max) return false;
  const text = value.trim();
  if (!text) return optional && value.length === 0;
  return text.length >= min && text.length <= max;
}

export function hasBoundedRecommendationFields(candidate, { requireAddress = false } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const limits = RECOMMENDATION_LIMITS;
  if (!isBoundedText(candidate.category, { min: 1, max: limits.category })) return false;
  if (!isBoundedText(candidate.restaurant, { min: 2, max: limits.restaurant })) return false;
  if (!isBoundedText(candidate.menu, { min: 2, max: limits.menu })) return false;
  if (!isBoundedText(candidate.branch ?? "", { max: limits.branch, optional: true })) return false;
  if (requireAddress && !isBoundedText(candidate.address, { min: 5, max: limits.address })) return false;
  if (!requireAddress && candidate.address !== undefined
    && !isBoundedText(candidate.address, { min: 5, max: limits.address })) return false;
  if (candidate.priceText !== undefined
    && !isBoundedText(candidate.priceText, { min: 2, max: limits.priceText })) return false;
  if (candidate.comment !== undefined
    && !isBoundedText(candidate.comment, { min: 1, max: limits.comment })) return false;
  if (candidate.candidateId !== undefined
    && !isBoundedText(candidate.candidateId, { min: 1, max: limits.candidateId })) return false;
  return true;
}
