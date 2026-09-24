import test from "node:test";
import assert from "node:assert/strict";
import {
  choiceDiversityViolations,
  hasChoiceDiverseSet,
  ingredientFamiliesFor
} from "../src/choice-diversity.js";

function item(category, restaurant, menu, overrides = {}) {
  return { category, restaurant, menu, ...overrides };
}

test("cutlets and sushi retain the explicitly named protein species", () => {
  for (const [category, menu, expected] of [
    ["돈까스", "생선까스", ["seafood"]],
    ["돈까스", "치킨카츠", ["poultry"]],
    ["일식", "육회초밥", ["beef"]],
    ["일식", "계란초밥", ["other"]],
    ["일식", "육회 연어 초밥", ["beef", "seafood"]],
  ]) assert.deepEqual(ingredientFamiliesFor(item(category, "식당", menu)), expected, menu);
});

test("ingredient-family inference catches the reported cross-category overlaps", () => {
  assert.deepEqual(
    ingredientFamiliesFor(item("찜/탕", "두찜", "실비한우곱찜닭")),
    ["poultry", "beef", "offal"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("치킨", "솜리치킨", "순살 깨통닭 + 소스 +무")),
    ["poultry"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("샌드위치", "슬로우캘리", "닭가슴살 에그 통밀 랩")),
    ["poultry"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("버거", "왓더버거", "슈퍼통새우버거")),
    ["seafood"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("구이", "동네불막창&닭발", "반반세트")),
    ["offal"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("도시락", "본도시락", "본격 도시락 오리엔탈 깻잎 치킨")),
    ["poultry"]
  );
});

test("ingredient-family inference rejects identity substring false positives", () => {
  assert.deepEqual(
    ingredientFamiliesFor(item("한식", "김피라", "갈릭우삼겹덮밥", { ingredientFamilies: ["beef", "pork"] })),
    ["beef"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("한식", "식당", "우삼겹 제육덮밥", { ingredientFamilies: ["beef", "pork"] })),
    ["beef", "pork"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("한식", "만배식탁", "육회덮밥", { ingredientFamilies: ["beef", "seafood"] })),
    ["beef"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("회/해물", "바다식당", "광어회덮밥")),
    ["seafood"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("치킨", "모쿠모쿠", "김치치즈치킨", { comment: "탕수육 소스" })),
    ["poultry"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("한식", "보쌈집", "수육 정식")),
    ["pork"]
  );
});

test("deterministic menu identity removes contradictory model families", () => {
  assert.deepEqual(
    ingredientFamiliesFor(item("일식", "뜸들이다", "삼겹살카레", { ingredientFamilies: ["beef"] })),
    ["pork"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("버거", "KFC", "징거버거", { ingredientFamilies: ["seafood"] })),
    ["poultry"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("일식", "후토루", "연어 후토마키", { ingredientFamilies: ["beef"] })),
    ["seafood"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("아시안", "와우케밥 치킨", "치+양도네르롤", { ingredientFamilies: ["seafood"] })),
    ["poultry", "lamb"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("찜/탕", "장미맨숀", "곱도리탕", { ingredientFamilies: ["poultry", "offal"] })),
    ["poultry", "offal"]
  );
});

test("audited terse historical products keep their verified protein family", () => {
  const audited = [
    ["중식", "귀신반점 전북대점", "귀신짬뽕", ["seafood"]],
    ["중식", "도야짬뽕 전북대점", "도야짬뽕", ["seafood"]],
    ["한식", "행복은간장밥 전북대점", "간장 연새 덮밥", ["seafood"]],
    ["중식", "도야짬뽕 전북대점", "크림짬뽕", ["seafood"]],
    ["중식", "짬뽕지존 덕진점", "지존 짬뽕", ["seafood"]],
    ["양식", "롤링파스타 전북대점", "K-탈리안 세트", ["beef"]],
    ["분식", "청년다방 전북대점", "로제떡볶이", ["beef"]],
    ["피자", "도미노피자 전주금암점", "[오] 포테이토 (L)", ["pork"]],
    ["버거", "프랭크버거", "프랭크버거 세트", ["beef"]],
  ];
  for (const [category, restaurant, menu, expected] of audited) {
    assert.deepEqual(ingredientFamiliesFor(item(category, restaurant, menu)), expected);
  }
});

test("오리엔탈이라는 표현만으로 poultry로 오인하지 않는다", () => {
  assert.deepEqual(
    ingredientFamiliesFor(item("도시락", "샐러드집", "오리엔탈 채소 도시락")),
    ["other"]
  );
});

test("restaurant names never leak into operational ingredient families", () => {
  assert.deepEqual(
    ingredientFamiliesFor(item("분식", "불닭발 동대문 엽기떡볶이", "로제떡볶이")),
    ["other"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("분식", "닭발과곱창", "떡볶이")),
    ["other"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("아시안", "포코", "분짜", { ingredientFamilies: ["other"] })),
    ["pork"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("버거", "롯데리아", "더블 데리버거", { ingredientFamilies: ["other"] })),
    ["beef"]
  );
});

test("reviewed terse dishes still receive their operational protein family", () => {
  assert.deepEqual(
    ingredientFamiliesFor(item("찜/탕", "해이루", "감자탕", { ingredientFamilies: ["other"] })),
    ["pork"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("일식", "면식당", "돈코츠라멘", { ingredientFamilies: ["other"] })),
    ["pork"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("도시락", "봉구스 밥버거", "햄치즈밥버거", { ingredientFamilies: ["other"] })),
    ["pork"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("찜/탕", "청담명품부대찌개", "청담명품부대찌개", { ingredientFamilies: ["other"] })),
    ["pork"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("중식", "양꼬치집", "양꼬치", { ingredientFamilies: ["other"] })),
    ["lamb"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("찜/탕", "금암 피순대", "피순대국밥", { ingredientFamilies: ["offal"] })),
    ["pork", "offal"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("일식", "무모한초밥", "특싱글초밥 18p")),
    ["seafood"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("버거", "버거킹", "콰트로치즈와퍼세트")),
    ["beef"]
  );
  assert.deepEqual(
    ingredientFamiliesFor(item("버거", "버거킹", "통새우와퍼")),
    ["seafood"]
  );
});

test("a pool with different categories but only shrimp and chicken has no viable trio", () => {
  const currentPool = [
    item("버거", "롯데리아", "새우버거"),
    item("치킨", "BHC치킨", "뿌링클"),
    item("치킨", "후켄", "순살간장치킨"),
    item("도시락", "본도시락", "본격 도시락 오리엔탈 깻잎 치킨")
  ];
  assert.equal(hasChoiceDiverseSet(currentPool, 3), false);
});

test("historical audit reports one group-level violation with the shared family", () => {
  const shared = {
    channel: "C123",
    messageTs: "100.1",
    source: "scheduled-cache",
    recommendedAt: "2026-07-14T08:25:00.000Z"
  };
  const violations = choiceDiversityViolations([
    item("치킨", "후켄", "순살간장치킨", shared),
    item("버거", "롯데리아", "새우버거", shared),
    item("도시락", "본도시락", "본격 도시락 오리엔탈 깻잎 치킨", shared)
  ]);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].families, ["poultry"]);
});

test("reviewed Futoru soba futomaki shrimp stays product-scoped across spelling variants", () => {
  for (const menu of ["소바 후토마키", "소바후토마끼"]) {
    assert.deepEqual(ingredientFamiliesFor({
      restaurant: "후토루 전북대점", menu, category: "일식", ingredientFamilies: ["other"],
    }), ["seafood"]);
  }
  assert.deepEqual(ingredientFamiliesFor({
    restaurant: "후토루", menu: "소바", category: "일식", ingredientFamilies: ["other"],
  }), ["other"]);
  assert.deepEqual(ingredientFamiliesFor({
    restaurant: "다른소바집", menu: "소바 후토마키", category: "일식", ingredientFamilies: ["other"],
  }), ["other"]);
});
