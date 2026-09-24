import test from "node:test";
import assert from "node:assert/strict";
import { auditHasIntegrityFailure, auditRecommendationData, formatAuditReport } from "../src/recommendation-audit.js";

function recommendation(overrides = {}) {
  return {
    category: "도시락",
    restaurant: "한식집",
    menu: "제육덮밥",
    priceText: "9,000원",
    evidence: ["가격/배달 https://example.com/menu"],
    channel: "C123",
    messageTs: "100.1",
    mealType: "점심",
    source: "scheduled-codex-cli",
    requestedMode: "codex-cli",
    generationMode: "codex-cli",
    fallbackUsed: false,
    recommendedAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}

test("recommendation audit reports integrity, provenance, evidence, and cooldowns", () => {
  const report = auditRecommendationData({
    history: {
      items: [
        recommendation(),
        recommendation({ restaurant: "중식집", menu: "짬뽕", category: "중식" }),
        recommendation({ restaurant: "일식집", menu: "돈카츠", category: "돈까스" })
      ]
    },
    sentMessages: { messages: [{ channel: "C123", ts: "100.1" }] },
    now: new Date("2026-07-12T00:00:00.000Z"),
    windowDays: 30
  });

  assert.equal(report.totals.recommendationItems, 3);
  assert.equal(report.integrity.groupSizes[3], 1);
  assert.equal(report.provenance.generationMode["codex-cli"], 3);
  assert.equal(report.evidence.entriesWithoutUrl, 0);
  assert.equal(auditHasIntegrityFailure(report), false);
  assert.match(formatAuditReport(report), /items\/messages: 3\/1/u);
});

test("recommendation audit includes candidate preference DB statistics and integrity", () => {
  const report = auditRecommendationData({
    history: { items: [] },
    sentMessages: { messages: [] },
    candidatePreferences: {
      version: 1,
      responses: [{
        responseId: "R1",
        respondentId: "12345678-1234-5abc-adef-123456789abc",
        channel: "D123",
        messageTs: "100.1",
        mealType: "저녁",
        source: "manual-private-test",
        submittedAt: "2026-07-14T00:00:00.000Z",
        ratings: [
          { category: "도시락", restaurant: "한식집", menu: "제육", rating: 5 },
          { category: "중식", restaurant: "중식집", menu: "짬뽕", rating: 3 },
          { category: "돈까스", restaurant: "일식집", menu: "돈카츠", rating: 1 }
        ]
      }]
    }
  });
  assert.equal(report.totals.candidatePreferenceResponses, 1);
  assert.equal(report.totals.candidatePreferenceRatings, 3);
  assert.equal(report.candidatePreferences.ratingDistribution[5], 1);
  assert.equal(report.candidatePreferences.excludedPrivateTestResponses, 1);
  assert.equal(report.candidatePreferences.excludedNonLearningResponses, 1);
  assert.equal(auditHasIntegrityFailure(report), false);
});

test("recommendation audit strict integrity detects malformed preference data", () => {
  const report = auditRecommendationData({
    history: { items: [] },
    sentMessages: { messages: [] },
    candidatePreferences: { version: 1, responses: [{ responseId: "R1", ratings: [] }] }
  });
  assert.match(report.integrity.candidatePreferenceError, /Slack channel/u);
  assert.equal(auditHasIntegrityFailure(report), true);
});

test("recommendation audit binds learning surveys to the exact retained recommendation group", () => {
  const historyItems = [
    recommendation(),
    recommendation({ restaurant: "중식집", menu: "짬뽕", category: "중식" }),
    recommendation({ restaurant: "일식집", menu: "돈카츠", category: "돈까스" })
  ];
  const response = {
    responseId: "R-SCHEDULED",
    respondentId: "12345678-1234-5abc-adef-123456789abc",
    channel: "C123",
    messageTs: "100.1",
    mealType: "점심",
    source: "scheduled-codex-cli",
    submittedAt: "2026-07-11T00:00:00.000Z",
    ratings: historyItems.map(({ category, restaurant, menu }) => ({ category, restaurant, menu, rating: 5 }))
  };
  const base = {
    history: { items: historyItems },
    sentMessages: { messages: [{ channel: "C123", ts: "100.1" }] },
    candidatePreferences: { version: 1, responses: [response] },
    now: new Date("2026-07-12T00:00:00.000Z")
  };
  assert.equal(auditHasIntegrityFailure(auditRecommendationData(base)), false);
  const mismatched = structuredClone(base);
  mismatched.candidatePreferences.responses[0].ratings[0].menu = "조작된 메뉴";
  const mismatchReport = auditRecommendationData(mismatched);
  assert.equal(mismatchReport.integrity.candidatePreferenceMismatches.length, 1);
  assert.equal(auditHasIntegrityFailure(mismatchReport), true);
  const orphaned = structuredClone(base);
  orphaned.history.items = [];
  orphaned.sentMessages.messages = [];
  const orphanReport = auditRecommendationData(orphaned);
  assert.equal(orphanReport.integrity.candidatePreferenceOrphans.length, 1);
  assert.equal(auditHasIntegrityFailure(orphanReport), true);
});

test("recommendation audit unifies embedded and separated restaurant branches", () => {
  const historyItems = [
    recommendation({ restaurant: "더 담다 전북대점", menu: "흑돼지인생돈까스" }),
    recommendation({ restaurant: "중식집", menu: "짬뽕", category: "중식" }),
    recommendation({ restaurant: "일식집", menu: "돈카츠", category: "돈까스" })
  ];
  const ratings = historyItems.map(({ category, restaurant, menu }, index) => ({
    category,
    restaurant: index === 0 ? "더 담다" : restaurant,
    ...(index === 0 ? { branch: "전북대점" } : {}),
    menu,
    rating: 5
  }));
  const report = auditRecommendationData({
    history: { items: historyItems },
    sentMessages: { messages: [{ channel: "C123", ts: "100.1" }] },
    candidatePreferences: {
      version: 1,
      responses: [{
        responseId: "R-BRANCH",
        respondentId: "12345678-1234-5abc-adef-123456789abc",
        channel: "C123",
        messageTs: "100.1",
        mealType: "점심",
        source: "scheduled-codex-cli",
        submittedAt: "2026-07-11T00:00:00.000Z",
        ratings
      }]
    },
    now: new Date("2026-07-12T00:00:00.000Z")
  });
  assert.equal(report.integrity.candidatePreferenceMismatches.length, 0);
  assert.equal(report.totals.uniqueRestaurants, 3);
});

test("recommendation audit detects incomplete history groups", () => {
  const report = auditRecommendationData({
    history: { items: [recommendation()] },
    sentMessages: { messages: [] },
    now: new Date("2026-07-12T00:00:00.000Z")
  });
  assert.equal(auditHasIntegrityFailure(report), true);
});

test("recommendation audit rejects a future enforcement cutoff instead of auditing zero records", () => {
  const report = auditRecommendationData({
    history: { items: [] },
    sentMessages: { messages: [] },
    now: new Date("2026-07-12T00:00:00.000Z"),
    policyEnforcementSince: "2099-01-01T00:00:00.000Z"
  });
  assert.deepEqual(report.integrity.enforcementConfigurationErrors, [
    "policy enforcement timestamp is in the future"
  ]);
  assert.equal(auditHasIntegrityFailure(report), true);
});

test("recommendation audit rejects cross-store timestamp causality reversal", () => {
  const messageTs = String(Date.parse("2026-07-10T01:00:00.000Z") / 1000);
  const report = auditRecommendationData({
    history: { items: [
      recommendation({ messageTs, recommendedAt: "2026-07-10T00:00:00.000Z" }),
      recommendation({ messageTs, restaurant: "중식집", menu: "짬뽕", category: "중식", recommendedAt: "2026-07-10T00:00:00.000Z" }),
      recommendation({ messageTs, restaurant: "일식집", menu: "돈카츠", category: "돈까스", recommendedAt: "2026-07-10T00:00:00.000Z" })
    ] },
    sentMessages: { messages: [{
      channel: "C123",
      ts: messageTs,
      sentAt: "2026-07-10T01:00:00.000Z"
    }] },
    now: new Date("2026-07-12T00:00:00.000Z")
  });
  assert.ok(report.integrity.temporalCausalityViolations.length > 0);
  assert.equal(auditHasIntegrityFailure(report), true);
});

test("recommendation audit fails shared main ingredients only after policy enforcement", () => {
  const history = {
    items: [
      recommendation({ category: "치킨", restaurant: "후켄", menu: "순살간장치킨", recommendedAt: "2026-07-14T09:01:00.000Z" }),
      recommendation({ category: "버거", restaurant: "롯데리아", menu: "새우버거", recommendedAt: "2026-07-14T09:01:00.000Z" }),
      recommendation({ category: "도시락", restaurant: "본도시락", menu: "오리엔탈 깻잎 치킨 도시락", recommendedAt: "2026-07-14T09:01:00.000Z" })
    ]
  };
  const historical = auditRecommendationData({
    history,
    sentMessages: { messages: [{ channel: "C123", ts: "100.1" }] },
    choiceDiversityEnforcementSince: "2026-07-14T10:00:00.000Z"
  });
  assert.equal(historical.choiceDiversity.allViolationEvents, 1);
  assert.equal(historical.choiceDiversity.enforcedViolationEvents, 0);
  assert.equal(auditHasIntegrityFailure(historical), false);

  const enforced = auditRecommendationData({
    history,
    sentMessages: { messages: [{ channel: "C123", ts: "100.1" }] },
    choiceDiversityEnforcementSince: "2026-07-14T09:00:00.000Z"
  });
  assert.equal(enforced.choiceDiversity.enforcedViolationEvents, 1);
  assert.equal(auditHasIntegrityFailure(enforced), true);
});

test("recommendation audit fails cooldown violations only after policy enforcement", () => {
  const firstAt = "2026-07-10T00:00:00.000Z";
  const repeatedAt = "2026-07-11T00:00:00.000Z";
  const history = {
    items: [
      recommendation({ recommendedAt: firstAt, ingredientFamilies: ["other"] }),
      recommendation({ recommendedAt: firstAt, restaurant: "중식집", menu: "짬뽕", category: "중식", ingredientFamilies: ["other"] }),
      recommendation({ recommendedAt: firstAt, restaurant: "일식집", menu: "돈카츠", category: "돈까스", ingredientFamilies: ["other"] }),
      recommendation({ messageTs: "100.2", recommendedAt: repeatedAt, menu: "제육비빔밥", ingredientFamilies: ["other"] }),
      recommendation({ messageTs: "100.2", recommendedAt: repeatedAt, restaurant: "피자집", menu: "치즈피자", category: "피자", ingredientFamilies: ["other"] }),
      recommendation({ messageTs: "100.2", recommendedAt: repeatedAt, restaurant: "버거집", menu: "치즈버거", category: "버거", ingredientFamilies: ["other"] })
    ]
  };
  const sentMessages = { messages: [
    { channel: "C123", ts: "100.1" },
    { channel: "C123", ts: "100.2" }
  ] };
  const historical = auditRecommendationData({
    history,
    sentMessages,
    now: new Date("2026-07-13T00:00:00.000Z"),
    policyEnforcementSince: "2026-07-12T00:00:00.000Z"
  });
  assert.equal(historical.cooldowns.allViolationEvents, 1);
  assert.equal(historical.cooldowns.enforcedViolationEvents, 0);
  assert.equal(auditHasIntegrityFailure(historical), false);

  const enforced = auditRecommendationData({
    history,
    sentMessages,
    now: new Date("2026-07-13T00:00:00.000Z"),
    policyEnforcementSince: repeatedAt
  });
  assert.equal(enforced.cooldowns.enforcedViolationEvents, 1);
  assert.equal(enforced.cooldowns.enforcedViolations[0].kind, "restaurant");
  assert.equal(auditHasIntegrityFailure(enforced), true);
  assert.match(formatAuditReport(enforced), /cooldown violations: all=1, recent=1, enforced=1/u);
});
