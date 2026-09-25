import { normalizeKey, normalizeMenuKey, normalizeRestaurantKey } from "./text.js";

export const INGREDIENT_FAMILIES = Object.freeze([
  "poultry",
  "beef",
  "pork",
  "seafood",
  "lamb",
  "offal",
  "other"
]);

export const INGREDIENT_FAMILY_LABELS = Object.freeze({
  poultry: "닭·오리",
  beef: "소고기",
  pork: "돼지고기",
  seafood: "해산물",
  lamb: "양고기",
  offal: "곱창·막창류",
  other: "기타"
});

const INGREDIENT_FAMILY_SET = new Set(INGREDIENT_FAMILIES);
const NON_BLOCKING_FAMILY = "other";
const EXACT_FAMILY_OVERRIDES = new Map([
  // This restaurant offers chicken and lamb variants. Bare "케밥" does not
  // identify the ordered protein; a named variant retains its own inference.
  ["레반트\u001f케밥", Object.freeze(["other"])],
  // The verified menu description identifies 막창+곱창. "닭발" appears only
  // in the shop name, so treating this menu as poultry is an identity leak.
  ["동네불막창닭발\u001f반반세트", Object.freeze(["offal"])],
  // Audited canonical products whose short menu names do not expose the
  // protein needed by the operational diversity gate.
  ["포코\u001f분짜", Object.freeze(["pork"])],
  // The JBNU branch's reviewed 소바 후토마키 contains shrimp tempura.
  // Evidence: https://www.diningcode.com/profile.php?rid=RLR1LDm7iCIy
  // Keep this product-scoped: plain soba is not inherently seafood.
  ["후토루\u001f소바후토마키", Object.freeze(["seafood"])],

  ["롯데리아\u001f더블데리버거", Object.freeze(["beef"])],
  // Audited legacy/static products whose official short label does not name
  // the protein. These keep historical rows and the emergency-only static
  // catalog explicitly labelled without reading ingredients from shop names.
  ["맥도날드전주덕진dt점\u001f빅맥세트", Object.freeze(["beef"])],
  ["맥도날드\u001f빅맥세트", Object.freeze(["beef"])],
  ["버거킹전북대점\u001f콰트로치즈와퍼세트", Object.freeze(["beef"])],
  ["버거킹\u001f콰트로치즈와퍼세트", Object.freeze(["beef"])],
  ["맘스터치전북대점\u001f싸이버거세트", Object.freeze(["poultry"])],
  ["맘스터치\u001f싸이버거세트", Object.freeze(["poultry"])],
  ["파파존스전주점\u001f수퍼파파스l", Object.freeze(["pork"])],
  ["파파존스\u001f수퍼파파스l", Object.freeze(["pork"])],
  ["고기듬뿍국물두루치기본점\u001f고기듬뿍국물두루치기", Object.freeze(["pork"])],
  ["고기듬뿍국물두루치기\u001f고기듬뿍국물두루치기", Object.freeze(["pork"])],
  ["꾸꾸삼겹전북대점\u001f꾸꾸실속세트300g공기밥1개", Object.freeze(["pork"])],
  ["꾸꾸삼겹\u001f꾸꾸실속세트300g공기밥1개", Object.freeze(["pork"])],
  ["와우케밥치킨\u001f치양도네르롤", Object.freeze(["poultry", "lamb"])],
  ["장미맨숀\u001f곱도리탕", Object.freeze(["poultry", "offal"])],
  ["귀신반점전북대점\u001f귀신짬뽕", Object.freeze(["seafood"])],
  ["귀신반점\u001f귀신짬뽕", Object.freeze(["seafood"])],
  ["도야짬뽕전북대점\u001f도야짬뽕", Object.freeze(["seafood"])],
  ["도야짬뽕\u001f도야짬뽕", Object.freeze(["seafood"])],
  ["행복은간장밥전북대점\u001f간장연새덮밥", Object.freeze(["seafood"])],
  ["행복은간장밥\u001f간장연새덮밥", Object.freeze(["seafood"])],
  ["도야짬뽕전북대점\u001f크림짬뽕", Object.freeze(["seafood"])],
  ["도야짬뽕\u001f크림짬뽕", Object.freeze(["seafood"])],
  ["짬뽕지존덕진점\u001f지존짬뽕", Object.freeze(["seafood"])],
  ["짬뽕지존\u001f지존짬뽕", Object.freeze(["seafood"])],
  ["롤링파스타전북대점\u001fk탈리안세트", Object.freeze(["beef"])],
  ["롤링파스타\u001fk탈리안세트", Object.freeze(["beef"])],
  ["청년다방전북대점\u001f로제떡볶이", Object.freeze(["beef"])],
  ["청년다방\u001f로제떡볶이", Object.freeze(["beef"])],
  ["도미노피자전주금암점\u001f오포테이토l", Object.freeze(["pork"])],
  ["도미노피자\u001f오포테이토l", Object.freeze(["pork"])],
  ["프랭크버거\u001f프랭크버거세트", Object.freeze(["beef"])]
]);
const FAMILY_PATTERNS = Object.freeze({
  poultry: /(?:닭|치킨|통닭|싸이버거|징거(?:버거)?|chicken|훈제오리|오리구이|오리불고기|오리주물럭|오리백숙)/iu,
  beef: /(?:한우|소고기|쇠고기|우삼겹|차돌|소불고기|육회|양지|규동|육개장|설렁탕|비프|beef)/iu,
  // These terms describe pork even when a short product name omits the meat
  // itself.  Keeping the inference menu-only prevents a shop name from
  // leaking into diversity while covering reviewed dishes such as 감자탕,
  // 돈코츠라멘, 순대국밥, 햄치즈밥버거, and 부대찌개.
  pork: /(?:돼지|제육|삼겹|목살|항정|족발|보쌈|(?<!탕)수육|돈까스|돈가스|돈카츠|돈코츠|차슈|감자탕|뼈해장국|순대|부대찌개|햄|소시지|스팸|탕수육|프로슈토|포크|pork)/iu,
  seafood: /(?:해물|수산|새우|쉬림프|슈림프|shrimp|연어|참치|명란|초밥|스시|광어|우럭|오징어|문어|낙지|주꾸미|쭈꾸미|아구|아귀|대게|꽃게|킹크랩|게장|크랩|랍스터|조개|전복|장어|고등어|갈치|생선|(?<!육)회덮밥|모둠회|모듬회|광어회|연어회|참치회|생굴|석화|굴국밥|굴전|굴밥)/iu,
  lamb: /(?:양고기|양갈비|양꼬치|램|lamb)/iu,
  offal: /(?:곱창|막창|대창|내장|피순대|순대국|한우곱|곱도리)/iu
});

function orderedFamilies(values) {
  const set = new Set(values);
  return INGREDIENT_FAMILIES.filter((family) => set.has(family));
}

export function normalizeIngredientFamilies(values) {
  if (!Array.isArray(values)) return [];
  return orderedFamilies(values.filter((value) => INGREDIENT_FAMILY_SET.has(value)));
}

// Official current product: whole shrimp is a topping on a beef patty.
// https://www.burgerking.co.kr/menu/detail/1080121 (checked 2026-09-25).
// Do not extend this exception to unrelated shrimp/chicken/plant burgers.
export function hasBeefWhopperPatty(menu) {
  const name = normalizeKey(menu);
  return /통새우와퍼/iu.test(name)
    || (/와퍼/iu.test(name)
      && !/(?:새우|쉬림프|슈림프|shrimp|해산물|seafood|치킨|닭|chicken|식물|비건|플랜트|plant|vegan)/iu.test(name));
}

export function ingredientFamiliesFor(candidate) {
  const identityKey = `${normalizeRestaurantKey(candidate?.restaurant)}\u001f${normalizeMenuKey(candidate?.menu)}`;
  const exactOverride = EXACT_FAMILY_OVERRIDES.get(identityKey);
  if (exactOverride) return [...exactOverride];

  const explicitFamilies = new Set(
    normalizeIngredientFamilies(candidate?.ingredientFamilies)
      .filter((family) => family !== NON_BLOCKING_FAMILY)
  );
  // Restaurant and branch names are identity, not ingredients. Reading them
  // here made a shop such as "불닭발 동대문 엽기떡볶이" turn a plain
  // 떡볶이 menu into poultry and could unnecessarily shrink the ready pool.
  // Ambiguous short products must be resolved by a model-supplied explicit
  // family or a narrowly audited exact override above.
  const inferredFamilies = new Set();
  const text = normalizeKey(candidate?.menu);

  for (const [family, pattern] of Object.entries(FAMILY_PATTERNS)) {
    if (pattern.test(text)) inferredFamilies.add(family);
  }
  // 육회 is raw beef, not the seafood word 회. Remove a stale/model-supplied
  // seafood tag unless an independent seafood signal is present.
  if (/육회/iu.test(text) && !FAMILY_PATTERNS.seafood.test(text)) {
    inferredFamilies.delete("seafood");
  }
  // 우삼겹 is beef. The shared 삼겹 substring must not retain or infer pork
  // unless an independent pork term is also present.
  if (/우삼겹/iu.test(text)
      && !/(?:돼지|흑돼지|암퇘지|제육|(?<!우)삼겹|목살|항정|족발|보쌈|수육|돈까스|돈가스|돈카츠|돈코츠|차슈|포크|pork)/iu.test(text)) {
    inferredFamilies.delete("pork");
  }
  // Shared with public search tags; audited mixed patties keep both proteins.
  if (hasBeefWhopperPatty(text)) {
    inferredFamilies.add("beef");
  }
  // In unqualified Korean menu names, 불고기 denotes beef. Explicit pork,
  // poultry, or duck wording always wins and avoids a false dual-family tag.
  if (/불고기/iu.test(text) && !/(?:돼지|흑돼지|오리|닭|제육|고추장)/iu.test(text)) {
    inferredFamilies.add("beef");
  }
  if (candidate?.category === "치킨") inferredFamilies.add("poultry");
  if (candidate?.category === "회/해물") inferredFamilies.add("seafood");
  if (candidate?.category === "족발/보쌈"
      || (candidate?.category === "돈까스" && !/(?:생선|치킨|닭|두부|새우)/u.test(text))) inferredFamilies.add("pork");

  // Sushi is a preparation, not a fish ingredient. Named beef/egg/tofu
  // sushi must not acquire seafood solely from the shared 초밥/스시 suffix.
  if (/(?:육회|소고기|한우|계란|달걀|두부)/u.test(text)
      && !FAMILY_PATTERNS.seafood.test(text.replace(/초밥|스시/gu, ""))) {
    inferredFamilies.delete("seafood");
    explicitFamilies.delete("seafood");
  }

  // A protein named by the canonical menu (or guaranteed by its category) is
  // stronger than a model-supplied family. Keeping both made contradictions
  // such as 삼겹살카레=beef+pork survive validation. Explicit families remain
  // authoritative only for genuinely terse products with no deterministic
  // protein signal; reviewed composites use the exact overrides above.
  const families = inferredFamilies.size ? inferredFamilies : explicitFamilies;
  return families.size ? orderedFamilies(families) : [NON_BLOCKING_FAMILY];
}

export function blockingIngredientFamilies(candidate) {
  return ingredientFamiliesFor(candidate).filter((family) => family !== NON_BLOCKING_FAMILY);
}

export function sharedIngredientFamilies(left, right) {
  const rightFamilies = new Set(blockingIngredientFamilies(right));
  return blockingIngredientFamilies(left).filter((family) => rightFamilies.has(family));
}

export function hasChoiceDiverseSet(candidates, limit = 3) {
  if (!Array.isArray(candidates) || !Number.isInteger(limit) || limit < 1) return false;

  const visit = (index, picked, categories, restaurants, menus, ingredientFamilies) => {
    if (picked === limit) return true;
    if (candidates.length - index < limit - picked) return false;

    for (let i = index; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const restaurant = normalizeRestaurantKey(candidate?.restaurant);
      const menu = normalizeMenuKey(candidate?.menu);
      const families = blockingIngredientFamilies(candidate);
      if (!candidate?.category || !restaurant || !menu) continue;
      if (categories.has(candidate.category) || restaurants.has(restaurant) || menus.has(menu)) continue;
      if (families.some((family) => ingredientFamilies.has(family))) continue;
      if (visit(
        i + 1,
        picked + 1,
        new Set([...categories, candidate.category]),
        new Set([...restaurants, restaurant]),
        new Set([...menus, menu]),
        new Set([...ingredientFamilies, ...families])
      )) return true;
    }
    return false;
  };

  return visit(0, 0, new Set(), new Set(), new Set(), new Set());
}

export function choiceDiversityViolations(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const channel = String(item?.channel || "");
    const messageTs = String(item?.messageTs || "");
    if (!channel || !messageTs) continue;
    const key = `${channel}:${messageTs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const violations = [];
  for (const group of groups.values()) {
    const owners = new Map();
    for (const item of group) {
      for (const family of blockingIngredientFamilies(item)) {
        if (!owners.has(family)) owners.set(family, []);
        owners.get(family).push(item);
      }
    }
    const families = orderedFamilies(
      [...owners].filter(([, familyItems]) => familyItems.length > 1).map(([family]) => family)
    );
    if (!families.length) continue;
    violations.push({
      channel: group[0].channel,
      messageTs: group[0].messageTs,
      mealType: group[0].mealType,
      source: group[0].source,
      recommendedAt: group[0].recommendedAt,
      families,
      items: group.map((item) => ({
        category: item.category,
        restaurant: item.restaurant,
        menu: item.menu,
        ingredientFamilies: ingredientFamiliesFor(item)
      }))
    });
  }
  return violations.sort((a, b) => Date.parse(a.recommendedAt || "") - Date.parse(b.recommendedAt || ""));
}
