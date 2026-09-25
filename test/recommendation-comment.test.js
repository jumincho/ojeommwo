import test from "node:test";
import assert from "node:assert/strict";
import { recommendationCommentForDisplay } from "../src/recommendation-comment.js";

test("generic Levant kebab does not claim an unrecorded protein option", () => {
  const generic = { restaurant: "레반트", menu: "케밥", category: "아시안", comment: "담백하게 구운 양고기와 채소의 풍미가 어우러져 든든한 한 끼입니다." };
  assert.doesNotMatch(recommendationCommentForDisplay(generic), /양고기/u);
  assert.match(recommendationCommentForDisplay({ ...generic, menu: "양고기 케밥" }), /양고기/u);
  assert.match(recommendationCommentForDisplay({ ...generic, restaurant: "다른 식당" }), /양고기/u);
});
