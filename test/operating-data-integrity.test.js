import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMealEventStore,
  validateRecommendationHistoryStore,
  validateRecommendationBatchForDelivery,
  validateSchedulerStateStore,
  validateSentMessageStore
} from "../src/operating-data-integrity.js";
import { REQUIRED_CHOICE_DIVERSITY_ENFORCEMENT_SINCE } from "../src/config.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

function recommendation(overrides = {}) {
  return {
    category: "도시락",
    restaurant: "밥집",
    menu: "제육",
    priceText: "9,000원",
    comment: "매콤한 양념과 부드러운 고기가 따뜻한 밥에 어우러져, 한입마다 든든한 감칠맛이 살아납니다.",
    evidence: ["https://example.com/menu"],
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "점심",
    source: "scheduled-cache",
    recommendedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

function validHistory() {
  return {
    version: 1,
    items: [
      recommendation(),
      recommendation({ category: "중식", restaurant: "반점", menu: "짬뽕" }),
      recommendation({ category: "돈까스", restaurant: "카츠집", menu: "돈카츠" })
    ]
  };
}

test("historical recategorization preserves send truth without bypassing new delivery diversity", () => {
  const history = validHistory();
  history.items = history.items.map((item) => ({ ...item, recommendedAt: "2026-09-01T00:00:00Z" }));
  history.items[0].categoryAtSend = history.items[0].category;
  history.items[0].category = history.items[1].category;
  assert.deepEqual(validateRecommendationHistoryStore(history), { itemCount: 3, groupCount: 1 });
  assert.throws(() => validateRecommendationBatchForDelivery(history.items, {
    mealType: "점심", source: "scheduled-cache",
  }), /historical categoryAtSend/u);
  delete history.items[0].categoryAtSend;
  assert.throws(() => validateRecommendationHistoryStore(history), /three unique category/u);
});

test("core operating stores accept normalized versioned data", () => {
  assert.deepEqual(validateRecommendationHistoryStore(validHistory()), { itemCount: 3, groupCount: 1 });
  assert.deepEqual(validateSentMessageStore({
    version: 1,
    messages: [{
      channel: "C123ABC",
      ts: "123.456",
      mealType: "점심",
      source: "scheduled-cache",
      sentAt: "2026-07-14T00:00:00.000Z"
    }]
  }), { messageCount: 1 });
  assert.deepEqual(validateSchedulerStateStore({ version: 1, sentKeys: ["2026-07-14:점심"] }), { sentKeyCount: 1 });
});

test("recommendation history requires complete diverse three-item groups", () => {
  assert.throws(
    () => validateRecommendationHistoryStore({ ...validHistory(), items: validHistory().items.slice(0, 2) }),
    /exactly three/u
  );
  const duplicateMenu = validHistory();
  duplicateMenu.items[1].menu = "제육";
  assert.throws(() => validateRecommendationHistoryStore(duplicateMenu), /three unique menu/u);
});

test("category diversity is enforced only after its documented policy boundary", () => {
  const legacy = validHistory();
  const boundary = Date.parse(REQUIRED_CHOICE_DIVERSITY_ENFORCEMENT_SINCE);
  legacy.items = legacy.items.map((item) => ({
    ...item,
    recommendedAt: new Date(boundary - 1).toISOString(),
  }));
  legacy.items[1].category = legacy.items[0].category;
  assert.deepEqual(validateRecommendationHistoryStore(legacy), { itemCount: 3, groupCount: 1 });

  const enforced = structuredClone(legacy);
  enforced.items = enforced.items.map((item) => ({
    ...item,
    recommendedAt: new Date(boundary).toISOString(),
  }));
  assert.throws(() => validateRecommendationHistoryStore(enforced), /three unique category/u);
});

test("recommendation history rejects non-text and oversized evidence", () => {
  const objectEvidence = validHistory();
  objectEvidence.items[0].evidence = { blob: "x".repeat(1000) };
  assert.throws(() => validateRecommendationHistoryStore(objectEvidence), /malformed or oversized evidence/u);
  const scalarOversized = validHistory();
  scalarOversized.items[0].evidence = "x".repeat(2049);
  assert.throws(() => validateRecommendationHistoryStore(scalarOversized), /malformed or oversized evidence/u);
});

test("recommendation history accepts identity-bound model category adjudication only", () => {
  const history = validHistory();
  history.items[0] = stampCategoryAdjudication(history.items[0], {
    category: history.items[0].category,
    now: new Date("2026-07-14T00:00:00.000Z"),
  });
  assert.deepEqual(validateRecommendationHistoryStore(history), { itemCount: 3, groupCount: 1 });
  history.items[0].menu = "변조된 메뉴";
  assert.throws(() => validateRecommendationHistoryStore(history), /invalid category adjudication/u);
});

test("core DBs reject English meal names, duplicate targets, and invalid scheduler keys", () => {
  assert.throws(() => validateSentMessageStore({
    version: 1,
    messages: [{
      channel: "C123ABC", ts: "123.456", mealType: "dinner", source: "scheduled-cache", sentAt: "2026-07-14T00:00:00.000Z"
    }]
  }), /non-normalized/u);
  assert.throws(
    () => validateSchedulerStateStore({ version: 1, sentKeys: ["2026-07-14:lunch"] }),
    /invalid sent key/u
  );
});

test("sent message deletion tombstones require a valid cleanup timestamp and reason", () => {
  const message = {
    channel: "C123ABC",
    ts: "123.456",
    mealType: "점심",
    source: "scheduled-cache",
    sentAt: "2026-07-14T00:00:00.000Z",
    deletedAt: "2026-07-16T00:00:00.000Z",
    deletionReason: "retention-cleanup"
  };
  assert.deepEqual(
    validateSentMessageStore({ version: 1, messages: [message] }),
    { messageCount: 1 }
  );
  assert.throws(
    () => validateSentMessageStore({ version: 1, messages: [{ ...message, deletedAt: "not-a-date" }] }),
    /invalid timestamp/u
  );
  assert.throws(
    () => validateSentMessageStore({ version: 1, messages: [{ ...message, deletionReason: "manual" }] }),
    /invalid deletion reason/u
  );
  const { deletionReason, ...incomplete } = message;
  assert.throws(
    () => validateSentMessageStore({ version: 1, messages: [incomplete] }),
    /incomplete deletion state/u
  );
  const pending = {
    ...message,
    clientMsgId: "12345678-1234-5abc-adef-123456789abc",
    deletionRequestedAt: "2026-07-15T00:00:00.000Z"
  };
  delete pending.deletedAt;
  assert.deepEqual(validateSentMessageStore({ version: 1, messages: [pending] }), { messageCount: 1 });
  assert.throws(
    () => validateSentMessageStore({
      version: 1,
      messages: [pending, { ...pending, channel: "C999ABC", ts: "999.999" }]
    }),
    /valid and unique/u
  );
  assert.throws(
    () => validateSentMessageStore({
      version: 1,
      messages: [{ ...message, deletionRequestedAt: "2026-07-17T00:00:00.000Z" }]
    }),
    /before its deletion request/u
  );
});

test("meal event integrity rejects the retired participant field and checks ratings, tags, and IDs", () => {
  const event = {
    eventId: "E1",
    menu: "제육",
    mealType: "점심",
    rating: 5,
    tags: ["재주문"],
    createdAt: "2026-07-14T00:00:00.000Z"
  };
  assert.deepEqual(validateMealEventStore({ version: 1, events: [event] }), { eventCount: 1 });
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, participantCount: 2 }] }),
    /retired participant count/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, tags: ["재주문", "재주문"] }] }),
    /invalid tags/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, rating: 2, tags: ["재주문"] }] }),
    /contradictory rating/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, rating: 4, tags: ["다시 안 먹기"] }] }),
    /contradictory rating/u
  );
  const rejected = {
    ...event,
    rawRestaurant: "으",
    rawMenu: "으",
    normalizationStatus: "rejected-input",
    normalizationAttemptCount: 0,
    normalizationLastError: "실제 상호명과 메뉴명을 확인할 수 없습니다."
  };
  assert.deepEqual(validateMealEventStore({ version: 1, events: [rejected] }), { eventCount: 1 });
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...rejected, normalizationAttemptCount: 1 }] }),
    /inconsistent rejected-input/u
  );

  const unverified = {
    ...event,
    rawRestaurant: "밥집",
    rawMenu: "제육",
    normalizationStatus: "unverified",
    normalizationAttemptCount: 3,
    normalizationStartedAt: "2026-07-14T00:05:00.000Z",
    normalizationCompletedAt: "2026-07-14T00:06:00.000Z",
    normalizationLastError: "현재 공개 근거로 지점과 메뉴를 검증하지 못했습니다."
  };
  assert.deepEqual(validateMealEventStore({ version: 1, events: [unverified] }), { eventCount: 1 });
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...unverified, normalizationAttemptCount: 2 }] }),
    /inconsistent unverified/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...unverified, normalizationCompletedAt: undefined }] }),
    /inconsistent unverified/u
  );
});

test("verified multi-menu events require consistent canonical names and location evidence fields", () => {
  const event = {
    eventId: "E-MULTI",
    restaurant: "두찜",
    branch: "전주금암점",
    address: "전북특별자치도 전주시 덕진구 기린대로 400",
    latitude: 35.85,
    longitude: 127.137,
    distanceKm: 0.51,
    category: "찜/탕",
    menu: "로제찜닭 · 까만찜닭",
    menus: ["로제찜닭", "까만찜닭"],
    rawRestaurant: "두찜",
    rawMenu: "로제찜닭, 까만찜닭",
    normalizationStatus: "verified",
    normalizationAttemptCount: 1,
    normalizationStartedAt: "2026-07-14T00:05:00.000Z",
    normalizationCompletedAt: "2026-07-14T00:10:00.000Z",
    normalization: {
      version: 2,
      method: "luna-web-search",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      useSearch: true,
      confidence: "high",
      restaurantEvidenceUrl: "https://example.com/store",
      menuEvidence: [
        { input: "로제찜닭", canonicalName: "로제찜닭", evidenceUrl: "https://example.com/rose" },
        { input: "까만찜닭", canonicalName: "까만찜닭", evidenceUrl: "https://example.com/black" }
      ],
      verifiedAt: "2026-07-14T00:10:00.000Z"
    },
    mealType: "저녁",
    tags: [],
    createdAt: "2026-07-14T00:00:00.000Z"
  };
  assert.deepEqual(validateMealEventStore({ version: 1, events: [event] }), { eventCount: 1 });
  assert.deepEqual(
    validateMealEventStore({
      version: 1,
      events: [{
        ...event,
        eventId: "E-MULTI-MEDIUM",
        rawRestaurant: "",
        normalization: { ...event.normalization, reasoningEffort: "medium" }
      }]
    }),
    { eventCount: 1 }
  );
  assert.deepEqual(
    validateMealEventStore({
      version: 1,
      events: [{
        ...event,
        eventId: "E-MULTI-REVIEWED",
        branch: "",
        normalization: {
          version: 2,
          method: "reviewed-catalog-live-evidence",
          source: "tracked-reviewed-alias",
          deterministicEvidence: true,
          confidence: "high",
          restaurantEvidenceUrl: "https://example.com/store",
          menuEvidence: event.normalization.menuEvidence,
          verifiedAt: "2026-07-14T00:10:00.000Z"
        }
      }]
    }),
    { eventCount: 1 }
  );
  assert.throws(
    () => validateMealEventStore({
      version: 1,
      events: [{
        ...event,
        eventId: "E-MULTI-LOW",
        normalization: { ...event.normalization, reasoningEffort: "low" }
      }]
    }),
    /invalid verified normalization contract/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, menu: "로제찜닭" }] }),
    /inconsistent canonical menus/u
  );
  assert.deepEqual(
    validateMealEventStore({ version: 1, events: [{ ...event, branch: "" }] }),
    { eventCount: 1 }
  );
  assert.deepEqual(
    validateMealEventStore({
      version: 1,
      events: [{
        ...event,
        eventId: "E-MULTI-TERRA",
        normalization: {
          ...event.normalization,
          method: "codex-web-search",
          model: "gpt-5.6-terra",
          reasoningEffort: "medium"
        }
      }]
    }),
    { eventCount: 1 }
  );
  assert.deepEqual(
    validateMealEventStore({
      version: 1,
      events: [{
        ...event,
        eventId: "E-MULTI-LUNA-XHIGH",
        normalization: {
          ...event.normalization,
          method: "codex-web-search",
          model: "gpt-6-luna",
          reasoningEffort: "xhigh"
        }
      }]
    }),
    { eventCount: 1 }
  );
  assert.throws(
    () => validateMealEventStore({
      version: 1,
      events: [{
        ...event,
        eventId: "E-MULTI-FALSE-LEGACY",
        normalization: { ...event.normalization, model: "gpt-5.6-terra" }
      }]
    }),
    /invalid verified normalization contract/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, restaurant: "" }] }),
    /missing restaurant or address/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, latitude: null, longitude: null }] }),
    /missing branch coordinates/u
  );
});

test("operating timestamps reject values beyond the five-minute clock-skew allowance", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const allowed = validHistory();
  allowed.items = allowed.items.map((item) => ({
    ...item,
    recommendedAt: "2026-07-14T00:05:00.000Z"
  }));
  assert.deepEqual(
    validateRecommendationHistoryStore(allowed, { now }),
    { itemCount: 3, groupCount: 1 }
  );
  const future = structuredClone(allowed);
  future.items = future.items.map((item) => ({
    ...item,
    recommendedAt: "2026-07-14T00:05:00.001Z"
  }));
  assert.throws(
    () => validateRecommendationHistoryStore(future, { now }),
    /more than five minutes in the future/u
  );

  assert.throws(() => validateMealEventStore({
    version: 1,
    events: [{
      eventId: "E-FUTURE",
      menu: "제육",
      mealType: "점심",
      tags: [],
      createdAt: "2026-07-14T00:05:00.001Z"
    }]
  }, { now }), /more than five minutes in the future/u);
});

test("sent deletion and meal normalization lifecycles enforce monotonic state ordering", () => {
  const now = new Date("2026-07-14T02:00:00.000Z");
  const sent = {
    channel: "C123ABC",
    ts: "123.456",
    mealType: "점심",
    source: "scheduled-cache",
    sentAt: "2026-07-14T01:00:00.000Z",
    deletionRequestedAt: "2026-07-14T00:59:00.000Z",
    deletionReason: "retention-cleanup"
  };
  assert.throws(
    () => validateSentMessageStore({ version: 1, messages: [sent] }, { now }),
    /requested deletion before it was sent/u
  );

  const base = {
    eventId: "E-STATE",
    menu: "제육",
    mealType: "점심",
    tags: [],
    createdAt: "2026-07-14T01:00:00.000Z",
    normalizationStatus: "failed",
    normalizationAttemptCount: 1,
    normalizationStartedAt: "2026-07-14T01:10:00.000Z",
    normalizationCompletedAt: "2026-07-14T01:11:00.000Z",
    normalizationLastError: "근거 부족"
  };
  assert.deepEqual(
    validateMealEventStore({ version: 1, events: [base] }, { now }),
    { eventCount: 1 }
  );
  assert.throws(() => validateMealEventStore({
    version: 1,
    events: [{ ...base, normalizationStartedAt: "2026-07-14T00:59:00.000Z" }]
  }, { now }), /started before the event was created/u);
  assert.throws(() => validateMealEventStore({
    version: 1,
    events: [{ ...base, normalizationCompletedAt: "2026-07-14T01:09:00.000Z" }]
  }, { now }), /invalid timestamp order/u);
  assert.throws(() => validateMealEventStore({
    version: 1,
    events: [{ ...base, normalizationStatus: "pending" }]
  }, { now }), /inconsistent pending normalization state/u);
});

test("meal event integrity rejects raw identities and duplicate respondent meal slots", () => {
  const event = {
    eventId: "E-PROTECTED-1",
    respondentId: "12345678-1234-5abc-adef-123456789abc",
    date: "2026-07-14",
    menu: "제육",
    mealType: "점심",
    source: "scheduled-cache",
    tags: [],
    channel: "C123ABC",
    messageTs: "123.456",
    createdAt: "2026-07-14T00:00:00.000Z"
  };
  assert.deepEqual(validateMealEventStore({ version: 1, events: [event] }), { eventCount: 1 });
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, userId: "U123ABC" }] }),
    /prohibited raw user/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [{ ...event, date: "2026-02-31" }] }),
    /invalid date/u
  );
  assert.throws(
    () => validateMealEventStore({ version: 1, events: [event, { ...event, eventId: "E-PROTECTED-2", messageTs: "999.999" }] }),
    /respondent\/date\/meal slots must be unique/u
  );
});
