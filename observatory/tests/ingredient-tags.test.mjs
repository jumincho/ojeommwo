import { hasBeefWhopperPatty } from "../../src/choice-diversity.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  INGREDIENT_SEARCH_TAGS,
  MAX_INGREDIENT_SEARCH_TAGS,
  ingredientSearchTagsFor,
} from "../scripts/lib/ingredient-tags.mjs";
import { testSnapshot } from "./helpers/snapshot-fixture.mjs";
import { validateSnapshot as validateBrowserSnapshot } from "../app/lib/snapshot-validator.mjs";
import { validateSnapshot as validateServerSnapshot } from "../scripts/lib/snapshot-schema.mjs";

const generatedAt = new Date().toISOString();
const snapshot = testSnapshot(generatedAt);
const allowedTags = new Set(INGREDIENT_SEARCH_TAGS);

function hasTag(menu, id) {
  return menu.ingredientFamilies.some((tag) => tag.startsWith(`${id} ·`));
}

function searchByIngredient(query) {
  const needle = String(query).normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ").trim();
  return snapshot.menus.filter((menu) => menu.ingredientFamilies.join(" ").toLocaleLowerCase("ko-KR").includes(needle));
}

test("an unqualified Levant kebab does not inherit an unverified lamb label", () => {
  assert.deepEqual(ingredientSearchTagsFor({
    restaurant: "레반트", menu: "케밥", category: "아시안", ingredientFamilies: ["lamb"]
  }), ["mixed ingredients · 복합재료"]);
  assert.ok(ingredientSearchTagsFor({
    restaurant: "레반트", menu: "양고기 케밥", category: "아시안"
  }).includes("lamb · 양고기"));
});

test("all current observatory menus have bounded canonical bilingual ingredient tags", () => {
  assert.ok(snapshot.menus.length >= 114, "the canonical projection unexpectedly lost menus");
  assert.equal(validateServerSnapshot(snapshot), snapshot);
  assert.equal(validateBrowserSnapshot(snapshot), snapshot);
  for (const menu of snapshot.menus) {
    assert.ok(menu.ingredientFamilies.length >= 1 && menu.ingredientFamilies.length <= MAX_INGREDIENT_SEARCH_TAGS, `${menu.restaurantLabel}/${menu.menu}`);
    assert.equal(new Set(menu.ingredientFamilies).size, menu.ingredientFamilies.length, `${menu.restaurantLabel}/${menu.menu} duplicate tags`);
    assert.ok(menu.ingredientFamilies.every((tag) => allowedTags.has(tag)), `${menu.restaurantLabel}/${menu.menu} non-canonical tag`);
    assert.ok(menu.ingredientFamilies.every((tag) => /[a-z].* · .*[가-힣]/u.test(tag)), `${menu.restaurantLabel}/${menu.menu} is not bilingual`);
    const ambiguousHistoricalKebab = menu.restaurant === "레반트" && menu.menu === "케밥";
    assert.equal(menu.ingredientFamilies.some((tag) => tag.startsWith("mixed")), ambiguousHistoricalKebab,
      `${menu.restaurantLabel}/${menu.menu} has an unexpected generic tag`);
  }
});

test("category guarantees are exhaustively preserved without trusting the raw category as arbitrary prose", () => {
  const guarantees = new Map([
    ["치킨", ["chicken"]],
    ["족발/보쌈", ["pork"]],
    ["회/해물", ["seafood"]],
    ["피자", ["bread", "cheese"]],
    ["버거", ["bread"]],
    ["샌드위치", ["bread"]],
    ["도시락", ["rice"]],
  ]);
  for (const [category, tags] of guarantees) {
    const menus = snapshot.menus.filter((menu) => menu.category === category);
    assert.ok(menus.length > 0, `fixture has no ${category} menus`);
    for (const menu of menus) {
      for (const tag of tags) assert.equal(hasTag(menu, tag), true, `${menu.restaurantLabel}/${menu.menu} is missing ${tag}`);
    }
  }
});

test("pork and 돼지고기 searches are equivalent and cover definite pork without protein substring false positives", () => {
  const english = searchByIngredient("pork");
  const korean = searchByIngredient("돼지고기");
  assert.deepEqual(korean.map((menu) => menu.id), english.map((menu) => menu.id));
  assert.ok(english.length >= 15);
  for (const expected of [
    "삼겹살카레",
    "피순대국밥",
    "돈코츠라멘",
    "고기듬뿍 국물두루치기",
    "1인보쌈M",
    "족보세트(반반, 앞다리)",
    "제육덮밥",
    "차슈덮밥",
    "고구마 치즈 돈카츠",
    "뼈해장국",
  ]) {
    // Live projection membership can expire; semantic regression coverage
    // must remain deterministic even when an old example leaves the DB.
    assert.ok(ingredientSearchTagsFor({ menu: expected }).some((tag) => tag.startsWith("pork ·")), expected);
    for (const current of snapshot.menus.filter((menu) => menu.menu === expected)) {
      assert.equal(hasTag(current, "pork"), true, `${expected} is missing from pork search`);
    }
  }
  for (const excluded of ["갈릭우삼겹덮밥", "우삼겹 도리아", "싸이버거 세트", "통새우와퍼세트", "광어"]) {
    assert.equal(english.some((menu) => menu.menu === excluded), false, `${excluded} is a pork false positive`);
  }
});

test("rice search does not absorb wheat tteok or unrelated noodle and burger names", () => {
  const riceResults = searchByIngredient("rice");
  assert.equal(riceResults.some((menu) => menu.menu === "떡볶이"), false);
  assert.equal(riceResults.some((menu) => menu.menu === "엽기떡볶이"), false);
  assert.equal(ingredientSearchTagsFor({ menu: "짜장밥" }).includes("noodles · 면"), false);
  const riceBurger = ingredientSearchTagsFor({ category: "버거", menu: "라이스버거" });
  assert.equal(riceBurger.includes("bread · 빵/도우"), false);
  assert.equal(riceBurger.includes("rice · 밥"), true);
});

test("tag inference handles explicit families, guarded identity overlaps, restaurant context, and fallback", () => {
  assert.deepEqual(ingredientSearchTagsFor({
    category: "한식",
    restaurant: "만배식탁",
    menu: "육회덮밥",
    ingredientFamilies: ["beef"],
  }), ["beef · 소고기", "rice · 밥"]);
  assert.deepEqual(ingredientSearchTagsFor({
    category: "회/해물",
    restaurant: "후토루",
    menu: "연어 후토마키",
    ingredientFamilies: ["seafood"],
  }), ["seafood · 해산물", "rice · 밥"]);
  assert.deepEqual(ingredientSearchTagsFor({
    category: "회/해물",
    restaurant: "주미담",
    menu: "해물볶음우동",
    ingredientFamilies: ["seafood"],
  }), ["seafood · 해산물", "noodles · 면"]);

  assert.deepEqual(ingredientSearchTagsFor({ menu: "오늘의 메뉴", ingredientFamilies: ["pork"] }), ["pork · 돼지고기"]);
  assert.deepEqual(ingredientSearchTagsFor({ menu: "우삼겹 덮밥", ingredientFamilies: ["beef", "pork"] }), ["beef · 소고기", "rice · 밥"]);
  assert.deepEqual(
    ingredientSearchTagsFor({ category: "아시안", restaurant: "와우케밥 치킨", menu: "치+양도네르롤" }),
    ["chicken · 닭고기", "lamb · 양고기", "bread · 빵/도우"]
  );

  const orientalChicken = ingredientSearchTagsFor({ category: "치킨", menu: "교촌오리지날" });
  assert.equal(orientalChicken.includes("chicken · 닭고기"), true);
  assert.equal(orientalChicken.includes("duck · 오리고기"), false);
  const orientalSauce = ingredientSearchTagsFor({ category: "치킨", menu: "오리엔탈파닭" });
  assert.equal(orientalSauce.includes("duck · 오리고기"), false);

  const duckFromGroupedFamily = ingredientSearchTagsFor({ menu: "훈제오리 정식", ingredientFamilies: ["poultry"] });
  assert.equal(duckFromGroupedFamily.includes("duck · 오리고기"), true);
  assert.equal(duckFromGroupedFamily.includes("chicken · 닭고기"), false);

  for (const [menu, expectedTag] of [
    ["돼지불고기 덮밥", "pork · 돼지고기"],
    ["오리불고기 정식", "duck · 오리고기"],
    ["닭불고기 정식", "chicken · 닭고기"],
  ]) {
    const tags = ingredientSearchTagsFor({ menu });
    assert.equal(tags.includes(expectedTag), true, `${menu} lost its stated protein`);
    assert.equal(tags.includes("beef · 소고기"), false, `${menu} is a beef false positive`);
  }
  assert.equal(ingredientSearchTagsFor({ menu: "리얼불고기 피자" }).includes("beef · 소고기"), true);

  const shrimpWhopper = ingredientSearchTagsFor({ category: "버거", menu: "통새우와퍼세트" });
  assert.equal(shrimpWhopper.includes("seafood · 해산물"), true);
  assert.equal(shrimpWhopper.includes("beef · 소고기"), true);
  const beefWhopper = ingredientSearchTagsFor({ category: "버거", menu: "와퍼세트", comment: "불향 패티" });
  assert.equal(beefWhopper.includes("beef · 소고기"), true);
  assert.equal(beefWhopper.includes("meat patty · 고기 패티"), false);

  const riceBurger = ingredientSearchTagsFor({ category: "도시락", menu: "햄치즈밥버거" });
  assert.deepEqual(riceBurger, ["rice · 밥", "cheese · 치즈", "processed meat · 가공육"]);
  for (const menu of ["햄버거", "햄버그스테이크", "hamburger"]) {
    const tags = ingredientSearchTagsFor({ category: "버거", menu });
    assert.equal(tags.includes("processed meat · 가공육"), false, `${menu} is not ham`);
    assert.equal(tags.includes("bread · 빵/도우"), true);
  }

  const shopNameMustNotLeak = ingredientSearchTagsFor({
    category: "분식",
    restaurant: "불닭발 동대문 엽기떡볶이",
    menu: "로제떡볶이",
    comment: "로제소스와 떡, 양배추가 어우러집니다.",
  });
  assert.equal(shopNameMustNotLeak.includes("chicken · 닭고기"), false);

  const sauceNameMustNotLeak = ingredientSearchTagsFor({
    category: "치킨",
    restaurant: "모쿠모쿠",
    menu: "김치치즈치킨",
    comment: "순살 치킨에 김치와 치즈, 탕수육 소스를 곁들입니다.",
    ingredientFamilies: ["poultry"],
  });
  assert.equal(sauceNameMustNotLeak.includes("pork · 돼지고기"), false);
  assert.equal(ingredientSearchTagsFor({ menu: "보쌈 수육 정식" }).includes("pork · 돼지고기"), true);

  const auditedGenericSet = ingredientSearchTagsFor({
    category: "구이",
    restaurant: "동네불막창&닭발",
    menu: "반반세트",
    comment: "막창과 곱창에 치즈계란찜을 곁들입니다.",
    ingredientFamilies: ["poultry", "offal"],
  });
  assert.deepEqual(auditedGenericSet, ["offal · 내장"]);

  assert.deepEqual(ingredientSearchTagsFor({
    category: "일식",
    restaurant: "모퉁이덮밥",
    menu: "모퉁이덮밥",
  }), ["pork · 돼지고기", "rice · 밥"]);
  assert.deepEqual(ingredientSearchTagsFor({
    category: "죽",
    restaurant: "전통 웰빙팥죽",
    menu: "새알팥죽",
  }), ["red bean · 팥", "rice · 밥"]);
  assert.deepEqual(ingredientSearchTagsFor({
    category: "아시안",
    restaurant: "포코",
    menu: "분짜",
    ingredientFamilies: ["other"],
  }), ["pork · 돼지고기", "noodles · 면", "vegetables · 채소"]);
  assert.deepEqual(ingredientSearchTagsFor({
    category: "버거",
    restaurant: "롯데리아",
    menu: "더블 데리버거",
    ingredientFamilies: ["other"],
  }), ["beef · 소고기", "bread · 빵/도우", "vegetables · 채소"]);
  assert.deepEqual(ingredientSearchTagsFor({
    category: "샐러드",
    restaurant: "슬로우캘리",
    menu: "오리엔탈 두부 포케",
    ingredientFamilies: ["other"],
  }), ["tofu · 두부", "rice · 밥", "vegetables · 채소"]);
  const prosciuttoPizza = ingredientSearchTagsFor({
    category: "피자",
    restaurant: "셋다운",
    menu: "프로슈토 부라타 치즈 페스츄리 피자",
  });
  for (const tag of ["pork · 돼지고기", "bread · 빵/도우", "cheese · 치즈", "processed meat · 가공육"]) {
    assert.equal(prosciuttoPizza.includes(tag), true, `prosciutto pizza lost ${tag}`);
  }

  const genericShopName = ingredientSearchTagsFor({
    category: "구이",
    restaurant: "닭발과곱창",
    menu: "반반세트",
  });
  assert.equal(genericShopName.includes("chicken · 닭고기"), false);
  assert.equal(genericShopName.includes("offal · 내장"), false);

  const frankPeanut = ingredientSearchTagsFor({
    category: "버거",
    restaurant: "프랭크버거",
    menu: "피넛버터더블치즈버거",
    comment: "피넛버터, 치즈와 패티가 들어갑니다.",
  });
  for (const tag of ["beef · 소고기", "bread · 빵/도우", "cheese · 치즈", "peanut · 땅콩"]) {
    assert.equal(frankPeanut.includes(tag), true, `Frank Burger lost ${tag}`);
  }

  const unknownPatty = ingredientSearchTagsFor({
    category: "버거",
    restaurant: "버거피아",
    menu: "좀비버거",
    description: "패티 두 장과 토마토, 양상추가 들어갑니다.",
  });
  assert.equal(unknownPatty.includes("meat patty · 고기 패티"), true);
  assert.equal(unknownPatty.includes("beef · 소고기"), false);

  assert.deepEqual(ingredientSearchTagsFor({ category: "한식", menu: "오늘의 특선" }), ["mixed ingredients · 복합재료"]);
});

test("strict server and browser validators reject empty, unknown, or duplicate ingredient tags", () => {
  for (const invalidTags of [[], ["pork"], ["pork · 돼지고기", "pork · 돼지고기"]]) {
    const changed = structuredClone(snapshot);
    changed.menus[0].ingredientFamilies = invalidTags;
    assert.throws(() => validateServerSnapshot(changed), /ingredientFamilies/iu);
    assert.throws(() => validateBrowserSnapshot(changed), /재료|ingredientFamilies|중복/u);
  }
});


test("cutlet and sushi search tags do not invent a different animal", () => {
  for (const [category, menu, absent, present] of [
    ["돈까스", "생선까스", "pork", "seafood"],
    ["돈까스", "치킨카츠", "pork", "chicken"],
    ["일식", "육회초밥", "seafood", "beef"],
    ["일식", "계란초밥", "seafood", "egg"],
  ]) {
    const tags = ingredientSearchTagsFor({ category, menu, ingredientFamilies: menu === "육회초밥" ? ["beef"] : [] });
    assert.ok(tags.some((tag) => tag.startsWith(`${present} ·`)), menu);
    assert.ok(tags.every((tag) => !tag.startsWith(`${absent} ·`)), menu);
  }
  const tags = ingredientSearchTagsFor({ menu: "치킨", comment: "오늘은 돼지고기 대신 닭고기가 좋아요" });
  assert.ok(tags.every((tag) => !tag.startsWith("pork ·")));
});


test("buckwheat futomaki does not inherit rice from its format suffix", () => {
  const tags = ingredientSearchTagsFor({ menu: "소바 후토마키", description: "밥 대신 메밀면으로 말았습니다." });
  assert.ok(tags.includes("noodles · 면"));
  assert.ok(!tags.includes("rice · 밥"));
});

test("audited Hutoru soba futomaki includes shrimp without relabeling ordinary soba", () => {
  const actual = ingredientSearchTagsFor({restaurant: "후토루 전북대점", menu: "소바 후토마키", category: "일식"});
  assert.ok(actual.includes("seafood · 해산물"));
  assert.ok(actual.includes("noodles · 면"));
  assert.ok(!ingredientSearchTagsFor({restaurant: "다른 식당", menu: "소바", category: "일식"}).includes("seafood · 해산물"));
});

test("serving suggestions do not become ingredient tags", () => {
  const tags = ingredientSearchTagsFor({
    restaurant: "두찜", menu: "실비한우곱찜닭", category: "찜/탕",
    ingredientFamilies: ["poultry", "beef", "offal"],
    description: "진한 찜 양념이 스며들어 밥과 함께 든든합니다.",
  });
  assert.equal(tags.includes("rice · 밥"), false);
  assert.ok(ingredientSearchTagsFor({ menu: "새우볶음밥", category: "중식" }).includes("rice · 밥"));
});


test("pairing suggestions do not become ingredients while explicit ingredients and meal identity remain", () => {
  const description = "돼지고기와 떡이 매콤한 국물 양념을 머금어 밥과 계란후라이에 비벼 먹기 좋습니다.";
  const base = { menu: "고기듬뿍 국물두루치기", category: "찜/탕", description };
  const tags = ingredientSearchTagsFor(base);
  assert.equal(tags.includes("egg · 달걀"), false);
  assert.equal(tags.includes("pork · 돼지고기"), true);
  assert.equal(tags.includes("tteok · 떡"), true);
  assert.equal(ingredientSearchTagsFor({ ...base, ingredients: "계란" }).includes("egg · 달걀"), true);
  assert.equal(ingredientSearchTagsFor({ ...base, menu: "계란 덮밥" }).includes("egg · 달걀"), true);
  for (const menu of ["치+양도네르롤", "치킨 퀘사디아", "토르티야 랩"]) {
    assert.equal(ingredientSearchTagsFor({ menu }).includes("bread · 빵/도우"), true, menu);
  }
});

 test("ingredient prose handles Korean noun particles without treating grams as lamb", () => {
  assert.ok(ingredientSearchTagsFor({ menu: "마라탕", category: "중식", description: "다양한 채소·면의 식감" }).includes("noodles · 면"));
  assert.ok(!ingredientSearchTagsFor({ menu: "크림파스타", description: "300그램의 든든한 한 끼" }).includes("lamb · 양고기"));
  assert.ok(ingredientSearchTagsFor({ menu: "램 스테이크" }).includes("lamb · 양고기"));
  assert.ok(ingredientSearchTagsFor({ menu: "램고기 구이" }).includes("lamb · 양고기"));
});

// New catalog rows must not depend on a rich marketing description to search.
test("ingredient identity survives common Korean spellings without description", () => {
  for (const menu of ["머쉬룸 파스타", "머시룸 크림 파스타", "트러플 리조또", "양송이 덮밥"]) {
    assert.ok(ingredientSearchTagsFor({ menu }).includes("mushroom · 버섯"), menu);
  }
  for (const menu of ["규동", "가츠동", "돈부리"]) {
    assert.ok(ingredientSearchTagsFor({ menu }).includes("rice · 밥"), menu);
  }
  assert.ok(ingredientSearchTagsFor({ menu: "규동" }).includes("beef · 소고기"));
  assert.ok(!ingredientSearchTagsFor({ menu: "봉골레 파스타", restaurant: "머쉬룸 식당" }).includes("mushroom · 버섯"));
});


test("verified mixed patties and leafy vegetables remain searchable for new menus", () => {
  for (const menu of ["통새우와퍼", "통새우 와퍼 주니어 세트"]) {
    const tags = ingredientSearchTagsFor({ category: "버거", menu });
    assert.ok(tags.includes("beef · 소고기"), menu);
    assert.ok(tags.includes("seafood · 해산물"), menu);
  }
  for (const menu of ["통새우슈림프버거", "치킨와퍼", "플랜트와퍼"]) {
    assert.ok(!ingredientSearchTagsFor({ category: "버거", menu }).includes("beef · 소고기"), menu);
  }
  for (const menu of ["우거지뼈해장국", "시래기국", "대파육개장"]) {
    assert.ok(ingredientSearchTagsFor({ menu }).includes("vegetables · 채소"), menu);
  }
});


test("browser and operational Whopper protein contracts agree", () => {
  for (const menu of ["통새우와퍼", "통새우 와퍼 주니어 세트", "와퍼", "콰트로치즈와퍼", "통새우슈림프버거", "치킨와퍼", "플랜트와퍼", "비건 와퍼"]) {
    assert.equal(ingredientSearchTagsFor({ category: "버거", menu }).includes("beef · 소고기"), hasBeefWhopperPatty(menu), menu);
  }
});
