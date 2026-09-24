import { normalizeMealType } from "./meal-types.js";
import { normalizeMenuKey, normalizeRestaurantKey } from "./text.js";
import { isAllowedCategory } from "./categories.js";
import { PSEUDONYMOUS_ID_PATTERN } from "./interaction-identity.js";
import { RECOMMENDATION_LIMITS } from "./recommendation-limits.js";
import { assertTimestampOrder, timestampMs } from "./time-integrity.js";
import { hasValidCategoryAdjudication } from "./category-arbitration.js";

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertSlackMessageTarget(channel, messageTs, label) {
  if (!/^[CGD][A-Z0-9]+$/u.test(String(channel || ""))) {
    throw new Error(`${label} has an invalid Slack channel`);
  }
  if (!/^\d+\.\d+$/u.test(String(messageTs || ""))) {
    throw new Error(`${label} has an invalid Slack message timestamp`);
  }
}

function isValidDateKey(value) {
  const date = String(value || "");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date)
    && Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === date;
}

export function validateCandidatePreferenceStore(store, { now = new Date() } = {}) {
  assertObject(store, "candidate preference store");
  if (store.version !== 1) throw new Error("candidate preference store must use version 1");
  if (!Array.isArray(store.responses)) throw new Error("candidate preference store must contain a responses array");
  if (store.responses.length > 5000) throw new Error("candidate preference store cannot exceed 5000 responses");
  const responseIds = new Set();
  let ratingCount = 0;

  for (const response of store.responses) {
    assertObject(response, "candidate preference response");
    if (!String(response.responseId || "").trim() || responseIds.has(response.responseId)) {
      throw new Error("candidate preference response IDs must be present and unique");
    }
    responseIds.add(response.responseId);
    if (Object.hasOwn(response, "user") || Object.hasOwn(response, "userId") || Object.hasOwn(response, "submittedBy")) {
      throw new Error(`candidate preference ${response.responseId} contains a prohibited raw user identifier`);
    }
    if (response.respondentId !== undefined && !PSEUDONYMOUS_ID_PATTERN.test(String(response.respondentId))) {
      throw new Error(`candidate preference ${response.responseId} has an invalid pseudonymous respondent`);
    }
    if (response.date !== undefined && !isValidDateKey(response.date)) {
      throw new Error(`candidate preference ${response.responseId} has an invalid date`);
    }
    assertSlackMessageTarget(response.channel, response.messageTs, `candidate preference ${response.responseId}`);
    if (!String(response.source || "").trim() || String(response.source).length > 80) {
      throw new Error(`candidate preference ${response.responseId} has an invalid source`);
    }
    const timestampLabel = `candidate preference ${response.responseId}`;
    const createdAt = response.createdAt === undefined
      ? null
      : timestampMs(response.createdAt, { label: `${timestampLabel} creation`, now });
    const submittedAt = response.submittedAt === undefined
      ? null
      : timestampMs(response.submittedAt, { label: `${timestampLabel} submission`, now });
    const updatedAt = response.updatedAt === undefined
      ? null
      : timestampMs(response.updatedAt, { label: `${timestampLabel} update`, now });
    if (createdAt === null && submittedAt === null && updatedAt === null) {
      throw new Error(`${timestampLabel} has an invalid timestamp`);
    }
    if (createdAt !== null && submittedAt !== null) {
      assertTimestampOrder(createdAt, submittedAt, `${timestampLabel} creation and submission`);
    }
    if (submittedAt !== null && updatedAt !== null) {
      assertTimestampOrder(submittedAt, updatedAt, `${timestampLabel} submission and update`);
    } else if (createdAt !== null && updatedAt !== null) {
      assertTimestampOrder(createdAt, updatedAt, `${timestampLabel} creation and update`);
    }
    if (normalizeMealType(response.mealType || "meal") !== response.mealType) {
      throw new Error(`candidate preference ${response.responseId} has a non-normalized meal type`);
    }
    if (!Array.isArray(response.ratings) || response.ratings.length !== 3) {
      throw new Error(`candidate preference ${response.responseId} must contain exactly three ratings`);
    }
    const candidateKeys = new Set();
    for (const item of response.ratings) {
      assertObject(item, `candidate preference ${response.responseId} rating`);
      if (!String(item.category || "").trim() || !String(item.restaurant || "").trim() || !String(item.menu || "").trim()) {
        throw new Error(`candidate preference ${response.responseId} has an incomplete candidate`);
      }
      if (String(item.category).length > 40 || String(item.restaurant).length > 120
        || String(item.branch || "").length > 80 || String(item.menu).length > 120
        || String(item.candidateId || "").length > RECOMMENDATION_LIMITS.candidateId) {
        throw new Error(`candidate preference ${response.responseId} has oversized candidate data`);
      }
      if (!isAllowedCategory(item.category)) {
        throw new Error(`candidate preference ${response.responseId} has a category outside the current taxonomy`);
      }
      const hasAnyAdjudicationField = [
        item.categoryAuthority,
        item.categoryAdjudicatedAt,
        item.categoryAdjudicationKey,
      ].some((value) => value !== undefined);
      if (hasAnyAdjudicationField && !hasValidCategoryAdjudication(item)) {
        throw new Error(`candidate preference ${response.responseId} has invalid category adjudication metadata`);
      }
      if (!Number.isInteger(item.rating) || item.rating < 1 || item.rating > 5) {
        throw new Error(`candidate preference ${response.responseId} has a rating outside 1-5`);
      }
      const key = `${normalizeRestaurantKey(item.restaurant)}:${normalizeMenuKey(item.menu)}`;
      if (candidateKeys.has(key)) throw new Error(`candidate preference ${response.responseId} contains duplicate candidates`);
      candidateKeys.add(key);
      ratingCount += 1;
    }
  }

  return { responseCount: store.responses.length, ratingCount };
}

export function validateCoffeeParticipationStore(store, { now = new Date() } = {}) {
  assertObject(store, "coffee participation store");
  if (store.version !== 1) throw new Error("coffee participation store must use version 1");
  if (!Array.isArray(store.messages)) throw new Error("coffee participation store must contain a messages array");
  if (store.messages.length > 500) throw new Error("coffee participation store cannot exceed 500 messages");
  const messageKeys = new Set();
  let participantCount = 0;

  for (const message of store.messages) {
    assertObject(message, "coffee participation message");
    assertSlackMessageTarget(message.channel, message.messageTs, "coffee participation message");
    const key = `${message.channel}:${message.messageTs}`;
    if (messageKeys.has(key)) throw new Error("coffee participation message targets must be unique");
    messageKeys.add(key);
    timestampMs(message.updatedAt, { label: `coffee participation ${key}`, now });
    if (!Array.isArray(message.userIds) || message.userIds.length > 100) {
      throw new Error(`coffee participation ${key} must contain 0-100 users`);
    }
    const uniqueUsers = new Set(message.userIds);
    if (uniqueUsers.size !== message.userIds.length || message.userIds.some((id) => !/^[UW][A-Z0-9]+$/u.test(String(id)))) {
      throw new Error(`coffee participation ${key} contains invalid or duplicate Slack users`);
    }
    participantCount += message.userIds.length;
  }

  return { messageCount: store.messages.length, participantCount };
}
