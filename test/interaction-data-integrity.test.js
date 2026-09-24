import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCandidatePreferenceStore,
  validateCoffeeParticipationStore
} from "../src/interaction-data-integrity.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

function preference(overrides = {}) {
  return {
    responseId: "R1",
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt: "2026-07-14T00:00:00.000Z",
    ratings: [
      { category: "도시락", restaurant: "밥집", menu: "제육", rating: 5 },
      { category: "중식", restaurant: "반점", menu: "짬뽕", rating: 3 },
      { category: "돈까스", restaurant: "카츠집", menu: "돈카츠", rating: 1 }
    ],
    ...overrides
  };
}

test("interaction DB integrity accepts complete privacy-preserving records", () => {
  assert.deepEqual(
    validateCandidatePreferenceStore({ version: 1, responses: [preference()] }),
    { responseCount: 1, ratingCount: 3 }
  );
  assert.deepEqual(validateCoffeeParticipationStore({
    version: 1,
    messages: [{
      channel: "C123ABC",
      messageTs: "123.456",
      userIds: ["U111AAA", "U222BBB"],
      updatedAt: "2026-07-14T00:00:00.000Z"
    }]
  }), { messageCount: 1, participantCount: 2 });
  assert.deepEqual(validateCoffeeParticipationStore({
    version: 1,
    messages: [{
      channel: "C123ABC",
      messageTs: "999.999",
      userIds: [],
      updatedAt: "2026-07-14T01:00:00.000Z"
    }]
  }), { messageCount: 1, participantCount: 0 });
});

test("candidate preference integrity rejects raw identities and incomplete ratings", () => {
  assert.throws(
    () => validateCandidatePreferenceStore({ version: 1, responses: [preference({ userId: "U111AAA" })] }),
    /prohibited raw user/u
  );
  assert.throws(
    () => validateCandidatePreferenceStore({ responses: [preference({ ratings: preference().ratings.slice(0, 2) })] }),
    /version 1/u
  );
  assert.throws(
    () => validateCandidatePreferenceStore({ version: 1, responses: [preference({ ratings: preference().ratings.slice(0, 2) })] }),
    /exactly three/u
  );
});

test("candidate preference integrity validates optional pseudonymous identity and calendar date", () => {
  assert.deepEqual(validateCandidatePreferenceStore({ version: 1, responses: [preference({
    respondentId: "12345678-1234-5abc-adef-123456789abc",
    date: "2026-07-14"
  })] }), { responseCount: 1, ratingCount: 3 });
  assert.throws(
    () => validateCandidatePreferenceStore({ version: 1, responses: [preference({ respondentId: "U123ABC" })] }),
    /invalid pseudonymous/u
  );
  assert.throws(
    () => validateCandidatePreferenceStore({ version: 1, responses: [preference({ date: "2026-02-31" })] }),
    /invalid date/u
  );
});

test("candidate preference integrity accepts identity-bound model category adjudication only", () => {
  const record = preference();
  record.ratings[0] = stampCategoryAdjudication(record.ratings[0], {
    category: record.ratings[0].category,
    now: new Date("2026-07-14T00:00:00.000Z"),
  });
  assert.deepEqual(
    validateCandidatePreferenceStore({ version: 1, responses: [record] }),
    { responseCount: 1, ratingCount: 3 }
  );
  record.ratings[0].restaurant = "변조 식당";
  assert.throws(
    () => validateCandidatePreferenceStore({ version: 1, responses: [record] }),
    /invalid category adjudication/u
  );
});

test("coffee participation integrity rejects duplicate users and message targets", () => {
  const message = {
    channel: "D123ABC",
    messageTs: "123.456",
    userIds: ["U111AAA", "U111AAA"],
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
  assert.throws(
    () => validateCoffeeParticipationStore({ version: 1, messages: [message] }),
    /invalid or duplicate Slack users/u
  );
  assert.throws(
    () => validateCoffeeParticipationStore({ version: 1, messages: [
      { ...message, userIds: ["U111AAA"] },
      { ...message, userIds: ["U222BBB"] }
    ] }),
    /targets must be unique/u
  );
});

test("interaction timestamps enforce five-minute skew and monotonic preference revisions", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  assert.deepEqual(validateCandidatePreferenceStore({
    version: 1,
    responses: [preference({ submittedAt: "2026-07-14T00:05:00.000Z" })]
  }, { now }), { responseCount: 1, ratingCount: 3 });
  assert.throws(() => validateCandidatePreferenceStore({
    version: 1,
    responses: [preference({ submittedAt: "2026-07-14T00:05:00.001Z" })]
  }, { now }), /more than five minutes in the future/u);
  assert.throws(() => validateCandidatePreferenceStore({
    version: 1,
    responses: [preference({
      createdAt: "2026-07-14T00:00:02.000Z",
      submittedAt: "2026-07-14T00:00:01.000Z",
      updatedAt: "2026-07-14T00:00:03.000Z"
    })]
  }, { now }), /invalid timestamp order/u);
  assert.throws(() => validateCoffeeParticipationStore({
    version: 1,
    messages: [{
      channel: "C123ABC",
      messageTs: "123.456",
      userIds: [],
      updatedAt: "2026-07-14T00:05:00.001Z"
    }]
  }, { now }), /more than five minutes in the future/u);
});
