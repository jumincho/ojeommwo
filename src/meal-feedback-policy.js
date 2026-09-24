export function hasContradictoryPreferenceFeedback(ratingValue, tags = []) {
  const rating = ratingValue === null || ratingValue === undefined || ratingValue === ""
    ? null
    : Number(ratingValue);
  const selectedTags = new Set(Array.isArray(tags) ? tags : []);
  return Number.isFinite(rating) && (
    (rating <= 2 && selectedTags.has("재주문"))
    || (rating >= 4 && selectedTags.has("다시 안 먹기"))
  );
}
