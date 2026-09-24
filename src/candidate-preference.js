import { config } from "./config.js";
import { mealContextForBlockAction } from "./interaction-context.js";
import { respondentIdForPayload, slackUserIdForPayload, stablePseudonymousId } from "./interaction-identity.js";
import { normalizeMealType } from "./meal-types.js";
import { appendCandidatePreference, getCandidatePreferences } from "./storage.js";
import { cleanText, normalizeMenuKey, normalizeRestaurantKey } from "./text.js";
import { RECOMMENDATION_LIMITS } from "./recommendation-limits.js";
import { hasValidCategoryAdjudication } from "./category-arbitration.js";

const CALLBACK_ID = "candidate_preference_submission";

function invalidMetadataSubmission() {
  return {
    handled: true,
    errors: {
      candidate_preference_0: "추천 정보를 다시 불러와 주세요."
    }
  };
}

function boundedCandidateId(value) {
  const candidateId = cleanText(value);
  if (candidateId.length > RECOMMENDATION_LIMITS.candidateId) {
    throw new Error("Candidate preference contains an oversized candidate ID");
  }
  return candidateId;
}

function optionLabel(item, index) {
  const label = `${index + 1}. ${cleanText(item.restaurant)} · ${cleanText(item.menu)}`;
  return label.length <= 150 ? label : `${label.slice(0, 147)}...`;
}

function ratingOptions() {
  const labels = ["전혀 안 끌림", "별로", "보통", "먹고 싶음", "매우 먹고 싶음"];
  return labels.map((label, index) => ({
    text: { type: "plain_text", text: `${index + 1}점 · ${label}`, emoji: true },
    value: String(index + 1)
  }));
}

function stableResponseId(payload, metadata) {
  const userId = slackUserIdForPayload(payload);
  const channel = String(metadata.channel || "");
  const messageTs = String(metadata.messageTs || "");
  if (!/^[CGD][A-Z0-9]+$/u.test(channel) || !/^\d+\.\d+$/u.test(messageTs)) {
    throw new Error("Candidate preference submission requires a valid Slack message target");
  }
  return stablePseudonymousId("candidate-preference", [userId, channel, messageTs]);
}

function dateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

export function buildCandidatePreferenceModal({ channel, messageTs, mealType, source = "", recommendations }) {
  if (!Array.isArray(recommendations) || recommendations.length !== 3) {
    throw new Error("Candidate preference modal requires exactly three recommendations");
  }
  const compact = recommendations.map((item) => {
    const branch = cleanText(item.branch).slice(0, 80);
    const compactItem = {
      candidateId: boundedCandidateId(item.candidateId),
      category: cleanText(item.category).slice(0, 40),
      restaurant: cleanText(item.restaurant).slice(0, 120),
      ...(branch ? { branch } : {}),
      menu: cleanText(item.menu).slice(0, 120)
    };
    return hasValidCategoryAdjudication({ ...item, ...compactItem })
      ? {
          ...compactItem,
          categoryAuthority: item.categoryAuthority,
          categoryAdjudicatedAt: item.categoryAdjudicatedAt,
          categoryAdjudicationKey: item.categoryAdjudicationKey,
        }
      : compactItem;
  });
  const metadata = JSON.stringify({ channel, messageTs, mealType: normalizeMealType(mealType), source, recommendations: compact });
  if (metadata.length > 3000) throw new Error("Candidate preference metadata exceeds the Slack modal limit");
  return {
    type: "modal",
    callback_id: CALLBACK_ID,
    private_metadata: metadata,
    title: { type: "plain_text", text: "추천 메뉴 선호도 조사", emoji: true },
    submit: { type: "plain_text", text: "저장", emoji: true },
    close: { type: "plain_text", text: "취소", emoji: true },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "먹어 본 여부와 관계없이, 지금 각 메뉴가 얼마나 끌리는지 평가해 주세요." }
      },
      ...compact.map((item, index) => ({
        type: "input",
        block_id: `candidate_preference_${index}`,
        label: { type: "plain_text", text: optionLabel(item, index), emoji: true },
        element: {
          type: "static_select",
          action_id: `candidate_rating_${index}`,
          placeholder: { type: "plain_text", text: "1~5점 선택", emoji: true },
          options: ratingOptions()
        }
      }))
    ]
  };
}

export function candidatePreferenceModalForBlockAction(payload, {
  preferences = getCandidatePreferences()
} = {}) {
  const context = mealContextForBlockAction(payload);
  const responseId = stableResponseId(payload, context);
  if ((preferences.responses || []).some((item) => item.responseId === responseId)) {
    return buildCandidatePreferenceConfirmation({ duplicate: true });
  }
  return buildCandidatePreferenceModal(context);
}

export function parseCandidatePreferenceSubmission(payload) {
  if (payload.view?.callback_id !== CALLBACK_ID) return { handled: false };
  let metadata;
  try {
    metadata = JSON.parse(payload.view.private_metadata || "{}");
  } catch {
    return invalidMetadataSubmission();
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return invalidMetadataSubmission();
  }
  if (!/^[CGD][A-Z0-9]+$/u.test(String(metadata.channel || ""))
      || !/^\d+\.\d+$/u.test(String(metadata.messageTs || ""))
      || !Array.isArray(metadata.recommendations)
      || metadata.recommendations.length !== 3) {
    return invalidMetadataSubmission();
  }
  let ratings;
  try {
    ratings = metadata.recommendations.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid recommendation metadata");
      const raw = payload.view.state?.values?.[`candidate_preference_${index}`]?.[`candidate_rating_${index}`]
        ?.selected_option?.value;
      const rating = Number(raw);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
      const branch = cleanText(item.branch).slice(0, 80);
      const normalized = {
        candidateId: boundedCandidateId(item.candidateId),
        category: cleanText(item.category).slice(0, 40),
        restaurant: cleanText(item.restaurant).slice(0, 120),
        ...(branch ? { branch } : {}),
        menu: cleanText(item.menu).slice(0, 120),
        rating
      };
      if (!normalized.category || !normalized.restaurant || !normalized.menu) return null;
      const hasAnyAdjudicationField = [
        item.categoryAuthority,
        item.categoryAdjudicatedAt,
        item.categoryAdjudicationKey,
      ].some((value) => value !== undefined);
      if (hasAnyAdjudicationField) {
        const adjudicated = {
          ...normalized,
          categoryAuthority: item.categoryAuthority,
          categoryAdjudicatedAt: item.categoryAdjudicatedAt,
          categoryAdjudicationKey: item.categoryAdjudicationKey,
        };
        if (!hasValidCategoryAdjudication(adjudicated)) {
          throw new Error("invalid category adjudication metadata");
        }
        Object.assign(normalized, {
          categoryAuthority: item.categoryAuthority,
          categoryAdjudicatedAt: item.categoryAdjudicatedAt,
          categoryAdjudicationKey: item.categoryAdjudicationKey,
        });
      }
      return normalized;
    });
  } catch {
    return invalidMetadataSubmission();
  }
  const errors = {};
  ratings.forEach((rating, index) => {
    if (!rating) errors[`candidate_preference_${index}`] = "1점에서 5점 사이로 선택해 주세요.";
  });
  if (Object.keys(errors).length > 0) return { handled: true, errors };
  const unique = new Set(ratings.map(
    (item) => `${normalizeRestaurantKey(item.restaurant)}:${normalizeMenuKey(item.menu)}`
  ));
  if (unique.size !== 3) return invalidMetadataSubmission();
  const now = new Date();
  return {
    handled: true,
    response: {
      responseId: stableResponseId(payload, metadata),
      respondentId: respondentIdForPayload(payload),
      date: dateKey(now),
      mealType: normalizeMealType(metadata.mealType || "meal"),
      source: cleanText(metadata.source) || "preference-survey",
      channel: String(metadata.channel || ""),
      messageTs: String(metadata.messageTs || ""),
      ratings,
      submittedAt: now.toISOString()
    }
  };
}

export function persistCandidatePreferenceSubmission(payload, {
  appendPreference = appendCandidatePreference,
  retentionDays = config.candidatePreferenceRetentionDays
} = {}) {
  const parsed = parseCandidatePreferenceSubmission(payload);
  if (!parsed.handled || parsed.errors) return parsed;
  const result = appendPreference(parsed.response, { retentionDays });
  return { ...parsed, duplicate: result?.inserted === false };
}

export function buildCandidatePreferenceConfirmation({ duplicate = false } = {}) {
  return {
    type: "modal",
    title: { type: "plain_text", text: "추천 메뉴 선호도 조사", emoji: true },
    close: { type: "plain_text", text: "닫기", emoji: true },
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: duplicate
          ? "ℹ️ 이미 이 추천에 응답했습니다. 중복 반영을 막기 위해 최초 응답을 유지합니다."
          : "✅ 세 메뉴의 선호도를 저장했습니다."
      }
    }]
  };
}
