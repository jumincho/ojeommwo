import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { stampCategoryAdjudication } from "../../src/category-arbitration.js";
import { withJsonStoreLockAt } from "../../src/storage.js";
import {
  BOT_CONTRACT_SOURCE_FILES,
  BOT_ROOT,
  algorithmContract,
  config,
  expandMealEvents,
  hasCurrentDeterministicEvidence,
  isLearningCandidatePreferenceResponse,
  isLearningMealEvent,
  isLearningRecommendationHistoryItem,
  isExcludedMealCandidate,
  normalizeVerifiedCandidate,
  tastePosterior,
} from "../scripts/lib/bot-contract.mjs";
import {
  SNAPSHOT_INPUT_FILES,
  TAXONOMY,
  TASTE_GRAVITY_EASTER_EGGS,
  buildSnapshot,
  candidateKey,
  categoryFor,
  dedupeActiveCandidates,
  dedupeCurrentPrices,
  dedupeRecentDeliveryByRestaurant,
  normalizeKey,
  OBSERVATORY_RECENT_DELIVERY_TTL_DAYS,
  preferredIngredientFamilies,
  restaurantBranchKey,
  snapshotSourceFingerprint,
} from "../scripts/lib/observatory-snapshot.mjs";
import { validateSnapshot } from "../scripts/lib/snapshot-schema.mjs";

// Freeze the complete operating input before fixing the test clock. Later
// scheduled refreshes must not mix newly checked rows with an older suite
// timestamp, or invalidate the same-input determinism assertion.
const liveDataDir = path.resolve(process.env.OJEOMMWO_DATA_DIR || path.join(BOT_ROOT, "data"));
const suiteFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-snapshot-suite-"));
const dataDir = path.join(suiteFixtureRoot, "data");
fs.mkdirSync(dataDir);
const fixtureFiles = [...new Set([
  ...SNAPSHOT_INPUT_FILES, "coffee-participation.json", "delivery-outbox.json",
])].sort();
function captureFixture(index = 0) {
  if (index < fixtureFiles.length) {
    return withJsonStoreLockAt(liveDataDir, fixtureFiles[index], () => captureFixture(index + 1));
  }
  for (const name of fixtureFiles) {
    fs.copyFileSync(path.join(liveDataDir, name), path.join(dataDir, name));
  }
  fs.copyFileSync(path.join(BOT_ROOT, "package.json"), path.join(suiteFixtureRoot, "package.json"));
}
try {
  captureFixture();
} catch (error) {
  fs.rmSync(suiteFixtureRoot, { recursive: true, force: true });
  throw error;
}
const generatedAt = new Date().toISOString();
after(() => fs.rmSync(suiteFixtureRoot, { recursive: true, force: true }));

function readJson(name, directory = dataDir) {
  return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
}

function allKeys(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, result);
    return result;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      result.push(key);
      allKeys(nested, result);
    }
  }
  return result;
}

function menuByKey(snapshot) {
  return new Map(snapshot.menus.map((menu) => [candidateKey(menu.restaurant, menu.menu, menu.branch), menu]));
}

function copyOperatingFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-observatory-data-"));
  const fixtureData = path.join(root, "data");
  fs.mkdirSync(fixtureData);
  for (const name of [
    ...SNAPSHOT_INPUT_FILES,
    "coffee-participation.json",
    "delivery-outbox.json",
  ]) {
    fs.copyFileSync(path.join(dataDir, name), path.join(fixtureData, name));
  }
  fs.copyFileSync(path.join(suiteFixtureRoot, "package.json"), path.join(root, "package.json"));
  return { root, dataDir: fixtureData };
}

test("snapshot v2 is a complete canonical projection and passes the strict whitelist", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.generatedAt, generatedAt);
  assert.equal(snapshot.stats.menus, snapshot.menus.length);
  assert.equal(snapshot.stats.restaurants, snapshot.restaurants.length);
  assert.equal(snapshot.stats.recommendationMessages, snapshot.recommendationEvents.length);
  assert.ok(snapshot.menus.length >= 100);
  assert.ok(snapshot.stats.recommendationItems >= 250);
  assert.match(snapshot.source.sourceFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(snapshot.algorithm.contractFingerprint, /^[a-f0-9]{64}$/u);
  const contract = algorithmContract();
  assert.equal(snapshot.algorithm.priorAlpha, contract.priorAlpha);
  assert.equal(snapshot.algorithm.priorBeta, contract.priorBeta);

  const allowed = new Set(TAXONOMY.map((item) => item.id));
  const menuIds = new Set();
  const menuKeys = new Set();
  for (const menu of snapshot.menus) {
    assert.ok(allowed.has(menu.category));
    assert.ok(!menuIds.has(menu.id));
    menuIds.add(menu.id);
    const key = candidateKey(menu.restaurant, menu.menu, menu.branch);
    assert.ok(!menuKeys.has(key), `duplicate canonical menu: ${key}`);
    menuKeys.add(key);
    assert.ok(menu.taste.alpha >= contract.priorAlpha);
    assert.ok(menu.taste.beta >= contract.priorBeta);
    assert.ok(menu.taste.mean >= 0 && menu.taste.mean <= 1);
    assert.ok(menu.taste.intervalLow >= 0 && menu.taste.intervalLow <= menu.taste.mean);
    assert.ok(menu.taste.intervalHigh <= 1 && menu.taste.intervalHigh >= menu.taste.mean);
  }
  for (const event of snapshot.recommendationEvents) {
    assert.ok(event.menuIds.length >= 1 && event.menuIds.length <= 5);
    assert.ok(event.menuIds.every((id) => menuIds.has(id)));
  }
});

test("restaurant-scoped live menu renames collapse across every projection source", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  const gwangjang = snapshot.menus.filter((menu) => menu.restaurant === "광장수산");
  const luochongqing = snapshot.menus.filter((menu) => normalizeKey(menu.restaurant) === "로충칭마라탕");

  assert.equal(gwangjang.filter((menu) => ["광어", "광어(소)"].includes(menu.menu)).length, 1);
  assert.ok(gwangjang.some((menu) => menu.menu === "광어(소)"));
  assert.equal(luochongqing.filter((menu) => ["마라탕", "마라탕 1인"].includes(menu.menu)).length, 1);
  assert.ok(luochongqing.some((menu) => menu.menu === "마라탕 1인"));
});

test("Subway cucumber is score zero and remains isolated from every operational namespace", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  assert.deepEqual(snapshot.displayOnly.tasteGravity, TASTE_GRAVITY_EASTER_EGGS);
  assert.deepEqual(snapshot.displayOnly.tasteGravity, [{
    id: "taste_easter_egg_subway_cucumber",
    restaurantLabel: "서브웨이",
    menu: "오이샌드위치",
    category: "샌드위치",
    score: 0,
    algorithmImpact: false,
    note: "연구실 공식 금지 메뉴입니다.",
  }]);
  assert.equal(snapshot.menus.some((menu) => menu.restaurant === "서브웨이" && menu.menu === "오이샌드위치"), false);
  assert.equal(snapshot.restaurants.some((restaurant) => restaurant.name === "서브웨이"), false);
  assert.equal(snapshot.recommendationEvents.some((event) => event.menuIds.includes("taste_easter_egg_subway_cucumber")), false);
  assert.equal(snapshot.cooccurrenceEdges.some((edge) => edge.source === "taste_easter_egg_subway_cucumber" || edge.target === "taste_easter_egg_subway_cucumber"), false);
});

test("legacy records map into the bot-owned 19-category taxonomy or are excluded as non-meals", () => {
  const history = readJson("recommendation-history.json");
  const allowed = new Set(TAXONOMY.map((item) => item.id));
  for (const item of history.items) {
    const category = categoryFor(item);
    if (isExcludedMealCandidate(item)) assert.equal(category, null);
    else assert.ok(allowed.has(category), `${item.category}/${item.restaurant}/${item.menu}`);
  }
});

test("private tests, unverified meals, and respondentless surveys are excluded everywhere", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  const menus = menuByKey(snapshot);
  const history = readJson("recommendation-history.json").items;
  const learningHistory = history.filter(isLearningRecommendationHistoryItem);
  const historyGroups = new Map();
  for (const item of learningHistory) {
    const key = `${item.channel}:${item.messageTs}`;
    if (!historyGroups.has(key)) historyGroups.set(key, []);
    historyGroups.get(key).push(item);
  }
  const eligibleLearningHistory = [...historyGroups.values()]
    .filter((group) => group.every((item) => categoryFor(item)))
    .flat();
  const expectedHistory = new Map();
  for (const item of eligibleLearningHistory) {
    const key = candidateKey(item.restaurant, item.menu, item.branch);
    expectedHistory.set(key, (expectedHistory.get(key) || 0) + 1);
  }
  for (const menu of snapshot.menus) {
    assert.equal(menu.occurrences, expectedHistory.get(candidateKey(menu.restaurant, menu.menu, menu.branch)) || 0);
  }
  for (const item of history.filter((entry) => !isLearningRecommendationHistoryItem(entry))) {
    const menu = menus.get(candidateKey(item.restaurant, item.menu, item.branch));
    assert.equal(menu?.occurrences || 0, expectedHistory.get(candidateKey(item.restaurant, item.menu, item.branch)) || 0);
  }
  assert.equal(snapshot.stats.recommendationItems, eligibleLearningHistory.length);

  const mealEvents = readJson("meal-events.json").events;
  const expectedMeals = new Map();
  for (const item of expandMealEvents(mealEvents.filter(isLearningMealEvent))) {
    const key = candidateKey(item.restaurant, item.menu, item.branch);
    expectedMeals.set(key, (expectedMeals.get(key) || 0) + 1);
  }
  for (const menu of snapshot.menus) {
    assert.equal(menu.mealEventCount, expectedMeals.get(candidateKey(menu.restaurant, menu.menu, menu.branch)) || 0);
  }
  assert.equal(snapshot.stats.mealEvents, mealEvents.filter(isLearningMealEvent).length);

  const responses = readJson("candidate-preferences.json").responses;
  assert.ok(responses.some((response) => !response.respondentId), "fixture must exercise respondentless legacy data");
  assert.equal(snapshot.stats.preferenceResponses, responses.filter(isLearningCandidatePreferenceResponse).length);
});

test("displayed posterior is the rounded canonical production posterior for every menu", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  const mealStore = readJson("meal-events.json");
  const preferenceStore = readJson("candidate-preferences.json");
  const now = new Date(generatedAt);
  for (const menu of snapshot.menus) {
    const production = tastePosterior({
      category: menu.category,
      restaurant: menu.restaurant,
      menu: menu.menu,
    }, {
      events: mealStore.events,
      preferences: preferenceStore,
      halfLifeDays: config.tasteHalfLifeDays,
      preferenceWeight: config.candidatePreferenceWeight,
      now,
    });
    for (const field of ["alpha", "beta", "mean", "bias", "evidenceWeight", "confidence", "intervalLow", "intervalHigh"]) {
      assert.ok(Math.abs(production[field] - menu.taste[field]) < 0.00001, `${menu.restaurant}/${menu.menu} ${field}`);
    }
    for (const field of ["mealPositive", "mealNegative", "surveyPositive", "surveyNegative"]) {
      assert.ok(Math.abs(production.sources[field] - menu.taste.sources[field]) < 0.00001, `${menu.restaurant}/${menu.menu} ${field}`);
    }
  }
});

test("only active deterministic candidates provide availability and current price metadata", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  const menus = menuByKey(snapshot);
  const now = new Date(generatedAt);
  const rawCandidates = readJson("verified-candidates.json").candidates;
  const active = rawCandidates.map((candidate) => ({
    raw: candidate,
    normalized: normalizeVerifiedCandidate(candidate, { now }),
  })).filter(({ raw, normalized }) => normalized && hasCurrentDeterministicEvidence(raw, { now }));
  assert.equal(snapshot.stats.freshCandidates, active.length);
  assert.equal(snapshot.menus.filter((menu) => menu.availableNow).length, active.length);
  for (const { raw, normalized } of active) {
    const menu = menus.get(candidateKey(
      normalized.restaurant,
      normalized.menu,
      normalized.branch
    ));
    assert.ok(menu, `${raw.restaurant}/${raw.menu} is missing`);
    assert.equal(menu.availableNow, true);
    assert.equal(menu.deliveryStatus, raw.deliveryStatus === "verified" ? "verified" : "likely");
    assert.equal(menu.deliveryFreshness, "current");
    assert.equal(menu.priceText, raw.priceText);
    assert.equal(menu.availabilityCheckedAt, new Date(raw.deliveryCheckedAt).toISOString());
    assert.equal(menu.priceCheckedAt, new Date(raw.priceCheckedAt).toISOString());
    assert.ok(Date.parse(menu.availabilityExpiresAt) >= now.getTime());
    assert.ok(Date.parse(menu.priceExpiresAt) >= now.getTime());
    assert.equal(menu.sources.includes("verified"), true);
  }
  for (const menu of snapshot.menus.filter((item) => !item.availableNow)) {
    assert.equal(menu.priceCheckedAt, null);
    assert.equal(menu.priceExpiresAt, null);
    assert.equal(menu.sources.includes("verified"), false);
    if (menu.deliveryStatus === null) {
      assert.equal(menu.deliveryFreshness, null);
      assert.equal(menu.availabilityCheckedAt, null);
      assert.equal(menu.availabilityExpiresAt, null);
    } else {
      assert.ok(["verified", "likely"].includes(menu.deliveryStatus));
      assert.ok(["current", "recent"].includes(menu.deliveryFreshness));
      assert.ok(Date.parse(menu.availabilityExpiresAt) >= now.getTime());
    }
  }
  assert.ok(
    snapshot.menus.some((menu) => !menu.availableNow && menu.deliveryStatus),
    "recent branch-level delivery evidence should cover menus outside the active candidate pool",
  );
});

test("recent catalog delivery evidence is branch-level, bounded, and expires", () => {
  const catalog = readJson("verified-candidates.json").catalog;
  const sample = catalog.find((candidate) => candidate.deliveryCheckedAt);
  assert.ok(sample, "fixture must contain a catalog delivery record");
  const checkedAt = Date.parse(sample.deliveryCheckedAt);
  const withinWindow = new Date(checkedAt + 10 * 86_400_000);
  const expired = new Date(checkedAt + (OBSERVATORY_RECENT_DELIVERY_TTL_DAYS + 1) * 86_400_000);

  const current = dedupeRecentDeliveryByRestaurant([sample], withinWindow);
  assert.equal(current.size, 1);
  assert.ok(current.has(restaurantBranchKey(sample.restaurant, sample.branch)));
  assert.equal(dedupeRecentDeliveryByRestaurant([sample], expired).size, 0);
});

test("active candidates are deduplicated by canonical branch-aware key using strongest then newest evidence", () => {
  const original = readJson("verified-candidates.json").candidates[0];
  const older = structuredClone(original);
  const olderTime = new Date(Date.parse(original.evidenceVerifiedAt) - 60_000).toISOString();
  older.evidenceVerifiedAt = olderTime;
  older.deliveryCheckedAt = olderTime;
  older.priceCheckedAt = olderTime;
  older.priceText = "7,400원";

  const strongest = structuredClone(older);
  strongest.deliveryStatus = "verified";
  strongest.deliveryEvidenceUrl = "https://www.baemin.com/store";
  strongest.priceText = "7,300원";

  const newestSelection = dedupeActiveCandidates([older, original], new Date(generatedAt));
  assert.equal(newestSelection.size, 1);
  assert.equal([...newestSelection.values()][0].priceText, original.priceText);

  const strongestSelection = dedupeActiveCandidates([original, strongest], new Date(generatedAt));
  assert.equal(strongestSelection.size, 1);
  assert.equal([...strongestSelection.values()][0].priceText, strongest.priceText);
});

test("canonical menu identity includes branch", () => {
  assert.notEqual(
    candidateKey("가게", "대표 메뉴", "전북대점"),
    candidateKey("가게", "대표 메뉴", "전주점"),
  );
  assert.equal(
    candidateKey("가게 전북대점", "대표 메뉴"),
    candidateKey("가게", "대표 메뉴", "전북대점"),
  );
  assert.equal(
    candidateKey("후토루", "연어후토마끼", "전북대점"),
    candidateKey("후토루", "연어 후토마키", "전북대점"),
  );
});

test("ingredient family authority uses the first non-empty canonical record without stale unions", () => {
  const active = { ingredientFamilies: ["beef"] };
  const stale = { ingredientFamilies: ["pork", "offal"] };
  assert.deepEqual(preferredIngredientFamilies([active, stale]), ["beef"]);
  assert.deepEqual(preferredIngredientFamilies([undefined, { ingredientFamilies: [] }, stale]), ["pork", "offal"]);
  assert.deepEqual(preferredIngredientFamilies([undefined, { ingredientFamilies: [] }]), []);
});

test("full fingerprint changes for every input byte and the algorithm contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-observatory-fingerprint-"));
  try {
    for (const name of SNAPSHOT_INPUT_FILES) fs.copyFileSync(path.join(dataDir, name), path.join(root, name));
    const contract = algorithmContract();
    const baseline = snapshotSourceFingerprint(root, contract);
    assert.match(baseline, /^[a-f0-9]{64}$/u);
    for (const name of SNAPSHOT_INPUT_FILES) {
      const filePath = path.join(root, name);
      const original = fs.readFileSync(filePath);
      fs.appendFileSync(filePath, " ");
      assert.notEqual(snapshotSourceFingerprint(root, contract), baseline, `${name} did not affect fingerprint`);
      fs.writeFileSync(filePath, original);
    }
    assert.notEqual(snapshotSourceFingerprint(root, { ...contract, candidatePreferenceWeight: contract.candidatePreferenceWeight + 0.01 }), baseline);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("algorithm fingerprint covers every directly imported bot contract module", () => {
  assert.deepEqual(BOT_CONTRACT_SOURCE_FILES, [
    "src/taste-profile.js",
    "src/choice-diversity.js",
    "src/history-policy.js",
    "src/meal-event-items.js",
    "src/categories.js",
    "src/category-arbitration.js",
    "prompts/category-adjudication.schema.json",
    "src/verified-candidates.js",
    "src/recommendation-comment.js",
    "src/audited-location-branches.js",
    "src/operating-snapshot.js",
    "src/text.js",
    "src/config.js",
  ]);
  assert.deepEqual(Object.keys(algorithmContract().sourceFiles), [...BOT_CONTRACT_SOURCE_FILES]);
});

test("operating-store validation is a fail-closed precondition", () => {
  const fixture = copyOperatingFixture();
  try {
    const coffeePath = path.join(fixture.dataDir, "coffee-participation.json");
    const coffee = readJson("coffee-participation.json", fixture.dataDir);
    fs.writeFileSync(coffeePath, `${JSON.stringify({ ...coffee, version: 999 })}\n`);
    assert.throws(() => buildSnapshot({ dataDir: fixture.dataDir, generatedAt }), /coffee|snapshot|version/iu);
    fs.copyFileSync(path.join(dataDir, "coffee-participation.json"), coffeePath);

    const verifiedPath = path.join(fixture.dataDir, "verified-candidates.json");
    const verified = readJson("verified-candidates.json", fixture.dataDir);
    for (const candidate of verified.candidates) {
      candidate.priceCheckedAt = "2000-01-01T00:00:00.000Z";
      candidate.deliveryCheckedAt = "2000-01-01T00:00:00.000Z";
      candidate.evidenceVerifiedAt = "2000-01-01T00:00:00.000Z";
    }
    fs.writeFileSync(verifiedPath, `${JSON.stringify(verified)}\n`);
    assert.throws(() => buildSnapshot({ dataDir: fixture.dataDir, generatedAt }), /verified candidate|invalid active/iu);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("strict validator rejects unknown private keys and embedded secrets or URLs", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  const cases = [
    (value) => { value.menus[0].messageTs = "123.456"; },
    (value) => { value.menus[0].comment = "근거는 https://example.com/menu 입니다"; },
    (value) => { value.menus[0].comment = "담당 U0123456789 확인"; },
    (value) => { value.menus[0].comment = "token xoxb-not-a-real-secret"; },
    (value) => { value.source.sourceFingerprint = value.source.sourceFingerprint.slice(0, 16); },
    (value) => { value.algorithm.contractFingerprint = "0".repeat(64); },
    (value) => { value.algorithm.priorAlpha -= 1; },
    (value) => { value.menus[0].address = "private location"; },
  ];
  for (const mutate of cases) {
    const malicious = structuredClone(snapshot);
    mutate(malicious);
    assert.throws(() => validateSnapshot(malicious), /snapshot validation failed/u);
  }
});

test("snapshot excludes Slack targets, user identifiers, locations, evidence URLs, and test source labels", () => {
  const snapshot = buildSnapshot({ dataDir, generatedAt });
  const keys = allKeys(snapshot);
  const prohibited = /^(?:address|channel|messageTs|respondentId|userId|latitude|longitude|evidence|evidenceUrl|priceEvidenceUrl|deliveryEvidenceUrl)$/iu;
  assert.deepEqual(keys.filter((key) => prohibited.test(key)), []);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /\b[CDGUW][A-Z0-9]{8,}\b/u);
  assert.doesNotMatch(serialized, /xox[baprs]-|xapp-/iu);
  assert.doesNotMatch(serialized, /https?:\/\//iu);
  assert.doesNotMatch(serialized, /manual-private-test/u);
});

test("snapshot generation is deterministic for the same inputs and clock", () => {
  const first = buildSnapshot({ dataDir, generatedAt });
  const second = buildSnapshot({ dataDir, generatedAt });
  assert.deepEqual(second, first);
});


test("newer catalog prices win by exact menu identity while stale and unverified prices cannot replace them", () => {
  const clock = new Date(generatedAt);
  const original = readJson("verified-candidates.json").candidates.find((row) => (
    normalizeVerifiedCandidate(row, { now: clock }) && hasCurrentDeterministicEvidence(row, { now: clock })
  ));
  assert.ok(original);
  const older = structuredClone(original);
  older.priceText = "7,300원";
  older.priceCheckedAt = new Date(Date.parse(original.priceCheckedAt) - 60_000).toISOString();
  const current = structuredClone(original);
  current.priceText = "8,300원";
  const unverified = { ...current, priceText: "99,999원", evidenceVerifiedAt: "" };
  const stale = { ...current, priceText: "1,000원", priceCheckedAt: "2000-01-01T00:00:00.000Z" };
  const prices = dedupeCurrentPrices([older, current, unverified, stale], clock);
  assert.equal(prices.size, 1);
  assert.equal([...prices.values()][0].priceText, "8,300원");
  const key = candidateKey(current.restaurant, current.menu, current.branch);
  assert.ok(prices.has(key));
  assert.equal(prices.has(candidateKey(current.restaurant, `${current.menu} 다른 메뉴`, current.branch)), false);
});

test("semantic category adjudication survives every snapshot projection boundary", () => {
  const fixture = copyOperatingFixture();
  try {
    const row = stampCategoryAdjudication({
      restaurant: "분류검증 식당", menu: "돈까스샐러드", category: "샐러드",
    }, { category: "샐러드", now: new Date(generatedAt) });
    assert.equal(categoryFor(row), "샐러드");
    assert.equal(categoryFor({ ...row, menu: "불고기 피자", category: "한식" }), "피자");
    const file = path.join(fixture.dataDir, "recommendations.json");
    const source = JSON.parse(fs.readFileSync(file, "utf8"));
    // Static recommendations use the same record grouping and final selection
    // pipeline as historical and active candidates.
    const records = Array.isArray(source) ? source : source.items;
    records.push(row);
    fs.writeFileSync(file, JSON.stringify(source));
    const snapshot = buildSnapshot({ dataDir: fixture.dataDir, generatedAt });
    assert.equal(snapshot.menus.find((item) => item.restaurant === row.restaurant)?.category, "샐러드");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
