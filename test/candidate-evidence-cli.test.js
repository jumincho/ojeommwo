import test from "node:test";
import assert from "node:assert/strict";
import { evidenceCheckHasReadiness } from "../scripts/check-candidate-evidence.js";

function candidate(category, restaurant, menu, ingredient) {
  return {
    category,
    restaurant,
    menu,
    ingredientFamilies: [ingredient]
  };
}

test("candidate evidence CLI fails closed unless a diverse three-menu set remains", () => {
  assert.equal(evidenceCheckHasReadiness([]), false);
  assert.equal(evidenceCheckHasReadiness([
    candidate("한식", "가게1", "메뉴1", "pork"),
    candidate("한식", "가게2", "메뉴2", "beef"),
    candidate("일식", "가게3", "메뉴3", "seafood")
  ]), false);
  assert.equal(evidenceCheckHasReadiness([
    candidate("한식", "가게1", "메뉴1", "pork"),
    candidate("일식", "가게2", "메뉴2", "seafood"),
    candidate("중식", "가게3", "메뉴3", "beef")
  ]), true);
});
