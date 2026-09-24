import test from "node:test";
import assert from "node:assert/strict";
import {
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

