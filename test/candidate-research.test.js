import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCandidateResearchPrompt,
  buildVerifiedCandidateStore,
  CANDIDATE_ACTIVE_LIMIT,
  CANDIDATE_READINESS_INPUT_LIMIT,
  candidateReadinessPolicy,
  candidateEvidenceHorizonAt,
  candidateRefreshPreflight,
  hasCandidateReadiness,
  hasViableRecommendationSet,
  invalidateVerifiedCandidateStoreCandidates,
  removeUnavailableVerifiedCandidateStoreCandidates,
  isRetryableStructuredRunError,
  mergeCandidateCatalog,
  nextScheduledCandidateRefreshAt,
  nextScheduledSendAt,
  refreshVerifiedCandidates,
  saveVerifiedCandidateStore,
  selectCandidateCatalogBatch,
  updateVerifiedCandidateCatalog,
  validateResearchResult,
  validateVerifiedCandidateStoreEnvelope
} from "../src/candidate-research.js";
import { getCacheCandidates } from "../src/recommender.js";
import {
  parseCandidateRefreshArgs,
  runCandidateRefreshCli
} from "../scripts/refresh-verified-candidates.js";
import { readJsonAt, writeJsonAt } from "../src/storage.js";
import { normalizeKey } from "../src/text.js";
import { candidateIdFor } from "../src/verified-candidates.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

function candidate(index) {
  const categories = ["구이", "중식", "찜/탕", "치킨", "돈까스", "피자", "회/해물", "샌드위치", "버거", "도시락"];
  const categoryMenus = ["숯불구이", "짜장면", "갈비탕", "후라이드치킨", "등심돈까스", "페퍼로니피자", "연어초밥", "BLT샌드위치", "클래식버거", "정식도시락"];
  return {
    category: categories[index % categories.length],
    restaurant: `식당${index}`, branch: "전북대점", address: `전주시 테스트로 ${index}`,
    latitude: 35.848 + index / 10000, longitude: 127.134, menu: `${categoryMenus[index % categoryMenus.length]} ${index}`, priceText: "9,000원",
    ingredientFamilies: ["other"],
    priceChannel: "store", priceCheckedAt: "2026-07-11T00:00:00.000Z",
    deliveryStatus: "likely", deliveryCheckedAt: "2026-07-11T00:00:00.000Z",
    evidenceVerification: "deterministic-html", evidenceVerifiedAt: "2026-07-11T00:00:00.000Z",
    priceEvidenceUrl: `https://example.com/${index}/price`,
    deliveryEvidenceUrl: `https://example.com/${index}/delivery`,
    comment: "매콤한 양념이 재료에 고르게 배고 아삭한 채소 식감이 더해져, 한입마다 풍성한 맛을 즐길 수 있습니다.", evidence: [`https://example.com/${index}`]
  };
}

function freshCandidate(index, now = new Date("2026-07-13T00:00:00.000Z")) {
  return { ...candidate(index), priceCheckedAt: now.toISOString(), deliveryCheckedAt: now.toISOString(), evidenceVerifiedAt: now.toISOString() };
}

function* combinations(values, size, start = 0, picked = []) {
  if (picked.length === size) {
    yield picked;
    return;
  }
  const remainingNeeded = size - picked.length;
  for (let index = start; index <= values.length - remainingNeeded; index += 1) {
    yield* combinations(values, size, index + 1, [...picked, values[index]]);
  }
}

function bruteForceRobustCore(core) {
  let sawViableSelection = false;
  for (const selected of combinations(core, 3)) {
    if (!hasViableRecommendationSet(selected, 3)) continue;
    sawViableSelection = true;
    const selectedMembers = new Set(selected);
    const blockedRestaurants = new Set(selected.map((item) => normalizeKey(item.restaurant)));
    const blockedMenus = new Set(selected.map((item) => normalizeKey(item.menu)));
    const remaining = core.filter((item) =>
      !selectedMembers.has(item)
      && !blockedRestaurants.has(normalizeKey(item.restaurant))
      && !blockedMenus.has(normalizeKey(item.menu))
    );
    if (![...combinations(remaining, 3)].some((set) => hasViableRecommendationSet(set, 3))) {
      return false;
    }
  }
  return sawViableSelection;
}

function bruteForceMorningReadiness(candidates) {
  return [...combinations(candidates, 6)].some(bruteForceRobustCore);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("candidate research requires a fresh eligible pool", () => {
  const candidates = Array.from({ length: 3 }, (_, index) => candidate(index));
  assert.equal(validateResearchResult({ candidates }, { now: new Date("2026-07-12T00:00:00.000Z") }).length, 3);
  assert.throws(() => validateResearchResult({ candidates: candidates.slice(0, 2) }, { now: new Date("2026-07-12T00:00:00.000Z") }), /need 3/u);
  const prompt = buildCandidateResearchPrompt();
  assert.match(prompt, /신규 후보를 최소 3개, 목표 4개, 최대 5개/u);
  assert.match(prompt, /전체 웹 검색은 최대 10회/u);
  assert.match(prompt, /직선거리 0\.05km 이상 6km 이하/u);
  assert.match(prompt, /서로 다른 카테고리·상호·메뉴와 겹치지 않는 주재료 축 3개/u);
  assert.match(prompt, /같은 카테고리는 최대 2개/u);
  assert.match(prompt, /신규 후보 4개를 확보하면 최대 개수를 채우기 위한 추가 검색을 중단/u);
  assert.match(prompt, /반환 직전에 거리·가격·배달 근거·cooldown 제외·의미 다양성 조건을 직접 점검/u);
  assert.match(prompt, /likely 후보는 3km 이내를 우선/u);
  assert.match(prompt, /최소 수를 확보했다는 이유만으로 조사를 끝내지 말고/u);
  assert.match(prompt, /검색 결과 스니펫·검색엔진 캐시·도구 요약은 후보 발견에만/u);
  assert.match(prompt, /공급자 공통 홈\/검색 껍데기/u);
  assert.match(prompt, /단독 한 끼로 성립하는 메인 메뉴/u);
  assert.match(prompt, /https:\/\/www\.tabling\.co\.kr\/place/u);
  assert.match(prompt, /https:\/\/www\.diningcode\.com\/profile\.php\?rid=/u);
});

test("candidate catalog preserves an identity-bound model category adjudication", () => {
  const raw = candidate(0);
  const ambiguous = stampCategoryAdjudication({
    ...raw,
    category: "멕시칸",
    restaurant: "새로운식당",
    menu: "시그니처 보울",
  }, {
    category: "멕시칸",
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const [stored] = mergeCandidateCatalog([], [ambiguous]);
  assert.equal(stored.category, "멕시칸");
  assert.equal(stored.categoryAuthority, "model-adjudicated");
  assert.equal(stored.categoryAdjudicationKey, ambiguous.categoryAdjudicationKey);
});

test("candidate refresh reuses a ready candidate and asks the model only for the missing pool", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const ready = candidate(2);
  const prompt = buildCandidateResearchPrompt({ now, readyCandidates: [ready] });
  assert.match(prompt, /신규 후보를 최소 2개, 목표 3개, 최대 4개/u);
  assert.match(prompt, /준비 후보 1개/u);
  assert.match(prompt, /전체 웹 검색은 최대 8회/u);
  assert.match(prompt, /준비 후보를 재검색하거나 출력하지 말고/u);
  assert.match(prompt, /<UNTRUSTED_READY_CANDIDATES_JSON>/u);

  const store = buildVerifiedCandidateStore(
    { candidates: [candidate(0), candidate(1)] },
    { now, existingCandidates: [ready] }
  );
  assert.equal(store.candidates.length, 3);
  assert.equal(store.candidates.some((item) => item.restaurant === ready.restaurant), true);
  assert.equal(store.catalog.length, 3);
});

test("candidate refresh asks for only one new menu when two compatible candidates are ready", () => {
  const prompt = buildCandidateResearchPrompt({
    now: new Date("2026-07-12T00:00:00.000Z"),
    readyCandidates: [candidate(0), candidate(1)]
  });
  assert.match(prompt, /신규 후보를 최소 1개, 목표 2개, 최대 3개/u);
  assert.match(prompt, /신규 후보 2개를 확보하면 최대 개수를 채우기 위한 추가 검색을 중단/u);
  assert.match(prompt, /전체 웹 검색은 최대 6회/u);
});

test("every weekday research window provisions a disjoint post-send reserve", () => {
  const now = new Date("2026-07-13T00:00:00.000Z"); // Monday 09:00 KST.
  assert.deepEqual(candidateReadinessPolicy({ now }), {
    phase: "weekday-reserve",
    requiredReadySets: 2,
    requiredReadyCount: 6
  });
  assert.deepEqual(candidateReadinessPolicy({
    now: new Date("2026-07-13T06:00:00.000Z") // Monday 15:00 KST.
  }), {
    phase: "weekday-reserve",
    requiredReadySets: 2,
    requiredReadyCount: 6
  });
  assert.equal(hasCandidateReadiness(Array.from({ length: 5 }, (_, index) => candidate(index)), 2), false);
  assert.equal(hasCandidateReadiness(Array.from({ length: 6 }, (_, index) => candidate(index)), 2), true);
  const prompt = buildCandidateResearchPrompt({ now, requiredReadySets: 2 });
  assert.match(prompt, /신규 후보를 최소 6개, 목표 7개, 최대 8개/u);
  assert.match(prompt, /전체 웹 검색은 최대 14회/u);
  assert.match(prompt, /어떤 유효한 3개 조합이 먼저 선택되더라도/u);
  assert.match(prompt, /상호·메뉴 cooldown을 제외한 뒤 다음 3개 다양성 조합/u);
});

test("morning reserve survives every viable lunch selection instead of only one partition", () => {
  const robust = Array.from({ length: 6 }, (_, index) => ({
    ...candidate(index),
    category: ["구이", "중식", "찜/탕"][index % 3],
    menu: `강건성메뉴${index}`,
    ingredientFamilies: ["poultry", "beef", "pork", "seafood", "lamb", "offal"].slice(index, index + 1)
  }));
  assert.equal(hasCandidateReadiness(robust, 2), true);

  const fragileFamilies = ["poultry", "poultry", "beef", "pork", "seafood", "lamb"];
  const fragile = Array.from({ length: 6 }, (_, index) => ({
    ...candidate(index),
    menu: `취약성메뉴${index}`,
    ingredientFamilies: [fragileFamilies[index]]
  }));
  assert.equal(hasCandidateReadiness(fragile, 2), false);
});

test("morning reserve examines the complete bounded pool beyond early fragile partitions", () => {
  const shapes = [
    ["도시락", ["poultry"]], ["피자", ["beef"]], ["치킨", ["lamb"]],
    ["도시락", ["other"]], ["치킨", ["seafood"]], ["버거", ["poultry"]],
    ["구이", ["poultry"]], ["중식", ["beef"]], ["찜/탕", ["pork"]],
    ["돈까스", ["seafood"]], ["피자", ["lamb"]], ["도시락", ["offal"]]
  ];
  const pool = shapes.map(([category, ingredientFamilies], index) => ({
    ...candidate(index),
    category,
    ingredientFamilies
  }));
  assert.equal(hasCandidateReadiness(pool, 2), true);
});

test("bounded morning-readiness search matches exhaustive six-core evaluation", () => {
  const random = seededRandom(0x5eedc0de);
  const categories = ["구이", "중식", "찜/탕", "돈까스", "도시락"];
  const families = ["other", "poultry", "beef", "pork", "seafood", "lamb"];
  for (let caseIndex = 0; caseIndex < 250; caseIndex += 1) {
    const size = 6 + Math.floor(random() * 4);
    const pool = Array.from({ length: size }, (_, index) => ({
      ...candidate(caseIndex * 20 + index),
      category: categories[Math.floor(random() * categories.length)],
      restaurant: `무작위식당${Math.floor(random() * 8)}`,
      menu: `무작위메뉴${Math.floor(random() * 8)}`,
      ingredientFamilies: [families[Math.floor(random() * families.length)]]
    }));
    assert.equal(
      hasCandidateReadiness(pool, 2),
      bruteForceMorningReadiness(pool),
      `readiness mismatch for deterministic random case ${caseIndex}`
    );
  }
});

test("morning-readiness search is bounded for the configured adversarial input limit", () => {
  const pool = Array.from({ length: CANDIDATE_READINESS_INPUT_LIMIT }, (_, index) => ({
    ...candidate(index),
    category: index === 0 ? "구이" : index <= 29 ? "중식" : "찜/탕",
    ingredientFamilies: ["other"]
  }));
  assert.equal(hasCandidateReadiness(pool, 2), false);
  assert.throws(
    () => hasCandidateReadiness([...pool, candidate(999)], 2),
    new RegExp(`at most ${CANDIDATE_READINESS_INPUT_LIMIT} candidates`, "u")
  );
});

test("verified candidate envelope persists no more than the 12-candidate active budget", () => {
  assert.equal(CANDIDATE_ACTIVE_LIMIT, 12);
  assert.doesNotThrow(() => validateVerifiedCandidateStoreEnvelope({
    version: 1,
    candidates: Array.from({ length: CANDIDATE_ACTIVE_LIMIT }, () => ({}))
  }));
  assert.throws(() => validateVerifiedCandidateStoreEnvelope({
    version: 1,
    candidates: Array.from({ length: CANDIDATE_ACTIVE_LIMIT + 1 }, () => ({}))
  }), /at most 12 active candidates/u);
});

test("candidate catalog keeps the newest safe evidence as research-only seed metadata", () => {
  const older = {
    ...candidate(0),
    priceCheckedAt: "2026-06-01T00:00:00.000Z",
    deliveryCheckedAt: "2026-06-01T00:00:00.000Z",
    evidenceVerifiedAt: "2026-06-01T00:00:00.000Z"
  };
  const newer = {
    ...candidate(0),
    priceText: "10,000원",
    priceCheckedAt: "2026-07-01T00:00:00.000Z",
    deliveryCheckedAt: "2026-07-01T00:00:00.000Z",
    evidenceVerifiedAt: "2026-07-01T00:00:00.000Z"
  };
  const catalog = mergeCandidateCatalog([older], [newer, { restaurant: "invalid" }]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].priceText, "10,000원");

  const prompt = buildCandidateResearchPrompt({
    now: new Date("2026-07-12T00:00:00.000Z"),
    catalogCandidates: catalog
  });
  assert.match(prompt, /기존 URL이 사라졌거나 내용이 맞지 않을 때만/u);
  assert.match(prompt, /"address": "전주시 테스트로 0"/u);
  assert.match(prompt, /"previousPriceCheckedAt": "2026-07-01T00:00:00.000Z"/u);
});

test("candidate research diagnostics expose deterministic gate loss and tolerate overprovisioning", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const copiedTarget = {
    ...candidate(0),
    restaurant: "좌표복제집",
    menu: "좌표복제메뉴",
    latitude: 35.8461205,
    longitude: 127.1340012
  };
  assert.throws(
    () => validateResearchResult({ candidates: [copiedTarget, candidate(1), candidate(2)] }, { now }),
    /3 raw, 2 eligibility-valid, 2 cooldown-eligible/u
  );
  assert.equal(
    validateResearchResult({ candidates: [copiedTarget, candidate(1), candidate(2), candidate(3)] }, { now }).length,
    3
  );
});

test("candidate research requires a selectable diverse set", () => {
  const sameCategory = Array.from({ length: 3 }, (_, index) => ({
    ...candidate(index),
    category: "치킨",
    restaurant: `치킨집${index}`,
    menu: `후라이드치킨 ${index}`,
    ingredientFamilies: ["poultry"]
  }));
  assert.equal(hasViableRecommendationSet(sameCategory, 3), false);
  assert.throws(
    () => validateResearchResult({ candidates: sameCategory }, { now: new Date("2026-07-12T00:00:00.000Z") }),
    /cannot form 3 unique/u
  );
});

test("candidate research rejects category-diverse pools that repeat a main ingredient", () => {
  const poultryPool = [
    { ...candidate(0), category: "찜/탕", restaurant: "두찜", menu: "실비한우곱찜닭", ingredientFamilies: ["poultry", "beef", "offal"] },
    { ...candidate(1), category: "치킨", restaurant: "솜리치킨", menu: "순살 깨통닭", ingredientFamilies: ["poultry"] },
    { ...candidate(2), category: "샌드위치", restaurant: "슬로우캘리", menu: "닭가슴살 에그 통밀 랩", ingredientFamilies: ["poultry"] }
  ];
  assert.equal(hasViableRecommendationSet(poultryPool, 3), false);
});

test("candidate refresh preflight skips holidays and applies morning reserve readiness", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const existingCandidates = Array.from({ length: 3 }, (_, index) => freshCandidate(index));
  const emptyHistory = { version: 1, items: [] };
  const emptyMeals = { version: 1, events: [] };
  assert.deepEqual(candidateRefreshPreflight({
    now,
    existingCandidates,
    history: emptyHistory,
    mealEvents: emptyMeals,
    holidayCheck: () => true
  }), { skip: true, reason: "holiday", eligibleCount: 0 });
  assert.deepEqual(candidateRefreshPreflight({
    now,
    existingCandidates,
    history: emptyHistory,
    mealEvents: emptyMeals,
    holidayCheck: () => false
  }), { skip: false, reason: "refresh-needed", eligibleCount: 3 });
  assert.deepEqual(candidateRefreshPreflight({
    now,
    existingCandidates,
    history: emptyHistory,
    mealEvents: emptyMeals,
    holidayCheck: () => false,
    requiredReadySets: 1
  }), { skip: true, reason: "ready", eligibleCount: 3 });
  assert.deepEqual(candidateRefreshPreflight({
    now,
    existingCandidates: Array.from({ length: 6 }, (_, index) => freshCandidate(index)),
    history: emptyHistory,
    mealEvents: emptyMeals,
    holidayCheck: () => false
  }), { skip: true, reason: "ready", eligibleCount: 6 });
  assert.deepEqual(candidateRefreshPreflight({
    now: new Date("2026-07-13T06:00:00.000Z"),
    existingCandidates,
    history: emptyHistory,
    mealEvents: emptyMeals,
    holidayCheck: () => false
  }), { skip: false, reason: "refresh-needed", eligibleCount: 3 });
});

test("candidate refresh does not reuse evidence that expires before the next scheduled send", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const existingCandidates = Array.from({ length: 3 }, (_, index) => ({
    ...candidate(index),
    deliveryCheckedAt: "2026-07-10T01:00:00.000Z"
  }));
  const result = candidateRefreshPreflight({
    now,
    existingCandidates,
    history: { version: 1, items: [] },
    mealEvents: { version: 1, events: [] },
    holidayCheck: () => false
  });
  assert.deepEqual(result, { skip: false, reason: "refresh-needed", eligibleCount: 0 });
});

test("actual next-send horizon rejects evidence that a fixed three-hour check would accept", () => {
  const now = new Date("2026-07-12T18:00:00.000Z"); // Monday 03:00 KST.
  const nextSendAt = nextScheduledSendAt({ now, holidayCheck: () => false });
  assert.equal(nextSendAt.toISOString(), "2026-07-13T02:25:00.000Z");
  const expiring = Array.from({ length: 3 }, (_, index) => ({
    ...candidate(index),
    priceCheckedAt: "2026-07-10T00:00:00.000Z",
    deliveryCheckedAt: "2026-07-10T00:00:00.000Z",
    evidenceVerifiedAt: "2026-07-10T00:00:00.000Z"
  }));
  assert.throws(() => validateResearchResult({ candidates: expiring }, { now }), /0 eligibility-valid/u);
  assert.throws(
    () => validateResearchResult({ candidates: expiring }, { now: nextSendAt }),
    /0 eligibility-valid/u
  );
});

test("next candidate refresh includes post-send reserve replenishment", () => {
  assert.equal(nextScheduledCandidateRefreshAt({
    now: new Date("2026-07-12T23:49:00.000Z"),
    holidayCheck: () => false
  }).toISOString(), "2026-07-12T23:50:00.000Z");
  assert.equal(nextScheduledCandidateRefreshAt({
    now: new Date("2026-07-13T03:00:00.000Z"),
    holidayCheck: () => false
  }).toISOString(), "2026-07-13T06:00:00.000Z");
  assert.equal(nextScheduledCandidateRefreshAt({
    now: new Date("2026-07-13T07:00:00.000Z"),
    holidayCheck: () => false
  }).toISOString(), "2026-07-13T08:35:00.000Z");
});

test("catalog revalidation batches rotate without starving entries beyond the first twelve", () => {
  const catalog = Array.from({ length: 25 }, (_, index) => ({ index }));
  const first = selectCandidateCatalogBatch(catalog);
  const second = selectCandidateCatalogBatch(catalog, { cursor: first.nextCursor });
  const third = selectCandidateCatalogBatch(catalog, { cursor: second.nextCursor });
  assert.deepEqual(first.candidates.map((item) => item.index), Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(second.candidates.map((item) => item.index), Array.from({ length: 12 }, (_, index) => index + 12));
  assert.deepEqual(third.candidates.map((item) => item.index), [24, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(third.nextCursor, 11);
});

test("active candidates do not consume catalog revalidation batch slots", async () => {
  const now = new Date("2026-07-11T00:00:00.000Z");
  const active = [candidate(0), candidate(1)];
  const nonactive = Array.from({ length: 12 }, (_, index) => candidate(index + 2));
  const verificationBatches = [];
  let modelInvoked = false;
  const result = await refreshVerifiedCandidates({
    force: true,
    requiredReadySets: 2,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({
      version: 1,
      candidates: active,
      catalogRevalidationCursor: 0,
      catalog: [...active, ...nonactive]
    }),
    verifyCandidates: async (candidates) => {
      verificationBatches.push(candidates);
      return candidates.map((item) => ({
        ...item,
        priceCheckedAt: now.toISOString(),
        deliveryCheckedAt: now.toISOString(),
        evidenceVerification: "deterministic-html",
        evidenceVerifiedAt: now.toISOString()
      }));
    },
    runStructured: async () => {
      modelInvoked = true;
      throw new Error("The model must not run when catalog revalidation restores readiness");
    }
  });

  assert.deepEqual(verificationBatches.map((batch) => batch.length), [2, 12]);
  assert.deepEqual(
    new Set(verificationBatches[1].map((item) => item.restaurant)),
    new Set(nonactive.map((item) => item.restaurant))
  );
  assert.equal(modelInvoked, false);
  assert.equal(result.refreshSource, "catalog-revalidation");
  assert.equal(hasCandidateReadiness(result.candidates, 2), true);
});

test("catalog preflight checks later deterministic batches before spending a model call", async () => {
  const now = new Date("2026-07-11T00:00:00.000Z");
  const catalog = Array.from({ length: 24 }, (_, index) => candidate(index + 40));
  const verificationBatchSizes = [];
  let verificationCall = 0;
  let modelInvoked = false;
  const result = await refreshVerifiedCandidates({
    force: true,
    requiredReadySets: 2,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({
      version: 1,
      candidates: [],
      catalogRevalidationCursor: 0,
      catalog,
    }),
    verifyCandidates: async (candidates) => {
      verificationBatchSizes.push(candidates.length);
      verificationCall += 1;
      if (verificationCall <= 2) return [];
      return candidates.map((item) => ({
        ...item,
        priceCheckedAt: now.toISOString(),
        deliveryCheckedAt: now.toISOString(),
        evidenceVerification: "deterministic-html",
        evidenceVerifiedAt: now.toISOString(),
      }));
    },
    runStructured: async () => {
      modelInvoked = true;
      throw new Error("The model must not run before bounded catalog preflight is exhausted");
    },
  });

  assert.deepEqual(verificationBatchSizes, [0, 12, 12]);
  assert.equal(modelInvoked, false);
  assert.equal(result.refreshSource, "catalog-revalidation");
  assert.equal(result.catalogBatchesProcessed, 2);
  assert.equal(hasCandidateReadiness(result.candidates, 2), true);
});

test("catalog preflight visits a short final batch without wrapping into duplicate fetches", async () => {
  const now = new Date("2026-07-11T00:00:00.000Z");
  const catalog = Array.from({ length: 14 }, (_, index) => candidate(index + 40));
  const researched = Array.from({ length: 6 }, (_, index) => candidate(index + 80));
  const verificationBatches = [];
  const result = await refreshVerifiedCandidates({
    force: true,
    requiredReadySets: 2,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({
      version: 1,
      candidates: [],
      catalogRevalidationCursor: 0,
      catalog
    }),
    verifyCandidates: async (candidates) => {
      verificationBatches.push(candidates.map((item) => item.restaurant));
      const isResearchBatch = candidates.some((item) => item.restaurant === researched[0].restaurant);
      return isResearchBatch ? candidates : [];
    },
    runStructured: async () => ({ parsed: { candidates: researched } })
  });

  assert.deepEqual(verificationBatches.map((batch) => batch.length), [0, 12, 2, 6]);
  assert.equal(new Set([...verificationBatches[1], ...verificationBatches[2]]).size, 14);
  assert.equal(result.catalogBatchesProcessed, 2);
  assert.equal(hasCandidateReadiness(result.candidates, 2), true);
});

test("candidate refresh CAS preserves concurrent catalog additions and rejects active-store races", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-candidate-cas-"));
  const baselineActive = Array.from({ length: 3 }, (_, index) => candidate(index));
  const baseStore = {
    version: 1,
    generatedAt: "2026-07-12T00:00:00.000Z",
    catalogUpdatedAt: "2026-07-12T00:00:00.000Z",
    candidates: baselineActive,
    catalog: [candidate(10)]
  };
  const proposed = {
    ...baseStore,
    generatedAt: "2026-07-12T01:00:00.000Z",
    catalogUpdatedAt: "2026-07-12T01:00:00.000Z",
    candidates: Array.from({ length: 3 }, (_, index) => candidate(index + 3)),
    catalog: [candidate(11)]
  };
  try {
    // A catalog-only writer commits after the refresh took its active snapshot.
    writeJsonAt(dataDir, "verified-candidates.json", {
      ...baseStore,
      catalogUpdatedAt: "2026-07-12T00:30:00.000Z",
      catalog: [candidate(10), candidate(12)]
    });
    const saved = saveVerifiedCandidateStore(proposed, {
      expectedActiveCandidates: baselineActive,
      dataDir
    });
    assert.deepEqual(saved.candidates, proposed.candidates);
    assert.deepEqual(
      new Set(saved.catalog.map((item) => item.restaurant)),
      new Set([candidate(10).restaurant, candidate(11).restaurant, candidate(12).restaurant])
    );

    const conflicting = {
      ...saved,
      generatedAt: "2026-07-12T01:30:00.000Z",
      candidates: Array.from({ length: 3 }, (_, index) => candidate(index + 6))
    };
    writeJsonAt(dataDir, "verified-candidates.json", conflicting);
    assert.throws(() => saveVerifiedCandidateStore(proposed, {
      expectedActiveCandidates: baselineActive,
      dataDir
    }), /CAS conflict.*existing store preserved/u);
    assert.deepEqual(readJsonAt(dataDir, "verified-candidates.json", null), conflicting);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("hard-negative invalidation is an atomic active-and-catalog CAS", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-candidate-invalidation-cas-"));
  const active = Array.from({ length: 3 }, (_, index) => candidate(index));
  const closedId = candidateIdFor(active[0]);
  const initial = {
    version: 1,
    candidates: active,
    catalog: [...active, candidate(10)],
    invalidatedCandidateIds: []
  };
  try {
    writeJsonAt(dataDir, "verified-candidates.json", initial);
    const saved = invalidateVerifiedCandidateStoreCandidates([closedId], {
      expectedActiveCandidates: active,
      dataDir
    });
    assert.equal(saved.candidates.some((item) => candidateIdFor(item) === closedId), false);
    assert.equal(saved.catalog.some((item) => candidateIdFor(item) === closedId), false);
    assert.deepEqual(saved.invalidatedCandidateIds, [closedId]);
    const recoveryCopy = JSON.parse(fs.readFileSync(
      path.join(dataDir, "verified-candidates.json.bak"),
      "utf8"
    ));
    assert.equal(recoveryCopy.candidates.some((item) => candidateIdFor(item) === closedId), false);
    assert.equal(recoveryCopy.catalog.some((item) => candidateIdFor(item) === closedId), false);
    assert.ok(recoveryCopy.invalidatedCandidateIds.includes(closedId));

    const concurrent = {
      ...saved,
      candidates: [candidate(20), ...saved.candidates]
    };
    writeJsonAt(dataDir, "verified-candidates.json", concurrent);
    assert.throws(() => invalidateVerifiedCandidateStoreCandidates([candidateIdFor(candidate(1))], {
      expectedActiveCandidates: saved.candidates,
      dataDir
    }), /invalidation CAS conflict.*no stale invalidation applied/u);
    assert.deepEqual(readJsonAt(dataDir, "verified-candidates.json", null), concurrent);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unavailable evidence removes active and catalog rows without permanent invalidation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-candidate-unavailable-cas-"));
  const active = Array.from({ length: 3 }, (_, index) => candidate(index));
  const unavailableId = candidateIdFor(active[0]);
  const initial = {
    version: 1,
    candidates: active,
    catalog: [...active, candidate(10)],
    invalidatedCandidateIds: []
  };
  try {
    writeJsonAt(dataDir, "verified-candidates.json", initial);
    const saved = removeUnavailableVerifiedCandidateStoreCandidates([unavailableId], {
      expectedActiveCandidates: active,
      dataDir
    });
    assert.equal(saved.candidates.some((item) => candidateIdFor(item) === unavailableId), false);
    assert.equal(saved.catalog.some((item) => candidateIdFor(item) === unavailableId), false);
    assert.deepEqual(saved.invalidatedCandidateIds, []);
    const recoveryCopy = JSON.parse(fs.readFileSync(
      path.join(dataDir, "verified-candidates.json.bak"),
      "utf8"
    ));
    assert.equal(recoveryCopy.candidates.some((item) => candidateIdFor(item) === unavailableId), false);
    assert.deepEqual(recoveryCopy.invalidatedCandidateIds, []);

    const concurrent = { ...saved, candidates: [candidate(20), ...saved.candidates] };
    writeJsonAt(dataDir, "verified-candidates.json", concurrent);
    assert.throws(() => removeUnavailableVerifiedCandidateStoreCandidates(
      [candidateIdFor(candidate(1))],
      { expectedActiveCandidates: saved.candidates, dataDir }
    ), /unavailable removal CAS conflict.*no stale removal applied/u);
    assert.deepEqual(readJsonAt(dataDir, "verified-candidates.json", null), concurrent);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("atomic catalog merge rereads the latest store and preserves active candidates", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-candidate-catalog-"));
  const active = Array.from({ length: 3 }, (_, index) => candidate(index));
  try {
    writeJsonAt(dataDir, "verified-candidates.json", {
      version: 1,
      candidates: active,
      catalogUpdatedAt: "2026-07-12T00:00:00.000Z",
      catalogRevalidationCursor: 7,
      catalog: [candidate(10), candidate(11)]
    });
    const saved = updateVerifiedCandidateCatalog([candidate(12)], {
      dataDir,
      now: new Date("2026-07-12T01:00:00.000Z"),
      includeActiveCandidates: true
    });
    assert.deepEqual(saved.candidates, active);
    assert.deepEqual(
      new Set(saved.catalog.map((item) => item.restaurant)),
      new Set([...active, candidate(10), candidate(11), candidate(12)].map((item) => item.restaurant))
    );
    assert.equal(saved.catalogRevalidationCursor, 0,
      "a newly retained partial must be in the very next catalog revalidation batch");

    writeJsonAt(dataDir, "verified-candidates.json", {
      ...saved,
      catalogRevalidationCursor: 5
    });
    const idempotent = updateVerifiedCandidateCatalog([candidate(12)], {
      dataDir,
      now: new Date("2026-07-12T01:30:00.000Z")
    });
    assert.equal(idempotent.catalogRevalidationCursor, 5,
      "an idempotent partial retry must preserve catalog rotation progress");

    const refreshed = candidate(12);
    refreshed.priceText = "10,000원";
    refreshed.priceCheckedAt = "2026-07-12T02:00:00.000Z";
    refreshed.deliveryCheckedAt = "2026-07-12T02:00:00.000Z";
    refreshed.evidenceVerifiedAt = "2026-07-12T02:00:00.000Z";
    const updated = updateVerifiedCandidateCatalog([refreshed], {
      dataDir,
      now: new Date("2026-07-12T02:00:00.000Z")
    });
    assert.equal(updated.catalogRevalidationCursor, 0,
      "a materially refreshed catalog candidate must reset the revalidation cursor");
    assert.throws(
      () => updateVerifiedCandidateCatalog(null, { dataDir }),
      /requires a candidate array/u
    );
    writeJsonAt(dataDir, "verified-candidates.json", {
      ...updated,
      candidates: [candidate(20), ...updated.candidates]
    });
    assert.throws(
      () => updateVerifiedCandidateCatalog([candidate(13)], {
        dataDir,
        expectedActiveCandidates: updated.candidates
      }),
      /catalog update CAS conflict.*no stale partial candidates applied/u
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("scheduled and forced refreshes revalidate every active candidate even when already ready", async () => {
  for (const scenario of [
    { force: false, now: new Date("2026-07-13T06:00:00.000Z"), count: 6 },
    { force: true, now: new Date("2026-07-13T00:00:00.000Z"), count: 6 }
  ]) {
    const active = Array.from({ length: scenario.count }, (_, index) => freshCandidate(index));
    const batches = [];
    let modelInvoked = false;
    let saveOptions;
    const result = await refreshVerifiedCandidates({
      force: scenario.force,
      now: scenario.now,
      holidayCheck: () => false,
      readCandidateStore: () => ({ version: 1, candidates: active, catalog: [] }),
      saveCandidateStore: (_store, options) => { saveOptions = options; },
      verifyCandidates: async (candidates) => {
        batches.push([...candidates]);
        return candidates;
      },
      runStructured: async () => {
        modelInvoked = true;
        throw new Error("must not run");
      }
    });
    assert.equal(batches[0].length, scenario.count);
    assert.equal(modelInvoked, false);
    assert.equal(result.refreshSource, "active-revalidation");
    assert.equal(result.activeRevalidatedCount, scenario.count);
    assert.deepEqual(saveOptions.expectedActiveCandidates, active);
  }
});

test("all-fetch-failed revalidation retains still-current active evidence as transient", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const active = Array.from({ length: 3 }, (_, index) => candidate(index));
  let modelInvoked = false;
  let savedStore;
  const result = await refreshVerifiedCandidates({
    force: true,
    requiredReadySets: 1,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: active, catalog: [] }),
    saveCandidateStore: (store) => { savedStore = store; },
    verifyCandidates: async (candidates, { diagnostics } = {}) => {
      for (const item of candidates) {
        diagnostics?.push({
          candidateId: candidateIdFor(item),
          reason: "all-fetch-failed",
          disposition: "transient",
          sources: []
        });
      }
      return [];
    },
    runStructured: async () => {
      modelInvoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(modelInvoked, false);
  assert.equal(result.candidates.length, 3);
  assert.equal(savedStore.candidates.length, 3);
  assert.equal(result.evidenceDiagnostics.active.reasons["all-fetch-failed"], 3);
});

test("dry-run hard negatives are reflected in the result without invoking persistence adapters", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const active = Array.from({ length: 3 }, (_, index) => candidate(index));
  const closedId = candidateIdFor(active[0]);
  let invalidationWrites = 0;
  let finalWrites = 0;
  const result = await refreshVerifiedCandidates({
    dryRun: true,
    force: true,
    requiredReadySets: 1,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: active, catalog: active }),
    saveCandidateStore: () => { finalWrites += 1; },
    invalidateCandidateStore: () => { invalidationWrites += 1; },
    verifyCandidates: async (candidates, { diagnostics } = {}) => {
      if (candidates.some((item) => candidateIdFor(item) === closedId)) {
        diagnostics?.push({
          candidateId: closedId,
          reason: "structured-inactive-business",
          disposition: "hard-negative",
          sources: []
        });
        return candidates.filter((item) => candidateIdFor(item) !== closedId);
      }
      return candidates;
    },
    runStructured: async () => ({ parsed: { candidates: [candidate(3)] } })
  });
  assert.equal(invalidationWrites, 0);
  assert.equal(finalWrites, 0);
  assert.equal(result.candidates.some((item) => candidateIdFor(item) === closedId), false);
  assert.equal(result.catalog.some((item) => candidateIdFor(item) === closedId), false);
  assert.ok(result.invalidatedCandidateIds.includes(closedId));
});

test("a FAKE-BRANCH unavailable result is not transiently retained and remains rediscoverable", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const active = [
    { ...candidate(0), branch: "FAKE-BRANCH" },
    candidate(1),
    candidate(2)
  ];
  const unavailableId = candidateIdFor(active[0]);
  let removalWrites = 0;
  const result = await refreshVerifiedCandidates({
    dryRun: true,
    force: true,
    requiredReadySets: 1,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: active, catalog: active, invalidatedCandidateIds: [] }),
    removeUnavailableCandidateStore: () => { removalWrites += 1; },
    verifyCandidates: async (candidates, { diagnostics } = {}) => {
      if (candidates.some((item) => candidateIdFor(item) === unavailableId)) {
        diagnostics?.push({
          candidateId: unavailableId,
          reason: "branch-unverified",
          disposition: "unavailable",
          sources: [{ status: 410 }]
        });
      }
      return candidates.filter((item) => candidateIdFor(item) !== unavailableId);
    },
    runStructured: async () => ({ parsed: { candidates: [candidate(3)] } })
  });
  assert.equal(removalWrites, 0);
  assert.equal(result.candidates.some((item) => candidateIdFor(item) === unavailableId), false);
  assert.equal(result.catalog.some((item) => candidateIdFor(item) === unavailableId), false);
  assert.equal(result.invalidatedCandidateIds.includes(unavailableId), false);
});

test("candidate refresh readiness override consistently replaces the time-based policy", async () => {
  const scenarios = [
    {
      now: new Date("2026-07-13T00:00:00.000Z"), // Monday morning normally requires two sets.
      requiredReadySets: 1,
      candidates: Array.from({ length: 3 }, (_, index) => freshCandidate(index)),
      promptPattern: /신규 후보를 최소 3개, 목표 4개, 최대 5개/u
    },
    {
      now: new Date("2026-07-13T06:00:00.000Z"), // Monday afternoon normally requires one set.
      requiredReadySets: 2,
      candidates: Array.from({ length: 6 }, (_, index) => freshCandidate(index)),
      promptPattern: /신규 후보를 최소 6개, 목표 7개, 최대 8개/u
    }
  ];
  for (const scenario of scenarios) {
    let prompt = "";
    const result = await refreshVerifiedCandidates({
      force: true,
      now: scenario.now,
      requiredReadySets: scenario.requiredReadySets,
      holidayCheck: () => false,
      readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
      saveCandidateStore: () => {},
      verifyCandidates: async (candidates) => candidates,
      runStructured: async (options) => {
        prompt = options.prompt;
        return { parsed: { candidates: scenario.candidates } };
      }
    });
    assert.match(prompt, scenario.promptPattern);
    assert.equal(result.readiness.phase, "explicit-override");
    assert.equal(result.readiness.requiredReadySets, scenario.requiredReadySets);
    assert.equal(result.candidates.length, scenario.candidates.length);
  }
});

test("candidate refresh rejects invalid readiness overrides before reading the store", async () => {
  for (const requiredReadySets of [0, 3, "1", null]) {
    let read = false;
    await assert.rejects(() => refreshVerifiedCandidates({
      requiredReadySets,
      readCandidateStore: () => {
        read = true;
        return { version: 1, candidates: [], catalog: [] };
      }
    }), /readiness sets must be 1 or 2/u);
    assert.equal(read, false);
  }
});

test("candidate refresh CLI parses and forwards only strict readiness overrides", async () => {
  assert.equal(parseCandidateRefreshArgs(["--explore"]).exploreNewRestaurants, true);
  assert.deepEqual(parseCandidateRefreshArgs([
    "--dry-run", "--force", "--required-ready-sets", "2"
  ]), { dryRun: true, force: true, exploreNewRestaurants: false, requiredReadySets: 2 });
  assert.deepEqual(parseCandidateRefreshArgs([]), {
    dryRun: false,
    force: false,
    exploreNewRestaurants: false,
    requiredReadySets: undefined
  });

  let asserted = false;
  let forwarded;
  const logs = [];
  await runCandidateRefreshCli({
    args: ["--force", "--required-ready-sets", "1"],
    assertConfig: (options) => {
      asserted = true;
      assert.deepEqual(options, { dryRun: true, requireBotToken: false });
    },
    refresh: async (options) => {
      forwarded = options;
      return { skipped: true, skipReason: "weekend", eligibleCount: 0 };
    },
    log: (message) => logs.push(message)
  });
  assert.equal(asserted, true);
  assert.deepEqual(forwarded, { dryRun: false, force: true, exploreNewRestaurants: false, requiredReadySets: 1 });
  assert.match(logs[0], /skipped reason=weekend/u);
});

test("optional discovery adds only a verified new restaurant without weakening a ready pool", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const active = [candidate(0), candidate(1), candidate(2)];
  let prompt = "";
  let timeoutMs = 0;
  const result = await refreshVerifiedCandidates({
    force: true,
    exploreNewRestaurants: true,
    requiredReadySets: 1,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: active, catalog: active }),
    saveCandidateStore: (store) => store,
    verifyCandidates: async (candidates) => candidates,
    runStructured: async (options) => {
      prompt = options.prompt;
      timeoutMs = options.timeoutMs;
      return { parsed: { candidates: [candidate(0), candidate(3)] } };
    }
  });
  assert.match(prompt, /신규 식당 탐색/u);
  assert.match(prompt, /신규 후보를 최소 1개, 목표 1개, 최대 1개/u);
  assert.match(prompt, /전체 웹 검색은 최대 4회/u);
  assert.doesNotMatch(prompt, /반환 묶음 자체에서 서로 다른 카테고리/u);
  assert.ok(timeoutMs > 0 && timeoutMs <= 300_000);
  assert.equal(result.explorationStatus, "verified-new-restaurants");
  assert.equal(result.exploredCandidateCount, 1);
  assert.ok(result.candidates.some((item) => item.restaurant === "식당3"));
  assert.equal(result.candidates.filter((item) => item.restaurant === "식당0").length, 1);
  assert.equal(hasCandidateReadiness(result.candidates, 1), true);
});

test("optional discovery failure preserves existing verified readiness", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const active = [candidate(0), candidate(1), candidate(2)];
  let modelAttempts = 0;
  const result = await refreshVerifiedCandidates({
    force: true,
    exploreNewRestaurants: true,
    requiredReadySets: 1,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: active, catalog: active }),
    saveCandidateStore: (store) => store,
    verifyCandidates: async (candidates) => candidates,
    runStructured: async () => { modelAttempts += 1; throw new Error("timed out"); }
  });
  assert.equal(result.explorationStatus, "unavailable");
  assert.equal(modelAttempts, 1);
  assert.equal(result.exploredCandidateCount, 0);
  assert.equal(result.candidates.length, 3);
  assert.equal(hasCandidateReadiness(result.candidates, 1), true);
});

test("candidate refresh CLI rejects missing, invalid, duplicate, and unknown arguments before work", async () => {
  const invalidArgs = [
    ["--required-ready-sets"],
    ["--required-ready-sets", "0"],
    ["--required-ready-sets", "3"],
    ["--required-ready-sets", "1", "--required-ready-sets", "2"],
    ["--unknown"]
  ];
  for (const args of invalidArgs) {
    let worked = false;
    await assert.rejects(() => runCandidateRefreshCli({
      args,
      assertConfig: () => { worked = true; },
      refresh: async () => { worked = true; }
    }), /candidate refresh argument|required-ready-sets/iu);
    assert.equal(worked, false);
  }
});

test("candidate refresh accumulates a valid partial result and backfills only the missing pool", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const prompts = [];
  let savedStore;
  const rejected = { ...candidate(9), restaurant: "주소불일치집", menu: "주소불일치메뉴" };
  const result = await refreshVerifiedCandidates({
    dryRun: false,
    force: true,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    saveCandidateStore: (store) => { savedStore = store; },
    verifyCandidates: async (candidates, { diagnostics } = {}) => {
      for (const item of candidates.filter((candidateItem) => candidateItem.restaurant === rejected.restaurant)) {
        diagnostics?.push({
          candidateId: candidateIdFor(item),
          reason: "matched-page-missing-coupled-menu-price",
          disposition: "rejected"
        });
      }
      return candidates.filter((item) => item.restaurant !== rejected.restaurant);
    },
    runStructured: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        parsed: {
          candidates: prompts.length === 1
            ? [candidate(0), candidate(1), rejected]
            : [candidate(2)]
        }
      };
    }
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /신규 후보를 최소 3개/u);
  assert.match(prompts[1], /보강 시도 2\/5/u);
  assert.match(prompts[1], /신규 후보를 최소 1개/u);
  assert.match(prompts[1], /준비 후보 2개/u);
  assert.match(prompts[0], /주소는 자동 검증이 허용된 근거 페이지에 표시된 문자열만 그대로 사용/u);
  assert.match(prompts[1], /<UNTRUSTED_REJECTED_CANDIDATES_JSON>/u);
  assert.match(prompts[1], /"restaurant": "주소불일치집"/u);
  assert.match(prompts[1], /"deterministicRejectionReason": "matched-page-missing-coupled-menu-price"/u);
  assert.match(prompts[1], /같은 상호·메뉴 또는 같은 근거 URL 조합을 수정 없이 다시 출력하지 말고/u);
  assert.equal(result.refreshSource, "model-retry");
  assert.equal(result.run.attemptCount, 2);
  assert.deepEqual(
    result.run.attempts.map(({ rawCandidateCount, evidenceVerifiedCount, accumulatedReadyCount }) =>
      [rawCandidateCount, evidenceVerifiedCount, accumulatedReadyCount]
    ),
    [[3, 2, 2], [1, 1, 3]]
  );
  assert.equal(result.candidates.length, 3);
  assert.equal(savedStore.candidates.length, 3);
});

test("candidate refresh feeds post-evidence eligibility failures into the next model attempt", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const prompts = [];
  const locallyRejected = {
    ...candidate(9),
    category: "기타",
    restaurant: "분류계약미확인상호",
    branch: "",
    menu: "분류계약미확인메뉴"
  };
  const result = await refreshVerifiedCandidates({
    force: true,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    saveCandidateStore: () => {},
    verifyCandidates: async (candidates) => candidates,
    runStructured: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        parsed: {
          candidates: prompts.length === 1
            ? [candidate(0), candidate(1), locallyRejected]
            : [candidate(2)]
        }
      };
    }
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /"restaurant": "분류계약미확인상호"/u);
  assert.match(
    prompts[1],
    /"deterministicRejectionReason": "category-unresolved"/u
  );
  assert.deepEqual(
    result.run.attempts.map(({ rawCandidateCount, evidenceVerifiedCount, postGateEligibleCount }) =>
      [rawCandidateCount, evidenceVerifiedCount, postGateEligibleCount]
    ),
    [[3, 3, 2], [1, 1, 1]]
  );
});

test("candidate refresh routes a soft category conflict through model adjudication before persistence", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const ambiguous = {
    ...candidate(2),
    category: "멕시칸",
    restaurant: "새로운식당",
    branch: "전북대점",
    menu: "시그니처 보울",
  };
  ambiguous.candidateId = candidateIdFor(ambiguous);
  const calls = [];
  const result = await refreshVerifiedCandidates({
    force: true,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    saveCandidateStore: () => {},
    verifyCandidates: async (candidates) => candidates,
    runStructured: async (options) => {
      calls.push(options.runKind);
      if (options.runKind === "category-adjudication") {
        return {
          parsed: {
            reviews: [{
              candidateId: ambiguous.candidateId,
              category: "멕시칸",
              confidence: "high",
              reason: "메뉴의 구성과 조리 형식이 멕시칸 보울로 명확하게 확인됩니다.",
            }],
          },
        };
      }
      return { parsed: { candidates: [candidate(0), candidate(1), ambiguous] } };
    },
  });
  assert.deepEqual(calls, ["candidate-refresh", "category-adjudication"]);
  const stored = result.candidates.find((item) => item.restaurant === "새로운식당");
  assert.equal(stored.category, "멕시칸");
  assert.equal(stored.categoryAuthority, "model-adjudicated");
  assert.equal(result.run.attempts[0].categoryReviewRunCount, 1);
});

test("candidate refresh retains deterministic partials when bounded backfill never reaches three", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const prompts = [];
  const retained = [];
  let saved = false;
  await assert.rejects(() => refreshVerifiedCandidates({
    dryRun: false,
    force: true,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    saveCandidateStore: () => { saved = true; },
    savePartialCandidateCatalog: (candidates, options) => {
      retained.push({ candidates, options });
    },
    verifyCandidates: async (candidates) => candidates,
    runStructured: async ({ prompt }) => {
      prompts.push(prompt);
      return { parsed: { candidates: [candidate(0), candidate(1)] } };
    }
  }), /exhausted 5\/5 model attempts.*raw\/deterministic verified\/post-gate eligible=2\/2\/2,2\/2\/2,2\/2\/2,2\/2\/2,2\/2\/2.*2 deterministic partial candidate\(s\) retained in catalog; active store preserved/u);

  assert.equal(prompts.length, 5);
  assert.match(prompts[1], /보강 시도 2\/5/u);
  assert.match(prompts[1], /신규 후보를 최소 1개/u);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].candidates.length, 2);
  assert.deepEqual(retained[0].options.expectedActiveCandidates, []);
  assert.equal(saved, false);
});

test("a closed active candidate stays removed when morning backfill cannot restore readiness", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-closed-candidate-refresh-"));
  const now = new Date("2026-07-13T00:00:00.000Z");
  const active = Array.from({ length: 3 }, (_, index) => candidate(index));
  const closedId = candidateIdFor(active[0]);
  const researchOnly = [candidate(3), candidate(4)];
  const initial = {
    version: 1,
    generatedAt: "2026-07-12T23:50:00.000Z",
    catalogUpdatedAt: "2026-07-12T23:50:00.000Z",
    candidates: active,
    catalog: [...active],
    invalidatedCandidateIds: []
  };
  try {
    writeJsonAt(dataDir, "verified-candidates.json", initial);
    await assert.rejects(() => refreshVerifiedCandidates({
      dryRun: false,
      force: true,
      requiredReadySets: 2,
      now,
      holidayCheck: () => false,
      readCandidateStore: () => readJsonAt(dataDir, "verified-candidates.json", null),
      saveCandidateStore: (store, options) => saveVerifiedCandidateStore(store, { ...options, dataDir }),
      invalidateCandidateStore: (candidateIds, options) =>
        invalidateVerifiedCandidateStoreCandidates(candidateIds, { ...options, dataDir }),
      verifyCandidates: async (candidates, { diagnostics } = {}) => {
        if (candidates.some((item) => candidateIdFor(item) === closedId)) {
          diagnostics?.push({
            candidateId: closedId,
            reason: "structured-inactive-business",
            disposition: "hard-negative",
            sources: []
          });
          return candidates.filter((item) => candidateIdFor(item) !== closedId);
        }
        return candidates;
      },
      runStructured: async () => ({ parsed: { candidates: researchOnly } })
    }), /hard-negative candidate removal\(s\) committed; active store preserved/u);

    const persisted = readJsonAt(dataDir, "verified-candidates.json", null);
    assert.equal(persisted.candidates.some((item) => candidateIdFor(item) === closedId), false);
    assert.equal(persisted.catalog.some((item) => candidateIdFor(item) === closedId), false);
    assert.ok(persisted.invalidatedCandidateIds.includes(closedId));

    const cache = getCacheCandidates({
      now,
      history: {
        items: [{ ...active[0], recommendedAt: "2026-07-12T00:00:00.000Z" }]
      },
      verifiedCandidateData: persisted,
      staticCandidateData: [],
      allowUnverifiedFallback: false
    });
    assert.equal(cache.some((item) => candidateIdFor(item) === closedId), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("candidate research retries one transient structured failure and records the retry", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  let structuredCalls = 0;
  const result = await refreshVerifiedCandidates({
    force: true,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    saveCandidateStore: () => {},
    verifyCandidates: async (candidates) => candidates,
    runStructured: async () => {
      structuredCalls += 1;
      if (structuredCalls === 1) {
        const error = new Error("Codex CLI timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return { parsed: { candidates: [candidate(0), candidate(1), candidate(2)] } };
    }
  });
  assert.equal(structuredCalls, 2);
  assert.equal(result.run.attempts[0].structuredRunAttemptCount, 2);
});

test("candidate research fails fast for explicitly non-retryable structured errors", async () => {
  let structuredCalls = 0;
  let saved = false;
  const error = new Error("invalid output schema");
  error.retryable = false;
  await assert.rejects(() => refreshVerifiedCandidates({
    force: true,
    now: new Date("2026-07-12T00:00:00.000Z"),
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    saveCandidateStore: () => { saved = true; },
    verifyCandidates: async (candidates) => candidates,
    runStructured: async () => {
      structuredCalls += 1;
      throw error;
    }
  }), /invalid output schema/u);
  assert.equal(isRetryableStructuredRunError(error), false);
  assert.equal(structuredCalls, 1);
  assert.equal(saved, false);
});

test("candidate research bounds repeated transient structured failures", async () => {
  let structuredCalls = 0;
  await assert.rejects(() => refreshVerifiedCandidates({
    force: true,
    now: new Date("2026-07-12T00:00:00.000Z"),
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    saveCandidateStore: () => {},
    verifyCandidates: async (candidates) => candidates,
    runStructured: async () => {
      structuredCalls += 1;
      throw new Error("network timeout");
    }
  }), /failed after 2\/2 transient attempts.*existing store preserved/u);
  assert.equal(structuredCalls, 2);
});

test("candidate refresh fails closed when every deterministic verifier attempt fails", async () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  let saved = false;
  let runCount = 0;
  const legacy = Array.from({ length: 3 }, (_, index) => {
    const value = { ...candidate(index) };
    delete value.evidenceVerification;
    delete value.evidenceVerifiedAt;
    return value;
  });
  await assert.rejects(() => refreshVerifiedCandidates({
    dryRun: false,
    force: true,
    now,
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: legacy, catalog: [] }),
    saveCandidateStore: () => { saved = true; },
    verifyCandidates: async () => [],
    runStructured: async () => {
      runCount += 1;
      return { parsed: { candidates: Array.from({ length: 3 }, (_, index) => candidate(index + 3)) } };
    }
  }), /exhausted 5\/5 model attempts.*raw\/deterministic verified\/post-gate eligible=3\/0\/0,3\/0\/0,3\/0\/0,3\/0\/0,3\/0\/0.*active store preserved/u);
  assert.equal(runCount, 5);
  assert.equal(saved, false);
});

test("candidate refresh rejects an unsafe research-attempt bound before any work", async () => {
  let read = false;
  await assert.rejects(() => refreshVerifiedCandidates({
    maxResearchAttempts: 0,
    readCandidateStore: () => { read = true; return { version: 1, candidates: [] }; }
  }), /attempts must be an integer between 1 and 5/u);
  assert.equal(read, false);
  await assert.rejects(() => refreshVerifiedCandidates({
    maxResearchAttempts: 6,
    readCandidateStore: () => { read = true; return { version: 1, candidates: [] }; }
  }), /attempts must be an integer between 1 and 5/u);
  assert.equal(read, false);
});

test("candidate refresh rejects oversized structured output before evidence work", async () => {
  let evidenceCandidateCount = 0;
  await assert.rejects(() => refreshVerifiedCandidates({
    dryRun: true,
    force: true,
    requiredReadySets: 1,
    now: new Date("2026-07-12T00:00:00.000Z"),
    holidayCheck: () => false,
    readCandidateStore: () => ({ version: 1, candidates: [], catalog: [] }),
    verifyCandidates: async (candidates) => {
      evidenceCandidateCount += candidates.length;
      return candidates;
    },
    runStructured: async () => ({
      parsed: { candidates: Array.from({ length: 13 }, (_, index) => candidate(index)) }
    })
  }), /more than 12 candidates.*existing store preserved/u);
  assert.equal(evidenceCandidateCount, 0);
});

test("candidate refresh does not invoke the model when preflight can reuse the pool", async () => {
  let invoked = false;
  const result = await refreshVerifiedCandidates({
    now: new Date("2026-07-13T00:00:00.000Z"),
    holidayCheck: () => true,
    runStructured: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "holiday");
});

test("candidate refresh shell wrapper forwards explicit validated CLI arguments", () => {
  const script = fs.readFileSync(path.resolve("scripts/run-candidate-refresh.sh"), "utf8");
  assert.match(
    script,
    /node scripts\/refresh-verified-candidates\.js "\$@" >>"\$log_path" 2>&1/u
  );
  assert.match(script, /085\[0-9\]\|090\[0-9\]\|0910/u);
  assert.match(script, /morning_refresh_window/u);
  assert.match(script, /scheduled_two_set_request/u);
  assert.match(script, /\[ "\$#" -eq 2 \][\s\S]*--required-ready-sets[\s\S]*'2'/u);
  assert.match(script, /required sets=2\|requires 2 viable set/u);
  assert.match(script, /--required-ready-sets 1/u);
  assert.match(script, /degraded-ready: one complete set is safe for the imminent send/u);
  assert.match(script, /error_detail="\$\{error_detail:0:180\}"/u);

  const cron = fs.readFileSync(path.resolve("scripts/pororo-crontab.txt"), "utf8");
  const refreshLines = cron.split(/\r?\n/u).filter((line) => line.includes("run-candidate-refresh.sh"));
  assert.equal(refreshLines.length, 4);
  assert.equal(refreshLines.filter((line) => line.endsWith("run-candidate-refresh.sh --required-ready-sets 2'" )).length, 3);
  assert.equal(refreshLines.filter((line) => line.endsWith("run-candidate-refresh.sh --required-ready-sets 2 --explore'" )).length, 1);
});

test("evidence covers every send in the next 24 hours without demanding holiday freshness", () => {
  const noHoliday = () => false;
  assert.equal(candidateEvidenceHorizonAt({now: new Date("2026-09-15T02:00:00+09:00"), holidayCheck: noHoliday}).toISOString(), "2026-09-15T08:25:00.000Z");
  assert.equal(candidateEvidenceHorizonAt({now: new Date("2026-09-15T11:35:00+09:00"), holidayCheck: noHoliday}).toISOString(), "2026-09-16T02:25:00.000Z");
  assert.equal(candidateEvidenceHorizonAt({now: new Date("2026-09-15T17:35:00+09:00"), holidayCheck: noHoliday}).toISOString(), "2026-09-16T08:25:00.000Z");
  assert.equal(candidateEvidenceHorizonAt({now: new Date("2026-09-18T17:35:00+09:00"), holidayCheck: noHoliday}).toISOString(), "2026-09-18T11:35:00.000Z");
  assert.throws(() => candidateEvidenceHorizonAt({now: new Date("invalid")}), /valid current time/u);
});
