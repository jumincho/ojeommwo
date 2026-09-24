import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveryDistanceRiskPenalty,
  findCooldownConflicts,
  getCacheCandidates,
  getCachedRecommendations,
  getRecommendations,
  sanitizeRecommendations,
  selectRecommendations,
  validateStaticFallback
} from "../src/recommender.js";
import { ingredientFamiliesFor } from "../src/choice-diversity.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

const baseCandidates = [
  { category: "한식", restaurant: "한식집", menu: "제육덮밥", priceText: "9,000원", comment: "제육 양념이 밥과 잘 맞습니다." },
  { category: "중식", restaurant: "중식집", menu: "짬뽕", priceText: "10,000원", comment: "칼칼한 국물이 살아 있습니다." },
  { category: "돈까스", restaurant: "일식집", menu: "돈카츠", priceText: "11,000원", comment: "바삭한 튀김옷이 좋습니다." },
  { category: "찜/탕", restaurant: "분식집", menu: "떡볶이", priceText: "8,000원", comment: "쫀득한 떡과 매콤한 양념이 좋습니다." }
];

test("uncertain delivery receives a bounded distance penalty but target-verified delivery does not", () => {
  assert.equal(deliveryDistanceRiskPenalty({ deliveryStatus: "likely", distanceKm: 2.9 }), 0);
  assert.equal(deliveryDistanceRiskPenalty({ deliveryStatus: "likely", distanceKm: 4 }), 6);
  assert.equal(deliveryDistanceRiskPenalty({ deliveryStatus: "likely", distanceKm: 8 }), 18);
  assert.equal(deliveryDistanceRiskPenalty({ deliveryStatus: "verified", distanceKm: 5 }), 0);
});

function evidenceBackedHistoryCandidate(overrides = {}) {
  return {
    category: "한식",
    restaurant: "근거한식당",
    branch: "전북대점",
    address: "전주시 덕진구 테스트로 10",
    latitude: 35.848,
    longitude: 127.134,
    menu: "제육덮밥",
    priceText: "9,000원",
    priceChannel: "store",
    priceCheckedAt: "2026-07-11T00:00:00.000Z",
    deliveryStatus: "likely",
    deliveryCheckedAt: "2026-07-11T00:00:00.000Z",
    evidenceVerifiedAt: "2026-07-11T00:00:00.000Z",
    evidenceVerification: "deterministic-html",
    priceEvidenceUrl: "https://example.com/history-price",
    deliveryEvidenceUrl: "https://example.com/history-delivery",
    evidence: ["https://example.com/history"],
    comment: "매콤한 제육 양념과 부드러운 고기가 따뜻한 밥에 어우러져, 한입마다 진한 감칠맛을 즐길 수 있습니다.",
    recommendedAt: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

test("sanitizeRecommendations rejects placeholders and unsupported categories", () => {
  const sanitized = sanitizeRecommendations([
    null,
    "invalid",
    [],
    ...baseCandidates,
    { category: "기타", restaurant: "기타집", menu: "메뉴", priceText: "1,000원", comment: "테스트 메뉴입니다." },
    { category: "도시락", restaurant: "검증된 식당명", menu: "검증된 메뉴명", priceText: "1,000원", comment: "테스트 메뉴입니다." }
  ]);

  assert.equal(sanitized.length, baseCandidates.length);
  assert.ok(sanitized.every((item) => item.category !== "기타"));
});

test("sanitizeRecommendations preserves deterministic evidence provenance", () => {
  const [sanitized] = sanitizeRecommendations([{
    ...baseCandidates[0],
    evidenceVerifiedAt: "2026-07-15T00:00:00.000Z",
    evidenceVerification: "deterministic-html"
  }]);

  assert.equal(sanitized.evidenceVerifiedAt, "2026-07-15T00:00:00.000Z");
  assert.equal(sanitized.evidenceVerification, "deterministic-html");
});

test("sanitizeRecommendations always materializes the operational ingredient family", () => {
  const [inferred] = sanitizeRecommendations([{
    category: "버거",
    restaurant: "맥도날드 전주덕진DT점",
    menu: "빅맥 세트",
    priceText: "7,600원",
    comment: "소고기 패티와 채소가 들어간 버거입니다."
  }]);
  assert.deepEqual(inferred.ingredientFamilies, ["beef"]);

  const [explicit] = sanitizeRecommendations([{
    ...baseCandidates[1],
    ingredientFamilies: ["seafood"]
  }]);
  assert.deepEqual(explicit.ingredientFamilies, ["seafood"]);
});

test("sanitizeRecommendations rejects an unstamped model-only cuisine but accepts model adjudication", () => {
  const novel = {
    category: "멕시칸",
    restaurant: "새로운식당",
    menu: "시그니처 보울",
    priceText: "10,000원",
    comment: "신선한 채소와 든든한 속재료가 어우러져 한 끼로 즐기기 좋습니다."
  };
  assert.deepEqual(sanitizeRecommendations([novel]), []);
  const verified = sanitizeRecommendations([{
    ...novel,
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-07-15T00:00:00.000Z"
  }]);
  assert.deepEqual(verified, []);

  const [adjudicated] = sanitizeRecommendations([
    stampCategoryAdjudication(novel, {
      category: "멕시칸",
      now: new Date("2026-07-15T00:00:00.000Z"),
    })
  ]);
  assert.equal(adjudicated.category, "멕시칸");
  assert.equal(adjudicated.categoryAuthority, "model-adjudicated");

  const [corrected] = sanitizeRecommendations([{
    ...novel,
    category: "도시락",
    restaurant: "파파존스 전주점",
    menu: "수퍼 파파스(L)",
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-07-15T00:00:00.000Z"
  }]);
  assert.equal(corrected.category, "피자");

  const [bulgogiPizza] = sanitizeRecommendations([{
    ...novel,
    category: "한식",
    restaurant: "피자마루 전북대점",
    menu: "불고기 피자",
  }]);
  assert.equal(bulgogiPizza.category, "피자");
});

test("sanitizeRecommendations rejects oversized model and database fields", () => {
  assert.deepEqual(sanitizeRecommendations([{
    ...baseCandidates[0],
    menu: "메".repeat(121)
  }]), []);
  assert.deepEqual(sanitizeRecommendations([{
    ...baseCandidates[0],
    evidence: Array.from({ length: 7 }, (_, index) => `https://example.com/${index}`)
  }]), []);
  assert.deepEqual(sanitizeRecommendations([{
    ...baseCandidates[0],
    evidence: "x".repeat(2049)
  }]), []);
  assert.deepEqual(sanitizeRecommendations([{
    ...baseCandidates[0],
    restaurant: `${" ".repeat(101)}밥집`
  }]), []);
});

test("selectRecommendations returns unique categories, restaurants, and menus", () => {
  const picked = selectRecommendations(baseCandidates, {
    limit: 3,
    rng: () => 0.1,
    history: { items: [] }
  });

  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((item) => item.category)).size, 3);
  assert.equal(new Set(picked.map((item) => item.restaurant)).size, 3);
  assert.equal(new Set(picked.map((item) => item.menu)).size, 3);
});

test("selectRecommendations rejects shared main ingredients across categories when alternatives exist", () => {
  const overlappingHighRank = [
    { category: "찜/탕", restaurant: "두찜", menu: "실비한우곱찜닭", priceText: "25,000원", comment: "매콤한 양념과 쫄깃한 식감이 잘 어울립니다.", sourceRank: 4 },
    { category: "치킨", restaurant: "솜리치킨", menu: "순살 깨통닭", priceText: "20,000원", comment: "바삭한 튀김옷과 고소한 풍미가 잘 어울립니다.", sourceRank: 4 },
    { category: "샌드위치", restaurant: "슬로우캘리", menu: "닭가슴살 에그 통밀 랩", priceText: "9,000원", comment: "담백한 속재료와 통밀 랩이 잘 어울립니다.", sourceRank: 4 }
  ];
  const alternatives = [
    { category: "도시락", restaurant: "김피라", menu: "갈릭우삼겹덮밥", priceText: "10,000원", comment: "불향과 마늘 풍미가 밥에 잘 어울립니다.", sourceRank: 3 },
    { category: "피자", restaurant: "해산물피자집", menu: "통새우 피자", priceText: "22,000원", comment: "탱글한 새우와 치즈가 잘 어울립니다.", sourceRank: 3 },
    { category: "돈까스", restaurant: "카츠집", menu: "등심 돈카츠", priceText: "12,000원", comment: "두툼한 등심과 바삭한 튀김옷이 잘 어울립니다.", sourceRank: 3 }
  ];
  const picked = selectRecommendations([...overlappingHighRank, ...alternatives], {
    limit: 3,
    rng: () => 0.5,
    history: { items: [] }
  });
  const families = picked.flatMap((candidate) => ingredientFamiliesFor(candidate).filter((family) => family !== "other"));
  assert.equal(new Set(families).size, families.length);
  assert.equal(picked.filter((candidate) => ingredientFamiliesFor(candidate).includes("poultry")).length, 1);
});

test("selectRecommendations avoids recent restaurants when alternatives exist", () => {
  const now = new Date("2026-05-26T00:00:00.000Z");
  const picked = selectRecommendations(baseCandidates, {
    limit: 3,
    now,
    rng: () => 0.1,
    history: {
      items: [
        {
          restaurant: "한식집",
          menu: "제육덮밥",
          recommendedAt: "2026-05-25T00:00:00.000Z"
        }
      ]
    }
  });

  assert.equal(picked.length, 3);
  assert.ok(!picked.some((item) => item.restaurant === "한식집"));
});

test("selectRecommendations does not relax cooldowns by default", () => {
  const now = new Date("2026-05-26T00:00:00.000Z");

  assert.throws(() => selectRecommendations(baseCandidates.slice(0, 3), {
    limit: 3,
    now,
    rng: () => 0.1,
    history: {
      items: [
        {
          restaurant: "한식집",
          menu: "제육덮밥",
          recommendedAt: "2026-05-25T00:00:00.000Z"
        }
      ]
    }
  }), /Not enough valid recommendations/u);
});

test("findCooldownConflicts reports recent restaurant and menu duplicates", () => {
  const conflicts = findCooldownConflicts(baseCandidates.slice(0, 1), {
    items: [
      {
        restaurant: "한식집",
        menu: "제육덮밥",
        recommendedAt: "2026-05-25T00:00:00.000Z"
      }
    ]
  }, {
    now: new Date("2026-05-26T00:00:00.000Z"),
    restaurantCooldownDays: 14,
    menuCooldownDays: 7
  });

  assert.deepEqual(conflicts.map((conflict) => conflict.kind).sort(), ["menu", "restaurant"]);
});

test("cooldowns treat menu spelling variants as one menu", () => {
  const conflicts = findCooldownConflicts([
    { ...baseCandidates[0], restaurant: "후토루", menu: "연어 후토마키" },
  ], {
    items: [{
      restaurant: "다른 상호",
      menu: "연어후토마끼",
      recommendedAt: "2026-05-25T00:00:00.000Z",
    }],
  }, { now: new Date("2026-05-26T00:00:00.000Z") });
  assert.deepEqual(conflicts.map((conflict) => conflict.kind), ["menu"]);
});

test("cooldowns merge embedded and split branch representations of one restaurant", () => {
  const conflicts = findCooldownConflicts([{
    ...baseCandidates[0],
    restaurant: "김피라",
    branch: "전북대점"
  }], {
    items: [{
      restaurant: "김피라 전북대점",
      menu: "다른 메뉴",
      recommendedAt: "2026-05-25T00:00:00.000Z"
    }]
  }, { now: new Date("2026-05-26T00:00:00.000Z") });
  assert.deepEqual(conflicts.map((conflict) => conflict.kind), ["restaurant"]);
});

test("cooldown boundary tolerates only bounded cron schedule jitter", () => {
  const candidate = { ...baseCandidates[0], restaurant: "도미노피자", menu: "블랙타이거 슈림프" };
  const now = new Date("2026-07-13T08:25:03.477Z");
  const nearBoundary = {
    version: 1,
    items: [{
      ...candidate,
      restaurant: "도미노피자 전주금암점",
      menu: "[오] 포테이토 (L)",
      recommendedAt: "2026-06-29T08:26:31.495Z"
    }]
  };
  assert.equal(findCooldownConflicts([candidate], nearBoundary, { now }).length, 0);
  const clearlyEarly = structuredClone(nearBoundary);
  clearlyEarly.items[0].recommendedAt = "2026-06-29T08:36:31.495Z";
  assert.ok(findCooldownConflicts([candidate], clearlyEarly, { now }).some((item) => item.kind === "restaurant"));
});

test("findCooldownConflicts ignores future-dated history", () => {
  const conflicts = findCooldownConflicts(baseCandidates.slice(0, 1), {
    items: [{
      restaurant: "한식집",
      menu: "제육덮밥",
      recommendedAt: "2026-05-27T00:00:00.000Z"
    }]
  }, { now: new Date("2026-05-26T00:00:00.000Z") });
  assert.deepEqual(conflicts, []);
});

test("findCooldownConflicts includes verified actual meals", () => {
  const conflicts = findCooldownConflicts(baseCandidates.slice(0, 1), { items: [] }, {
    now: new Date("2026-05-26T00:00:00.000Z"),
    mealEvents: {
      events: [{
        restaurant: "한식집",
        menu: "다른 메뉴",
        source: "scheduled-lunch",
        respondentId: "sha256:test-respondent",
        normalizationStatus: "verified-source",
        createdAt: "2026-05-25T00:00:00.000Z"
      }]
    }
  });
  assert.deepEqual(conflicts.map((conflict) => conflict.kind), ["restaurant"]);
});

test("tracked fallback data and the cache pipeline can produce three recommendations", () => {
  assert.equal(validateStaticFallback().ok, true);
  const strict = getCacheCandidates({
    history: { items: [] },
    verifiedCandidateData: [],
    staticCandidateData: baseCandidates,
    allowUnverifiedFallback: false
  });
  assert.deepEqual(strict, []);
  const emergency = getCacheCandidates({
    history: { items: [] },
    verifiedCandidateData: [],
    staticCandidateData: baseCandidates,
    allowUnverifiedFallback: true
  });
  assert.ok(emergency.length >= 20);
});

test("getRecommendations rejects unknown modes", async () => {
  await assert.rejects(() => getRecommendations({ mealType: "점심", mode: "typo" }), /recommendation mode/u);
});

test("higher-quality candidate sources always outrank random low-quality candidates", () => {
  const highQuality = [baseCandidates[0], baseCandidates[1], baseCandidates[3]]
    .map((item) => ({ ...item, sourceRank: 2 }));
  const lowQuality = [
    { category: "피자", restaurant: "낮은집1", menu: "크림파스타", priceText: "9,000원", comment: "크림소스와 면이 어울립니다.", sourceRank: 0 },
    { category: "치킨", restaurant: "낮은집2", menu: "후라이드순살", priceText: "19,000원", comment: "바삭한 튀김옷과 닭고기가 어울립니다.", sourceRank: 0 },
    { category: "버거", restaurant: "낮은집3", menu: "치즈버거세트", priceText: "8,000원", comment: "치즈와 패티가 어울립니다.", sourceRank: 0 }
  ];
  const picked = selectRecommendations([...lowQuality, ...highQuality], {
    history: { items: [] },
    rng: () => 0.99,
    limit: 3
  });
  assert.ok(picked.every((item) => item.sourceRank === 2));
});

test("cache candidates exclude history older than the configured freshness window", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const history = {
    items: [
      evidenceBackedHistoryCandidate({ recommendedAt: "2026-07-01T00:00:00.000Z" }),
      { category: "중식", restaurant: "오래된전용식당", menu: "오래된전용메뉴", priceText: "9,000원", comment: "오래된 후보입니다.", recommendedAt: "2026-05-01T00:00:00.000Z" }
    ]
  };
  const candidates = getCacheCandidates({ history, now, verifiedCandidateData: [], staticCandidateData: [] });
  assert.ok(candidates.some((item) => item.restaurant === "근거한식당"));
  assert.ok(!candidates.some((item) => item.restaurant === "오래된전용식당"));
});

test("cache history excludes a recently recommended candidate with stale delivery evidence", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const candidates = getCacheCandidates({
    now,
    history: { items: [evidenceBackedHistoryCandidate({
      recommendedAt: "2026-07-11T12:00:00.000Z",
      deliveryCheckedAt: "2026-07-08T23:00:00.000Z"
    })] },
    verifiedCandidateData: [],
    staticCandidateData: [],
    allowUnverifiedFallback: false
  });
  assert.deepEqual(candidates, []);
});

test("cache history is never reused without a current deterministic evidence marker", () => {
  const candidate = evidenceBackedHistoryCandidate();
  delete candidate.evidenceVerifiedAt;
  delete candidate.evidenceVerification;
  const candidates = getCacheCandidates({
    now: new Date("2026-07-12T00:00:00.000Z"),
    history: { items: [candidate] },
    verifiedCandidateData: [],
    staticCandidateData: [],
    allowUnverifiedFallback: false,
  });
  assert.deepEqual(candidates, []);
});

test("cache candidates normalize legacy plain-style comments before reuse", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const candidates = getCacheCandidates({
    now,
    history: {
      items: [{
        ...evidenceBackedHistoryCandidate(),
        comment: "매콤한 양념과 고기 식감이 밥에 잘 어울린다.",
        recommendedAt: "2026-07-01T00:00:00.000Z"
      }]
    },
    verifiedCandidateData: [],
    staticCandidateData: []
  });
  const reused = candidates.find((item) => item.restaurant === "근거한식당");
  assert.ok(reused);
  assert.match(reused.comment, /(?:니다|요|죠|세요)[.!?]$/u);
  assert.doesNotMatch(reused.comment, /어울린다/u);
});

test("actual meals participate in cooldown without treating unchosen recommendations as dislikes", () => {
  const picked = selectRecommendations(baseCandidates, {
    limit: 3,
    now: new Date("2026-07-12T00:00:00.000Z"),
    rng: () => 0.5,
    history: { items: [] },
    mealEvents: { events: [{
      restaurant: "한식집",
      menu: "제육덮밥",
      createdAt: "2026-07-11T00:00:00.000Z",
      rating: 5,
      respondentId: "respondent-actual-meal",
      source: "scheduled-cache",
      normalizationStatus: "verified-source"
    }] }
  });
  assert.ok(!picked.some((item) => item.restaurant === "한식집"));
});

test("private test messages provide modal context without affecting recommendation learning", () => {
  const history = {
    items: [{
      ...baseCandidates[0],
      source: "manual-private-test",
      recommendedAt: "2026-07-11T00:00:00.000Z"
    }]
  };
  const conflicts = findCooldownConflicts(baseCandidates.slice(0, 1), history, {
    now: new Date("2026-07-12T00:00:00.000Z")
  });
  const cacheCandidates = getCacheCandidates({ history, now: new Date("2026-07-12T00:00:00.000Z") });
  assert.equal(conflicts.length, 0);
  assert.ok(!cacheCandidates.some((item) => item.restaurant === "한식집"));
});


test("selection uses the supplied clock for both taste decay and cooldown", () => {
  const oldFavorite = { category: "한식", restaurant: "오래된밥집", menu: "제육덮밥", priceText: "9,000원", comment: "매콤한 양념과 밥이 어울립니다." };
  const newFavorite = { category: "한식", restaurant: "새로운밥집", menu: "김치볶음밥", priceText: "9,000원", comment: "고소한 볶음밥을 즐길 수 있습니다." };
  const candidates = [oldFavorite, newFavorite,
    { category: "중식", restaurant: "해물반점", menu: "해물짬뽕", priceText: "9,000원", comment: "칼칼한 해물 국물이 좋습니다." },
    { category: "분식", restaurant: "분식당", menu: "떡볶이", priceText: "8,000원", comment: "매콤한 양념과 떡이 어울립니다." },
  ];
  const event = (candidate, respondentId, createdAt) => ({ ...candidate, eventId: respondentId, respondentId,
    rating: 5, mealType: "점심", source: "scheduled-cache", normalizationStatus: "verified-source", createdAt });
  const events = [event(oldFavorite, "old-a", "2026-01-01T00:00:00Z"),
    event(oldFavorite, "old-b", "2026-01-01T00:00:00Z"),
    event(newFavorite, "new-a", "2030-01-01T00:00:00Z")];
  const options = { mealEvents: { events }, mealType: "점심", rng: () => 0.5,
    restaurantCooldownDays: 0, menuCooldownDays: 0 };
  const first = selectRecommendations(candidates, { ...options, now: new Date("2026-01-01T00:00:00Z") });
  const later = selectRecommendations(candidates, { ...options, now: new Date("2030-01-01T00:00:00Z") });
  assert.equal(first.find(item => item.category === "한식").restaurant, oldFavorite.restaurant);
  assert.equal(later.find(item => item.category === "한식").restaurant, newFavorite.restaurant);
});
