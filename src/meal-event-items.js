import { cleanText, normalizeMenuKey } from "./text.js";

function uniqueMenuNames(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeMenuKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Preserve line-separated menus before ordinary whitespace normalization.
export function cleanMealMenuInput(value, maxLength = 400) {
  return cleanText(String(value ?? "").replace(/\r\n?|\n/gu, ", ")).slice(0, maxLength);
}

export function splitMealMenuNames(value) {
  const parts = cleanMealMenuInput(value)
    .split(/\s*(?:,|，|;|；|\n|\s+(?:및|그리고)\s+|\s+·\s+)\s*/u)
    .map((item) => cleanText(item).slice(0, 120))
    .filter(Boolean);
  return uniqueMenuNames(parts).slice(0, 5);
}

export function mealMenuNamesForEvent(event = {}) {
  const explicit = Array.isArray(event.menus)
    ? event.menus.map((item) => cleanText(item).slice(0, 120)).filter(Boolean)
    : [];
  const names = explicit.length ? explicit : splitMealMenuNames(event.menu);
  return uniqueMenuNames(names).slice(0, 5);
}

export function expandMealEvents(events = []) {
  return (Array.isArray(events) ? events : []).flatMap((event) => {
    const menus = mealMenuNamesForEvent(event);
    const scale = menus.length ? 1 / menus.length : 1;
    return menus.map((menu) => ({ ...event, menu, menuSignalScale: scale }));
  });
}
