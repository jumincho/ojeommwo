import { getRecommendationHistory } from "./storage.js";
import { normalizeMealType } from "./meal-types.js";
import { cleanText, normalizeMenuKey, normalizeRestaurantKey } from "./text.js";
import { candidateIdFor } from "./verified-candidates.js";
import { RECOMMENDATION_LIMITS } from "./recommendation-limits.js";
import { hasValidCategoryAdjudication } from "./category-arbitration.js";

const MAX_ACTION_VALUE_LENGTH = 1900;

function compactRecommendation(item) {
  const branch = cleanText(item?.branch).slice(0, 80);
  const compact = {
    category: cleanText(item?.category).slice(0, 40),
    restaurant: cleanText(item?.restaurant).slice(0, 120),
    ...(branch ? { branch } : {}),
    menu: cleanText(item?.menu).slice(0, 120)
  };
  const candidateId = cleanText(item?.candidateId) || candidateIdFor(compact);
  if (candidateId.length > RECOMMENDATION_LIMITS.candidateId) {
    throw new Error("Meal interaction context contains an oversized candidate ID");
  }
  const result = { candidateId, ...compact };
  return hasValidCategoryAdjudication({ ...item, ...result })
    ? {
        ...result,
        categoryAuthority: item.categoryAuthority,
        categoryAdjudicatedAt: item.categoryAdjudicatedAt,
        categoryAdjudicationKey: item.categoryAdjudicationKey,
      }
    : result;
}

function validateRecommendations(recommendations) {
  if (!Array.isArray(recommendations) || recommendations.length !== 3) {
    throw new Error("Meal interaction context requires exactly three recommendations");
  }
  const compact = recommendations.map(compactRecommendation);
  if (compact.some((item) => !item.category || !item.restaurant || !item.menu)) {
    throw new Error("Meal interaction context contains an incomplete recommendation");
  }
  const keys = new Set(compact.map(
    (item) => `${normalizeRestaurantKey(item.restaurant)}:${normalizeMenuKey(item.menu)}`
  ));
  if (keys.size !== compact.length) throw new Error("Meal interaction context contains duplicate recommendations");
  return compact;
}

export function encodeMealInteractionContext({ mealType, source = "", recommendations }) {
  const compact = validateRecommendations(recommendations);
  const value = JSON.stringify({
    v: 1,
    mealType: normalizeMealType(mealType || "meal"),
    source: cleanText(source).slice(0, 80),
    // candidateId is a canonical restaurant/branch/menu derivative. Omitting
    // it here keeps the Slack action value bounded; decode reconstructs it.
    recommendations: compact.map(({ candidateId: _candidateId, ...item }) => item)
  });
  if (value.length > MAX_ACTION_VALUE_LENGTH) {
    throw new Error("Meal interaction context exceeds the Slack button value limit");
  }
  return value;
}

export function decodeMealInteractionContext(value) {
  if (!String(value || "").trim().startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Meal interaction context is not valid JSON");
  }
  if (parsed?.v !== 1) throw new Error("Meal interaction context version is unsupported");
  return {
    mealType: normalizeMealType(parsed.mealType || "meal"),
    source: cleanText(parsed.source).slice(0, 80),
    recommendations: validateRecommendations(parsed.recommendations)
  };
}

function messageTarget(payload) {
  const channel = payload?.channel?.id || payload?.container?.channel_id;
  const messageTs = payload?.message?.ts || payload?.container?.message_ts;
  if (!/^[CGD][A-Z0-9]+$/u.test(String(channel || ""))) {
    throw new Error("Message interaction requires a valid channel");
  }
  if (!/^\d+\.\d+$/u.test(String(messageTs || ""))) {
    throw new Error("Message interaction requires a valid timestamp");
  }
  return { channel, messageTs };
}

export function mealContextForBlockAction(payload, { history = getRecommendationHistory() } = {}) {
  const { channel, messageTs } = messageTarget(payload);
  const historical = (history.items || []).filter((item) => item.channel === channel && item.messageTs === messageTs);
  if (historical.length === 3) {
    return {
      channel,
      messageTs,
      mealType: normalizeMealType(historical[0].mealType || "meal"),
      source: historical[0].source || "",
      recommendations: validateRecommendations(historical)
    };
  }

  const encoded = payload.actions?.map((item) => item.value).find((value) => String(value || "").trim().startsWith("{"));
  const decoded = decodeMealInteractionContext(encoded);
  if (!decoded) throw new Error("Could not find the three recommendations for this message");
  return { channel, messageTs, ...decoded };
}
