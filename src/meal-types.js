const MEAL_ALIASES = new Map([
  ["lunch", "점심"],
  ["점심", "점심"],
  ["dinner", "저녁"],
  ["저녁", "저녁"],
  ["meal", "식사"],
  ["식사", "식사"]
]);

export const MEAL_TYPES = Object.freeze({
  lunch: "점심",
  dinner: "저녁",
  generic: "식사"
});

export function normalizeMealType(value, { allowGeneric = true } = {}) {
  const normalized = MEAL_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!normalized || (!allowGeneric && normalized === MEAL_TYPES.generic)) {
    const allowed = allowGeneric
      ? "lunch, dinner, meal, 점심, 저녁, or 식사"
      : "lunch, dinner, 점심, or 저녁";
    throw new Error(`meal must be ${allowed}`);
  }
  return normalized;
}
