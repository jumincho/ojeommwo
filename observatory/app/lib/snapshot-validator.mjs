import { INGREDIENT_SEARCH_TAGS, MAX_INGREDIENT_SEARCH_TAGS } from "../../scripts/lib/ingredient-tags.mjs";

const FOOD_CATEGORIES = Object.freeze([
  "한식", "치킨", "분식", "돈까스", "족발/보쌈", "찜/탕", "구이", "피자", "중식", "일식",
  "회/해물", "양식", "아시안", "샌드위치", "샐러드", "버거", "멕시칸", "도시락", "죽",
]);

const HEX_64 = /^[a-f0-9]{64}$/u;
const HEX_COLOR = /^#[a-f0-9]{6}$/iu;
const IDENTIFIER = /^[a-z]+_[a-f0-9]{16}$/u;
const SOURCE_KINDS = new Set(["catalog", "history", "meal", "preference", "verified"]);
const INGREDIENT_SEARCH_TAG_SET = new Set(INGREDIENT_SEARCH_TAGS);
const BLOCKED_KEY = /^(?:address|channel|channelId|coordinates|deliveryEvidenceUrl|evidence|evidenceUrl|latitude|longitude|messageTs|priceEvidenceUrl|respondentId|slackUserId|sourceUrl|userId)$/iu;
const EMBEDDED_URL = /(?:https?|ftp):\/\//iu;
const SLACK_TOKEN = /\bxox(?:a|b|p|r|s)-|\bxapp-/iu;
const SLACK_IDENTIFIER = /\b(?:C|D|G|U|W)[A-Z0-9]{8,}\b/u;
const MAX_VISITED_VALUES = 50_000;
const MAX_DEPTH = 14;

function fail(path, message) {
  throw new Error(`스냅숏 검증 실패: ${path} ${message}`);
}

function invariant(condition, path, message) {
  if (!condition) fail(path, message);
}

function object(value, path) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), path, "항목이 올바른 객체가 아닙니다.");
  return value;
}

function exactKeys(value, expected, path) {
  const record = object(value, path);
  const actual = Object.keys(record).sort();
  const allowed = [...expected].sort();
  invariant(actual.length === allowed.length && actual.every((key, index) => key === allowed[index]), path, "허용되지 않은 필드가 있거나 필수 필드가 빠졌습니다.");
  return record;
}

function exactKeysWithRollingShapes(value, shapes, path) {
  const record = object(value, path);
  const actual = Object.keys(record).sort();
  const matches = shapes.some((shape) => {
    const allowed = [...shape].sort();
    return actual.length === allowed.length
      && actual.every((key, index) => key === allowed[index]);
  });
  invariant(matches, path, "허용되지 않은 필드가 있거나 필수 필드가 빠졌습니다.");
  return record;
}

function array(value, path, { min = 0, max = 20_000 } = {}) {
  invariant(Array.isArray(value), path, "항목이 배열이 아닙니다.");
  invariant(value.length >= min && value.length <= max, path, `개수가 허용 범위(${min}~${max})를 벗어났습니다.`);
  return value;
}

function string(value, path, { min = 0, max = 500 } = {}) {
  invariant(typeof value === "string" && value.length >= min && value.length <= max, path, `문자열 길이가 허용 범위(${min}~${max})를 벗어났습니다.`);
  return value;
}

function number(value, path, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  invariant(Number.isFinite(value) && value >= min && value <= max, path, `숫자가 허용 범위(${min}~${max})를 벗어났습니다.`);
  return value;
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, path, `정수가 허용 범위(${min}~${max})를 벗어났습니다.`);
  return value;
}

function isoDate(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  string(value, path, { min: 20, max: 40 });
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, path, "시간 형식이 올바르지 않습니다.");
  return value;
}

function uniqueStrings(value, path, { min = 0, max = 200, itemMax = 120 } = {}) {
  const items = array(value, path, { min, max });
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    string(item, `${path}[${index}]`, { min: 1, max: itemMax });
    invariant(!seen.has(item), `${path}[${index}]`, "중복된 값입니다.");
    seen.add(item);
  }
  return items;
}

function scanForPrivateData(root) {
  const queue = [{ value: root, path: "snapshot", depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const { value, path, depth } = queue.pop();
    visited += 1;
    invariant(visited <= MAX_VISITED_VALUES, "snapshot", "검사할 데이터가 지나치게 큽니다.");
    invariant(depth <= MAX_DEPTH, path, "중첩 깊이가 지나치게 큽니다.");
    if (typeof value === "string") {
      invariant(!EMBEDDED_URL.test(value), path, "외부 URL을 포함할 수 없습니다.");
      invariant(!SLACK_TOKEN.test(value), path, "Slack 토큰 형태의 값을 포함할 수 없습니다.");
      invariant(!SLACK_IDENTIFIER.test(value), path, "Slack 식별자 형태의 값을 포함할 수 없습니다.");
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      invariant(value.length <= 20_000, path, "배열이 지나치게 큽니다.");
      for (let index = 0; index < value.length; index += 1) {
        queue.push({ value: value[index], path: `${path}[${index}]`, depth: depth + 1 });
      }
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      invariant(!BLOCKED_KEY.test(key), `${path}.${key}`, "공개 스냅숏에서 금지된 개인정보 필드입니다.");
      queue.push({ value: child, path: `${path}.${key}`, depth: depth + 1 });
    }
  }
}

function validateTaste(rawTaste, path) {
  const taste = exactKeys(rawTaste, [
    "alpha", "beta", "bias", "confidence", "evidenceWeight", "intervalHigh", "intervalLow", "mean", "sources",
  ], path);
  number(taste.alpha, `${path}.alpha`, { min: 0 });
  number(taste.beta, `${path}.beta`, { min: 0 });
  number(taste.mean, `${path}.mean`, { min: 0, max: 1 });
  number(taste.bias, `${path}.bias`, { min: -1, max: 1 });
  number(taste.evidenceWeight, `${path}.evidenceWeight`, { min: 0 });
  number(taste.confidence, `${path}.confidence`, { min: 0, max: 1 });
  number(taste.intervalLow, `${path}.intervalLow`, { min: 0, max: taste.mean });
  number(taste.intervalHigh, `${path}.intervalHigh`, { min: taste.mean, max: 1 });
  invariant(taste.alpha + taste.beta > 0, path, "베타 분포의 모수가 모두 0일 수 없습니다.");
  const posteriorMean = taste.alpha / (taste.alpha + taste.beta);
  invariant(Math.abs(posteriorMean - taste.mean) <= 2e-5, `${path}.mean`, "베타 분포 모수와 일치하지 않습니다.");
  const sources = exactKeys(taste.sources, ["mealNegative", "mealPositive", "surveyNegative", "surveyPositive"], `${path}.sources`);
  for (const key of ["mealPositive", "mealNegative", "surveyPositive", "surveyNegative"]) {
    number(sources[key], `${path}.sources.${key}`, { min: 0 });
  }
}

function validateEvidence(menu, generatedTime, path) {
  const fields = ["availabilityCheckedAt", "availabilityExpiresAt", "priceCheckedAt", "priceExpiresAt"];
  for (const field of fields) isoDate(menu[field], `${path}.${field}`, { nullable: true });
  invariant(typeof menu.availableNow === "boolean", `${path}.availableNow`, "참/거짓 값이 아닙니다.");
  if (menu.deliveryStatus === null) {
    invariant(menu.deliveryFreshness === null, `${path}.deliveryFreshness`, "배달 정보가 없는데 최신도 값이 있습니다.");
    invariant(menu.availabilityCheckedAt === null && menu.availabilityExpiresAt === null, path, "배달 정보가 없는데 확인 시간이 있습니다.");
  } else {
    invariant(menu.deliveryStatus === "verified" || menu.deliveryStatus === "likely", `${path}.deliveryStatus`, "배달 근거 등급이 올바르지 않습니다.");
    invariant(menu.deliveryFreshness === "current" || menu.deliveryFreshness === "recent", `${path}.deliveryFreshness`, "배달 정보 최신도가 올바르지 않습니다.");
    invariant(menu.availabilityCheckedAt !== null && menu.availabilityExpiresAt !== null, path, "배달 정보에 확인·유효 시간이 필요합니다.");
    invariant(Date.parse(menu.availabilityCheckedAt) <= Date.parse(menu.availabilityExpiresAt), path, "배달 가능 확인 시간이 뒤집혔습니다.");
    invariant(Date.parse(menu.availabilityExpiresAt) >= generatedTime, path, "생성 시점에 이미 만료된 배달 근거입니다.");
  }
  if (!menu.availableNow) {
    invariant(menu.priceCheckedAt === null && menu.priceExpiresAt === null, path, "현재 미검증 메뉴가 가격 확인 시간을 포함하고 있습니다.");
    invariant(!menu.sources.includes("verified"), `${path}.sources`, "현재 미검증 메뉴가 검증됨으로 표시되어 있습니다.");
    return;
  }
  invariant(menu.deliveryFreshness === "current", `${path}.deliveryFreshness`, "현재 검증 메뉴에는 최신 배달 근거가 필요합니다.");
  invariant(menu.priceCheckedAt !== null && menu.priceExpiresAt !== null, path, "현재 검증 메뉴에 가격 확인·유효 시간이 필요합니다.");
  invariant(menu.sources.includes("verified"), `${path}.sources`, "현재 검증 메뉴에 verified 출처가 없습니다.");
  invariant(Date.parse(menu.priceCheckedAt) <= Date.parse(menu.priceExpiresAt), path, "가격 확인 시간이 뒤집혔습니다.");
  invariant(Date.parse(menu.priceExpiresAt) >= generatedTime, path, "생성 시점에 이미 만료된 가격 근거입니다.");
}

/**
 * Validate an untrusted browser snapshot deeply before it becomes UI state.
 * The returned value is the same object after every nested record and
 * cross-reference has passed the public schema-v2 contract.
 *
 * @param {unknown} raw
 * @returns {any}
 */
export function validateSnapshot(raw) {
  scanForPrivateData(raw);
  const snapshot = exactKeys(raw, [
    "algorithm", "cooccurrenceEdges", "displayOnly", "generatedAt", "menus", "recommendationEvents", "restaurants", "schemaVersion", "source", "stats", "taxonomy",
  ], "snapshot");
  invariant(snapshot.schemaVersion === 2, "snapshot.schemaVersion", "지원하는 버전(2)이 아닙니다.");
  isoDate(snapshot.generatedAt, "snapshot.generatedAt");
  const generatedTime = Date.parse(snapshot.generatedAt);

  const source = exactKeys(snapshot.source, ["privacy", "project", "releaseVersion", "sourceFingerprint"], "snapshot.source");
  invariant(source.project === "ojeommwo-v2", "snapshot.source.project", "프로젝트가 일치하지 않습니다.");
  string(source.releaseVersion, "snapshot.source.releaseVersion", { min: 1, max: 40 });
  invariant(HEX_64.test(source.sourceFingerprint), "snapshot.source.sourceFingerprint", "SHA-256 지문이 올바르지 않습니다.");
  invariant(source.privacy === "sanitized-aggregate-only", "snapshot.source.privacy", "공개용 개인정보 보호 계약이 없습니다.");

  const algorithm = exactKeys(snapshot.algorithm, [
    "candidatePreferenceWeight", "contractFingerprint", "displayUsesStablePosteriorMean", "explorationRate", "posterior", "priorAlpha", "priorBeta", "tasteHalfLifeDays",
  ], "snapshot.algorithm");
  invariant(algorithm.posterior === "beta", "snapshot.algorithm.posterior", "지원하는 선호 모델이 아닙니다.");
  number(algorithm.priorAlpha, "snapshot.algorithm.priorAlpha", { min: 0.001 });
  number(algorithm.priorBeta, "snapshot.algorithm.priorBeta", { min: 0.001 });
  number(algorithm.tasteHalfLifeDays, "snapshot.algorithm.tasteHalfLifeDays", { min: 1, max: 3650 });
  number(algorithm.candidatePreferenceWeight, "snapshot.algorithm.candidatePreferenceWeight", { min: 0, max: 100 });
  number(algorithm.explorationRate, "snapshot.algorithm.explorationRate", { min: 0, max: 1 });
  invariant(HEX_64.test(algorithm.contractFingerprint), "snapshot.algorithm.contractFingerprint", "알고리즘 계약 지문이 올바르지 않습니다.");
  invariant(algorithm.displayUsesStablePosteriorMean === true, "snapshot.algorithm.displayUsesStablePosteriorMean", "화면은 안정적인 사후 평균만 사용해야 합니다.");

  const taxonomy = array(snapshot.taxonomy, "snapshot.taxonomy", { min: FOOD_CATEGORIES.length, max: FOOD_CATEGORIES.length });
  const taxonomyIds = new Set();
  taxonomy.forEach((rawCategory, index) => {
    const category = exactKeys(rawCategory, ["color", "emoji", "glow", "id"], `snapshot.taxonomy[${index}]`);
    invariant(category.id === FOOD_CATEGORIES[index], `snapshot.taxonomy[${index}].id`, "공식 카테고리 순서와 일치하지 않습니다.");
    string(category.emoji, `snapshot.taxonomy[${index}].emoji`, { min: 1, max: 8 });
    invariant(HEX_COLOR.test(category.color) && HEX_COLOR.test(category.glow), `snapshot.taxonomy[${index}]`, "색상 값이 올바르지 않습니다.");
    taxonomyIds.add(category.id);
  });

  const displayOnly = exactKeys(snapshot.displayOnly, ["tasteGravity"], "snapshot.displayOnly");
  const tasteGravity = array(displayOnly.tasteGravity, "snapshot.displayOnly.tasteGravity", { max: 200 });
  const displayIds = new Set();
  tasteGravity.forEach((rawItem, index) => {
    const path = `snapshot.displayOnly.tasteGravity[${index}]`;
    const item = exactKeys(rawItem, ["algorithmImpact", "category", "id", "menu", "note", "restaurantLabel", "score"], path);
    string(item.id, `${path}.id`, { min: 1, max: 100 });
    invariant(!displayIds.has(item.id), `${path}.id`, "중복된 식별자입니다.");
    displayIds.add(item.id);
    string(item.restaurantLabel, `${path}.restaurantLabel`, { min: 1, max: 120 });
    string(item.menu, `${path}.menu`, { min: 1, max: 120 });
    invariant(taxonomyIds.has(item.category), `${path}.category`, "공식 카테고리가 아닙니다.");
    invariant(item.score === 0 && item.algorithmImpact === false, path, "화면 전용 항목이 추천 계산에 영향을 줍니다.");
    string(item.note, `${path}.note`, { min: 1, max: 180 });
  });

  const menus = array(snapshot.menus, "snapshot.menus", { min: 1, max: 2_500 });
  const menuIds = new Set();
  const canonicalMenus = new Set();
  menus.forEach((rawMenu, index) => {
    const path = `snapshot.menus[${index}]`;
    const baseMenuKeys = [
      "availabilityCheckedAt", "availabilityExpiresAt", "availableNow", "averageSurveyRating", "branch", "category", "comment", "firstRecommendedAt", "id", "ingredientFamilies", "lastRecommendedAt", "mealEventCount", "menu", "occurrences", "priceCheckedAt", "priceExpiresAt", "priceText", "restaurant", "restaurantId", "restaurantLabel", "sources", "surveyCount", "taste",
    ];
    const menu = exactKeysWithRollingShapes(rawMenu, [
      baseMenuKeys,
      [...baseMenuKeys, "deliveryStatus"],
      [...baseMenuKeys, "deliveryStatus", "deliveryFreshness"],
    ], path);
    // A Sites source update can become active before pororo publishes the
    // matching snapshot. Accept exactly the immediately previous schema and
    // conservatively interpret its verified candidate evidence as "likely".
    // New uploads and the source-side validator still require the explicit
    // field, so this is a bounded rolling-deploy bridge rather than schema
    // loosening.
    if (!Object.hasOwn(menu, "deliveryStatus")) {
      menu.deliveryStatus = menu.availableNow ? "likely" : null;
    }
    if (!Object.hasOwn(menu, "deliveryFreshness")) {
      menu.deliveryFreshness = menu.deliveryStatus ? "current" : null;
    }
    invariant(typeof menu.id === "string" && IDENTIFIER.test(menu.id) && menu.id.startsWith("menu_"), `${path}.id`, "메뉴 식별자가 올바르지 않습니다.");
    invariant(!menuIds.has(menu.id) && !displayIds.has(menu.id), `${path}.id`, "중복된 식별자입니다.");
    menuIds.add(menu.id);
    invariant(typeof menu.restaurantId === "string" && IDENTIFIER.test(menu.restaurantId) && menu.restaurantId.startsWith("restaurant_"), `${path}.restaurantId`, "상호 식별자가 올바르지 않습니다.");
    string(menu.restaurant, `${path}.restaurant`, { min: 1, max: 120 });
    string(menu.branch, `${path}.branch`, { max: 80 });
    string(menu.restaurantLabel, `${path}.restaurantLabel`, { min: 1, max: 201 });
    string(menu.menu, `${path}.menu`, { min: 1, max: 120 });
    invariant(taxonomyIds.has(menu.category), `${path}.category`, "공식 카테고리가 아닙니다.");
    // U+001F is an internal field separator; all other punctuation is intentionally removed.
    // eslint-disable-next-line no-control-regex
    const canonical = `${menu.restaurant}\u001f${menu.branch}\u001f${menu.menu}`.toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}\u001f]/gu, "");
    invariant(!canonicalMenus.has(canonical), path, "상호·지점·메뉴 조합이 중복되었습니다.");
    canonicalMenus.add(canonical);
    string(menu.priceText, `${path}.priceText`, { min: 1, max: 60 });
    string(menu.comment, `${path}.comment`, { max: 240 });
    const ingredientFamilies = uniqueStrings(menu.ingredientFamilies, `${path}.ingredientFamilies`, { min: 1, max: MAX_INGREDIENT_SEARCH_TAGS, itemMax: 40 });
    ingredientFamilies.forEach((item, itemIndex) => {
      invariant(INGREDIENT_SEARCH_TAG_SET.has(item), `${path}.ingredientFamilies[${itemIndex}]`, "공식 재료 검색 태그가 아닙니다.");
    });
    integer(menu.occurrences, `${path}.occurrences`);
    isoDate(menu.firstRecommendedAt, `${path}.firstRecommendedAt`, { nullable: true });
    isoDate(menu.lastRecommendedAt, `${path}.lastRecommendedAt`, { nullable: true });
    invariant((menu.firstRecommendedAt === null) === (menu.lastRecommendedAt === null), path, "최초·최근 추천일 중 하나만 존재합니다.");
    if (menu.firstRecommendedAt) invariant(Date.parse(menu.firstRecommendedAt) <= Date.parse(menu.lastRecommendedAt), path, "추천일 순서가 뒤집혔습니다.");
    integer(menu.mealEventCount, `${path}.mealEventCount`);
    integer(menu.surveyCount, `${path}.surveyCount`);
    if (menu.averageSurveyRating !== null) number(menu.averageSurveyRating, `${path}.averageSurveyRating`, { min: 1, max: 5 });
    const sources = uniqueStrings(menu.sources, `${path}.sources`, { min: 1, max: SOURCE_KINDS.size, itemMax: 20 });
    sources.forEach((sourceKind) => invariant(SOURCE_KINDS.has(sourceKind), `${path}.sources`, "알 수 없는 출처 종류입니다."));
    validateEvidence(menu, generatedTime, path);
    validateTaste(menu.taste, `${path}.taste`);
  });

  const restaurants = array(snapshot.restaurants, "snapshot.restaurants", { max: 2_500 });
  const restaurantIds = new Set();
  restaurants.forEach((rawRestaurant, index) => {
    const path = `snapshot.restaurants[${index}]`;
    const restaurant = exactKeys(rawRestaurant, ["branches", "categories", "id", "menuCount", "name", "occurrences"], path);
    invariant(typeof restaurant.id === "string" && IDENTIFIER.test(restaurant.id) && restaurant.id.startsWith("restaurant_"), `${path}.id`, "상호 식별자가 올바르지 않습니다.");
    invariant(!restaurantIds.has(restaurant.id), `${path}.id`, "중복된 식별자입니다.");
    restaurantIds.add(restaurant.id);
    string(restaurant.name, `${path}.name`, { min: 1, max: 120 });
    uniqueStrings(restaurant.branches, `${path}.branches`, { max: 200, itemMax: 80 });
    integer(restaurant.menuCount, `${path}.menuCount`, { min: 1 });
    integer(restaurant.occurrences, `${path}.occurrences`);
    const categories = uniqueStrings(restaurant.categories, `${path}.categories`, { max: FOOD_CATEGORIES.length, itemMax: 20 });
    categories.forEach((category) => invariant(taxonomyIds.has(category), `${path}.categories`, "공식 카테고리가 아닙니다."));
  });
  menus.forEach((menu) => invariant(restaurantIds.has(menu.restaurantId), `snapshot.menus.${menu.id}.restaurantId`, "존재하지 않는 상호를 가리킵니다."));

  const events = array(snapshot.recommendationEvents, "snapshot.recommendationEvents", { max: 20_000 });
  const eventIds = new Set();
  events.forEach((rawEvent, index) => {
    const path = `snapshot.recommendationEvents[${index}]`;
    const event = exactKeys(rawEvent, ["id", "mealType", "menuIds", "recommendedAt"], path);
    invariant(typeof event.id === "string" && IDENTIFIER.test(event.id) && event.id.startsWith("recommendation_"), `${path}.id`, "추천 식별자가 올바르지 않습니다.");
    invariant(!eventIds.has(event.id), `${path}.id`, "중복된 식별자입니다.");
    eventIds.add(event.id);
    isoDate(event.recommendedAt, `${path}.recommendedAt`);
    string(event.mealType, `${path}.mealType`, { min: 1, max: 20 });
    const ids = uniqueStrings(event.menuIds, `${path}.menuIds`, { min: 1, max: 5, itemMax: 40 });
    ids.forEach((id) => invariant(menuIds.has(id), `${path}.menuIds`, "존재하지 않는 메뉴를 가리킵니다."));
  });

  const edges = array(snapshot.cooccurrenceEdges, "snapshot.cooccurrenceEdges", { max: 50_000 });
  const edgeIds = new Set();
  edges.forEach((rawEdge, index) => {
    const path = `snapshot.cooccurrenceEdges[${index}]`;
    const edge = exactKeys(rawEdge, ["count", "source", "target"], path);
    invariant(menuIds.has(edge.source) && menuIds.has(edge.target) && edge.source !== edge.target, path, "관계가 존재하지 않거나 같은 메뉴를 가리킵니다.");
    integer(edge.count, `${path}.count`, { min: 1 });
    const edgeId = [edge.source, edge.target].sort().join(":");
    invariant(!edgeIds.has(edgeId), path, "중복된 메뉴 관계입니다.");
    edgeIds.add(edgeId);
  });

  const stats = exactKeys(snapshot.stats, [
    "categoryCounts", "freshCandidates", "mealEvents", "menus", "preferenceRatings", "preferenceResponses", "ratingDistribution", "recommendationItems", "recommendationMessages", "restaurants", "sentMessages", "timelineEnd", "timelineStart",
  ], "snapshot.stats");
  for (const key of ["recommendationItems", "recommendationMessages", "sentMessages", "restaurants", "menus", "mealEvents", "preferenceResponses", "preferenceRatings", "freshCandidates"]) {
    integer(stats[key], `snapshot.stats.${key}`);
  }
  isoDate(stats.timelineStart, "snapshot.stats.timelineStart");
  isoDate(stats.timelineEnd, "snapshot.stats.timelineEnd");
  invariant(Date.parse(stats.timelineStart) <= Date.parse(stats.timelineEnd), "snapshot.stats", "관측 기간이 뒤집혔습니다.");
  const categoryCounts = exactKeys(stats.categoryCounts, FOOD_CATEGORIES, "snapshot.stats.categoryCounts");
  for (const category of FOOD_CATEGORIES) integer(categoryCounts[category], `snapshot.stats.categoryCounts.${category}`);
  const ratingDistribution = exactKeys(stats.ratingDistribution, ["1", "2", "3", "4", "5"], "snapshot.stats.ratingDistribution");
  for (const rating of ["1", "2", "3", "4", "5"]) integer(ratingDistribution[rating], `snapshot.stats.ratingDistribution.${rating}`);

  invariant(stats.menus === menus.length, "snapshot.stats.menus", "메뉴 배열 개수와 일치하지 않습니다.");
  invariant(stats.restaurants === restaurants.length, "snapshot.stats.restaurants", "상호 배열 개수와 일치하지 않습니다.");
  invariant(stats.recommendationMessages === events.length, "snapshot.stats.recommendationMessages", "추천 묶음 개수와 일치하지 않습니다.");
  invariant(stats.freshCandidates === menus.filter((menu) => menu.availableNow).length, "snapshot.stats.freshCandidates", "현재 검증된 후보 개수와 일치하지 않습니다.");
  invariant(stats.recommendationItems === menus.reduce((sum, menu) => sum + menu.occurrences, 0), "snapshot.stats.recommendationItems", "추천 등장 합계와 일치하지 않습니다.");
  invariant(stats.preferenceRatings === Object.values(ratingDistribution).reduce((sum, value) => sum + value, 0), "snapshot.stats.preferenceRatings", "선호 점수 합계와 일치하지 않습니다.");
  for (const category of FOOD_CATEGORIES) {
    invariant(categoryCounts[category] === menus.filter((menu) => menu.category === category).length, `snapshot.stats.categoryCounts.${category}`, "카테고리 메뉴 개수와 일치하지 않습니다.");
  }
  for (const restaurant of restaurants) {
    const relatedMenus = menus.filter((menu) => menu.restaurantId === restaurant.id);
    invariant(restaurant.menuCount === relatedMenus.length, `snapshot.restaurants.${restaurant.id}.menuCount`, "상호의 메뉴 개수와 일치하지 않습니다.");
    invariant(restaurant.occurrences === relatedMenus.reduce((sum, menu) => sum + menu.occurrences, 0), `snapshot.restaurants.${restaurant.id}.occurrences`, "상호의 추천 등장 합계와 일치하지 않습니다.");
  }

  return snapshot;
}

export { FOOD_CATEGORIES };
