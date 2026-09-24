import { config } from "./config.js";
import { mealContextForBlockAction } from "./interaction-context.js";
import { respondentIdForPayload, slackUserIdForPayload, stablePseudonymousId } from "./interaction-identity.js";
import { normalizeMealType } from "./meal-types.js";
import { appendMealEvent, getMealEvents, getRecommendationHistory } from "./storage.js";
import { invalidCustomMealInputReason, prepareMealEventForNormalization } from "./meal-normalization.js";
import { hasContradictoryPreferenceFeedback } from "./meal-feedback-policy.js";
import { RECOMMENDATION_LIMITS } from "./recommendation-limits.js";
import { normalizeMenuKey } from "./text.js";
import { cleanMealMenuInput } from "./meal-event-items.js";

const CALLBACK_ID = "actual_meal_submission";
export const MEAL_FEEDBACK_TAGS = Object.freeze(["든든함", "가벼움", "매움", "재주문", "다시 안 먹기"]);
const ALLOWED_TAGS = new Set(MEAL_FEEDBACK_TAGS);

function invalidMealMetadataSubmission() {
  return { handled: true, errors: { meal_choice: "추천 정보를 다시 불러와 주세요." } };
}

function validMealSubmissionMetadata(metadata) {
  return metadata
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && /^[CGD][A-Z0-9]+$/u.test(String(metadata.channel || ""))
    && /^\d+\.\d+$/u.test(String(metadata.messageTs || ""))
    && Array.isArray(metadata.recommendations)
    && metadata.recommendations.length === 3
    && metadata.recommendations.every((item) => item
      && typeof item === "object"
      && !Array.isArray(item)
      && cleanMealText(item.restaurant)
      && cleanMealText(item.restaurant).length <= RECOMMENDATION_LIMITS.restaurant
      && cleanMealText(item.menu)
      && cleanMealText(item.menu).length <= RECOMMENDATION_LIMITS.menu
      && String(item.candidateId || "").length <= RECOMMENDATION_LIMITS.candidateId);
}

function boundedFeedbackCandidateId(value) {
  const candidateId = String(value || "");
  if (candidateId.length > RECOMMENDATION_LIMITS.candidateId) {
    throw new Error("Meal feedback contains an oversized candidate ID");
  }
  return candidateId;
}

function kstDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function stableEventId(payload, metadata) {
  const userId = slackUserIdForPayload(payload);
  const channel = String(metadata.channel || "");
  const messageTs = String(metadata.messageTs || "");
  if (!/^[CGD][A-Z0-9]+$/u.test(channel) || !/^\d+\.\d+$/u.test(messageTs)) {
    throw new Error("Meal submission requires a valid Slack message target");
  }
  return stablePseudonymousId("actual-meal", [userId, channel, messageTs]);
}

function optionLabel(item, index) {
  const text = `${index + 1}. ${item.restaurant} · ${item.menu}`;
  return text.length <= 75 ? text : `${text.slice(0, 72)}...`;
}

export function buildMealFeedbackModal({ channel, messageTs, mealType, recommendations, source = "", now = new Date() }) {
  const choices = recommendations.map((item, index) => ({
    text: { type: "plain_text", text: optionLabel(item, index), emoji: true },
    value: String(index)
  }));
  choices.push({ text: { type: "plain_text", text: "추천 외 다른 메뉴", emoji: true }, value: "other" });
  const metadata = JSON.stringify({
    channel,
    messageTs,
    mealType,
    source,
    submissionDate: kstDateKey(now),
    recommendations: recommendations.map((item) => ({
      candidateId: boundedFeedbackCandidateId(item.candidateId),
      category: item.category,
      restaurant: item.restaurant,
      branch: item.branch || "",
      menu: item.menu
    }))
  });
  if (metadata.length > 3000) throw new Error("Meal feedback metadata exceeds the Slack modal limit");

  return {
    type: "modal",
    callback_id: CALLBACK_ID,
    private_metadata: metadata,
    title: { type: "plain_text", text: "먹은 메뉴 기록", emoji: true },
    submit: { type: "plain_text", text: "저장", emoji: true },
    close: { type: "plain_text", text: "취소", emoji: true },
    blocks: [
      {
        type: "input",
        block_id: "meal_choice",
        label: { type: "plain_text", text: "무엇을 드셨나요?", emoji: true },
        element: {
          type: "static_select",
          action_id: "selected_choice",
          placeholder: { type: "plain_text", text: "메뉴 선택", emoji: true },
          options: choices
        }
      },
      {
        type: "input",
        block_id: "other_restaurant",
        optional: true,
        label: { type: "plain_text", text: "상호명 (선택)", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: "custom_restaurant",
          max_length: 80,
          placeholder: { type: "plain_text", text: "예: 홍콩반점0410 전북대점", emoji: true }
        }
      },
      {
        type: "input",
        block_id: "other_menu",
        optional: true,
        label: { type: "plain_text", text: "메뉴명 (쉼표로 여러 개 가능)", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: "custom_menu",
          max_length: 200,
          placeholder: { type: "plain_text", text: "예: 짜장면, 탕수육", emoji: true }
        }
      },
      {
        type: "input",
        block_id: "rating",
        optional: true,
        label: { type: "plain_text", text: "만족도", emoji: true },
        element: {
          type: "static_select",
          action_id: "selected_rating",
          placeholder: { type: "plain_text", text: "선택 사항", emoji: true },
          options: [1, 2, 3, 4, 5].map((rating) => ({
            text: { type: "plain_text", text: `${rating}점${rating === 5 ? " · 최고" : rating === 1 ? " · 아쉬움" : ""}` },
            value: String(rating)
          }))
        }
      },
      {
        type: "input",
        block_id: "tags",
        optional: true,
        label: { type: "plain_text", text: "평가 태그 (최대 3개)", emoji: true },
        element: {
          type: "multi_static_select",
          action_id: "selected_tags",
          placeholder: { type: "plain_text", text: "선택 사항", emoji: true },
          max_selected_items: 3,
          options: MEAL_FEEDBACK_TAGS.map((tag) => ({
            text: { type: "plain_text", text: tag, emoji: true },
            value: tag
          }))
        }
      }
    ]
  };
}

export function modalForBlockAction(payload, {
  events = getMealEvents(),
  now = new Date()
} = {}) {
  const context = mealContextForBlockAction(payload);
  const eventId = stableEventId(payload, context);
  const respondentId = respondentIdForPayload(payload);
  const date = kstDateKey(now);
  const mealType = normalizeMealType(context.mealType || "meal");
  const duplicate = (events.events || []).some((event) =>
    event.eventId === eventId
    || (event.respondentId === respondentId && event.date === date && event.mealType === mealType));
  return duplicate
    ? buildMealSubmissionConfirmation({ duplicate: true })
    : buildMealFeedbackModal({ ...context, now });
}

function stateValue(values, blockId, actionId) {
  return values?.[blockId]?.[actionId];
}

function cleanMealText(value) {
  return String(value || "")
    .replace(/[\u2018\u2019\u201c\u201d]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripConversationalWrapper(value) {
  return cleanMealText(value)
    .replace(/^(?:저는|나는|난)\s+/u, "")
    .replace(/^(?:(?:오늘)(?:\s*(?:아침|점심|저녁|야식|식사))?\s*(?:은|는|으로|로|에)?|(?:아침|점심|저녁|야식|식사)\s*(?:은|는|으로|로|에)?|(?:먹은\s*)?메뉴(?:는|가)?)\s*/u, "")
    .replace(/\s*(?:을|를)?\s*(?:먹었(?:어요|습니다|음)?|먹음|먹었다|먹었습니다|시켰(?:어요|습니다)?|주문했(?:어요|습니다)?)\s*[.!?]*$/u, "")
    .trim();
}

function knownMealMatch(input, knownMeals) {
  const normalizedInput = normalizeMenuKey(cleanMealText(input));
  const normalizedStripped = normalizeMenuKey(stripConversationalWrapper(input));
  if (!normalizedInput) return null;
  const candidates = (knownMeals || []).filter((item) => cleanMealText(item?.menu));
  const matches = candidates.filter((item) => {
    const restaurant = cleanMealText(item?.restaurant);
    const menu = cleanMealText(item?.menu);
    const restaurantKey = restaurant.toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
    const menuKey = normalizeMenuKey(menu);
    return normalizedInput.includes(menuKey) && (!restaurantKey || normalizedInput.includes(restaurantKey));
  });
  if (matches.length) {
    matches.sort((a, b) => cleanMealText(b.menu).length - cleanMealText(a.menu).length);
    return { restaurant: cleanMealText(matches[0].restaurant), menu: cleanMealText(matches[0].menu), normalization: "known-meal" };
  }

  const menuOnlyMatches = candidates.filter((item) => {
    const menuKey = normalizeMenuKey(cleanMealText(item.menu));
    return menuKey && normalizedStripped === menuKey;
  });
  const distinctRestaurants = new Set(menuOnlyMatches.map((item) => cleanMealText(item.restaurant)));
  if (menuOnlyMatches.length && distinctRestaurants.size === 1) {
    return {
      restaurant: cleanMealText(menuOnlyMatches[0].restaurant),
      menu: cleanMealText(menuOnlyMatches[0].menu),
      normalization: "known-menu"
    };
  }
  return null;
}

export function normalizeCustomMealInput(value, { knownMeals = [] } = {}) {
  const inputText = cleanMealMenuInput(value);
  if (!inputText) return { inputText: "", restaurant: "", menu: "", normalization: "empty" };

  const known = knownMealMatch(inputText, knownMeals);
  if (known) return { inputText, ...known };

  const cleaned = stripConversationalWrapper(inputText) || inputText;
  const relation = cleaned.match(/^(.+?)\s*(?:에서|의)\s+(.+)$/u);
  if (relation) {
    return {
      inputText,
      restaurant: cleanMealText(relation[1]),
      menu: stripConversationalWrapper(relation[2]) || cleanMealText(relation[2]),
      normalization: "relation"
    };
  }

  const parts = cleaned.split(/\s*(?:·|\||:)\s*|\s+[\-–—]\s+/u).filter(Boolean);
  if (parts.length >= 2) {
    return {
      inputText,
      restaurant: cleanMealText(parts[0]),
      menu: cleanMealText(parts.slice(1).join(" · ")),
      normalization: "delimiter"
    };
  }

  return { inputText, restaurant: "", menu: cleaned, normalization: "menu-only" };
}

export function parseMealSubmission(payload) {
  if (payload.view?.callback_id !== CALLBACK_ID) return { handled: false };
  let metadata;
  try {
    metadata = JSON.parse(payload.view.private_metadata || "{}");
  } catch {
    return invalidMealMetadataSubmission();
  }
  if (!validMealSubmissionMetadata(metadata)) return invalidMealMetadataSubmission();
  const values = payload.view.state?.values || {};
  const choice = stateValue(values, "meal_choice", "selected_choice")?.selected_option?.value;
  const customRestaurant = cleanMealText(stateValue(values, "other_restaurant", "custom_restaurant")?.value);
  const customMenu = cleanMealMenuInput(stateValue(values, "other_menu", "custom_menu")?.value);
  const legacyCustomMeal = String(stateValue(values, "other_meal", "custom_meal")?.value || "").trim();
  const hasLegacyCustomField = Boolean(stateValue(values, "other_meal", "custom_meal"));
  const hasSeparateCustomFields = Boolean(customRestaurant || customMenu);
  if (choice === "other" && !customMenu && !legacyCustomMeal) {
    const blockId = hasLegacyCustomField ? "other_meal" : "other_menu";
    return { handled: true, errors: { [blockId]: "드신 메뉴명을 입력해 주세요." } };
  }
  if (customRestaurant.length > 80) {
    return { handled: true, errors: { other_restaurant: "상호명은 80자 이내로 작성해 주세요." } };
  }
  if (customMenu.length > 200) {
    return { handled: true, errors: { other_menu: "메뉴명은 200자 이내로 작성해 주세요." } };
  }
  if (legacyCustomMeal.length > 120) {
    return { handled: true, errors: { other_meal: "입력은 120자 이내로 작성해 주세요." } };
  }
  const selected = choice !== "other" ? metadata.recommendations?.[Number(choice)] : null;
  if (!selected && choice !== "other") {
    return { handled: true, errors: { meal_choice: "메뉴를 다시 선택해 주세요." } };
  }
  if (String(selected?.candidateId || "").length > RECOMMENDATION_LIMITS.candidateId) {
    return { handled: true, errors: { meal_choice: "메뉴 정보를 다시 불러와 주세요." } };
  }
  const knownMeals = [...(metadata.recommendations || []), ...getRecommendationHistory().items];
  const normalizedCustomMeal = hasSeparateCustomFields
    ? {
        inputText: customRestaurant ? `${customRestaurant} · ${customMenu}` : customMenu,
        restaurant: customRestaurant,
        menu: customMenu,
        normalization: "separate-fields"
      }
    : normalizeCustomMealInput(legacyCustomMeal, { knownMeals });
  if (choice === "other") {
    const invalidReason = invalidCustomMealInputReason({
      restaurantInput: normalizedCustomMeal.restaurant,
      menuInput: normalizedCustomMeal.menu
    });
    if (invalidReason) {
      return { handled: true, errors: { [hasLegacyCustomField ? "other_meal" : "other_menu"]: invalidReason } };
    }
  }
  const ratingValue = stateValue(values, "rating", "selected_rating")?.selected_option?.value;
  const tags = stateValue(values, "tags", "selected_tags")?.selected_options?.map((item) => item.value) || [];
  if (tags.length > 3 || tags.some((tag) => !ALLOWED_TAGS.has(tag))) {
    return { handled: true, errors: { tags: "평가 태그를 다시 선택해 주세요." } };
  }
  if (tags.includes("재주문") && tags.includes("다시 안 먹기")) {
    return { handled: true, errors: { tags: "재주문과 다시 안 먹기는 함께 선택할 수 없습니다." } };
  }
  const rating = ratingValue ? Number(ratingValue) : null;
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return { handled: true, errors: { rating: "만족도를 다시 선택해 주세요." } };
  }
  if (hasContradictoryPreferenceFeedback(rating, tags)) {
    return { handled: true, errors: { tags: "만족도와 재주문/다시 안 먹기 태그가 서로 맞지 않습니다." } };
  }
  const now = new Date();
  const createdAt = now.toISOString();
  let event = {
    eventId: stableEventId(payload, metadata),
    respondentId: respondentIdForPayload(payload),
    date: /^\d{4}-\d{2}-\d{2}$/u.test(String(metadata.submissionDate || ""))
      ? metadata.submissionDate
      : kstDateKey(now),
    mealType: normalizeMealType(metadata.mealType || "meal"),
    source: metadata.source || "feedback",
    candidateId: selected?.candidateId || null,
    restaurant: selected?.restaurant || normalizedCustomMeal.restaurant,
    branch: selected?.branch || "",
    menu: selected?.menu || normalizedCustomMeal.menu,
    menus: selected?.menu ? [selected.menu] : undefined,
    category: selected?.category || null,
    ...(choice === "other" ? {
      inputText: normalizedCustomMeal.inputText,
      inputNormalization: normalizedCustomMeal.normalization
    } : {
      normalizationStatus: "verified-source"
    }),
    rating,
    tags,
    channel: metadata.channel,
    messageTs: metadata.messageTs,
    createdAt
  };
  if (choice === "other") {
    event = prepareMealEventForNormalization(event, { enabled: config.mealNormalizationEnabled });
  }
  return { handled: true, event };
}

export function persistMealSubmission(payload, {
  appendEvent = appendMealEvent,
  retentionDays = config.mealEventRetentionDays
} = {}) {
  const parsed = parseMealSubmission(payload);
  if (!parsed.handled || parsed.errors) return parsed;
  const result = appendEvent(parsed.event, { retentionDays });
  return { ...parsed, duplicate: result?.inserted === false };
}

export function buildMealSubmissionConfirmation({ duplicate = false } = {}) {
  return {
    type: "modal",
    title: { type: "plain_text", text: "먹은 메뉴 기록", emoji: true },
    close: { type: "plain_text", text: "닫기", emoji: true },
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: duplicate
          ? "ℹ️ 이미 이 식사 시간대의 메뉴를 기록했습니다. 중복 학습을 막기 위해 최초 기록을 유지합니다."
          : "✅ 저장되었습니다."
      }
    }]
  };
}
