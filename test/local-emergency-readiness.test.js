import test from "node:test";
import assert from "node:assert/strict";
import {
  assessLocalEmergencyReadiness,
  hasSequentialLocalEmergencyReadiness,
  localEmergencyMealSlots
} from "../src/local-emergency-readiness.js";
import { candidateIdFor } from "../src/verified-candidates.js";

const START = new Date("2026-07-20T00:00:00.000Z"); // Monday 09:00 KST
const EXPIRES = new Date("2026-07-21T00:00:00.000Z");
const HOLIDAYS = ["2026-01-01"];

const candidateDefinitions = [
  ["구이", "소담구이", "숯불 소갈비", "beef"],
  ["중식", "마라정원", "양고기마라탕", "lamb"],
  ["치킨", "바삭치킨", "순살치킨", "poultry"],
  ["돈까스", "카츠공방", "등심돈카츠", "pork"],
  ["회/해물", "바다식탁", "광어 사시미", "seafood"],
  ["찜/탕", "전골마을", "곱창전골", "offal"]
];

function candidates() {
  return candidateDefinitions.map(([category, restaurant, menu, family], index) => {
    const candidate = {
    category,
    restaurant,
    branch: "전북대점",
    address: `전주시 덕진구 테스트로 ${index + 1}`,
    latitude: 35.847 + index * 0.001,
    longitude: 127.134 + index * 0.001,
    menu,
    ingredientFamilies: [family],
    priceText: `${index + 9},000원`,
    priceChannel: "store",
    priceCheckedAt: "2026-07-19T23:00:00.000Z",
    deliveryStatus: "likely",
    deliveryCheckedAt: "2026-07-19T23:00:00.000Z",
    priceEvidenceUrl: `https://example.com/price/${index}`,
    deliveryEvidenceUrl: `https://example.com/delivery/${index}`,
    evidenceVerifiedAt: "2026-07-19T23:00:00.000Z",
    evidenceVerification: "deterministic-html",
      comment: "진한 양념과 알찬 재료가 따뜻한 밥과 조화롭게 어우러져, 한 끼로 든든하게 드시기 좋습니다."
    };
    return { ...candidate, candidateId: candidateIdFor(candidate) };
  });
}

test("24-hour emergency scheduling identifies both meals that must be covered", () => {
  const slots = localEmergencyMealSlots({ now: START, expiresAt: EXPIRES, holidayDates: HOLIDAYS });
  assert.deepEqual(slots.map((slot) => [slot.meal, slot.at.toISOString()]), [
    ["lunch", "2026-07-20T02:25:00.000Z"],
    ["dinner", "2026-07-20T08:25:00.000Z"]
  ]);
  assert.throws(
    () => localEmergencyMealSlots({
      now: START,
      expiresAt: new Date(START.getTime() + 24 * 60 * 60 * 1000 + 2000),
      holidayDates: HOLIDAYS
    }),
    /at most 24 hours/u
  );
  assert.throws(
    () => localEmergencyMealSlots({ now: START, expiresAt: EXPIRES, holidayDates: [] }),
    /does not cover 2026/u
  );
});

test("current catch-up meal remains in readiness capacity instead of being skipped as past", () => {
  const now = new Date("2026-07-20T02:26:00.000Z");
  const slots = localEmergencyMealSlots({
    now,
    expiresAt: new Date("2026-07-20T23:00:00.000Z"),
    holidayDates: HOLIDAYS,
    currentMeal: "lunch"
  });
  assert.deepEqual(slots.map((slot) => slot.meal), ["lunch", "dinner"]);
  assert.equal(slots[0].at.toISOString(), now.toISOString());
});

test("a catch-up activation clamps a nominal 24-hour lease before an untested third send", () => {
  const now = new Date("2026-07-20T02:26:00.000Z"); // Monday 11:26 KST
  assert.throws(() => localEmergencyMealSlots({
    now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    holidayDates: HOLIDAYS,
    currentMeal: "lunch"
  }), /more than two scheduled meals/u);

  const clamped = localEmergencyMealSlots({
    now,
    // Tuesday 11:25 KST is excluded by the strict `at < expiresAt` boundary.
    expiresAt: new Date("2026-07-21T02:25:00.000Z"),
    holidayDates: HOLIDAYS,
    currentMeal: "lunch"
  });
  assert.deepEqual(clamped.map((slot) => slot.meal), ["lunch", "dinner"]);
});

test("sequential readiness is robust to any first diverse recommendation set", () => {
  const pool = candidates();
  assert.equal(hasSequentialLocalEmergencyReadiness(pool, 2), true);
  assert.equal(hasSequentialLocalEmergencyReadiness(pool.slice(0, 5), 2), false);
  assert.equal(hasSequentialLocalEmergencyReadiness(pool.slice(0, 3), 1), true);
});

test("a robust six-candidate refresh leaves an immediate standby after a delivered triple", () => {
  const pool = candidates();
  const delivered = pool.slice(0, 3).map((candidate, index) => ({
    ...candidate,
    recommendedAt: "2026-07-20T00:00:00.000Z",
    channel: "CTEST",
    messageTs: `200.${index}`,
    mealType: "점심",
    source: "scheduled-cache"
  }));
  const now = new Date("2026-07-20T00:01:00.000Z");
  const expiresAt = new Date(now.getTime() + 1);
  for (const currentMeal of ["lunch", "dinner"]) {
    const result = assessLocalEmergencyReadiness({
      now,
      expiresAt,
      holidayDates: [],
      currentMeal,
      verifiedCandidates: pool,
      history: { version: 1, items: delivered },
      mealEvents: { version: 1, events: [] }
    });
    assert.equal(result.ready, true, `${currentMeal} must retain one viable reserve set`);
    assert.equal(result.eligibleCandidateCount, 3);
  }

  const depleted = assessLocalEmergencyReadiness({
    now,
    expiresAt,
    holidayDates: [],
    currentMeal: "lunch",
    verifiedCandidates: pool.slice(0, 5),
    history: { version: 1, items: delivered },
    mealEvents: { version: 1, events: [] }
  });
  assert.equal(depleted.ready, false);
  assert.equal(depleted.eligibleCandidateCount, 2);
});

test("fresh but cooldown-exhausted snapshot is rejected before emergency activation", () => {
  const pool = candidates();
  const ready = assessLocalEmergencyReadiness({
    now: START,
    expiresAt: EXPIRES,
    holidayDates: HOLIDAYS,
    verifiedCandidates: pool,
    history: { version: 1, items: [] },
    mealEvents: { version: 1, events: [] }
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.scheduledSendCount, 2);
  assert.equal(ready.eligibleCandidateCount, 6);

  const exhausted = assessLocalEmergencyReadiness({
    now: START,
    expiresAt: EXPIRES,
    holidayDates: HOLIDAYS,
    verifiedCandidates: pool,
    history: {
      version: 1,
      items: pool.map((candidate, index) => ({
        ...candidate,
        recommendedAt: "2026-07-19T23:30:00.000Z",
        channel: "CTEST",
        messageTs: `100.${index}`,
        mealType: "점심",
        source: "scheduled-cache"
      }))
    },
    mealEvents: { version: 1, events: [] }
  });
  assert.equal(exhausted.ready, false);
  assert.equal(exhausted.eligibleCandidateCount, 0);
  assert.match(exhausted.detail, /cannot safely cover 2/u);
});

test("candidate evidence must remain current through the last meal in the lease", () => {
  const staleByDinner = candidates().map((candidate) => ({
    ...candidate,
    priceCheckedAt: "2026-07-16T08:00:00.000Z",
    deliveryCheckedAt: "2026-07-16T08:00:00.000Z",
    evidenceVerifiedAt: "2026-07-16T08:00:00.000Z"
  }));
  const result = assessLocalEmergencyReadiness({
    now: START,
    expiresAt: EXPIRES,
    holidayDates: HOLIDAYS,
    verifiedCandidates: staleByDinner,
    history: { version: 1, items: [] },
    mealEvents: { version: 1, events: [] }
  });
  assert.equal(result.ready, false);
  assert.equal(result.eligibleCandidateCount, 0);
});

test("Friday evidence fails closed when it expires before Monday dinner", () => {
  const now = new Date("2026-08-30T10:00:00.000Z"); // Sunday 19:00 KST.
  const fridayCandidates = candidates().map((candidate) => ({
    ...candidate,
    priceCheckedAt: "2026-08-28T06:00:00.000Z",
    deliveryCheckedAt: "2026-08-28T06:00:00.000Z",
    evidenceVerifiedAt: "2026-08-28T06:00:00.000Z"
  }));
  const result = assessLocalEmergencyReadiness({
    now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    holidayDates: HOLIDAYS,
    verifiedCandidates: fridayCandidates,
    history: { version: 1, items: [] },
    mealEvents: { version: 1, events: [] }
  });
  assert.equal(result.ready, false);
  assert.equal(result.scheduledSendCount, 2);
  assert.equal(result.eligibleCandidateCount, 0);
  assert.equal(result.slots.at(-1).at, "2026-08-31T08:25:00.000Z");
});
