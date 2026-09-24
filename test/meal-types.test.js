import test from "node:test";
import assert from "node:assert/strict";
import { MEAL_TYPES, normalizeMealType } from "../src/meal-types.js";

test("normalizeMealType accepts English and Korean aliases", () => {
  assert.equal(normalizeMealType("LUNCH"), MEAL_TYPES.lunch);
  assert.equal(normalizeMealType("저녁"), MEAL_TYPES.dinner);
  assert.equal(normalizeMealType("meal"), MEAL_TYPES.generic);
});

test("normalizeMealType rejects unsupported or disallowed generic values", () => {
  assert.throws(() => normalizeMealType("brunch"), /meal must be/u);
  assert.throws(() => normalizeMealType("meal", { allowGeneric: false }), /meal must be/u);
});
