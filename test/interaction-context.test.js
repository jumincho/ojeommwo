import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeMealInteractionContext,
  encodeMealInteractionContext,
  mealContextForBlockAction
} from "../src/interaction-context.js";
import { candidateIdFor } from "../src/verified-candidates.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

const recommendations = [
  { candidateId: "a", category: "도시락", restaurant: "밥집", menu: "제육" },
  { candidateId: "b", category: "중식", restaurant: "반점", menu: "짬뽕" },
  { candidateId: "c", category: "돈까스", restaurant: "카츠집", menu: "돈카츠" }
];

test("embedded interaction context supports DM previews without writing history", () => {
  const value = encodeMealInteractionContext({ mealType: "dinner", source: "manual-private-test", recommendations });
  const context = mealContextForBlockAction({
    channel: { id: "D123ABC" },
    message: { ts: "123.456" },
    actions: [{ value }]
  }, { history: { version: 1, items: [] } });
  assert.equal(context.mealType, "저녁");
  assert.equal(context.source, "manual-private-test");
  assert.equal(context.recommendations.length, 3);
  assert.deepEqual(
    decodeMealInteractionContext(value).recommendations,
    recommendations.map((item) => ({ ...item, candidateId: candidateIdFor(item) }))
  );
});

test("stored history remains compatible with legacy buttons that have no context", () => {
  const history = {
    version: 1,
    items: recommendations.map((item) => ({
      ...item,
      channel: "C123ABC",
      messageTs: "123.456",
      mealType: "점심",
      source: "scheduled-cache"
    }))
  };
  const context = mealContextForBlockAction({
    channel: { id: "C123ABC" },
    message: { ts: "123.456" },
    actions: [{ value: "open" }]
  }, { history });
  assert.equal(context.mealType, "점심");
  assert.equal(context.recommendations[0].restaurant, "밥집");
});

test("embedded and historical interaction contexts preserve model category adjudication", () => {
  const adjudicated = stampCategoryAdjudication({
    category: "멕시칸",
    restaurant: "새로운식당",
    menu: "시그니처 보울",
  }, {
    category: "멕시칸",
    now: new Date("2026-07-14T00:00:00.000Z"),
  });
  const items = [adjudicated, recommendations[1], recommendations[2]];
  const value = encodeMealInteractionContext({ mealType: "점심", recommendations: items });
  assert.equal(decodeMealInteractionContext(value).recommendations[0].categoryAuthority, "model-adjudicated");

  const history = {
    version: 1,
    items: items.map((item) => ({
      ...item,
      channel: "C123ABC",
      messageTs: "123.456",
      mealType: "점심",
      source: "scheduled-cache",
    })),
  };
  const context = mealContextForBlockAction({
    channel: { id: "C123ABC" },
    message: { ts: "123.456" },
    actions: [{ value: "open" }],
  }, { history });
  assert.equal(context.recommendations[0].categoryAuthority, "model-adjudicated");
});

test("interaction context rejects branch-embedded aliases as duplicate restaurants", () => {
  assert.throws(() => encodeMealInteractionContext({
    mealType: "점심",
    recommendations: [
      { category: "돈까스", restaurant: "더 담다 전북대점", menu: "흑돼지인생돈까스" },
      { category: "돈까스", restaurant: "더 담다", branch: "전북대점", menu: "흑돼지인생돈까스" },
      { category: "중식", restaurant: "반점", menu: "짬뽕" }
    ]
  }), /duplicate recommendations/u);
});
