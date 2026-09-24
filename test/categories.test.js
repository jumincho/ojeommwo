import test from "node:test";
import assert from "node:assert/strict";
import {
  FOOD_CATEGORIES,
  classifyFoodCategory,
  classifyFoodCategoryDecision,
  isExcludedMealCandidate,
} from "../src/categories.js";

test("ingredients and mixed-cuisine shop names do not masquerade as a dish format", () => {
  for (const [menu, expected] of [
    ["메밀막국수", "한식"], ["메밀전병", "한식"], ["메밀소바", "일식"],
    ["피자돈까스", "돈까스"], ["피자김밥", "분식"], ["돈카츠카레", "일식"],
    ["얼큰 육개장", "찜/탕"], ["치즈철판김치볶음밥", "한식"],
  ]) assert.equal(classifyFoodCategory({ restaurant: "짱그미김밥", menu }), expected, menu);
});

test("food taxonomy preserves the intentional 19 meal categories in platform order", () => {
  assert.deepEqual(FOOD_CATEGORIES, [
    "한식", "치킨", "분식", "돈까스", "족발/보쌈", "찜/탕", "구이", "피자", "중식",
    "일식", "회/해물", "양식", "아시안", "샌드위치", "샐러드", "버거", "멕시칸", "도시락", "죽",
  ]);
});

test("category classification corrects known brand and menu misclassifications", () => {
  const cases = [
    [{ category: "도시락", restaurant: "파파존스 전주점", menu: "수퍼 파파스(L)" }, "피자"],
    [{ category: "치킨", restaurant: "한솥도시락 전북대정문점", menu: "치킨마요" }, "도시락"],
    [{ category: "찜/탕", restaurant: "흐엉꾸에 하롱베이퍼", menu: "양지쌀국수" }, "아시안"],
    [{ category: "도시락", restaurant: "롤링파스타 전북대점", menu: "우삼겹 도리아" }, "양식"],
    [{ category: "찜/탕", restaurant: "모두랑 전북대점", menu: "로제 떡볶이" }, "분식"],
    [{ category: "도시락", restaurant: "짱그미김밥 전북대점", menu: "치즈철판김치볶음밥" }, "한식"],
    [{ category: "돈까스", restaurant: "THE담다", menu: "매운 해물뎃판까스" }, "돈까스"],
    [{ category: "도시락", restaurant: "김피라", menu: "갈릭우삼겹덮밥" }, "한식"],
    [{ category: "구이", restaurant: "뜸들이다 전북대점", menu: "삼겹살카레" }, "일식"],
    [{ category: "도시락", restaurant: "KFC", menu: "Zinger" }, "치킨"],
    [{ category: "도시락", restaurant: "Subway", menu: "BLT Sandwich" }, "샌드위치"],
    [{ category: "치킨", restaurant: "Burger King", menu: "Whopper" }, "버거"],
    [{ category: "한식", restaurant: "만배식탁", menu: "육회덮밥" }, "한식"],
    [{ category: "한식", restaurant: "바다식당", menu: "광어회덮밥" }, "회/해물"],
    [{ category: "회/해물", restaurant: "돔베 초밥 아중점", menu: "연어3 + 광어3 + 참치3 9p" }, "일식"],
    [{ category: "회/해물", restaurant: "본죽&비빔밥cafe 전북대점", menu: "낙지김치비빔밥" }, "한식"],
    [{ category: "일식", restaurant: "돔베 초밥 아중점", menu: "광어회덮밥" }, "회/해물"],
    [{ category: "", restaurant: "와우케밥 치킨", menu: "롤 믹스 램 L" }, "아시안"],
    [{ category: "치킨", restaurant: "파스톨로지", menu: "치킨 파마지아나(호주식치킨까스)" }, "양식"],
    [{ category: "한식", restaurant: "모퉁이덮밥", menu: "모퉁이덮밥" }, "일식"],
    [{ category: "버거", restaurant: "벤티버거", menu: "버섯크림파스타" }, "양식"],
  ];
  for (const [input, expected] of cases) assert.equal(classifyFoodCategory(input), expected);
});

test("explicit meal formats outrank a restaurant's usual category without breaking terse brand products", () => {
  assert.equal(classifyFoodCategory({ restaurant: "벤티버거", menu: "버섯크림파스타" }), "양식");
  assert.equal(classifyFoodCategory({ restaurant: "롯데리아", menu: "핫크리스피치킨버거" }), "버거");
  assert.equal(classifyFoodCategory({ restaurant: "한솥도시락", menu: "치킨마요" }), "도시락");
  assert.equal(classifyFoodCategory({ restaurant: "도미노피자", menu: "리얼불고기(L)" }), "피자");
  assert.equal(classifyFoodCategory({ restaurant: "고씨네", menu: "치즈롤까스카레" }), "일식");
  assert.equal(classifyFoodCategory({ restaurant: "일반 식당", menu: "카레라이스" }), "일식");
  assert.equal(classifyFoodCategory({ restaurant: "뜸들이다", menu: "삼겹살카레" }), "일식");
});

test("structural dish formats outrank Korean or seafood ingredient modifiers", () => {
  const cases = [
    [{ category: "한식", restaurant: "피자마루 전북대점", menu: "불고기 피자" }, "피자"],
    [{ category: "한식", restaurant: "일반 식당", menu: "김치 피자" }, "피자"],
    [{ category: "회/해물", restaurant: "일반 식당", menu: "새우 크림 파스타" }, "양식"],
    [{ category: "한식", restaurant: "일반 식당", menu: "불고기 버거" }, "버거"],
    [{ category: "구이", restaurant: "뜸들이다", menu: "삼겹살카레" }, "일식"],
    [{ category: "회/해물", restaurant: "본죽&비빔밥cafe", menu: "낙지김치비빔밥" }, "한식"],
  ];
  for (const [input, expected] of cases) assert.equal(classifyFoodCategory(input), expected, input.menu);
  assert.equal(classifyFoodCategory({ category: "한식", restaurant: "피자마루", menu: "클래식 콤비네이션" }), "피자");
  assert.equal(classifyFoodCategoryDecision({
    category: "한식",
    restaurant: "피자마루",
    menu: "불고기 피자",
  }).authority, "structural-menu");
  assert.equal(classifyFoodCategoryDecision({
    category: "도시락",
    restaurant: "일반 식당",
    menu: "제육덮밥",
  }).authority, "semantic-menu-heuristic");
});

test("Japanese preparations outrank generic seafood ingredients", () => {
  const japanese = [
    "연어 후토마키",
    "연어후토마끼",
    "소바후토마끼",
    "아시타 베이직 초밥 정식",
    "냉모밀초밥세트 4p",
    "해물볶음우동(매콤)",
    "차슈덮밥",
    "가츠동",
  ];
  for (const menu of japanese) {
    assert.equal(
      classifyFoodCategory({ category: "회/해물", restaurant: "상호", menu }),
      "일식",
      menu
    );
  }
  assert.equal(classifyFoodCategory({
    category: "회/해물",
    restaurant: "광장수산",
    menu: "광어 사시미",
  }), "회/해물");
});

test("snack, dessert, drink, and side-only candidates are rejected without broad false positives", () => {
  for (const menu of [
    "18알 타코야끼", "타코 야끼", "타코-야끼", "타코야키", "아메리카노", "아메리 카노",
    "카라멜 마키아토", "카라멜 마끼아또",
    "딸기 케이크", "민트초코 내장탕", "블루베리 잼 시래기국밥",
    "감자튀김", "감자 튀김", "치즈 스틱", "군 만두", "인생껍데기 100g"
  ]) {
    assert.equal(isExcludedMealCandidate({ menu }), true, menu);
    assert.equal(classifyFoodCategory({ category: "일식", restaurant: "상호", menu }), null, menu);
  }
  assert.equal(isExcludedMealCandidate({ menu: "차돌박이 된장찌개" }), false);
  assert.equal(classifyFoodCategory({ category: "한식", restaurant: "상호", menu: "차돌박이 된장찌개" }), "찜/탕");
});

test("an allowed raw category is not trusted without restaurant or menu evidence", () => {
  assert.equal(classifyFoodCategory({ category: "도시락", restaurant: "임의상호", menu: "허니순살" }), null);
  assert.equal(classifyFoodCategory({ category: "도시락", restaurant: "임의상호", menu: "볶음밥" }), null);
  assert.equal(classifyFoodCategory({ category: "도시락", restaurant: "임의상호", menu: "냉면" }), "한식");
  assert.equal(classifyFoodCategory({ category: "도시락", restaurant: "교촌치킨 전북대점", menu: "허니순살" }), "치킨");
  assert.equal(classifyFoodCategory(
    { category: "도시락", restaurant: "임의상호", menu: "알 수 없는 메뉴" },
    { allowDeclaredCategory: true }
  ), "도시락");
});

test("cutlet fillings do not override the enclosing gimbap, burger, or sandwich format", () => {
  for (const [menu, expected] of [
    ["돈까스 김밥", "분식"], ["돈가스김밥", "분식"], ["돈카츠김밥", "분식"],
    ["치킨카츠버거", "버거"], ["돈카츠 샌드위치", "샌드위치"],
    ["Chicken Katsu Burger", "버거"], ["Pork Cutlet Sandwich", "샌드위치"],
  ]) {
    assert.equal(classifyFoodCategory({ restaurant: "일반식당", category: "돈까스", menu }), expected, menu);
  }
  assert.equal(classifyFoodCategory({ menu: "피자돈까스" }), "돈까스");
  assert.equal(classifyFoodCategory({ menu: "돈카츠카레" }), "일식");
});
