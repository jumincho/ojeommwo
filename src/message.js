import { categoryEmoji } from "./categories.js";
import {
  OPEN_OBSERVATORY_ACTION_ID,
  RECORD_ACTUAL_MEAL_ACTION_ID,
  SURVEY_RECOMMENDATIONS_ACTION_ID,
  TOGGLE_COFFEE_ACTION_ID
} from "./interaction-actions.js";
import { encodeMealInteractionContext } from "./interaction-context.js";
import { normalizeMealType } from "./meal-types.js";
import { DEFAULT_OBSERVATORY_URL, normalizeObservatoryUrl } from "./observatory-link.js";
import { cleanText as clean } from "./text.js";
import { recommendationCommentForDisplay } from "./recommendation-comment.js";
import {
  RECOMMENDATION_LIMITS,
  hasBoundedRecommendationFields
} from "./recommendation-limits.js";

function escapeSlackText(value) {
  return clean(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function formatRecommendation(item) {
  const rawCategory = clean(item.category || "기타");
  const category = escapeSlackText(rawCategory);
  const emoji = categoryEmoji(rawCategory);
  const restaurant = escapeSlackText(item.restaurant);
  const branch = escapeSlackText(item.branch);
  const restaurantLabel = branch && !restaurant.includes(branch) ? `${restaurant} ${branch}` : restaurant;
  const menu = escapeSlackText(item.menu);
  const priceText = escapeSlackText(item.priceText || item.price || "가격 확인 필요");
  const displayedPrice = item.priceChannel === "store" ? `${priceText} · 매장가` : priceText;
  const comment = escapeSlackText(recommendationCommentForDisplay(item));
  const formatted = `${emoji} *${category}:* ${restaurantLabel} - ${menu}\n>${displayedPrice}\n>${comment}`;
  if (formatted.length > RECOMMENDATION_LIMITS.slackBlockText) {
    throw new Error("Formatted recommendation exceeds the Slack section text limit");
  }
  return formatted;
}

function assertRecommendationShape(recommendations) {
  if (!Array.isArray(recommendations) || recommendations.length !== 3) {
    throw new Error("Slack meal messages require exactly 3 recommendations");
  }

  for (const [index, item] of recommendations.entries()) {
    if (!item || !clean(item.category) || !clean(item.restaurant) || !clean(item.menu)) {
      throw new Error(`Recommendation ${index + 1} is missing category, restaurant, or menu`);
    }
    if (!hasBoundedRecommendationFields(item)) {
      throw new Error(`Recommendation ${index + 1} has oversized display fields`);
    }
  }
}

function cleanWeatherText(value) {
  const weather = String(value || "")
    .split(/\r?\n/u)
    .map(escapeSlackText)
    .filter(Boolean)
    .join("\n");
  if (weather.length > RECOMMENDATION_LIMITS.slackBlockText) {
    throw new Error("Weather alert exceeds the Slack context text limit");
  }
  return weather;
}

export function buildMealText({ mealType, recommendations, weatherAlert = "", headerEmoji = "🍽️" }) {
  assertRecommendationShape(recommendations);
  const meal = normalizeMealType(mealType || "meal");
  const label = escapeSlackText(meal);
  const header = `${escapeSlackText(headerEmoji) || "🍽️"} *오늘 ${label} 드실 분?*`;
  const checkLine = `${label} 드실 분은 ✅ 이모지를 눌러주세요!`;
  const recommendationLines = recommendations.map(formatRecommendation).join("\n\n");
  const weather = cleanWeatherText(weatherAlert);
  const weatherLine = weather ? `\n${weather}` : "";

  const text = `${header}\n${checkLine}${weatherLine}\n\n*오늘의 배달 추천*\n\n${recommendationLines}`;
  if (text.length > RECOMMENDATION_LIMITS.slackFallbackText) {
    throw new Error("Slack meal fallback text exceeds its bounded payload size");
  }
  return text;
}

export function buildMealMessage({
  mealType,
  recommendations,
  weatherAlert = "",
  headerEmoji = "🍽️",
  feedbackEnabled = false,
  observatoryEnabled = true,
  observatoryUrl = DEFAULT_OBSERVATORY_URL,
  interactionSource = "",
  now = new Date(),
  timezone = "Asia/Seoul"
}) {
  assertRecommendationShape(recommendations);
  const meal = normalizeMealType(mealType || "meal");
  const label = escapeSlackText(meal);
  const header = `${escapeSlackText(headerEmoji) || "🍽️"} *오늘 ${label} 드실 분?*`;
  const checkLine = `${label} 드실 분은 ✅ 이모지를 눌러주세요!`;
  const weather = cleanWeatherText(weatherAlert);
  const text = buildMealText({ mealType: meal, recommendations, weatherAlert, headerEmoji, now, timezone });
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `${header}\n${checkLine}` } }
  ];
  if (weather) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: weather }] });
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*오늘의 배달 추천*" }
  });
  blocks.push(...recommendations.map((item) => ({
    type: "section",
    text: { type: "mrkdwn", text: formatRecommendation(item) }
  })));
  if (feedbackEnabled) {
    const interactionContext = encodeMealInteractionContext({ mealType: meal, source: interactionSource, recommendations });
    const elements = [
      {
        type: "button",
        action_id: RECORD_ACTUAL_MEAL_ACTION_ID,
        text: { type: "plain_text", text: "먹은 메뉴 기록", emoji: true },
        value: interactionContext
      },
      {
        type: "button",
        action_id: SURVEY_RECOMMENDATIONS_ACTION_ID,
        text: { type: "plain_text", text: "추천된 메뉴 선호도 조사", emoji: true },
        value: interactionContext
      },
      {
        type: "button",
        action_id: TOGGLE_COFFEE_ACTION_ID,
        text: { type: "plain_text", text: "이따 커피 마실 분?", emoji: true },
        value: "toggle"
      }
    ];
    if (observatoryEnabled) {
      elements.push({
        type: "button",
        action_id: OPEN_OBSERVATORY_ACTION_ID,
        text: { type: "plain_text", text: "🪐 메뉴 관측소", emoji: true },
        accessibility_label: "메뉴 관측소 열기",
        url: normalizeObservatoryUrl(observatoryUrl),
        value: "open"
      });
    }
    blocks.push({
      type: "actions",
      block_id: "meal_feedback_actions",
      elements
    });
  }
  return { text, blocks };
}
