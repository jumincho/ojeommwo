import { normalizeMealType } from "./meal-types.js";
import { normalizeKey, normalizeMenuKey } from "./text.js";
import {
  RECOMMENDATION_LIMITS,
  hasBoundedRecommendationFields,
  isBoundedText
} from "./recommendation-limits.js";
import { isAllowedCategory } from "./categories.js";
import {
  config,
  VERIFIED_NORMALIZATION_MODELS,
  VERIFIED_NORMALIZATION_REASONING_EFFORTS
} from "./config.js";
import { PSEUDONYMOUS_ID_PATTERN } from "./interaction-identity.js";
import { isPoliteRecommendationComment } from "./recommendation-comment.js";
import { haversineKm, isSafeEvidenceUrl, MIN_RESEARCH_DISTANCE_KM } from "./verified-candidates.js";
import { hasContradictoryPreferenceFeedback } from "./meal-feedback-policy.js";
import { isCurrentPolicyRecommendationPrice } from "./recommendation-price.js";
import { hasValidCategoryAdjudication } from "./category-arbitration.js";
import {
  assertNotFuture,
  assertTimestampOrder,
  currentTimeMs,
  parseTimestampMs,
  timestampMs
} from "./time-integrity.js";

const VALID_FEEDBACK_TAGS = new Set(["든든함", "가벼움", "매움", "재주문", "다시 안 먹기"]);
const VALID_NORMALIZATION_STATUSES = new Set([
  "pending", "normalizing", "verified", "verified-source", "unresolved", "unverified", "failed", "local-only", "rejected-input"
]);
const CLIENT_MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u;
const POLICY_ENFORCEMENT_TIME = Date.parse(config.policyEnforcementSince);
const CHOICE_DIVERSITY_ENFORCEMENT_TIME = Date.parse(config.choiceDiversityEnforcementSince);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertVersionOne(store, label) {
  assertObject(store, label);
  if (store.version !== 1) throw new Error(`${label} must use version 1`);
}

function assertSlackTarget(channel, messageTs, label) {
  if (!/^[CGD][A-Z0-9]+$/u.test(String(channel || ""))) throw new Error(`${label} has an invalid Slack channel`);
  if (!/^\d+\.\d+$/u.test(String(messageTs || ""))) throw new Error(`${label} has an invalid Slack timestamp`);
}

function assertNormalizedMealType(item, label) {
  if (normalizeMealType(item.mealType || "meal") !== item.mealType) {
    throw new Error(`${label} has a non-normalized meal type`);
  }
}

function assertDate(value, label, now) {
  return timestampMs(value, { label, now });
}

function assertDateKey(value, label) {
  const date = String(value || "");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} has an invalid date`);
  }
}

function policyApplies(item) {
  const time = Date.parse(item.recommendedAt || "");
  return Number.isFinite(time) && time >= POLICY_ENFORCEMENT_TIME;
}

function choiceDiversityApplies(item) {
  const time = Date.parse(item.recommendedAt || "");
  return Number.isFinite(time) && time >= CHOICE_DIVERSITY_ENFORCEMENT_TIME;
}

function evidenceValues(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}

function assertValidOptionalCategoryAdjudication(item, label) {
  const hasAnyField = [
    item.categoryAuthority,
    item.categoryAdjudicatedAt,
    item.categoryAdjudicationKey,
  ].some((value) => value !== undefined);
  if (hasAnyField && !hasValidCategoryAdjudication(item)) {
    throw new Error(`${label} has invalid category adjudication metadata`);
  }
}

function validateNormalizationState(event, label, eventTimestamp, now) {
  const status = event.normalizationStatus;
  const attemptCount = event.normalizationAttemptCount ?? 0;
  const startedAt = event.normalizationStartedAt === undefined
    ? null
    : assertDate(event.normalizationStartedAt, `${label} normalization start`, now);
  const completedAt = event.normalizationCompletedAt === undefined
    ? null
    : assertDate(event.normalizationCompletedAt, `${label} normalization completion`, now);
  const lastError = String(event.normalizationLastError || "");

  if (lastError.length > 240) throw new Error(`${label} has an oversized normalization error`);
  if (startedAt !== null && startedAt < eventTimestamp) {
    throw new Error(`${label} normalization started before the event was created`);
  }
  if (completedAt !== null) {
    if (startedAt === null) throw new Error(`${label} has a completion without a normalization start`);
    if (status !== "normalizing") assertTimestampOrder(startedAt, completedAt, `${label} normalization`);
  }

  if (status === undefined) {
    if (attemptCount !== 0 || startedAt !== null || completedAt !== null || lastError) {
      throw new Error(`${label} has normalization lifecycle data without a status`);
    }
    return { startedAt, completedAt };
  }

  if (status === "pending" || status === "local-only") {
    if (attemptCount !== 0 || startedAt !== null || completedAt !== null || lastError) {
      throw new Error(`${label} has an inconsistent ${status} normalization state`);
    }
  } else if (status === "rejected-input") {
    if (attemptCount !== 0 || startedAt !== null || completedAt !== null || !lastError.trim()) {
      throw new Error(`${label} has an inconsistent rejected-input normalization state`);
    }
  } else if (status === "normalizing") {
    if (attemptCount < 1 || startedAt === null || lastError) {
      throw new Error(`${label} has an inconsistent normalizing state`);
    }
    // A reclaimed retry can retain the preceding attempt's completion time,
    // but it may not look like the current claim already completed.
    if (completedAt !== null && completedAt > startedAt) {
      throw new Error(`${label} has a completion after its active normalization start`);
    }
  } else if (status === "failed" || status === "unresolved") {
    if (attemptCount < 1 || startedAt === null || completedAt === null || !lastError.trim()) {
      throw new Error(`${label} has an inconsistent ${status} normalization state`);
    }
  } else if (status === "unverified") {
    if (attemptCount !== config.mealNormalizationMaxAttempts
        || startedAt === null
        || completedAt === null
        || !lastError.trim()) {
      throw new Error(`${label} has an inconsistent unverified normalization state`);
    }
  } else if (status === "verified") {
    if (attemptCount < 1 || startedAt === null || completedAt === null || lastError) {
      throw new Error(`${label} has an inconsistent verified normalization state`);
    }
  } else if (status === "verified-source") {
    const hasLifecycle = attemptCount > 0 || startedAt !== null || completedAt !== null;
    if (lastError || (hasLifecycle && (attemptCount < 1 || startedAt === null || completedAt === null))) {
      throw new Error(`${label} has an inconsistent verified-source state`);
    }
  }
  return { startedAt, completedAt };
}

export function validateRecommendationHistoryStore(store, { now = new Date() } = {}) {
  assertVersionOne(store, "recommendation history");
  if (!Array.isArray(store.items)) throw new Error("recommendation history must contain an items array");
  if (store.items.length > 10_000) throw new Error("recommendation history cannot exceed 10000 items");
  const groups = new Map();
  for (const item of store.items) {
    assertObject(item, "recommendation history item");
    const label = `recommendation ${item.channel || "?"}:${item.messageTs || "?"}`;
    assertSlackTarget(item.channel, item.messageTs, label);
    assertNormalizedMealType(item, label);
    assertDate(item.recommendedAt, label, now);
    if (!hasBoundedRecommendationFields(item)) throw new Error(`${label} has missing or oversized recommendation fields`);
    assertValidOptionalCategoryAdjudication(item, label);
    if (item.categoryAtSend !== undefined && !isAllowedCategory(item.categoryAtSend)) {
      throw new Error(`${label} has an invalid original send category`);
    }
    if (!isBoundedText(item.source, { min: 1, max: 80 })) throw new Error(`${label} has an invalid source`);
    const evidence = evidenceValues(item.evidence);
    if (!evidence
      || evidence.length > RECOMMENDATION_LIMITS.evidenceCount
      || evidence.some((value) => value.length > RECOMMENDATION_LIMITS.evidenceUrl)) {
      throw new Error(`${label} has malformed or oversized evidence`);
    }
    if (policyApplies(item)) {
      if (!isAllowedCategory(item.category)) throw new Error(`${label} has a category outside the current taxonomy`);
      if (!isCurrentPolicyRecommendationPrice(item.priceText)) {
        throw new Error(`${label} has an invalid current-policy price`);
      }
      if (!isPoliteRecommendationComment(item.comment)) {
        throw new Error(`${label} has a non-polite or malformed current-policy comment`);
      }
      if (evidence.length < 1) throw new Error(`${label} has no current-policy evidence`);
    }
    const key = `${item.channel}:${item.messageTs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, group] of groups) {
    if (group.length !== 3) throw new Error(`recommendation group ${key} must contain exactly three items`);
    const uniqueFields = choiceDiversityApplies(group[0])
      ? ["category", "restaurant", "menu"]
      : ["restaurant", "menu"];
    for (const field of uniqueFields) {
      if (new Set(group.map((item) => normalizeKey(
        field === "category" ? item.categoryAtSend || item.category : item[field]
      ))).size !== 3) {
        throw new Error(`recommendation group ${key} must contain three unique ${field} values`);
      }
    }
    for (const field of ["mealType", "source", "recommendedAt"]) {
      if (new Set(group.map((item) => String(item[field] || ""))).size !== 1) {
        throw new Error(`recommendation group ${key} must have one shared ${field}`);
      }
    }
  }
  return { itemCount: store.items.length, groupCount: groups.size };
}

export function validateRecommendationBatchForDelivery(recommendations, {
  mealType,
  source,
  now = new Date()
} = {}) {
  if (!Array.isArray(recommendations)) throw new Error("delivery recommendations must be an array");
  if (recommendations.some((item) => item?.categoryAtSend !== undefined)) {
    throw new Error("New delivery recommendations cannot contain historical categoryAtSend metadata");
  }
  const recommendedAt = new Date(currentTimeMs(now, "delivery recommendation validation")).toISOString();
  return validateRecommendationHistoryStore({
    version: 1,
    items: recommendations.map((recommendation) => ({
      ...structuredClone(recommendation),
      channel: "DVALIDATION",
      messageTs: "1.1",
      mealType,
      source,
      recommendedAt
    }))
  }, { now });
}

export function validateSentMessageStore(store, { now = new Date() } = {}) {
  assertVersionOne(store, "sent message store");
  if (!Array.isArray(store.messages)) throw new Error("sent message store must contain a messages array");
  if (store.messages.length > 5000) throw new Error("sent message store cannot exceed 5000 messages");
  const keys = new Set();
  const clientMessageIds = new Set();
  for (const message of store.messages) {
    assertObject(message, "sent message");
    const label = `sent message ${message.channel || "?"}:${message.ts || "?"}`;
    assertSlackTarget(message.channel, message.ts, label);
    assertNormalizedMealType(message, label);
    const sentAt = parseTimestampMs(message.sentAt, label);
    if (!isBoundedText(message.source, { min: 1, max: 80 })) throw new Error(`${label} has an invalid source`);
    if (message.clientMsgId !== undefined) {
      if (!CLIENT_MESSAGE_ID_PATTERN.test(String(message.clientMsgId || ""))
          || clientMessageIds.has(message.clientMsgId)) {
        throw new Error("sent message client message IDs must be valid and unique");
      }
      clientMessageIds.add(message.clientMsgId);
    }
    const hasDeletionRequestedAt = Object.hasOwn(message, "deletionRequestedAt");
    const hasDeletedAt = Object.hasOwn(message, "deletedAt");
    const hasDeletionReason = Object.hasOwn(message, "deletionReason");
    if (hasDeletionReason !== (hasDeletionRequestedAt || hasDeletedAt)) {
      throw new Error(`${label} has an incomplete deletion state`);
    }
    const deletionRequestedAt = hasDeletionRequestedAt
      ? parseTimestampMs(message.deletionRequestedAt, `${label} deletion request`)
      : null;
    const deletedAt = hasDeletedAt
      ? parseTimestampMs(message.deletedAt, `${label} deletion`)
      : null;
    if (deletionRequestedAt !== null && deletionRequestedAt < sentAt) {
      throw new Error(`${label} requested deletion before it was sent`);
    }
    if (hasDeletedAt) {
      if (deletedAt < sentAt) throw new Error(`${label} was deleted before it was sent`);
      if (deletionRequestedAt !== null && deletedAt < deletionRequestedAt) {
        throw new Error(`${label} was deleted before its deletion request`);
      }
    }
    assertNotFuture(sentAt, { label, now });
    if (deletionRequestedAt !== null) {
      assertNotFuture(deletionRequestedAt, { label: `${label} deletion request`, now });
    }
    if (deletedAt !== null) assertNotFuture(deletedAt, { label: `${label} deletion`, now });
    if (hasDeletionReason && message.deletionReason !== "retention-cleanup") {
      throw new Error(`${label} has an invalid deletion reason`);
    }
    const key = `${message.channel}:${message.ts}`;
    if (keys.has(key)) throw new Error("sent message targets must be unique");
    keys.add(key);
  }
  return { messageCount: store.messages.length };
}

export function validateMealEventStore(store, { now = new Date() } = {}) {
  assertVersionOne(store, "meal event store");
  if (!Array.isArray(store.events)) throw new Error("meal event store must contain an events array");
  if (store.events.length > 2000) throw new Error("meal event store cannot exceed 2000 events");
  const seen = new Set();
  const respondentMealSlots = new Set();
  for (const event of store.events) {
    assertObject(event, "meal event");
    if (!String(event.eventId || "").trim() || seen.has(event.eventId)) {
      throw new Error("meal event IDs must be present and unique");
    }
    seen.add(event.eventId);
    const label = `meal event ${event.eventId}`;
    if (Object.hasOwn(event, "user") || Object.hasOwn(event, "userId") || Object.hasOwn(event, "submittedBy")) {
      throw new Error(`${label} contains a prohibited raw user identifier`);
    }
    if (event.respondentId !== undefined && !PSEUDONYMOUS_ID_PATTERN.test(String(event.respondentId))) {
      throw new Error(`${label} has an invalid pseudonymous respondent`);
    }
    if (event.date !== undefined) assertDateKey(event.date, label);
    const hasChannel = String(event.channel || "").length > 0;
    const hasMessageTs = String(event.messageTs || "").length > 0;
    if (hasChannel !== hasMessageTs) throw new Error(`${label} has an incomplete Slack message target`);
    if (hasChannel) assertSlackTarget(event.channel, event.messageTs, label);
    if (!String(event.menu || "").trim() || String(event.menu).length > 400) throw new Error(`${label} has an invalid menu`);
    if (String(event.restaurant || "").length > 120 || String(event.branch || "").length > 80) {
      throw new Error(`${label} has oversized restaurant data`);
    }
    if (String(event.source || "").length > 80
      || String(event.candidateId || "").length > RECOMMENDATION_LIMITS.candidateId
      || String(event.inputText || "").length > 400) {
      throw new Error(`${label} has oversized metadata`);
    }
    if (event.category !== null && event.category !== undefined && event.category !== "" && !isAllowedCategory(event.category)) {
      throw new Error(`meal event ${event.eventId} has a category outside the current taxonomy`);
    }
    if (event.menus !== undefined) {
      if (!Array.isArray(event.menus) || event.menus.length < 1 || event.menus.length > 5) {
        throw new Error(`meal event ${event.eventId} has invalid canonical menus`);
      }
      const menus = event.menus.map((item) => String(item || "").trim());
      if (menus.some((item) => !item || item.length > 120)
        || new Set(menus.map(normalizeKey)).size !== menus.length
        || String(event.menu) !== menus.join(" · ")) {
        throw new Error(`meal event ${event.eventId} has inconsistent canonical menus`);
      }
    }
    if (event.normalizationStatus !== undefined && !VALID_NORMALIZATION_STATUSES.has(event.normalizationStatus)) {
      throw new Error(`meal event ${event.eventId} has an invalid normalization status`);
    }
    if (event.normalizationAttemptCount !== undefined
      && (!Number.isInteger(event.normalizationAttemptCount) || event.normalizationAttemptCount < 0 || event.normalizationAttemptCount > 10)) {
      throw new Error(`meal event ${event.eventId} has an invalid normalization attempt count`);
    }
    const createdAt = event.createdAt === undefined
      ? null
      : assertDate(event.createdAt, `${label} creation`, now);
    const eatenAt = event.eatenAt === undefined
      ? null
      : assertDate(event.eatenAt, `${label} meal time`, now);
    const eventTimestamp = createdAt ?? eatenAt;
    if (eventTimestamp === null) throw new Error(`${label} has an invalid timestamp`);
    const normalizationTimes = validateNormalizationState(event, label, eventTimestamp, now);
    if (event.rawRestaurant !== undefined && String(event.rawRestaurant).length > 80) {
      throw new Error(`meal event ${event.eventId} has an oversized raw restaurant`);
    }
    if (event.rawMenu !== undefined && (!String(event.rawMenu).trim() || String(event.rawMenu).length > 400)) {
      throw new Error(`meal event ${event.eventId} has an invalid raw menu`);
    }
    if (event.normalizationStatus === "verified") {
      if (!String(event.restaurant || "").trim() || !String(event.address || "").trim()) {
        throw new Error(`verified meal event ${event.eventId} is missing restaurant or address data`);
      }
      if (!/전주/u.test(event.address) || !/\d/u.test(event.address)) {
        throw new Error(`verified meal event ${event.eventId} has an invalid Jeonju address`);
      }
      if (event.latitude === null || event.latitude === undefined || String(event.latitude).trim() === ""
        || event.longitude === null || event.longitude === undefined || String(event.longitude).trim() === ""
        || !Number.isFinite(Number(event.latitude)) || !Number.isFinite(Number(event.longitude))) {
        throw new Error(`verified meal event ${event.eventId} is missing branch coordinates`);
      }
      const latitude = Number(event.latitude);
      const longitude = Number(event.longitude);
      const distanceKm = haversineKm(config.targetLatitude, config.targetLongitude, latitude, longitude);
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
        || distanceKm < MIN_RESEARCH_DISTANCE_KM || distanceKm > config.researchDistanceKm) {
        throw new Error(`verified meal event ${event.eventId} has coordinates outside the allowed branch area`);
      }
      if (!Number.isFinite(Number(event.distanceKm)) || Math.abs(Number(event.distanceKm) - distanceKm) > 0.02) {
        throw new Error(`verified meal event ${event.eventId} has an inconsistent branch distance`);
      }
      // The meal UI deliberately permits a missing restaurant. Preserve that
      // empty original input when evidence identifies the shop from the menu.
      if (typeof event.rawRestaurant !== "string" || event.rawRestaurant.length > 80
          || !String(event.rawMenu || "").trim()) {
        throw new Error(`verified meal event ${event.eventId} does not preserve its raw restaurant and menu input`);
      }
      const normalization = event.normalization;
      const legacyModelContract = normalization?.method === "luna-web-search"
        && normalization.model === "gpt-5.6-luna"
        && VERIFIED_NORMALIZATION_REASONING_EFFORTS.includes(normalization.reasoningEffort)
        && normalization.useSearch === true;
      const codexSearchContract = normalization?.method === "codex-web-search"
        && VERIFIED_NORMALIZATION_MODELS.includes(normalization.model)
        && VERIFIED_NORMALIZATION_REASONING_EFFORTS.includes(normalization.reasoningEffort)
        && normalization.useSearch === true;
      const reviewedCatalogContract = normalization?.method === "reviewed-catalog-live-evidence"
        && normalization.source === "tracked-reviewed-alias"
        && normalization.deterministicEvidence === true;
      if (!normalization || normalization.version !== 2
        || (!legacyModelContract && !codexSearchContract && !reviewedCatalogContract)
        || normalization.confidence !== "high") {
        throw new Error(`verified meal event ${event.eventId} has an invalid verified normalization contract`);
      }
      if (!isSafeEvidenceUrl(normalization.restaurantEvidenceUrl)) {
        throw new Error(`verified meal event ${event.eventId} has unsafe restaurant evidence`);
      }
      if (!Array.isArray(normalization.menuEvidence)
        || normalization.menuEvidence.length !== event.menus?.length
        || normalization.menuEvidence.some((item, index) =>
          normalizeMenuKey(item?.canonicalName) !== normalizeMenuKey(event.menus[index])
          || !isSafeEvidenceUrl(item?.evidenceUrl))) {
        throw new Error(`verified meal event ${event.eventId} has inconsistent menu evidence`);
      }
      const verifiedAt = assertDate(normalization.verifiedAt, `verified meal event ${event.eventId} evidence`, now);
      if (verifiedAt < normalizationTimes.startedAt || verifiedAt > normalizationTimes.completedAt) {
        throw new Error(`verified meal event ${event.eventId} evidence has an invalid timestamp order`);
      }
    }
    assertNormalizedMealType(event, `meal event ${event.eventId}`);
    if (event.respondentId && event.date) {
      const slot = `${event.respondentId}:${event.date}:${event.mealType}`;
      if (respondentMealSlots.has(slot)) throw new Error("meal event respondent/date/meal slots must be unique");
      respondentMealSlots.add(slot);
    }
    const rating = event.rating === null || event.rating === undefined ? null : Number(event.rating);
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw new Error(`meal event ${event.eventId} has an invalid rating`);
    }
    if (Object.hasOwn(event, "participantCount")) {
      throw new Error(`meal event ${event.eventId} contains the retired participant count field`);
    }
    const tags = Array.isArray(event.tags) ? event.tags : [];
    if (tags.length > 3 || new Set(tags).size !== tags.length || tags.some((tag) => !VALID_FEEDBACK_TAGS.has(tag))) {
      throw new Error(`meal event ${event.eventId} has invalid tags`);
    }
    if (tags.includes("재주문") && tags.includes("다시 안 먹기")) {
      throw new Error(`meal event ${event.eventId} has contradictory preference tags`);
    }
    if (hasContradictoryPreferenceFeedback(rating, tags)) {
      throw new Error(`meal event ${event.eventId} has contradictory rating and preference tags`);
    }
  }
  return { eventCount: store.events.length };
}

export function validateSchedulerStateStore(store) {
  assertVersionOne(store, "scheduler state");
  if (!Array.isArray(store.sentKeys)) throw new Error("scheduler state must contain a sentKeys array");
  if (store.sentKeys.length > 60 || new Set(store.sentKeys).size !== store.sentKeys.length) {
    throw new Error("scheduler sent keys must be unique and limited to 60");
  }
  if (store.sentKeys.some((key) => !/^\d{4}-\d{2}-\d{2}:(?:점심|저녁)$/u.test(String(key)))) {
    throw new Error("scheduler state contains an invalid sent key");
  }
  return { sentKeyCount: store.sentKeys.length };
}
