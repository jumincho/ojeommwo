import test from "node:test";
import assert from "node:assert/strict";
import {
  mealSubmissionSlotKey,
  isLearningHistoryItem,
  isLearningMealEvent
} from "../src/history-policy.js";

test("terminal unverified meal input is excluded from every learning policy", () => {
  const item = {
    respondentId: "respondent-unverified",
    source: "scheduled-cache",
    normalizationStatus: "unverified"
  };
  assert.equal(isLearningMealEvent(item), false);
  assert.equal(isLearningHistoryItem(item), false);
});


test("private meal rehearsal has a separate submission slot without weakening production deduplication", () => {
  const event = { respondentId: "respondent", date: "2026-07-14", mealType: "점심", source: "scheduled-cache" };
  assert.notEqual(mealSubmissionSlotKey(event), mealSubmissionSlotKey({ ...event, source: "manual-private-test" }));
  assert.equal(mealSubmissionSlotKey(event), mealSubmissionSlotKey({ ...event, source: "scheduled-live" }));
  assert.equal(mealSubmissionSlotKey(event), mealSubmissionSlotKey({ ...event, source: undefined }));
  assert.equal(mealSubmissionSlotKey({ ...event, respondentId: undefined }), "");
  assert.equal(isLearningMealEvent({ ...event, source: "manual-private-test", normalizationStatus: "verified" }), false);
  assert.equal(isLearningHistoryItem({ ...event, source: "manual-private-test", normalizationStatus: "verified" }), false);
});
