import { cleanText } from "./text.js";

export const UNKNOWN_RECOMMENDATION_PRICE = "가격 확인 필요";
export const STANDARD_RECOMMENDATION_PRICE_PATTERN = /^(?:\d{1,3}(?:,\d{3})+|\d{4,6})원(?:\s*\/\s*\d+g)?$/u;

export function isCurrentPolicyRecommendationPrice(value, { allowUnknown = true } = {}) {
  const priceText = cleanText(value);
  return (allowUnknown && priceText === UNKNOWN_RECOMMENDATION_PRICE)
    || STANDARD_RECOMMENDATION_PRICE_PATTERN.test(priceText);
}
