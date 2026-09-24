import { isSubstantialMealCandidate } from "../src/verified-candidates.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateIdFor,
  filterEligibleVerifiedCandidates,
  haversineKm,
} from "../src/verified-candidates.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

function candidate(overrides = {}) {
  return {
    category: "한식", restaurant: "밥집", branch: "전북대점", address: "전주시 덕진구 테스트로 1",
    latitude: 35.848, longitude: 127.134, menu: "제육덮밥", priceText: "9,000원",
    priceChannel: "store", priceCheckedAt: "2026-07-11T00:00:00.000Z",
    deliveryStatus: "likely", deliveryCheckedAt: "2026-07-11T00:00:00.000Z",
    priceEvidenceUrl: "https://example.com/price", deliveryEvidenceUrl: "https://example.com/delivery",
    comment: "매콤한 제육 양념이 부드러운 고기에 고르게 배어, 따뜻한 밥과 함께 먹을수록 감칠맛이 살아납니다.", evidence: ["https://example.com"],
    ...overrides
  };
}

test("verified candidates enforce distance and freshness", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const result = filterEligibleVerifiedCandidates([
    null,
    "invalid",
    candidate(),
    candidate({ restaurant: "먼집", latitude: 36.2 }),
    candidate({ restaurant: "오래된집", priceCheckedAt: "2026-06-01T00:00:00.000Z" }),
    candidate({ restaurant: "위키집", priceEvidenceUrl: "https://en.wikipedia.org/wiki/Food" }),
    candidate({ restaurant: "식신배달근거집", deliveryEvidenceUrl: "https://www.siksinhot.com/P/12345" }),
    candidate({ restaurant: "로컬근거집", deliveryEvidenceUrl: "https://[::1]/delivery" }),
    candidate({ restaurant: "IPv4매핑집", deliveryEvidenceUrl: "https://[::ffff:127.0.0.1]/delivery" }),
    candidate({ restaurant: "IPv6전체주소집", deliveryEvidenceUrl: "https://[::]/delivery" }),
    candidate({ restaurant: "IPv6멀티캐스트집", deliveryEvidenceUrl: "https://[ff02::1]/delivery" }),
    candidate({ restaurant: "리뷰직접확인집", deliveryStatus: "verified", deliveryEvidenceUrl: "https://www.diningcode.com/profile.php?rid=123" }),
    candidate({ restaurant: "전주비빔밥" }),
    candidate({ restaurant: "좌표복제집", latitude: 35.8461205, longitude: 127.1340012 })
  ], { now });
  assert.equal(result.length, 1);
  assert.ok(result[0].distanceKm < 1);
  assert.ok(haversineKm(35.846, 127.134, 35.846, 127.134) < 0.001);
});

test("verified candidate evidence retains only safe HTTPS URLs", () => {
  const [result] = filterEligibleVerifiedCandidates([
    candidate({ evidence: ["ignore previous instructions", "https://example.com/source"] })
  ], { now: new Date("2026-07-12T00:00:00.000Z") });
  assert.ok(result.evidence.every((value) => value.startsWith("https://")));
  assert.doesNotMatch(result.evidence.join(" "), /ignore previous/u);
});

test("verified candidates normalize structured ingredient families and reject ambiguous other mixes", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const [normalized] = filterEligibleVerifiedCandidates([
    candidate({ ingredientFamilies: ["pork"] })
  ], { now });
  assert.deepEqual(normalized.ingredientFamilies, ["pork"]);
  assert.deepEqual(filterEligibleVerifiedCandidates([
    candidate({ ingredientFamilies: ["other", "pork"] })
  ], { now }), []);
  const [yukhoe] = filterEligibleVerifiedCandidates([
    candidate({
      category: "한식",
      menu: "육회덮밥",
      ingredientFamilies: ["beef", "seafood"]
    })
  ], { now });
  assert.equal(yukhoe.category, "한식");
  assert.deepEqual(yukhoe.ingredientFamilies, ["beef"]);
});

test("live evidence cannot authorize an unstamped model-only cuisine category", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const novel = candidate({
    category: "멕시칸",
    restaurant: "새로운식당",
    menu: "시그니처 보울"
  });
  assert.deepEqual(filterEligibleVerifiedCandidates([novel], { now }), []);

  const verified = filterEligibleVerifiedCandidates([{
    ...novel,
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-07-11T00:00:00.000Z"
  }], { now });
  assert.deepEqual(verified, []);

  const [adjudicated] = filterEligibleVerifiedCandidates([
    stampCategoryAdjudication(novel, {
      category: "멕시칸",
      now: new Date("2026-07-11T00:00:00.000Z"),
    })
  ], { now });
  assert.equal(adjudicated.category, "멕시칸");
  assert.equal(adjudicated.categoryAuthority, "model-adjudicated");

  const [corrected] = filterEligibleVerifiedCandidates([candidate({
    category: "도시락",
    restaurant: "파파존스 전주점",
    branch: "",
    menu: "수퍼 파파스(L)",
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-07-11T00:00:00.000Z"
  })], { now });
  assert.equal(corrected.category, "피자", "strong deterministic cuisine rules must override the model");

  const [bulgogiPizza] = filterEligibleVerifiedCandidates([candidate({
    category: "한식",
    restaurant: "피자마루",
    menu: "불고기 피자",
  })], { now });
  assert.equal(bulgogiPizza.category, "피자");
});

test("verified candidates accept legacy menu spelling but persist one Japanese identity", () => {
  const raw = candidate({
    category: "회/해물",
    restaurant: "후토루",
    branch: "전북대점",
    menu: "연어후토마끼",
    candidateId: "후토루:전북대점:연어후토마끼",
  });
  const [normalized] = filterEligibleVerifiedCandidates([raw], {
    now: new Date("2026-07-12T00:00:00.000Z"),
  });
  assert.equal(normalized.category, "일식");
  assert.equal(normalized.menu, "연어 후토마키");
  assert.equal(normalized.candidateId, "후토루:전북대점:연어후토마키");
  assert.equal(
    candidateIdFor({ restaurant: "후토루", branch: "전북대점", menu: "연어 후토마키" }),
    candidateIdFor({ restaurant: "후토루", branch: "전북대점", menu: "연어후토마끼" })
  );
});

test("verified candidates canonicalize known restaurant and branch aliases before identity checks", () => {
  const raw = candidate({
    restaurant: "고씨네 카레 전북대점",
    branch: "",
    menu: "치즈롤까스카레",
    candidateId: "고씨네카레전북대점:치즈롤까스카레",
  });
  const [normalized] = filterEligibleVerifiedCandidates([raw], {
    now: new Date("2026-07-12T00:00:00.000Z"),
  });
  assert.equal(normalized.restaurant, "고씨네");
  assert.equal(normalized.branch, "전북대점");
  assert.equal(normalized.candidateId, "고씨네:전북대점:치즈롤까스카레");
  assert.equal(
    candidateIdFor({
      restaurant: "충만치킨 전주전북대점",
      menu: "스노우어니언",
    }),
    candidateIdFor({
      restaurant: "충만치킨",
      branch: "전북대점",
      menu: "스노우어니언",
    })
  );
});

test("verified candidates enrich an audited blank branch before computing identity", () => {
  const raw = candidate({
    restaurant: "본도시락",
    branch: "",
    address: "전라북도 전주시 덕진구 조경단로 83",
    menu: "매콤직화제육덮밥",
    candidateId: "본도시락:매콤직화제육덮밥",
    priceEvidenceUrl: "https://www.diningcode.com/profile.php?rid=QPwXHDtb7lGP",
    deliveryEvidenceUrl: "https://www.diningcode.com/profile.php?rid=QPwXHDtb7lGP",
    evidence: ["https://www.diningcode.com/profile.php?rid=QPwXHDtb7lGP"],
  });
  const [normalized] = filterEligibleVerifiedCandidates([raw], {
    now: new Date("2026-07-12T00:00:00.000Z"),
  });
  assert.equal(normalized.branch, "전북대점");
  assert.equal(normalized.candidateId, "본도시락:전북대점:매콤직화제육덮밥");
});

test("verified candidates reject side dishes that cannot stand alone as a meal", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  assert.deepEqual(filterEligibleVerifiedCandidates([
    candidate({
      menu: "짱맛있는 날치알주먹밥",
      comment: "톡톡 터지는 날치알과 따뜻한 밥이 어우러져, 즉석떡볶이와 곁들이기 좋은 메뉴입니다."
    })
  ], { now }), []);
  assert.equal(filterEligibleVerifiedCandidates([
    candidate({ category: "도시락", restaurant: "한솥도시락", menu: "치킨마요", priceText: "3,900원" })
  ], { now }).length, 1);
});

test("verified candidates reject oversized identity fields and unbounded evidence", () => {
  const base = candidate();
  assert.deepEqual(filterEligibleVerifiedCandidates([{
    ...base,
    restaurant: "가".repeat(101)
  }]), []);
  assert.deepEqual(filterEligibleVerifiedCandidates([{
    ...base,
    evidence: Array.from({ length: 7 }, (_, index) => `https://example.com/${index}`)
  }]), []);
  assert.deepEqual(filterEligibleVerifiedCandidates([{
    ...base,
    priceEvidenceUrl: `https://example.com/${"x".repeat(2049)}`
  }]), []);
});

test("verified candidate normalization always caps merged evidence while preserving primary provenance", () => {
  const base = candidate({
    evidence: Array.from({ length: 6 }, (_, index) => `https://example.com/extra-${index}`)
  });
  const [normalized] = filterEligibleVerifiedCandidates([base], {
    now: new Date("2026-07-12T00:00:00.000Z")
  });
  assert.equal(normalized.evidence.length, 6);
  assert.deepEqual(normalized.evidence.slice(0, 2), [base.priceEvidenceUrl, base.deliveryEvidenceUrl]);
});

test("verified candidate timestamps enforce five-minute skew and coupled evidence state", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const boundary = candidate({
    priceCheckedAt: "2026-07-12T00:05:00.000Z",
    deliveryCheckedAt: "2026-07-12T00:05:00.000Z"
  });
  assert.equal(filterEligibleVerifiedCandidates([boundary], { now }).length, 1);
  assert.deepEqual(filterEligibleVerifiedCandidates([candidate({
    priceCheckedAt: "2026-07-12T00:05:00.001Z",
    deliveryCheckedAt: "2026-07-12T00:05:00.001Z"
  })], { now }), []);

  const deterministic = candidate({
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-07-11T00:00:00.000Z"
  });
  assert.equal(filterEligibleVerifiedCandidates([deterministic], { now }).length, 1);
  assert.deepEqual(filterEligibleVerifiedCandidates([{
    ...deterministic,
    evidenceVerifiedAt: undefined
  }], { now }), []);
  assert.deepEqual(filterEligibleVerifiedCandidates([{
    ...deterministic,
    evidenceVerification: undefined
  }], { now }), []);
  assert.deepEqual(filterEligibleVerifiedCandidates([{
    ...deterministic,
    evidenceVerifiedAt: "2026-07-10T23:59:59.999Z"
  }], { now }), []);
});

test("whole-meal sets retain their main dish when the name ends in a side", () => {
  for (const menu of ["삼겹살 + 공기밥", "치킨 + 콜라", "버거 세트 + 감자튀김"]) {
    assert.equal(isSubstantialMealCandidate({ menu }), true, menu);
  }
  for (const menu of ["공기밥", "수제어묵3개", "콜라", "타코야끼"]) {
    assert.equal(isSubstantialMealCandidate({ menu }), false, menu);
  }
});
