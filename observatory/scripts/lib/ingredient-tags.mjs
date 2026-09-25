const TAG_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "chicken", label: "chicken · 닭고기" }),
  Object.freeze({ id: "duck", label: "duck · 오리고기" }),
  Object.freeze({ id: "beef", label: "beef · 소고기" }),
  Object.freeze({ id: "pork", label: "pork · 돼지고기" }),
  Object.freeze({ id: "seafood", label: "seafood · 해산물" }),
  Object.freeze({ id: "lamb", label: "lamb · 양고기" }),
  Object.freeze({ id: "offal", label: "offal · 내장" }),
  Object.freeze({ id: "meat-patty", label: "meat patty · 고기 패티" }),
  Object.freeze({ id: "tofu", label: "tofu · 두부" }),
  Object.freeze({ id: "egg", label: "egg · 달걀" }),
  Object.freeze({ id: "red-bean", label: "red bean · 팥" }),
  Object.freeze({ id: "rice", label: "rice · 밥" }),
  Object.freeze({ id: "noodles", label: "noodles · 면" }),
  Object.freeze({ id: "bread", label: "bread · 빵/도우" }),
  Object.freeze({ id: "cheese", label: "cheese · 치즈" }),
  Object.freeze({ id: "dairy", label: "dairy · 유제품" }),
  Object.freeze({ id: "vegetables", label: "vegetables · 채소" }),
  Object.freeze({ id: "soybean", label: "soybean · 콩" }),
  Object.freeze({ id: "potato", label: "potato · 감자류" }),
  Object.freeze({ id: "rice-cake", label: "tteok · 떡" }),
  Object.freeze({ id: "mushroom", label: "mushroom · 버섯" }),
  Object.freeze({ id: "processed-meat", label: "processed meat · 가공육" }),
  Object.freeze({ id: "peanut", label: "peanut · 땅콩" }),
  Object.freeze({ id: "mixed", label: "mixed ingredients · 복합재료" }),
]);

export const INGREDIENT_SEARCH_TAGS = Object.freeze(TAG_DEFINITIONS.map(({ label }) => label));
export const MAX_INGREDIENT_SEARCH_TAGS = 4;

const TAG_BY_ID = new Map(TAG_DEFINITIONS.map((definition) => [definition.id, definition.label]));
const TAG_ORDER = new Map(TAG_DEFINITIONS.map((definition, index) => [definition.id, index]));

const EXPLICIT_FAMILY_TAGS = Object.freeze({
  chicken: "chicken",
  duck: "duck",
  beef: "beef",
  pork: "pork",
  seafood: "seafood",
  lamb: "lamb",
  offal: "offal",
});

// A tiny audited override is safer than deriving ingredients from a shop name.
// The canonical record describes this set as 막창+곱창; 닭발 appears only in
// the restaurant name and the stale operational family value.
const EXACT_MENU_TAG_OVERRIDES = new Map([
  // Verified JBNU branch menu: soba noodles and shrimp tempura.
  ["후토루\u001f소바 후토마키", Object.freeze(["seafood", "noodles"])],
  ["후토루 전북대점\u001f소바 후토마키", Object.freeze(["seafood", "noodles"])],
  ["동네불막창&닭발\u001f반반세트", Object.freeze(["offal"])],
  ["모퉁이덮밥\u001f모퉁이덮밥", Object.freeze(["pork", "rice"])],
  ["전통 웰빙팥죽\u001f새알팥죽", Object.freeze(["red-bean", "rice"])],
  ["포코\u001f분짜", Object.freeze(["pork", "noodles", "vegetables"])],
  ["롯데리아\u001f더블 데리버거", Object.freeze(["beef", "bread", "vegetables"])],
  ["슬로우캘리\u001f오리엔탈 두부 포케", Object.freeze(["tofu", "rice", "vegetables"])],
  // The JBNU restaurant sells both chicken and lamb kebabs; the historical
  // unqualified "케밥" row does not identify which protein was ordered.
  ["레반트\u001f케밥", Object.freeze(["mixed"])],
]);

const TEXT_RULES = Object.freeze([
  Object.freeze({ id: "chicken", pattern: /(?:닭고기|닭갈비|닭가슴살|닭다리살|닭발|닭볶음탕|닭불고기|치킨|통닭|찜닭|싸이버거|치킨버거|chicken)/iu }),
  Object.freeze({ id: "duck", pattern: /(?:훈제오리|오리고기|오리구이|오리불고기|오리주물럭|오리백숙|duck)/iu }),
  Object.freeze({ id: "beef", pattern: /(?:소고기|쇠고기|한우|육회|규동|우삼겹|차돌(?:박이)?|양지|우사골|소\s*불고기|한우\s*불고기|비프|beef)/iu }),
  Object.freeze({ id: "pork", pattern: /(?:돼지|흑돼지|암퇘지|제육|(?<!우)삼겹|목살|항정|족발|족보세트|보쌈|(?<!탕)수육|순대|돈까스|돈가스|돈카츠|돈코츠|차슈|프로슈토|뼈해장국|돼지국물|껍데기|두루치기|pork)/iu }),
  Object.freeze({ id: "seafood", pattern: /(?:해물|해산물|수산|새우|쉬림프|슈림프|shrimp|연어|참치|명란|광어|우럭|오징어|문어|낙지|주꾸미|쭈꾸미|대게|꽃게|킹크랩|게장|크랩|랍스터|조개|전복|장어|고등어|갈치|생선|(?<!육)회덮밥|모둠회|모듬회|초밥|스시|굴|석화|seafood|fish|salmon|tuna)/iu }),
  Object.freeze({ id: "lamb", pattern: /(?:양고기|양갈비|(?:^|[\s·,])램(?:고기|스테이크|숄더랙|[\s·,]|$)|lamb)/iu }),
  Object.freeze({ id: "offal", pattern: /(?:곱창|막창|대창|내장|선지|피순대|순대국|offal)/iu }),
  Object.freeze({ id: "tofu", pattern: /(?:순두부|연두부|두부|tofu)/iu }),
  Object.freeze({ id: "egg", pattern: /(?:계란|달걀|에그|egg)/iu }),
  Object.freeze({ id: "red-bean", pattern: /(?:팥|적두|red\s*bean)/iu }),
  Object.freeze({ id: "rice", pattern: /(?:덮밥|비빔밥|볶음밥|국밥|공기밥|밥버거|김밥|초밥|후토마(?:끼|키)|도리아|카레|죽|밥알|라이스|규동|가츠동|카츠동|돈부리|rice)/iu }),
  Object.freeze({ id: "noodles", pattern: /(?:라멘|라면|우동|짬뽕|짜장면|쌀국수|국수|파스타|소바|모밀|막국수|전분면|면발|면\s*재료|(?:^|[\s·,])면(?:[을이가와과의]|[\s·,]|$)|쏸라펀|noodles?|pasta|ramen|udon)/iu }),
  Object.freeze({ id: "bread", pattern: /(?:(?<!밥)버거|샌드위치|피자|통밀\s*랩|도네르\s*롤|또띠아|토르티야|퀘사디아|도우|빵|bread|bun|wrap|tortilla)/iu }),
  Object.freeze({ id: "cheese", pattern: /(?:치즈|모짜렐라|cheese)/iu }),
  Object.freeze({ id: "dairy", pattern: /(?:크림|로제|우유|유제품|cream|dairy)/iu }),
  Object.freeze({ id: "vegetables", pattern: /(?:채소|야채|샐러드|양상추|로메인|토마토|시금치|당근|아보카도|양파|호박|콩나물|깻잎|파채|상추|양배추|우거지|시래기|대파|쪽파|부추|김치|묵은지|할라피뇨|vegetables?)/iu }),
  Object.freeze({ id: "soybean", pattern: /(?:된장|콩나물|대두|soybean|soy)/iu }),
  Object.freeze({ id: "potato", pattern: /(?:감자|고구마|포테이토|웨지|potato)/iu }),
  Object.freeze({ id: "rice-cake", pattern: /(?:떡볶이|밀떡|쌀떡|떡사리|(?:^|[\s·,])떡(?:[이을과은도]|[\s·,]|$)|rice\s*cake)/iu }),
  Object.freeze({ id: "mushroom", pattern: /(?:버섯|머쉬룸|머시룸|양송이|새송이|표고|느타리|트러플|mushroom|truffle)/iu }),
  Object.freeze({ id: "processed-meat", pattern: /(?:햄(?!버거|버그)|베이컨|소시지|페퍼로니|프로슈토|sausage|\bham\b|bacon|pepperoni|prosciutto)/iu }),
  Object.freeze({ id: "peanut", pattern: /(?:피넛|땅콩|peanut)/iu }),
]);

const CATEGORY_DEFAULTS = Object.freeze({
  "치킨": Object.freeze(["chicken"]),
  "돈까스": Object.freeze(["pork"]),
  "족발/보쌈": Object.freeze(["pork"]),
  "회/해물": Object.freeze(["seafood"]),
  "피자": Object.freeze(["cheese", "bread"]),
  "버거": Object.freeze(["bread"]),
  "샌드위치": Object.freeze(["bread"]),
  "도시락": Object.freeze(["rice"]),
  "죽": Object.freeze(["rice"]),
});

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ").trim();
}

function addTextMatches(scores, text, score) {
  if (!text) return;
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) scores.set(rule.id, Math.max(scores.get(rule.id) || 0, score));
  }
  // Unqualified 불고기 conventionally denotes beef, but an explicitly named
  // 돼지/오리/닭 불고기 must never inherit the beef tag from the suffix alone.
  if (/불고기/iu.test(text) && !/(?:돼지|흑돼지|오리|닭|제육|고추장)/iu.test(text)) {
    scores.set("beef", Math.max(scores.get("beef") || 0, score));
  }
}

function addScore(scores, id, score) {
  if (!TAG_BY_ID.has(id)) return;
  scores.set(id, Math.max(scores.get(id) || 0, score));
}

/**
 * Produces up to four deterministic, bilingual search tags.
 *
 * Identity text outranks descriptive prose, while category defaults are only
 * used where the category guarantees an ingredient (for example 치킨) or a
 * staple (for example pizza dough). Restaurant names are not treated as
 * ingredients; narrowly audited brand/menu rules are explicit below.
 */
// Browser-safe counterpart of the operational patty rule. Cross-package
// regression tests enforce parity; importing the server tree here would cross
// Next's browser build boundary. Official product evidence:
// https://www.burgerking.co.kr/menu/detail/1080121
function hasBeefWhopperPatty(menu) {
  const name = normalizedText(menu).replace(/[^\p{L}\p{N}]/gu, "");
  return /통새우와퍼/iu.test(name)
    || (/와퍼/iu.test(name)
      && !/(?:새우|쉬림프|슈림프|shrimp|해산물|seafood|치킨|닭|chicken|식물|비건|플랜트|plant|vegan)/iu.test(name));
}

export function ingredientSearchTagsFor(candidate = {}) {
  const scores = new Map();
  const menu = normalizedText(candidate.menu);
  const restaurant = normalizedText(candidate.restaurant || candidate.restaurantLabel);
  const ingredientText = normalizedText([
    candidate.ingredients,
    candidate.ingredientText,
    candidate.description,
  ].filter(Boolean).join(" "));

  const exactOverride = EXACT_MENU_TAG_OVERRIDES.get(`${restaurant}\u001f${menu}`);
  if (exactOverride) return exactOverride.map((id) => TAG_BY_ID.get(id));

  for (const rawFamily of Array.isArray(candidate.ingredientFamilies) ? candidate.ingredientFamilies : []) {
    const family = normalizedText(rawFamily).replace(/[^a-z-]/gu, "");
    if (family === "poultry") {
      // The operational diversity family deliberately groups chicken and duck;
      // the public search tag must retain the species stated by the menu.
      addScore(scores, /(?:훈제오리|오리고기|오리구이|오리불고기|오리주물럭|오리백숙|duck)/iu.test(`${menu} ${ingredientText}`) ? "duck" : "chicken", 140);
      continue;
    }
    const id = EXPLICIT_FAMILY_TAGS[family];
    if (id) addScore(scores, id, 140);
  }

  addTextMatches(scores, menu, 120);
  // Serving suggestions describe food eaten alongside the dish, not its
  // ingredients. Keep structured ingredients intact and remove only a narrow
  // pairing clause from prose (e.g. "밥과 계란후라이에 비벼 먹기 좋다").
  const descriptionEvidence = normalizedText(candidate.description).replace(
    /(?:밥(?:과|와)\s*)?(?:계란|달걀)\s*(?:후라이|프라이)(?:에|와|과)\s*(?:비벼|곁들여|함께)\s*먹기\s*좋[^.!?]*(?:[.!?]|$)/giu,
    "",
  );
  const ingredientEvidence = normalizedText([
    candidate.ingredients, candidate.ingredientText, descriptionEvidence,
  ].filter(Boolean).join(" "));
  addTextMatches(scores, ingredientEvidence, 80);

  // The current 와우케밥 menu abbreviates its chicken+lamb blend as "치+양".
  // Keep this narrow to the canonical döner-roll product so an unrelated 양
  // (amount/quantity) can never be interpreted as lamb.
  if (/(?:치\s*\+\s*양|치양)도네르롤/iu.test(menu)) {
    addScore(scores, "chicken", 125);
    addScore(scores, "lamb", 125);
  }

  // The brand's current official franchise page identifies its standard patty
  // as beef. Species-named chicken/seafood products retain their own identity.
  // Evidence: https://frankburger.co.kr/index_fran.html
  if (/프랭크버거/iu.test(restaurant)
      && !/(?:치킨|닭|새우|쉬림프|슈림프|shrimp|seafood)/iu.test(menu)) {
    addScore(scores, "beef", 130);
  }

  const hasSpecificProtein = ["chicken", "duck", "beef", "pork", "seafood", "lamb", "offal"]
    .some((id) => scores.has(id));
  if (!hasSpecificProtein && /(?:고기\s*)?패티/iu.test(`${menu} ${ingredientText}`)) {
    addScore(scores, "meat-patty", 125);
  }

  // Historical candidates once mislabeled 우삼겹 as both beef and pork due to
  // the shared "삼겹" substring. The identity is unambiguously beef, so reject
  // that stale explicit family unless an independent pork term is present.
  if (/우삼겹/iu.test(`${menu} ${ingredientText}`)
      && !/(?:돼지|흑돼지|암퇘지|제육|(?<!우)삼겹|목살|항정|족발|족보세트|보쌈|수육|돈까스|돈가스|돈카츠|돈코츠|차슈|pork)/iu.test(`${menu} ${ingredientText}`)) {
    scores.delete("pork");
  }

  // A side soup mentioned only as a pairing is not an ingredient of 볶음밥.
  if (/볶음밥/iu.test(menu) && /짬뽕\s*국물(?:과|이랑|와)\s*같이/iu.test(ingredientText)) {
    scores.delete("noodles");
  }

  // 떡 may be wheat-based, so it is a separate tteok tag rather than a rice
  // alias. Comparisons with a nearby 김밥 must not make plain 떡볶이 searchable
  // as rice; explicit 김밥/밥/쌀떡 combinations retain the rice tag.
  if (/떡볶이/iu.test(menu) && !/(?:김밥|밥|쌀떡)/iu.test(menu)) scores.delete("rice");

  const defaults = CATEGORY_DEFAULTS[normalizedText(candidate.category)] || [];
  const riceBurgerWithoutBread = /(?:밥|라이스)버거/iu.test(menu)
    && !/(?:빵|번|bread|bun)/iu.test(`${menu} ${ingredientText}`);
  for (const id of defaults) {
    if (id === "bread" && riceBurgerWithoutBread) continue;
    // These defaults express an invariant of the meal format, not a weak
    // guess. Keep them ahead of descriptive toppings so a pizza cannot lose
    // its dough/cheese tags when three toppings happen to be named.
    if (id === "pork" && /(?:생선|치킨|닭|두부|새우)/u.test(menu)
        && !/(?:돼지|돈까스|돈가스|돈카츠|pork)/iu.test(menu)) continue;
    addScore(scores, id, 130);
  }

  // Korean rice burgers use compressed rice instead of a bread bun. Apply
  // this after category defaults so the generic 버거 default cannot re-add it.
  if (riceBurgerWithoutBread) scores.delete("bread");

  // Use the same audited patty rule as operational diversity (including the
  // beef-and-shrimp 통새우와퍼), so search and recommendations agree.
  if (hasBeefWhopperPatty(menu)) addScore(scores, "beef", 120);
  if (["chicken", "duck", "beef", "pork", "seafood", "lamb", "offal"].some((id) => scores.has(id))) {
    scores.delete("meat-patty");
  }

  // 초밥 names its preparation, while the named topping identifies protein.
  if (/(?:육회|소고기|한우|계란|달걀|두부)/u.test(menu)) {
    const seafoodRule = TEXT_RULES.find((rule) => rule.id === "seafood");
    if (!seafoodRule.pattern.test(menu.replace(/초밥|스시/gu, ""))) scores.delete("seafood");
  }

  if (/(?:생선|치킨|닭|두부|새우)/u.test(menu)
      && candidate.category === "돈까스"
      && !/(?:돼지|돈까스|돈가스|돈카츠|pork)/iu.test(menu)) scores.delete("pork");
  // Buckwheat rolls substitute noodles for rice; the 후토마키 suffix alone
  // must not undo an explicit rice-free preparation (mixed sets stay intact).
  if (/^(?:소바|메밀)\s*후토마(?:키|끼)(?:\s*\([^)]*\))?$/u.test(menu)
      || /^(?:[가-힣 ]+)?키토\s*김밥$/u.test(menu)) scores.delete("rice");
  if (!scores.size) addScore(scores, "mixed", 1);
  return [...scores.entries()]
    .sort(([leftId, leftScore], [rightId, rightScore]) => (
      rightScore - leftScore || (TAG_ORDER.get(leftId) ?? 999) - (TAG_ORDER.get(rightId) ?? 999)
    ))
    .slice(0, MAX_INGREDIENT_SEARCH_TAGS)
    .map(([id]) => TAG_BY_ID.get(id));
}
