/**
 * Category selection starts as "all". The first category click narrows to that
 * category, subsequent clicks add or remove categories, and clicking the last
 * remaining category returns to the all-categories view.
 *
 * @param {Set<string>} current
 * @param {string} category
 * @param {string[]} allCategoryIds
 */
export function nextCategorySelection(current, category, allCategoryIds) {
  const all = [...new Set(allCategoryIds)];
  const allowed = new Set(all);
  if (!allowed.has(category)) return new Set(all);

  const selected = new Set([...current].filter((item) => allowed.has(item)));
  if (selected.size === all.length || selected.size === 0) return new Set([category]);

  if (!selected.has(category)) {
    selected.add(category);
    return selected;
  }

  if (selected.size === 1) return new Set(all);
  selected.delete(category);
  return selected;
}
