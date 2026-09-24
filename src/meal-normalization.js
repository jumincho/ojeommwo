import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT_DIR } from "./config.js";
import { getMealEvents, getRecommendationHistory, readJson } from "./storage.js";
import { cleanMealMenuInput, splitMealMenuNames } from "./meal-event-items.js";
import { isLearningMealEvent } from "./history-policy.js";
import {
  canonicalizeMenuForRestaurant,
  canonicalizeMenuName,
  canonicalizeRestaurantIdentity,
  cleanText,
  normalizeKey,
  normalizeMenuKey,
} from "./text.js";
import { isExcludedMealCandidate } from "./categories.js";
import { isSafeEvidenceUrl } from "./verified-candidates.js";

function cleaned(value, maxLength = 120) {
  return cleanText(value).slice(0, maxLength);
}

const OBVIOUS_PLACEHOLDER_KEYS = new Set([
  "na", "none", "null", "undefined", "test", "asdf", "qwer", "qwerty", "zxcv",
  "fake", "garbage", "junk", "random", "trash",
  "없음", "없다", "미정", "모름", "몰라", "모르겠음", "모르겠어요", "테스트",
  "쓰레기", "쓰레기값", "안알랴줌", "가나다라", "가나다라마바사", "라마바사", "몰루",
  "ㅇㅇ", "ㄴㄴ", "ㅁㄴㅇㄹ", "맛있는음식입니다", "먹은메뉴", "식당이름", "상호명", "메뉴명",
  // Bot-name and generic recommendation prompts identify neither a meal nor
  // a restaurant. Quarantine these before spending a model normalization run
  // so they cannot become terminal manual-review rows after repeated search.
  "오점뭐", "오늘뭐먹지", "오늘점심뭐먹지", "오늘저녁뭐먹지", "아무거나",
  "메뉴추천", "메뉴추천해줘", "추천해줘"
]);
const OBVIOUS_FILLER_SYLLABLES = /^(?:으+|음+|어+|아+|ㅇ+|ㄴ+|ㅋ+|ㅎ+|ㅠ+|ㅜ+)$/u;
const JAMO_ONLY_INPUT = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]+$/u;
const URI_OR_MARKUP_INPUT = /(?:\b[a-z][a-z0-9+.-]{1,31}:\/\/|\b(?:data|file|javascript|magnet|mailto|sms|tel|urn):|www\.|<[^>]*>)/iu;
const INSTRUCTION_OR_COMMAND_INPUT = /(?:ignore\s+(?:all\s+)?(?:previous|prior)|disregard\s+(?:all\s+)?(?:previous|prior)|system\s+prompt|developer\s+message|시스템\s*메시지|프롬프트|(?:이전|앞선|기존)\s*(?:의\s*)?(?:지시|명령).{0,16}(?:무시|잊|따르지)|환경\s*변수|비밀\s*키|api\s*key|(?:^|\s)(?:rm|curl|wget|powershell|cmd(?:\.exe)?|bash)\s+)/iu;
const LATIN_ONLY_INPUT = /^[a-z0-9][a-z0-9 '&+().,_/-]*$/iu;
const LATIN_GARBAGE_KEYS = new Set([
  "abc", "abcdef", "asdfgh", "dummy", "foobar", "hello", "helloworld", "ipsum",
  "lorem", "qazwsx", "qwertyuiop", "sample", "testmenu", "world", "zxcvbn", "zzzzx"
]);
const MENU_SEPARATOR = /\s*(?:,|，|;|；|\n|\s+(?:및|그리고)\s+|\s+·\s+)\s*/u;
const MEANINGFUL_ONE_CHARACTER_FOODS = new Set(["죽", "회", "밥", "면"]);

function isRepeatedGarbageKey(key) {
  const characters = [...key];
  for (let unitLength = 1; unitLength <= Math.min(4, Math.floor(characters.length / 2)); unitLength += 1) {
    if (characters.length % unitLength !== 0) continue;
    const unit = characters.slice(0, unitLength).join("");
    const repetitions = characters.length / unitLength;
    if (unit.repeat(repetitions) !== key) continue;
    if (OBVIOUS_PLACEHOLDER_KEYS.has(unit) && [...unit].length >= 3) return true;
    if (repetitions >= 3 && characters.length >= 6 && /^[a-z0-9]+$/u.test(key)) return true;
  }
  return false;
}

function menuInputSegments(value) {
  return cleanMealMenuInput(value)
    .split(MENU_SEPARATOR)
    .map((item) => cleaned(item, 120))
    .filter(Boolean);
}

function clearlyInvalidMealField(value, { kind = "menu" } = {}) {
  const text = cleaned(value, 400);
  const key = normalizeKey(text);
  if (!key || URI_OR_MARKUP_INPUT.test(text) || INSTRUCTION_OR_COMMAND_INPUT.test(text)) return true;
  if (OBVIOUS_PLACEHOLDER_KEYS.has(key)
      || OBVIOUS_FILLER_SYLLABLES.test(key)
      || JAMO_ONLY_INPUT.test(key)
      || isRepeatedGarbageKey(key)) return true;
  const characters = [...key];
  if (/^\d+$/u.test(key)) return true;
  if (characters.length === 1 && !MEANINGFUL_ONE_CHARACTER_FOODS.has(key)) return true;
  if (characters.length >= 4 && new Set(characters).size === 1) return true;
  if (LATIN_ONLY_INPUT.test(text)) {
    if (LATIN_GARBAGE_KEYS.has(key)) return true;
    if (characters.length >= 5 && new Set(characters).size <= 2) return true;
    if (/(.)\1{3,}/iu.test(key)) return true;
    if (/(?:abcdef|qwerty|asdfgh|zxcvbn|qazwsx)/iu.test(key)) return true;
  }
  return false;
}

export function invalidCustomMealInputReason({ restaurantInput = "", menuInput = "" } = {}) {
  const restaurant = cleaned(restaurantInput, 80);
  const menu = cleanMealMenuInput(menuInput);
  if (!menu) return "드신 메뉴명을 입력해 주세요.";
  const menuSegments = menuInputSegments(menu);
  if (!menuSegments.length
      || menuSegments.length > 5
      || menuSegments.some((item) => clearlyInvalidMealField(item, { kind: "menu" }))
      || (restaurant && clearlyInvalidMealField(restaurant, { kind: "restaurant" }))) {
    return "실제 상호명과 메뉴명을 확인할 수 있도록 조금 더 구체적으로 입력해 주세요.";
  }
  // A real meal can include a side (for example "삼겹살, 껍데기"). Quarantine
  // the input only when every recorded item is non-meal; one substantive menu
  // is enough to send the whole meal through evidence-backed normalization.
  if (menuSegments.every((item) => isExcludedMealCandidate({ menu: item }))) {
    return "커피·디저트·간식·사이드가 아닌 한 끼 식사 메뉴를 입력해 주세요.";
  }
  const compactMenu = menu.replace(/[^\p{L}\p{N}]/gu, "");
  const sameVeryShortValue = restaurant
    && normalizeKey(restaurant) === normalizeKey(menu)
    && [...compactMenu].length === 1;
  if (sameVeryShortValue) {
    return "실제 상호명과 메뉴명을 확인할 수 있도록 조금 더 구체적으로 입력해 주세요.";
  }
  return "";
}

export function splitMealMenus(value) {
  return splitMealMenuNames(value);
}

function validateAliasStore(store) {
  if (!store || store.version !== 1 || !Array.isArray(store.entries)) {
    throw new Error("meal normalization aliases must use version 1 and contain an entries array");
  }
  for (const entry of store.entries) {
    if (!cleaned(entry?.restaurant) || !Array.isArray(entry?.menus) || entry.menus.length < 1) {
      throw new Error("meal normalization alias entry is incomplete");
    }
    if (entry.evidenceUrl !== undefined && !isSafeEvidenceUrl(entry.evidenceUrl)) {
      throw new Error("meal normalization alias evidence URL is unsafe");
    }
    if (entry.address !== undefined
      && (!/전주/u.test(cleaned(entry.address, 200)) || !/\d/u.test(cleaned(entry.address, 200)))) {
      throw new Error("meal normalization alias address must identify a numbered Jeonju location");
    }
    for (const item of entry.menus) {
      if (!cleaned(item?.menu) || (item.aliases !== undefined && !Array.isArray(item.aliases))) {
        throw new Error("meal normalization menu alias is invalid");
      }
    }
  }
  return store;
}

function staticRecommendations() {
  const filePath = path.join(DATA_DIR, "recommendations.json");
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("recommendations.json must contain an array");
  return parsed;
}

function staticAliasStore() {
  const filePath = path.join(ROOT_DIR, "config", "meal-normalization-aliases.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("Static meal normalization aliases are missing");
  }
  return validateAliasStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function catalogEntry(item, extras = {}) {
  const rawRestaurant = cleaned(item?.restaurant);
  const rawBranch = cleaned(item?.branch, 80);
  const identity = canonicalizeRestaurantIdentity({
    restaurant: rawRestaurant,
    branch: rawBranch
  });
  const restaurant = cleaned(identity.restaurant);
  const menu = canonicalizeMenuForRestaurant({
    restaurant,
    menu: item?.menu,
  }).slice(0, 120);
  if (!restaurant || !menu) return null;
  const branch = cleaned(identity.branch, 80);
  // Current verified candidates are reusable knowledge too. A URL is only a
  // lookup hint: normalizeMealEventFromReviewedCatalog fetches and validates
  // the actual branch/address/menu again before allowing learning.
  const evidenceUrl = extras.evidenceUrl || (item?.evidenceVerification === "deterministic-html"
    ? item.priceEvidenceUrl
    : "");
  return {
    restaurant,
    branch,
    category: cleaned(item?.category, 40),
    address: cleaned(item?.address ?? extras.address, 200),
    menu,
    candidateId: cleaned(item?.candidateId, 160),
    evidenceUrl: isSafeEvidenceUrl(evidenceUrl) ? cleaned(evidenceUrl, 2048) : "",
    restaurantAliases: [
      restaurant,
      branch ? `${restaurant} ${branch}` : "",
      rawRestaurant,
      rawBranch ? `${rawRestaurant} ${rawBranch}` : "",
      ...(extras.restaurantAliases || [])
    ]
      .map((value) => cleaned(value))
      .filter(Boolean),
    menuAliases: [menu, ...(extras.menuAliases || [])].map((value) => cleaned(value)).filter(Boolean)
  };
}

function verifiedMealEventCatalogEntries(events = []) {
  return (Array.isArray(events) ? events : []).flatMap((event) => {
    // Only production feedback which completed deterministic normalization is
    // reusable. Rejected, unresolved, private-test, and legacy rows remain
    // audit records and can never become normalization authority.
    if (!isLearningMealEvent(event)) return [];
    const address = cleaned(event.address, 200);
    const menuNames = Array.isArray(event.menus)
      ? event.menus.map((item) => canonicalizeMenuForRestaurant({
          restaurant: event.restaurant,
          menu: item,
        }).slice(0, 120)).filter(Boolean)
      : splitMealMenuNames(event.menu).map((item) => canonicalizeMenuForRestaurant({
          restaurant: event.restaurant,
          menu: item,
        }));
    const evidenceRows = Array.isArray(event.normalization?.menuEvidence)
      ? event.normalization.menuEvidence
      : [];
    if (!/전주/u.test(address) || !/\d/u.test(address)
        || !menuNames.length || evidenceRows.length !== menuNames.length) return [];
    const rawMenus = splitMealMenuNames(event.rawMenu || "");
    const rows = menuNames.map((menu, index) => {
      const evidence = evidenceRows[index];
      const evidenceUrl = cleaned(evidence?.evidenceUrl, 2048);
      if (!isSafeEvidenceUrl(evidenceUrl)
          || normalizeMenuKey(evidence?.canonicalName) !== normalizeMenuKey(menu)) return null;
      return catalogEntry({
        restaurant: event.restaurant,
        branch: event.branch,
        category: event.category,
        address,
        menu,
      }, {
        evidenceUrl,
        restaurantAliases: [event.rawRestaurant],
        menuAliases: [evidence?.input, rawMenus[index]],
      });
    });
    // A partially trustworthy multi-menu record is not useful: local reuse
    // must be able to revalidate the whole user submission, not just a subset.
    return rows.every(Boolean) ? rows : [];
  });
}

export function buildMealNormalizationCatalog({
  historyItems = [],
  mealEvents = [],
  verifiedCandidates = [],
  fallbackCandidates = [],
  aliasStore = { version: 1, entries: [] }
} = {}) {
  validateAliasStore(aliasStore);
  const raw = [
    ...historyItems.map((item) => catalogEntry(item)),
    ...verifiedMealEventCatalogEntries(mealEvents),
    ...verifiedCandidates.map((item) => catalogEntry(item)),
    ...fallbackCandidates.map((item) => catalogEntry(item)),
    ...aliasStore.entries.flatMap((entry) => entry.menus.map((item) => catalogEntry({
      restaurant: entry.restaurant,
      branch: entry.branch,
      category: entry.category,
      address: entry.address,
      menu: item.menu,
      candidateId: item.candidateId
    }, {
      restaurantAliases: entry.restaurantAliases,
      menuAliases: item.aliases,
      evidenceUrl: entry.evidenceUrl
    })))
  ].filter(Boolean);

  const merged = new Map();
  for (const item of raw) {
    const key = `${normalizeKey(item.restaurant)}:${normalizeKey(item.branch)}:${normalizeMenuKey(item.menu)}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, item);
      continue;
    }
    previous.category ||= item.category;
    previous.address ||= item.address;
    previous.candidateId ||= item.candidateId;
    previous.evidenceUrl ||= item.evidenceUrl;
    previous.restaurantAliases = [...new Set([...previous.restaurantAliases, ...item.restaurantAliases])];
    previous.menuAliases = [...new Set([...previous.menuAliases, ...item.menuAliases])];
  }
  return [...merged.values()];
}

export function verifiedMealNormalizationCandidates(verified) {
  if (!verified || typeof verified !== "object" || Array.isArray(verified)) {
    throw new Error("verified-candidates.json must contain an object");
  }
  if (!Array.isArray(verified.candidates)) throw new Error("verified-candidates.json must contain a candidates array");
  if (verified.catalog !== undefined && !Array.isArray(verified.catalog)) {
    throw new Error("verified-candidates.json catalog must be an array");
  }
  return [...verified.candidates, ...(verified.catalog || [])];
}

export function loadMealNormalizationCatalog() {
  const verified = readJson("verified-candidates.json", { version: 1, candidates: [] });
  const aliases = staticAliasStore();
  return buildMealNormalizationCatalog({
    historyItems: getRecommendationHistory().items,
    mealEvents: getMealEvents().events,
    // The catalog is evidence-backed normalization knowledge even when a row
    // is not in the small active recommendation pool. Omitting it made valid
    // catalog-only restaurants fall through to a needless model lookup.
    verifiedCandidates: verifiedMealNormalizationCandidates(verified),
    fallbackCandidates: staticRecommendations(),
    aliasStore: aliases
  });
}

function editDistance(left, right) {
  const a = [...left];
  const b = [...right];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      current.push(Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + (a[i] === b[j] ? 0 : 1)
      ));
    }
    previous = current;
  }
  return previous[b.length];
}

function aliasScore(input, alias, normalize = normalizeKey) {
  const left = normalize(input);
  const right = normalize(alias);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter >= 2 && (left.includes(right) || right.includes(left))) return 0.88 + 0.08 * (shorter / longer);
  const similarity = 1 - editDistance(left, right) / longer;
  return similarity >= 0.84 ? similarity : 0;
}

function chooseMatch(input, entries, { keyFor, aliasesFor, normalize = normalizeKey }) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = keyFor(entry);
    const score = Math.max(0, ...aliasesFor(entry).map((alias) => aliasScore(input, alias, normalize)));
    if (!score) continue;
    const previous = grouped.get(key);
    if (!previous || score > previous.score) grouped.set(key, { entry, score });
  }
  const ranked = [...grouped.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked[0].score < 0.84) return null;
  if (ranked[1] && ranked[0].score < 1 && ranked[0].score - ranked[1].score < 0.08) return null;
  if (ranked[1] && ranked[0].score === 1 && ranked[1].score === 1) return null;
  return ranked[0];
}

const GENERIC_MENU_ONLY_KEYS = new Set([
  "밥", "면", "죽", "회", "김밥", "떡볶이", "라면", "볶음밥", "비빔밥", "덮밥",
  "국밥", "콩나물국밥", "김치찌개", "된장찌개", "짜장면", "짬뽕", "탕수육",
  "우동", "소바", "메밀", "냉면", "칼국수", "카레", "커리", "초밥", "스시",
  "치킨", "피자", "버거", "파스타", "샐러드", "샌드위치", "삼겹살", "갈비",
  "불고기", "제육", "제육덮밥", "돈가스", "돈카츠", "쌀국수", "마라탕",
]);

function inferReviewedRestaurantFromMenus(inputMenus, catalog) {
  // A small local catalog is not exhaustive market evidence: one observed
  // vendor of a generic dish does not identify the user's restaurant.
  if (inputMenus.length === 1 && GENERIC_MENU_ONLY_KEYS.has(normalizeMenuKey(inputMenus[0]))) return null;
  const reviewed = catalog.filter((item) => item.evidenceUrl && item.address);
  if (!reviewed.length) return null;
  const matches = inputMenus.map((input) => chooseMatch(input, reviewed, {
    keyFor: (item) => [
      normalizeKey(item.restaurant),
      normalizeKey(item.branch),
      normalizeMenuKey(item.menu)
    ].join(":"),
    aliasesFor: (item) => item.menuAliases,
    normalize: normalizeMenuKey
  }));
  if (matches.some((match) => !match)) return null;
  const identities = new Set(matches.map(({ entry }) => [
    normalizeKey(entry.restaurant),
    normalizeKey(entry.branch)
  ].join(":")));
  if (identities.size !== 1) return null;
  return {
    entry: matches[0].entry,
    score: Math.min(...matches.map((match) => match.score))
  };
}

function conflictsWithExplicitBranch(input, matched, catalog) {
  if (!matched) return false;
  const sameRestaurant = catalog.filter((item) =>
    normalizeKey(item.restaurant) === normalizeKey(matched.entry.restaurant));
  const inputKey = normalizeKey(input);
  // Exact reviewed aliases include intentionally abbreviated branch names.
  if (sameRestaurant.some((item) => item.restaurantAliases.some((alias) =>
    normalizeKey(alias) === inputKey))) return false;
  const restaurantKey = normalizeKey(matched.entry.restaurant);
  const remainder = inputKey.startsWith(restaurantKey)
    ? inputKey.slice(restaurantKey.length)
    : normalizeKey(cleanText(input).split(" ").slice(1).join(" "));
  if (!remainder.endsWith("점")) return false;
  return !sameRestaurant.some((item) =>
    item.branch && remainder.endsWith(normalizeKey(item.branch)));
}

export function resolveCustomMealInput({ restaurantInput = "", menuInput = "", catalog = loadMealNormalizationCatalog() } = {}) {
  const originalRestaurant = cleaned(restaurantInput, 80);
  const inputMenus = splitMealMenus(menuInput);
  if (!inputMenus.length) throw new Error("At least one menu is required for meal normalization");

  const provisionalRestaurantMatch = originalRestaurant
    ? chooseMatch(originalRestaurant, catalog, {
        keyFor: (item) => normalizeKey(item.restaurant),
        aliasesFor: (item) => item.restaurantAliases
      })
    : null;
  // An explicitly named unknown branch must go through the model's nearby
  // search; the only branch currently in the catalog is not proof of intent.
  const directRestaurantMatch = conflictsWithExplicitBranch(originalRestaurant, provisionalRestaurantMatch, catalog)
    ? null
    : provisionalRestaurantMatch;
  const menuInferredRestaurantMatch = originalRestaurant
    ? null
    : inferReviewedRestaurantFromMenus(inputMenus, catalog);
  const restaurantMatch = directRestaurantMatch || menuInferredRestaurantMatch;
  let restaurant = restaurantMatch?.entry.restaurant || originalRestaurant;
  let relevant = restaurantMatch
    ? catalog.filter((item) => normalizeKey(item.restaurant) === normalizeKey(restaurant))
    : catalog;

  let branch = menuInferredRestaurantMatch?.entry.branch || "";
  let branchMethod = menuInferredRestaurantMatch ? "menu-inferred-known" : "unresolved";
  if (directRestaurantMatch) {
    const explicitBranches = relevant
      .filter((item) => item.branch && normalizeKey(originalRestaurant).includes(normalizeKey(item.branch)))
      .map((item) => item.branch);
    const knownBranches = [...new Set(relevant.map((item) => item.branch).filter(Boolean))];
    if (new Set(explicitBranches).size === 1) {
      [branch] = explicitBranches;
      branchMethod = "explicit-known";
    } else if (knownBranches.length === 1) {
      [branch] = knownBranches;
      branchMethod = "unique-known";
    }
  }
  if (branch) relevant = relevant.filter((item) => !item.branch || normalizeKey(item.branch) === normalizeKey(branch));

  const resolvedMenus = inputMenus.map((input) => {
    const match = restaurantMatch
      ? chooseMatch(input, relevant, {
          keyFor: (item) => normalizeMenuKey(item.menu),
          aliasesFor: (item) => item.menuAliases,
          normalize: normalizeMenuKey
        })
      : null;
    return match
      ? { input, menu: match.entry.menu, method: match.score === 1 ? "exact-known" : "fuzzy-known", score: Number(match.score.toFixed(3)), entry: match.entry }
      : { input, menu: input, method: "preserved", score: 0, entry: null };
  });

  const menus = [...new Map(
    resolvedMenus.map((item) => [
      normalizeMenuKey(item.menu),
      canonicalizeMenuForRestaurant({ restaurant, menu: item.menu }),
    ])
  ).values()];
  const categories = restaurantMatch
    ? [...new Set(resolvedMenus.map((item) => item.entry?.category).filter(Boolean))]
    : [];
  const allMenusKnown = resolvedMenus.every((item) => item.entry);
  const reviewedEvidenceRows = resolvedMenus
    .map((item) => item.entry)
    .filter((item) => item?.evidenceUrl && item?.address);
  const reviewedEvidenceUrls = [...new Set(reviewedEvidenceRows.map((item) => item.evidenceUrl))];
  const reviewedAddresses = [...new Set(reviewedEvidenceRows.map((item) => item.address))];
  const reviewedEvidence = allMenusKnown
    && reviewedEvidenceRows.length === resolvedMenus.length
    && reviewedEvidenceUrls.length === 1
    && reviewedAddresses.length === 1
    ? {
        address: reviewedAddresses[0],
        evidenceUrl: reviewedEvidenceUrls[0]
      }
    : null;
  return {
    restaurant,
    branch,
    menu: menus.join(" · "),
    menus,
    category: categories.length === 1 ? categories[0] : "",
    candidateId: menus.length === 1 ? (resolvedMenus[0].entry?.candidateId || "") : "",
    normalization: {
      version: 1,
      restaurantMethod: menuInferredRestaurantMatch
        ? "menu-inferred-known"
        : restaurantMatch
          ? (restaurantMatch.score === 1 ? "exact-known" : "fuzzy-known")
          : restaurant
            ? "preserved"
            : "unresolved",
      branchMethod,
      menuMethods: resolvedMenus.map(({ input, menu, method, score }) => ({ input, menu, method, score })),
      evidenceUrls: [...new Set(resolvedMenus.map((item) => item.entry?.evidenceUrl).filter(Boolean))],
      ...(reviewedEvidence ? { reviewedEvidence } : {}),
      fullyCanonical: Boolean(restaurantMatch || (!originalRestaurant && restaurant)) && allMenusKnown
        && (Boolean(branch) || !relevant.some((item) => item.branch))
    }
  };
}

export function prepareMealEventForNormalization(event, {
  catalog = loadMealNormalizationCatalog(),
  enabled = true
} = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Meal event normalization requires an event object");
  }
  const rawRestaurant = cleaned(event.rawRestaurant ?? event.restaurant, 80);
  const rawMenu = cleanMealMenuInput(event.rawMenu ?? event.menu);
  const invalidReason = invalidCustomMealInputReason({ restaurantInput: rawRestaurant, menuInput: rawMenu });
  const resolved = resolveCustomMealInput({ restaurantInput: rawRestaurant, menuInput: rawMenu, catalog });
  const priorNormalization = event.normalization && typeof event.normalization === "object"
    ? event.normalization
    : null;
  const {
    normalizationStartedAt: _normalizationStartedAt,
    normalizationCompletedAt: _normalizationCompletedAt,
    normalizationLastError: _normalizationLastError,
    ...baseEvent
  } = event;
  return {
    ...baseEvent,
    rawRestaurant,
    rawMenu,
    restaurant: resolved.restaurant,
    branch: resolved.branch,
    menu: resolved.menu,
    menus: resolved.menus,
    category: resolved.category || event.category || null,
    candidateId: event.candidateId || null,
    normalizationStatus: invalidReason ? "rejected-input" : enabled ? "pending" : "local-only",
    normalizationAttemptCount: 0,
    ...(invalidReason ? { normalizationLastError: invalidReason } : {}),
    normalization: {
      version: 2,
      method: "local-catalog-provisional",
      local: resolved.normalization,
      ...(priorNormalization?.verifiedAt ? { previous: priorNormalization } : {})
    }
  };
}
