export function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeKey(value) {
  return cleanText(value).toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
}

const BRANCH_SUFFIX_PATTERN = /\s*(금암전북대점|전주덕진DT점|전북대정문점|전주금암점|전주인후점|덕진광장로점|전주\s*전북대점|전북대점|전주점|본점)$/iu;
const BRANCH_NAME_ALIASES = Object.freeze(new Map([
  ["전주전북대점", "전북대점"],
  ["전주전북대", "전북대점"],
  ["전북대", "전북대점"],
]));
const RESTAURANT_NAME_ALIASES = Object.freeze(new Map([
  ["고씨네카레", "고씨네"],
  ["춘리마라탕", "춘리마라탕"],
  ["the담다", "더 담다"],
  ["더담다", "더 담다"],
  ["프랭크버거", "프랭크버거"],
  ["홍콩반점0410", "홍콩반점0410"],
  ["피자스쿨", "피자스쿨"],
]));
const MENU_NAME_ALIASES = Object.freeze(new Map([
  ["cozyburger", "코지버거"],
]));

// Restaurant-scoped aliases are intentionally evidence-audited and narrow.
// A bare dish name can be legitimate at another restaurant, so these must
// never become global menu aliases. They collapse historical/current labels
// without changing the identity of unrelated menus.
const RESTAURANT_MENU_NAME_ALIASES = Object.freeze(new Map([
  ["광장수산\u001f광어", "광어(소)"],
  ["로충칭마라탕\u001f마라탕", "마라탕 1인"],
]));

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function canonicalizeBranchName(value) {
  const branch = cleanText(value);
  return BRANCH_NAME_ALIASES.get(normalizeKey(branch)) || branch;
}

export function canonicalizeRestaurantName(value) {
  const restaurant = cleanText(value);
  return RESTAURANT_NAME_ALIASES.get(normalizeKey(restaurant)) || restaurant;
}

export function canonicalizeRestaurantIdentity({ restaurant = "", branch = "" } = {}) {
  const rawRestaurant = cleanText(restaurant);
  const rawBranch = cleanText(branch);
  let base = rawRestaurant;
  let detectedBranch = rawBranch;

  const suffixMatch = rawRestaurant.match(BRANCH_SUFFIX_PATTERN);
  if (suffixMatch) {
    const suffixBranch = cleanText(suffixMatch[1]);
    if (!rawBranch
        || canonicalizeBranchName(suffixBranch) === canonicalizeBranchName(rawBranch)) {
      base = cleanText(rawRestaurant.slice(0, suffixMatch.index));
      detectedBranch = rawBranch || suffixBranch;
    }
  } else if (rawBranch) {
    base = cleanText(rawRestaurant.replace(new RegExp(`\\s*${escapeRegExp(rawBranch)}$`, "iu"), ""));
  }

  return {
    restaurant: canonicalizeRestaurantName(base || rawRestaurant),
    branch: canonicalizeBranchName(detectedBranch),
  };
}

export function normalizeRestaurantKey(value) {
  // Historical rows sometimes embedded the branch suffix in `restaurant`,
  // while current rows store it separately. Restaurant-level policy is
  // brand-wide, so both representations must share one identity key.
  const identity = canonicalizeRestaurantIdentity({ restaurant: value });
  return normalizeKey(identity.restaurant);
}

// Keep display text and comparison identity separate. Restaurant menus often
// preserve brand-specific spellings such as "돈까스" or "모밀", while the
// recommendation, cooldown, and taste algorithms must not treat harmless
// orthographic variants as different dishes.
const MENU_KEY_ORTHOGRAPHY = Object.freeze([
  [/후토마끼/gu, "후토마키"],
  [/돈까스/gu, "돈가스"],
  [/모밀/gu, "메밀"],
  [/쭈꾸미/gu, "주꾸미"],
  [/후라이드/gu, "프라이드"],
  [/야끼/gu, "야키"],
]);

// A translated subtitle is not a second menu. Strip only semantically exact
// bilingual pairs; sizes, product editions and arbitrary English suffixes stay.
const MENU_TRANSLATIONS = new Map([
  ["spicypho", "매운쌀국수"],
  ["brisketpho", "양지쌀국수"],
  ["decklepho", "차돌쌀국수"],
  ["bulgogipho", "불고기쌀국수"],
  ["buncha", "분짜"],
  ["friedrice", "볶음밥"],
  ["smokyporkrice", "껌팃헤오"],
  ["bulgogipizza", "불고기피자"],
]);

function withoutKnownMenuTranslation(value) {
  const text = cleanText(value);
  const match = text.match(/^(.+?[가-힣])\s*(?:\(\s*)?([a-z]+(?:[ -]+[a-z]+)+)\s*\)?$/iu);
  if (!match) return text;
  return MENU_TRANSLATIONS.get(normalizeKey(match[2])) === normalizeKey(match[1])
    ? cleanText(match[1]) : text;
}

export function normalizeMenuKey(value) {
  const key = MENU_KEY_ORTHOGRAPHY.reduce(
    (key, [pattern, replacement]) => key.replace(pattern, replacement),
    normalizeKey(withoutKnownMenuTranslation(value))
  );
  return normalizeKey(MENU_NAME_ALIASES.get(key) || key);
}

export function canonicalizeMenuName(value) {
  let menu = withoutKnownMenuTranslation(value).replace(/후토마끼/gu, "후토마키");
  // This is an observed legacy split in the operating history. Canonicalize
  // the visible label as well as its key so old and new records are presented
  // as one menu without rewriting unrelated official brand spellings.
  menu = menu.replace(/([\p{L}\p{N}])후토마키/gu, "$1 후토마키");
  menu = MENU_NAME_ALIASES.get(normalizeKey(menu)) || menu;
  if (normalizeKey(menu) === "빅맥세트") return "빅맥 세트";
  return menu;
}

export function canonicalizeMenuForRestaurant({ restaurant = "", menu = "" } = {}) {
  const canonicalMenu = canonicalizeMenuName(menu);
  const identity = canonicalizeRestaurantIdentity({ restaurant });
  const scopedKey = `${normalizeKey(identity.restaurant)}\u001f${normalizeMenuKey(canonicalMenu)}`;
  return RESTAURANT_MENU_NAME_ALIASES.get(scopedKey) || canonicalMenu;
}

export function daysSince(isoDate, now = new Date()) {
  const time = Date.parse(isoDate || "");
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - time) / (24 * 60 * 60 * 1000);
}
