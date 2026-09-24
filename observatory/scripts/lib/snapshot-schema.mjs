import { FOOD_CATEGORIES, algorithmContract } from "./bot-contract.mjs";
import { INGREDIENT_SEARCH_TAGS, MAX_INGREDIENT_SEARCH_TAGS } from "./ingredient-tags.mjs";

const HEX_64 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z]+_[a-f0-9]{16}$/u;
const SOURCE_KINDS = new Set(["catalog", "history", "meal", "preference", "verified"]);
const INGREDIENT_SEARCH_TAG_SET = new Set(INGREDIENT_SEARCH_TAGS);
const BLOCKED_KEY = /^(?:address|channel|channelId|coordinates|deliveryEvidenceUrl|evidence|evidenceUrl|latitude|longitude|messageTs|priceEvidenceUrl|respondentId|slackUserId|sourceUrl|userId)$/iu;
const EMBEDDED_URL = /(?:https?|ftp):\/\//iu;
const SLACK_TOKEN = /\bxox(?:a|b|p|r|s)-|\bxapp-/iu;
const SLACK_IDENTIFIER = /\b(?:C|D|G|U|W)[A-Z0-9]{8,}\b/u;

function fail(message) {
  throw new Error(`snapshot validation failed: ${message}`);
}

function invariant(condition, message) {
  if (!condition) fail(message);
}

function plainObject(value, trail) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${trail} must be an object`);
  return value;
}

function exactKeys(value, expected, trail) {
  plainObject(value, trail);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  invariant(actual.length === allowed.length && actual.every((key, index) => key === allowed[index]), `${trail} keys must be exactly ${allowed.join(", ")}`);
}

function finiteNumber(value, trail, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  invariant(Number.isFinite(value) && value >= min && value <= max, `${trail} must be a finite number in [${min}, ${max}]`);
}

function integer(value, trail, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, `${trail} must be an integer in [${min}, ${max}]`);
}

function text(value, trail, { min = 0, max = 500 } = {}) {
  invariant(typeof value === "string" && value.length >= min && value.length <= max, `${trail} must be a string with length ${min}..${max}`);
}

function isoDate(value, trail, { nullable = false } = {}) {
  if (nullable && value === null) return;
  text(value, trail, { min: 20, max: 40 });
  invariant(Number.isFinite(Date.parse(value)), `${trail} must be an ISO timestamp`);
  invariant(new Date(value).toISOString() === value, `${trail} must be a canonical ISO timestamp`);
}

function inspectPrivacy(value, trail = "snapshot") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPrivacy(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      invariant(!BLOCKED_KEY.test(key), `private key ${trail}.${key}`);
      inspectPrivacy(child, `${trail}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  invariant(!EMBEDDED_URL.test(value), `URL at ${trail}`);
  invariant(!SLACK_TOKEN.test(value), `Slack token at ${trail}`);
  invariant(!SLACK_IDENTIFIER.test(value), `Slack identifier at ${trail}`);
}

function validateTaste(taste, trail, contract) {
  exactKeys(taste, [
    "alpha", "beta", "bias", "confidence", "evidenceWeight", "intervalHigh", "intervalLow", "mean", "sources",
  ], trail);
  finiteNumber(taste.alpha, `${trail}.alpha`, { min: contract.priorAlpha });
  finiteNumber(taste.beta, `${trail}.beta`, { min: contract.priorBeta });
  finiteNumber(taste.mean, `${trail}.mean`, { min: 0, max: 1 });
  finiteNumber(taste.bias, `${trail}.bias`, { min: -1, max: 1 });
  finiteNumber(taste.evidenceWeight, `${trail}.evidenceWeight`, { min: 0 });
  finiteNumber(taste.confidence, `${trail}.confidence`, { min: 0, max: 1 });
  finiteNumber(taste.intervalLow, `${trail}.intervalLow`, { min: 0, max: taste.mean });
  finiteNumber(taste.intervalHigh, `${trail}.intervalHigh`, { min: taste.mean, max: 1 });
  exactKeys(taste.sources, ["mealNegative", "mealPositive", "surveyNegative", "surveyPositive"], `${trail}.sources`);
  for (const [key, amount] of Object.entries(taste.sources)) finiteNumber(amount, `${trail}.sources.${key}`, { min: 0 });
}

function validateAvailability(menu, generatedTime, trail) {
  const dateFields = ["availabilityCheckedAt", "availabilityExpiresAt", "priceCheckedAt", "priceExpiresAt"];
  for (const field of dateFields) isoDate(menu[field], `${trail}.${field}`, { nullable: true });
  invariant(typeof menu.availableNow === "boolean", `${trail}.availableNow must be boolean`);
  if (menu.deliveryStatus === null) {
    invariant(menu.deliveryFreshness === null, `${trail} without delivery evidence must not carry delivery freshness`);
    invariant(menu.availabilityCheckedAt === null && menu.availabilityExpiresAt === null, `${trail} without delivery evidence must not carry delivery timestamps`);
  } else {
    invariant(menu.deliveryStatus === "verified" || menu.deliveryStatus === "likely", `${trail}.deliveryStatus is invalid`);
    invariant(menu.deliveryFreshness === "current" || menu.deliveryFreshness === "recent", `${trail}.deliveryFreshness is invalid`);
    invariant(menu.availabilityCheckedAt !== null && menu.availabilityExpiresAt !== null, `${trail} delivery evidence requires timestamps`);
    invariant(Date.parse(menu.availabilityCheckedAt) <= Date.parse(menu.availabilityExpiresAt), `${trail} availability interval is reversed`);
    invariant(Date.parse(menu.availabilityExpiresAt) >= generatedTime, `${trail} availability is already expired`);
  }
  if (!menu.availableNow) {
    invariant(menu.priceCheckedAt === null && menu.priceExpiresAt === null, `${trail} unavailable records must not carry current price timestamps`);
    invariant(!menu.sources.includes("verified"), `${trail} unavailable records must not claim a verified source`);
    return;
  }
  invariant(menu.deliveryFreshness === "current", `${trail} available records require current delivery evidence`);
  invariant(menu.priceCheckedAt !== null && menu.priceExpiresAt !== null, `${trail} available records require price timestamps`);
  invariant(menu.sources.includes("verified"), `${trail} available records require a verified source`);
  invariant(Date.parse(menu.priceCheckedAt) <= Date.parse(menu.priceExpiresAt), `${trail} price interval is reversed`);
  invariant(Date.parse(menu.priceExpiresAt) >= generatedTime, `${trail} price is already expired`);
}

export function validateSnapshot(snapshot) {
  const contract = algorithmContract();
  inspectPrivacy(snapshot);
  exactKeys(snapshot, [
    "algorithm", "cooccurrenceEdges", "displayOnly", "generatedAt", "menus", "recommendationEvents", "restaurants", "schemaVersion", "source", "stats", "taxonomy",
  ], "snapshot");
  invariant(snapshot.schemaVersion === 2, "schemaVersion must be 2");
  isoDate(snapshot.generatedAt, "snapshot.generatedAt");
  const generatedTime = Date.parse(snapshot.generatedAt);

  exactKeys(snapshot.source, ["privacy", "project", "releaseVersion", "sourceFingerprint"], "snapshot.source");
  invariant(snapshot.source.project === "ojeommwo-v2", "source.project must be ojeommwo-v2");
  text(snapshot.source.releaseVersion, "snapshot.source.releaseVersion", { min: 1, max: 40 });
  invariant(HEX_64.test(snapshot.source.sourceFingerprint), "sourceFingerprint must be a full lowercase SHA-256 digest");
  invariant(snapshot.source.privacy === "sanitized-aggregate-only", "privacy contract must be explicit");

  exactKeys(snapshot.algorithm, [
    "candidatePreferenceWeight", "contractFingerprint", "displayUsesStablePosteriorMean", "explorationRate", "posterior", "priorAlpha", "priorBeta", "tasteHalfLifeDays",
  ], "snapshot.algorithm");
  invariant(snapshot.algorithm.posterior === "beta", "algorithm.posterior must be beta");
  invariant(
    snapshot.algorithm.priorAlpha === contract.priorAlpha
      && snapshot.algorithm.priorBeta === contract.priorBeta,
    `algorithm prior must match the parent Beta(${contract.priorAlpha},${contract.priorBeta}) contract`,
  );
  invariant(snapshot.algorithm.tasteHalfLifeDays === contract.tasteHalfLifeDays, "taste half-life must match the parent contract");
  invariant(snapshot.algorithm.candidatePreferenceWeight === contract.candidatePreferenceWeight, "candidate preference weight must match the parent contract");
  invariant(snapshot.algorithm.explorationRate === contract.explorationRate, "taste exploration rate must match the parent contract");
  invariant(snapshot.algorithm.displayUsesStablePosteriorMean === true, "display must use the stable posterior mean");
  invariant(
    snapshot.algorithm.contractFingerprint === contract.contractFingerprint,
    "algorithm contractFingerprint must match the directly imported parent contract",
  );

  exactKeys(snapshot.displayOnly, ["tasteGravity"], "snapshot.displayOnly");
  invariant(Array.isArray(snapshot.displayOnly.tasteGravity), "displayOnly.tasteGravity must be an array");
  for (const [index, item] of snapshot.displayOnly.tasteGravity.entries()) {
    const trail = `snapshot.displayOnly.tasteGravity[${index}]`;
    exactKeys(item, ["algorithmImpact", "category", "id", "menu", "note", "restaurantLabel", "score"], trail);
    text(item.id, `${trail}.id`, { min: 1, max: 100 });
    text(item.restaurantLabel, `${trail}.restaurantLabel`, { min: 1, max: 120 });
    text(item.menu, `${trail}.menu`, { min: 1, max: 120 });
    invariant(FOOD_CATEGORIES.includes(item.category), `${trail}.category must be canonical`);
    invariant(item.score === 0, `${trail}.score must be display-only zero`);
    invariant(item.algorithmImpact === false, `${trail}.algorithmImpact must be false`);
    text(item.note, `${trail}.note`, { min: 1, max: 180 });
  }

  invariant(Array.isArray(snapshot.taxonomy) && snapshot.taxonomy.length === FOOD_CATEGORIES.length, "taxonomy must contain every canonical category");
  const taxonomyIds = [];
  for (const [index, item] of snapshot.taxonomy.entries()) {
    const trail = `snapshot.taxonomy[${index}]`;
    exactKeys(item, ["color", "emoji", "glow", "id"], trail);
    invariant(item.id === FOOD_CATEGORIES[index], `${trail}.id must preserve the canonical category order`);
    text(item.emoji, `${trail}.emoji`, { min: 1, max: 8 });
    invariant(/^#[a-f0-9]{6}$/iu.test(item.color) && /^#[a-f0-9]{6}$/iu.test(item.glow), `${trail} colors must be six-digit hex`);
    taxonomyIds.push(item.id);
  }

  exactKeys(snapshot.stats, [
    "categoryCounts", "freshCandidates", "mealEvents", "menus", "preferenceRatings", "preferenceResponses", "ratingDistribution", "recommendationItems", "recommendationMessages", "restaurants", "sentMessages", "timelineEnd", "timelineStart",
  ], "snapshot.stats");
  for (const key of ["freshCandidates", "mealEvents", "menus", "preferenceRatings", "preferenceResponses", "recommendationItems", "recommendationMessages", "restaurants", "sentMessages"]) {
    integer(snapshot.stats[key], `snapshot.stats.${key}`);
  }
  exactKeys(snapshot.stats.categoryCounts, taxonomyIds, "snapshot.stats.categoryCounts");
  for (const category of taxonomyIds) integer(snapshot.stats.categoryCounts[category], `snapshot.stats.categoryCounts.${category}`);
  exactKeys(snapshot.stats.ratingDistribution, ["1", "2", "3", "4", "5"], "snapshot.stats.ratingDistribution");
  for (const rating of ["1", "2", "3", "4", "5"]) integer(snapshot.stats.ratingDistribution[rating], `snapshot.stats.ratingDistribution.${rating}`);
  isoDate(snapshot.stats.timelineStart, "snapshot.stats.timelineStart");
  isoDate(snapshot.stats.timelineEnd, "snapshot.stats.timelineEnd");
  invariant(Date.parse(snapshot.stats.timelineStart) <= Date.parse(snapshot.stats.timelineEnd), "timeline is reversed");

  invariant(Array.isArray(snapshot.menus) && snapshot.menus.length > 0, "menus must be a non-empty array");
  const menuIds = new Set();
  const canonicalMenus = new Set();
  for (const [index, menu] of snapshot.menus.entries()) {
    const trail = `snapshot.menus[${index}]`;
    exactKeys(menu, [
      "availabilityCheckedAt", "availabilityExpiresAt", "availableNow", "averageSurveyRating", "branch", "category", "comment", "deliveryFreshness", "deliveryStatus", "firstRecommendedAt", "id", "ingredientFamilies", "lastRecommendedAt", "mealEventCount", "menu", "occurrences", "priceCheckedAt", "priceExpiresAt", "priceText", "restaurant", "restaurantId", "restaurantLabel", "sources", "surveyCount", "taste",
    ], trail);
    invariant(IDENTIFIER.test(menu.id) && menu.id.startsWith("menu_"), `${trail}.id is invalid`);
    invariant(!menuIds.has(menu.id), `${trail}.id is duplicated`);
    menuIds.add(menu.id);
    invariant(IDENTIFIER.test(menu.restaurantId) && menu.restaurantId.startsWith("restaurant_"), `${trail}.restaurantId is invalid`);
    text(menu.restaurant, `${trail}.restaurant`, { min: 1, max: 120 });
    text(menu.branch, `${trail}.branch`, { max: 80 });
    text(menu.restaurantLabel, `${trail}.restaurantLabel`, { min: 1, max: 201 });
    text(menu.menu, `${trail}.menu`, { min: 1, max: 120 });
    invariant(taxonomyIds.includes(menu.category), `${trail}.category is invalid`);
    // U+001F is an internal field separator; all other punctuation is intentionally removed.
    // eslint-disable-next-line no-control-regex
    const canonical = `${menu.restaurant}\u001f${menu.branch}\u001f${menu.menu}`.toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}\u001f]/gu, "");
    invariant(!canonicalMenus.has(canonical), `${trail} duplicates a restaurant/branch/menu tuple`);
    canonicalMenus.add(canonical);
    text(menu.priceText, `${trail}.priceText`, { min: 1, max: 60 });
    text(menu.comment, `${trail}.comment`, { max: 240 });
    invariant(Array.isArray(menu.ingredientFamilies) && menu.ingredientFamilies.length >= 1 && menu.ingredientFamilies.length <= MAX_INGREDIENT_SEARCH_TAGS, `${trail}.ingredientFamilies is invalid`);
    invariant(new Set(menu.ingredientFamilies).size === menu.ingredientFamilies.length, `${trail}.ingredientFamilies contains duplicates`);
    menu.ingredientFamilies.forEach((item, itemIndex) => {
      text(item, `${trail}.ingredientFamilies[${itemIndex}]`, { min: 1, max: 40 });
      invariant(INGREDIENT_SEARCH_TAG_SET.has(item), `${trail}.ingredientFamilies[${itemIndex}] is not canonical`);
    });
    integer(menu.occurrences, `${trail}.occurrences`);
    isoDate(menu.firstRecommendedAt, `${trail}.firstRecommendedAt`, { nullable: true });
    isoDate(menu.lastRecommendedAt, `${trail}.lastRecommendedAt`, { nullable: true });
    invariant((menu.firstRecommendedAt === null) === (menu.lastRecommendedAt === null), `${trail} recommendation dates must both be null or both be present`);
    if (menu.firstRecommendedAt) invariant(Date.parse(menu.firstRecommendedAt) <= Date.parse(menu.lastRecommendedAt), `${trail} recommendation dates are reversed`);
    integer(menu.mealEventCount, `${trail}.mealEventCount`);
    integer(menu.surveyCount, `${trail}.surveyCount`);
    if (menu.averageSurveyRating !== null) finiteNumber(menu.averageSurveyRating, `${trail}.averageSurveyRating`, { min: 1, max: 5 });
    invariant(Array.isArray(menu.sources) && menu.sources.length > 0 && new Set(menu.sources).size === menu.sources.length, `${trail}.sources is invalid`);
    menu.sources.forEach((source) => invariant(SOURCE_KINDS.has(source), `${trail}.sources contains an unknown value`));
    validateAvailability(menu, generatedTime, trail);
    validateTaste(menu.taste, `${trail}.taste`, contract);
  }

  invariant(Array.isArray(snapshot.restaurants), "restaurants must be an array");
  const restaurantIds = new Set();
  for (const [index, restaurant] of snapshot.restaurants.entries()) {
    const trail = `snapshot.restaurants[${index}]`;
    exactKeys(restaurant, ["branches", "categories", "id", "menuCount", "name", "occurrences"], trail);
    invariant(IDENTIFIER.test(restaurant.id) && restaurant.id.startsWith("restaurant_"), `${trail}.id is invalid`);
    invariant(!restaurantIds.has(restaurant.id), `${trail}.id is duplicated`);
    restaurantIds.add(restaurant.id);
    text(restaurant.name, `${trail}.name`, { min: 1, max: 120 });
    invariant(Array.isArray(restaurant.branches) && new Set(restaurant.branches).size === restaurant.branches.length, `${trail}.branches is invalid`);
    restaurant.branches.forEach((branch, branchIndex) => text(branch, `${trail}.branches[${branchIndex}]`, { min: 1, max: 80 }));
    integer(restaurant.menuCount, `${trail}.menuCount`, { min: 1 });
    integer(restaurant.occurrences, `${trail}.occurrences`);
    invariant(Array.isArray(restaurant.categories) && restaurant.categories.every((category) => taxonomyIds.includes(category)), `${trail}.categories is invalid`);
  }
  for (const menu of snapshot.menus) invariant(restaurantIds.has(menu.restaurantId), `menu ${menu.id} references an unknown restaurant`);

  invariant(Array.isArray(snapshot.recommendationEvents), "recommendationEvents must be an array");
  const eventIds = new Set();
  for (const [index, event] of snapshot.recommendationEvents.entries()) {
    const trail = `snapshot.recommendationEvents[${index}]`;
    exactKeys(event, ["id", "mealType", "menuIds", "recommendedAt"], trail);
    invariant(IDENTIFIER.test(event.id) && event.id.startsWith("recommendation_"), `${trail}.id is invalid`);
    invariant(!eventIds.has(event.id), `${trail}.id is duplicated`);
    eventIds.add(event.id);
    isoDate(event.recommendedAt, `${trail}.recommendedAt`);
    text(event.mealType, `${trail}.mealType`, { min: 1, max: 20 });
    invariant(Array.isArray(event.menuIds) && event.menuIds.length >= 1 && event.menuIds.length <= 5 && new Set(event.menuIds).size === event.menuIds.length, `${trail}.menuIds is invalid`);
    event.menuIds.forEach((id) => invariant(menuIds.has(id), `${trail} references an unknown menu`));
  }

  invariant(Array.isArray(snapshot.cooccurrenceEdges), "cooccurrenceEdges must be an array");
  const edgeIds = new Set();
  for (const [index, edge] of snapshot.cooccurrenceEdges.entries()) {
    const trail = `snapshot.cooccurrenceEdges[${index}]`;
    exactKeys(edge, ["count", "source", "target"], trail);
    invariant(menuIds.has(edge.source) && menuIds.has(edge.target) && edge.source !== edge.target, `${trail} references invalid menus`);
    integer(edge.count, `${trail}.count`, { min: 1 });
    const key = [edge.source, edge.target].sort().join(":");
    invariant(!edgeIds.has(key), `${trail} duplicates an edge`);
    edgeIds.add(key);
  }

  invariant(snapshot.stats.menus === snapshot.menus.length, "stats.menus must match menus.length");
  invariant(snapshot.stats.restaurants === snapshot.restaurants.length, "stats.restaurants must match restaurants.length");
  invariant(snapshot.stats.recommendationMessages === snapshot.recommendationEvents.length, "stats.recommendationMessages must match events.length");
  invariant(snapshot.stats.freshCandidates === snapshot.menus.filter((menu) => menu.availableNow).length, "stats.freshCandidates must match available menus");
  invariant(snapshot.stats.recommendationItems === snapshot.menus.reduce((sum, menu) => sum + menu.occurrences, 0), "stats.recommendationItems must match menu occurrences");
  invariant(snapshot.stats.preferenceRatings === Object.values(snapshot.stats.ratingDistribution).reduce((sum, count) => sum + count, 0), "preferenceRatings must match ratingDistribution");
  for (const category of taxonomyIds) {
    invariant(snapshot.stats.categoryCounts[category] === snapshot.menus.filter((menu) => menu.category === category).length, `categoryCounts.${category} is incorrect`);
  }
  for (const restaurant of snapshot.restaurants) {
    const related = snapshot.menus.filter((menu) => menu.restaurantId === restaurant.id);
    invariant(restaurant.menuCount === related.length, `restaurant ${restaurant.id} menuCount is incorrect`);
    invariant(restaurant.occurrences === related.reduce((sum, menu) => sum + menu.occurrences, 0), `restaurant ${restaurant.id} occurrences are incorrect`);
  }
  return snapshot;
}
