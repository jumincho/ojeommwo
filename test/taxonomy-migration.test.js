import test from "node:test";
import assert from "node:assert/strict";
import { migrateTaxonomyStores } from "../src/taxonomy-migration.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

function item(overrides = {}) {
  return {
    category: "도시락",
    restaurant: "파파존스 전주점",
    menu: "수퍼 파파스(L)",
    channel: "C123",
    messageTs: "1.1",
    ...overrides,
  };
}

test("taxonomy repair preserves original send category and is idempotent", () => {
  const input = {
    recommendations: [],
    recommendationHistory: { version: 1, items: [
      item({ category: "한식", restaurant: "홍익", menu: "얼큰 육개장" }),
      item({ category: "찜/탕", restaurant: "장미맨숀", menu: "곱도리탕" }),
      item({ category: "일식", restaurant: "치쿠린", menu: "쇼유돈코츠라멘" }),
    ] },
    sentMessages: { version: 1, messages: [] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  };
  const first = migrateTaxonomyStores(input);
  assert.equal(first.stores.recommendationHistory.items[0].category, "찜/탕");
  assert.equal(first.stores.recommendationHistory.items[0].categoryAtSend, "한식");
  assert.equal(first.report.removedRecommendationGroups, 0);
  assert.deepEqual(migrateTaxonomyStores(first.stores).stores, first.stores);
});

test("taxonomy migration removes an entire snack recommendation bundle and its linked records", () => {
  const input = {
    recommendations: [item()],
    recommendationHistory: {
      version: 1,
      items: [
        item(),
        item({ category: "일식", restaurant: "사이코우타코야끼", menu: "18알 타코야끼" }),
        item({ category: "치킨", restaurant: "교촌치킨", menu: "허니순살" }),
      ],
    },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: {
      version: 1,
      responses: [{ channel: "C123", messageTs: "1.1", ratings: [item(), item(), item()] }],
    },
    verifiedCandidates: { version: 1, candidates: [item()], catalog: [item()] },
  };
  const original = structuredClone(input);
  const result = migrateTaxonomyStores(input);
  assert.deepEqual(input, original, "migration must not mutate the source snapshot");
  assert.equal(result.stores.recommendationHistory.items.length, 0);
  assert.equal(result.stores.sentMessages.messages.length, 0);
  assert.equal(result.stores.candidatePreferences.responses.length, 0);
  assert.equal(result.report.removedRecommendationGroups, 1);
  assert.equal(result.stores.recommendations[0].category, "피자");
  assert.equal(result.stores.verifiedCandidates.candidates[0].category, "피자");
  assert.equal(result.stores.verifiedCandidates.catalog[0].category, "피자");
});

test("taxonomy migration canonicalizes active preference and meal data", () => {
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: { version: 1, items: [] },
    sentMessages: { version: 1, messages: [] },
    mealEvents: {
      version: 1,
      events: [{ eventId: "E1", category: null, restaurant: "산이솔이야", menu: "냉소바" }],
    },
    candidatePreferences: {
      version: 1,
      responses: [{
        ratings: [
          item({ category: "찜/탕", restaurant: "흐엉꾸에", menu: "양지쌀국수" }),
          item({ category: "햄버거", restaurant: "버거킹", menu: "와퍼" }),
          item({ category: "도시락", restaurant: "짱그미김밥", menu: "김치볶음밥" }),
        ],
      }],
    },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  });
  assert.equal(result.stores.mealEvents.events[0].category, "일식");
  assert.deepEqual(
    result.stores.candidatePreferences.responses[0].ratings.map((rating) => rating.category),
    ["아시안", "버거", "한식"]
  );
});

test("taxonomy migration never promotes unverified custom text into a category", () => {
  const unresolved = {
    eventId: "E-UNRESOLVED",
    inputText: "원조 삼거리 고갯길 · 블루베리 잼 시래기국밥",
    inputNormalization: "separate-fields",
    rawRestaurant: "원조 삼거리 고갯길",
    rawMenu: "블루베리 잼 시래기국밥",
    restaurant: "원조 삼거리 고갯길",
    menu: "블루베리 잼 시래기국밥",
    category: null,
    normalizationStatus: "rejected-input",
    normalizationAttemptCount: 3
  };
  const verified = {
    ...unresolved,
    eventId: "E-VERIFIED",
    inputText: "와우케밥치킨 · 치킨양믹스롤",
    rawRestaurant: "와우케밥치킨",
    rawMenu: "치킨양믹스롤",
    restaurant: "와우케밥 치킨",
    menu: "롤 믹스 램 L",
    normalizationStatus: "verified",
    category: null
  };
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: { version: 1, items: [] },
    sentMessages: { version: 1, messages: [] },
    mealEvents: { version: 1, events: [unresolved, verified] },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  });
  assert.equal(result.stores.mealEvents.events[0].category, null);
  assert.equal(result.stores.mealEvents.events[1].category, "아시안");
  assert.deepEqual(result.report.categoryChanges, { "미분류 -> 아시안": 1 });
});

test("taxonomy migration removes the retired meal participant-count field from every event", () => {
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: { version: 1, items: [] },
    sentMessages: { version: 1, messages: [] },
    mealEvents: {
      version: 1,
      events: [
        { eventId: "legacy", normalizationStatus: "pending", inputText: "대충 적은 메뉴", participantCount: 4 },
        { eventId: "verified", restaurant: "면식당", branch: "전북대점", menu: "돈코츠라멘", participantCount: 2 },
      ],
    },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  });
  assert.equal(result.report.removedMealParticipantCounts, 2);
  assert.equal(Object.hasOwn(result.stores.mealEvents.events[0], "participantCount"), false);
  assert.equal(Object.hasOwn(result.stores.mealEvents.events[1], "participantCount"), false);
});

test("taxonomy migration repairs audited candidate ingredient families", () => {
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: { version: 1, items: [] },
    sentMessages: { version: 1, messages: [] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: {
      version: 1,
      candidates: [],
      catalog: [
        { category: "한식", restaurant: "김피라", menu: "갈릭우삼겹덮밥", ingredientFamilies: ["beef", "pork"] },
        { category: "구이", restaurant: "동네불막창&닭발", menu: "반반세트", ingredientFamilies: ["poultry", "offal"] }
      ]
    }
  });
  assert.deepEqual(
    result.stores.verifiedCandidates.catalog.map((candidate) => candidate.ingredientFamilies),
    [["beef"], ["offal"]]
  );
  assert.deepEqual(result.report.ingredientFamilyChanges, {
    "beef,pork -> beef": 1,
    "poultry,offal -> offal": 1
  });
});

test("taxonomy migration backfills menu-source families without duplicating them into feedback events", () => {
  const legacy = {
    category: "버거",
    restaurant: "맥도날드 전주덕진DT점",
    menu: "빅맥 세트",
  };
  const result = migrateTaxonomyStores({
    recommendations: [{ ...legacy }],
    recommendationHistory: {
      version: 1,
      items: [{ ...legacy, channel: "C123", messageTs: "1.1" }],
    },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [{ ...legacy, eventId: "E1" }] },
    candidatePreferences: {
      version: 1,
      responses: [{ ratings: [
        { ...legacy },
        { category: "치킨", restaurant: "후켄", menu: "후라이드" },
        { category: "분식", restaurant: "분식집", menu: "떡볶이" },
      ] }],
    },
    verifiedCandidates: { version: 1, candidates: [{ ...legacy }], catalog: [] },
  });
  assert.deepEqual(result.stores.recommendations[0].ingredientFamilies, ["beef"]);
  assert.deepEqual(result.stores.recommendationHistory.items[0].ingredientFamilies, ["beef"]);
  assert.deepEqual(result.stores.verifiedCandidates.candidates[0].ingredientFamilies, ["beef"]);
  assert.equal(Object.hasOwn(result.stores.mealEvents.events[0], "ingredientFamilies"), false);
  assert.equal(Object.hasOwn(result.stores.candidatePreferences.responses[0].ratings[0], "ingredientFamilies"), false);
});

test("taxonomy migration repairs Japanese categories, menu labels, and canonical IDs together", () => {
  const legacy = {
    category: "회/해물",
    restaurant: "후토루",
    branch: "전북대점",
    menu: "연어후토마끼",
    candidateId: "후토루:전북대점:연어후토마끼",
  };
  const result = migrateTaxonomyStores({
    recommendations: [{ ...legacy }],
    recommendationHistory: {
      version: 1,
      items: [
        { ...legacy, channel: "C123", messageTs: "1.1" },
        {
          category: "회/해물",
          restaurant: "주미담",
          menu: "해물볶음우동(매콤)",
          channel: "C123",
          messageTs: "1.1",
        },
        {
          category: "회/해물",
          restaurant: "스시 아시타",
          menu: "아시타 베이직 초밥 정식",
          channel: "C123",
          messageTs: "1.1",
        },
      ],
    },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: {
      version: 1,
      responses: [{ ratings: [
        { ...legacy },
        { category: "회/해물", restaurant: "주미담", menu: "해물볶음우동(매콤)" },
        { category: "회/해물", restaurant: "스시 아시타", menu: "아시타 베이직 초밥 정식" },
      ] }],
    },
    verifiedCandidates: {
      version: 1,
      candidates: [{ ...legacy }],
      catalog: [],
    },
  });
  const canonical = result.stores.verifiedCandidates.candidates[0];
  assert.equal(canonical.category, "일식");
  assert.equal(canonical.menu, "연어 후토마키");
  assert.equal(canonical.candidateId, "후토루:전북대점:연어후토마키");
  assert.deepEqual(
    result.stores.recommendationHistory.items.map((item) => item.category),
    ["일식", "일식", "일식"]
  );
  assert.ok(result.report.candidateIdChanges >= 3);
  assert.ok(result.report.menuNameChanges["연어후토마끼 -> 연어 후토마키"] >= 3);
});

test("taxonomy migration repairs cuisine precedence and restaurant aliases without losing history", () => {
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: {
      version: 1,
      items: [
        {
          category: "회/해물",
          restaurant: "돔베 초밥 아중점",
          menu: "연어3 + 광어3 + 참치3 9p",
          channel: "C123",
          messageTs: "1.1",
        },
        {
          category: "회/해물",
          restaurant: "본죽&비빔밥cafe 전북대점",
          menu: "낙지김치비빔밥",
          channel: "C123",
          messageTs: "1.1",
        },
        {
          category: "돈까스",
          restaurant: "고씨네 카레 전북대점",
          menu: "치즈롤까스카레",
          channel: "C123",
          messageTs: "1.1",
        },
      ],
    },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: {
      version: 1,
      responses: [{
        ratings: [
          { category: "회/해물", restaurant: "돔베 초밥 아중점", menu: "연어3 + 광어3 + 참치3 9p" },
          { category: "회/해물", restaurant: "본죽&비빔밥cafe 전북대점", menu: "낙지김치비빔밥" },
          { category: "돈까스", restaurant: "고씨네 카레 전북대점", menu: "치즈롤까스카레" },
        ],
      }],
    },
    verifiedCandidates: {
      version: 1,
      candidates: [
        {
          category: "돈까스",
          restaurant: "고씨네 카레",
          branch: "전주 전북대점",
          menu: "치즈롤까스카레",
          candidateId: "고씨네카레:전주전북대점:치즈롤까스카레",
          deliveryCheckedAt: "2026-07-20T00:00:00.000Z",
        },
        {
          category: "돈까스",
          restaurant: "고씨네",
          branch: "전북대점",
          menu: "치즈롤까스카레",
          candidateId: "고씨네:전북대점:치즈롤까스카레",
          deliveryCheckedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
      catalog: [],
    },
  });

  assert.deepEqual(
    result.stores.recommendationHistory.items.map((entry) => entry.category),
    ["일식", "한식", "일식"]
  );
  assert.equal(result.stores.recommendationHistory.items[2].restaurant, "고씨네");
  assert.equal(result.stores.recommendationHistory.items[2].branch, "전북대점");
  assert.equal(result.stores.verifiedCandidates.candidates.length, 1);
  assert.equal(result.stores.verifiedCandidates.candidates[0].candidateId, "고씨네:전북대점:치즈롤까스카레");
  assert.equal(result.report.deduplicatedActiveCandidates, 1);
});

test("taxonomy migration collapses the audited THE담다 restaurant spelling", () => {
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: {
      version: 1,
      items: [{
        category: "돈까스",
        restaurant: "THE담다",
        menu: "매운 해물뎃판까스",
        channel: "C123",
        messageTs: "1.1",
      }],
    },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  });

  assert.equal(result.stores.recommendationHistory.items[0].restaurant, "더 담다");
  assert.equal(result.stores.recommendationHistory.items[0].branch, undefined);
  assert.equal(result.report.restaurantNameChanges["THE담다 -> 더 담다"], 1);
});

test("taxonomy migration collapses audited spacing variants into one branch identity", () => {
  const variants = [
    ["춘리 마라탕 전북대점", "마라탕", "중식", "춘리마라탕"],
    ["프랭크 버거 전북대점", "프랭크버거 세트", "버거", "프랭크버거"],
    ["홍콩반점 0410 전북대점", "짜장면", "중식", "홍콩반점0410"],
    ["피자 스쿨 전북대점", "고구마피자", "피자", "피자스쿨"],
  ];
  const history = variants.map(([restaurant, menu, category], index) => ({
    category,
    restaurant,
    menu,
    channel: "C123",
    messageTs: `${index + 1}.1`,
  }));
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: { version: 1, items: history },
    sentMessages: {
      version: 1,
      messages: history.map((item) => ({ channel: item.channel, ts: item.messageTs })),
    },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  });

  assert.deepEqual(
    result.stores.recommendationHistory.items.map(({ restaurant, branch }) => ({ restaurant, branch })),
    variants.map(([, , , restaurant]) => ({ restaurant, branch: "전북대점" }))
  );
  assert.equal(result.report.removedRecommendationGroups, 0);
  assert.equal(result.report.removedRecommendationItems, 0);
});

test("taxonomy migration collapses audited restaurant-specific menu label changes", () => {
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: {
      version: 1,
      items: [
        { category: "회/해물", restaurant: "광장수산", branch: "덕진광장로점", menu: "광어", candidateId: "광장수산:덕진광장로점:광어" },
        { category: "중식", restaurant: "로충칭마라탕", branch: "전북대점", menu: "마라탕", candidateId: "로충칭마라탕:전북대점:마라탕" },
      ],
    },
    sentMessages: { version: 1, messages: [] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  });

  assert.deepEqual(
    result.stores.recommendationHistory.items.map(({ menu, candidateId }) => ({ menu, candidateId })),
    [
      { menu: "광어(소)", candidateId: "광장수산:덕진광장로점:광어소" },
      { menu: "마라탕 1인", candidateId: "로충칭마라탕:전북대점:마라탕1인" },
    ]
  );
  assert.equal(result.report.menuNameChanges["광어 -> 광어(소)"], 1);
  assert.equal(result.report.menuNameChanges["마라탕 -> 마라탕 1인"], 1);
});

test("taxonomy migration enriches only audited locations and propagates identity to linked ratings", () => {
  const locations = [
    {
      category: "도시락",
      restaurant: "본도시락",
      branch: "",
      address: "전라북도 전주시 덕진구 조경단로 83",
      menu: "매콤직화제육덮밥",
      candidateId: "본도시락:매콤직화제육덮밥",
      evidence: ["https://www.diningcode.com/profile.php?rid=QPwXHDtb7lGP"],
    },
    {
      category: "회/해물",
      restaurant: "광장수산",
      branch: "",
      address: "전북특별자치도 전주시 덕진구 덕진광장로 1-11 1호",
      menu: "광어(소)",
      candidateId: "광장수산:광어소",
      evidence: ["https://www.diningcode.com/profile.php?rid=bzDOMtvnugZq"],
    },
    {
      category: "일식",
      restaurant: "하나요리당고",
      branch: "",
      address: "전라북도 전주시 덕진구 권삼득로 333 113호",
      menu: "토마토규동",
      candidateId: "하나요리당고:토마토규동",
      evidence: ["https://www.diningcode.com/profile.php?rid=2xHNItG0xclL"],
    },
  ];
  const history = locations.map((entry) => ({
    ...entry,
    channel: "C123",
    messageTs: "1.1",
  }));
  const ratings = locations.map(({ evidence, address, ...entry }) => ({
    ...entry,
    rating: 3,
  }));
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: { version: 1, items: history },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: {
      version: 1,
      responses: [{ channel: "C123", messageTs: "1.1", ratings }],
    },
    verifiedCandidates: {
      version: 1,
      candidates: [{ ...locations[0] }],
      catalog: [{ ...locations[1] }, { ...locations[2] }],
    },
  });

  const expectedBranches = ["전북대점", "덕진광장로점", "전북대점"];
  const expectedIds = [
    "본도시락:전북대점:매콤직화제육덮밥",
    "광장수산:덕진광장로점:광어소",
    "하나요리당고:전북대점:토마토규동",
  ];
  assert.deepEqual(
    result.stores.recommendationHistory.items.map((entry) => entry.branch),
    expectedBranches
  );
  assert.deepEqual(
    result.stores.candidatePreferences.responses[0].ratings.map((entry) => entry.branch),
    expectedBranches
  );
  assert.deepEqual(
    result.stores.candidatePreferences.responses[0].ratings.map((entry) => entry.candidateId),
    expectedIds
  );
  assert.deepEqual(result.report.branchNameChanges, {
    "미지정 -> 덕진광장로점": 3,
    "미지정 -> 전북대점": 6,
  });
  assert.equal(result.report.candidateIdChanges, 9);
});

test("taxonomy migration repairs reviewed live identity duplicates and cuisine errors", () => {
  const result = migrateTaxonomyStores({
    recommendations: [{
      category: "치킨",
      restaurant: "파스톨로지",
      menu: "치킨 파마지아나(호주식치킨까스)",
    }],
    recommendationHistory: { version: 1, items: [] },
    sentMessages: { version: 1, messages: [] },
    mealEvents: {
      version: 1,
      events: [{
        restaurant: "모퉁이",
        branch: "전북대점",
        address: "전북특별자치도 전주시 덕진구 삼송3길 42, 107호",
        menu: "모퉁이덮밥",
        menus: ["모퉁이덮밥"],
        category: "한식",
        inputText: "모퉁이 · 모퉁이 덮밥",
        normalizationStatus: "verified",
        normalization: {
          restaurantEvidenceUrl: "https://www.diningcode.com/profile.php?rid=ugffp3S7d2Yl",
          menuEvidence: [{
            canonicalName: "모퉁이덮밥",
            evidenceUrl: "https://www.tabling.co.kr/place/677cd7fa66de5f069893b106",
          }],
        },
      }],
    },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: {
      version: 1,
      candidates: [
        {
          category: "돈까스",
          restaurant: "더 담다",
          branch: "",
          address: "전주시 덕진구 권삼득로 333",
          menu: "흑돼지인생돈까스",
          candidateId: "더담다:흑돼지인생돈가스",
          evidence: ["https://www.tabling.co.kr/place/677ccbd066de5f06987decbb"],
          evidenceVerifiedAt: "2026-07-30T00:00:00.000Z",
        },
        {
          category: "돈까스",
          restaurant: "더 담다",
          branch: "전북대점",
          address: "전주시 덕진구 권삼득로 333",
          menu: "흑돼지인생돈까스",
          candidateId: "더담다:전북대점:흑돼지인생돈가스",
          evidence: ["https://www.tabling.co.kr/place/677ccbd066de5f06987decbb"],
          evidenceVerifiedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
      catalog: [
        {
          category: "버거",
          restaurant: "코지버거",
          branch: "",
          address: "전주시 덕진구 명륜3길 9-4",
          menu: "Cozy Burger",
          candidateId: "코지버거:cozyburger",
          evidence: ["https://www.diningcode.com/profile.php?rid=t1SdeO793r5P"],
          evidenceVerifiedAt: "2026-07-30T00:00:00.000Z",
        },
        {
          category: "버거",
          restaurant: "코지버거",
          branch: "전북대점",
          address: "전주시 덕진구 명륜3길 9-4",
          menu: "코지버거",
          candidateId: "코지버거:전북대점:코지버거",
          evidence: ["https://www.diningcode.com/profile.php?rid=t1SdeO793r5P"],
          evidenceVerifiedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(result.stores.recommendations[0].category, "양식");
  assert.equal(result.stores.mealEvents.events[0].restaurant, "모퉁이덮밥");
  assert.equal(result.stores.mealEvents.events[0].branch, "");
  assert.equal(result.stores.mealEvents.events[0].category, "일식");
  assert.equal(result.stores.verifiedCandidates.candidates.length, 1);
  assert.equal(result.stores.verifiedCandidates.candidates[0].branch, "전북대점");
  assert.equal(result.stores.verifiedCandidates.catalog.length, 1);
  assert.equal(result.stores.verifiedCandidates.catalog[0].menu, "코지버거");
  assert.equal(result.stores.verifiedCandidates.catalog[0].branch, "전북대점");
  assert.equal(result.report.deduplicatedActiveCandidates, 1);
  assert.equal(result.report.deduplicatedCatalogCandidates, 1);
});

test("taxonomy migration drops unstamped model-only recommendation categories even with item evidence", () => {
  const novel = {
    category: "멕시칸",
    restaurant: "새로운식당",
    branch: "전북대점",
    menu: "시그니처 보울",
    candidateId: "새로운식당:전북대점:시그니처보울",
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-08-20T00:00:00.000Z",
  };
  const result = migrateTaxonomyStores({
    recommendations: [{ ...novel }],
    recommendationHistory: {
      version: 1,
      items: [{ ...novel, channel: "C123", messageTs: "1.1" }]
    },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: {
      version: 1,
      responses: [{ channel: "C123", messageTs: "1.1", ratings: [
        { ...novel },
        { category: "피자", restaurant: "피자집", menu: "치즈피자", candidateId: "피자집:치즈피자" },
        { category: "버거", restaurant: "버거집", menu: "치즈버거", candidateId: "버거집:치즈버거" }
      ] }]
    },
    verifiedCandidates: {
      version: 1,
      candidates: [
        { ...novel },
        {
          ...novel,
          restaurant: "미검증식당",
          menu: "미검증 보울",
          candidateId: "미검증식당:전북대점:미검증보울",
          evidenceVerification: undefined,
          evidenceVerifiedAt: undefined,
        }
      ],
      catalog: [
        { ...novel },
        {
          ...novel,
          restaurant: "미검증카탈로그",
          menu: "미검증 플레이트",
          candidateId: "미검증카탈로그:전북대점:미검증플레이트",
          evidenceVerification: undefined,
          evidenceVerifiedAt: undefined,
        }
      ]
    },
  });
  assert.equal(result.stores.recommendations.length, 0, "static/model-only rows remain strict");
  assert.equal(result.stores.recommendationHistory.items.length, 0);
  assert.equal(result.stores.sentMessages.messages.length, 0);
  assert.equal(result.stores.verifiedCandidates.candidates.length, 0);
  assert.equal(result.stores.verifiedCandidates.catalog.length, 0);
  assert.equal(result.stores.candidatePreferences.responses.length, 0);
  assert.equal(result.report.removedActiveCandidates, 2);
  assert.equal(result.report.removedCatalogCandidates, 2);
  assert.equal(result.report.removedRecommendationGroups, 1);
  assert.equal(result.report.removedSentMessages, 1);
  assert.equal(result.report.removedPreferenceResponses, 1);
});

test("taxonomy migration preserves identity-bound model category adjudication in learned stores", () => {
  const stamped = stampCategoryAdjudication({
    category: "멕시칸",
    restaurant: "새로운식당",
    branch: "전북대점",
    menu: "시그니처 보울",
    candidateId: "새로운식당:전북대점:시그니처보울",
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-08-20T00:00:00.000Z",
  }, {
    category: "멕시칸",
    now: new Date("2026-08-20T00:00:00.000Z"),
  });
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: {
      version: 1,
      items: [{ ...stamped, channel: "C123", messageTs: "1.1" }],
    },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: {
      version: 1,
      responses: [{ channel: "C123", messageTs: "1.1", ratings: [
        { ...stamped },
        { category: "피자", restaurant: "피자집", menu: "치즈피자" },
        { category: "버거", restaurant: "버거집", menu: "치즈버거" },
      ] }],
    },
    verifiedCandidates: {
      version: 1,
      candidates: [{ ...stamped }],
      catalog: [{ ...stamped }],
    },
  });
  assert.equal(result.stores.recommendationHistory.items[0].category, "멕시칸");
  assert.equal(result.stores.recommendationHistory.items[0].categoryAuthority, "model-adjudicated");
  assert.equal(result.stores.candidatePreferences.responses[0].ratings[0].categoryAuthority, "model-adjudicated");
  assert.equal(result.stores.verifiedCandidates.candidates[0].categoryAuthority, "model-adjudicated");
  assert.equal(result.stores.verifiedCandidates.catalog[0].categoryAuthority, "model-adjudicated");
});

test("taxonomy migration rewrites a valid legacy model authority without changing its decision", () => {
  const stamped = stampCategoryAdjudication({
    category: "멕시칸",
    restaurant: "새로운식당",
    branch: "전북대점",
    menu: "시그니처 보울",
  }, { category: "멕시칸", now: new Date("2026-08-20T00:00:00.000Z") });
  const legacy = { ...stamped, categoryAuthority: "luna-adjudicated", channel: "C123", messageTs: "1.1" };
  const result = migrateTaxonomyStores({
    recommendations: [],
    recommendationHistory: { version: 1, items: [legacy] },
    sentMessages: { version: 1, messages: [{ channel: "C123", ts: "1.1" }] },
    mealEvents: { version: 1, events: [] },
    candidatePreferences: { version: 1, responses: [] },
    verifiedCandidates: { version: 1, candidates: [], catalog: [] },
  });
  assert.equal(result.stores.recommendationHistory.items[0].category, "멕시칸");
  assert.equal(result.stores.recommendationHistory.items[0].categoryAuthority, "model-adjudicated");
  assert.equal(result.report.categoryAuthorityChanges["luna-adjudicated -> model-adjudicated"], 1);
});
