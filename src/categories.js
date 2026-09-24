import { normalizeKey, normalizeMenuKey } from "./text.js";

export const FOOD_CATEGORIES = Object.freeze([
  "한식",
  "치킨",
  "분식",
  "돈까스",
  "족발/보쌈",
  "찜/탕",
  "구이",
  "피자",
  "중식",
  "일식",
  "회/해물",
  "양식",
  "아시안",
  "샌드위치",
  "샐러드",
  "버거",
  "멕시칸",
  "도시락",
  "죽"
]);

export const EXCLUDED_FOOD_CATEGORIES = Object.freeze(["커피/차", "디저트", "간식"]);
export const PLATFORM_BADGES = Object.freeze(["배민", "쿠팡이츠"]);

// Shared by discovery, custom-input normalization and independent category
// adjudication so an operator's taxonomy does not drift between model jobs.
export const CATEGORY_CLASSIFICATION_GUIDANCE = "음식의 핵심 형식을 부재료와 상호보다 우선합니다. 불고기 피자·김치 피자는 피자, 피자돈까스는 돈까스, 돈까스김밥은 분식, 치킨카츠버거는 버거, 돈카츠샌드위치는 샌드위치, 돈카츠카레·삼겹살카레는 일식입니다. 파마지아나(호주식 치킨까스)는 양식이며 낙지볶음·주꾸미볶음 같은 해산물 단품은 회/해물입니다. 초밥·후토마키·소바·우동·라멘은 일식, 메밀막국수·메밀전병은 한식입니다. 김밥집의 김치볶음밥은 한식이며 국밥·찌개·육개장·전골은 찜/탕입니다. 마라탕·마라샹궈·양꼬치는 중식, 케밥·쌀국수·팟타이·인도 커리는 아시안, 타코·브리또는 멕시칸입니다. 한솥 치킨마요와 밥버거는 도시락입니다. 초밥을 회/해물로, 카레를 양식으로, 피자를 한식으로 분류하지 마세요. 주재료 태그도 조리 형식과 구별합니다. 생선까스는 seafood, 치킨카츠는 poultry, 육회초밥은 beef이며 계란초밥을 seafood로 추정하지 마세요.";

export const CATEGORY_EMOJI = Object.freeze({
  "한식": "🍚",
  "치킨": "🍗",
  "분식": "🍢",
  "돈까스": "🍛",
  "족발/보쌈": "🥩",
  "찜/탕": "🍲",
  "구이": "🔥",
  "피자": "🍕",
  "중식": "🥢",
  "일식": "🍣",
  "회/해물": "🐟",
  "양식": "🍝",
  "아시안": "🍜",
  "샌드위치": "🥪",
  "샐러드": "🥗",
  "버거": "🍔",
  "멕시칸": "🌮",
  "도시락": "🍱",
  "죽": "🥣"
});

const CATEGORY_ALIASES = Object.freeze({
  "햄버거": "버거"
});

// These are unambiguously drink, dessert, snack, or side-only menu names. The
// patterns intentionally avoid broad words such as "차" (차돌) and "빵"
// (햄버거 빵) so a normal meal cannot be rejected by substring accident.
const NON_MEAL_PATTERN = /(?:타코야끼|타코야키|아메리카노|에스프레소|카페라떼|카푸치노|마키아토|마끼아또|밀크티|버블티|스무디|에이드|프라페|케이크|마카롱|크로플|와플|빙수|아이스크림|젤라또|쿠키|도넛|탕후루|호떡|붕어빵|민트초코|블루베리\s*잼|\b(?:takoyaki|coffee|espresso|latte|cappuccino|macchiato|milk\s*tea|bubble\s*tea|smoothie|frappe|cake|macaron|waffle|ice\s*cream|gelato|cookie|donut|dessert)\b)/iu;
// normalizeKey removes spacing and punctuation. Check that form as well so
// inputs such as "타코 야끼" or "아메리-카노" cannot bypass the meal gate.
const NON_MEAL_COMPACT_PATTERN = /(?:타코야키|아메리카노|에스프레소|카페라떼|카푸치노|마키아토|마키아또|밀크티|버블티|스무디|에이드|프라페|케이크|마카롱|크로플|와플|빙수|아이스크림|젤라또|쿠키|도넛|탕후루|호떡|붕어빵|민트초코|블루베리잼|takoyaki|coffee|espresso|latte|cappuccino|macchiato|milktea|bubbletea|smoothie|frappe|cake|macaron|waffle|icecream|gelato|cookie|donut|dessert)/iu;
const SIDE_ONLY_PATTERN = /^(?:주먹밥|공기밥|감자튀김|웨지감자|치즈볼|치즈스틱|콘샐러드|소떡소떡|군만두|닭꼬치|어묵(?:\d+개)?|오뎅(?:\d+개)?|콜라|사이다|소스|토핑)(?:\s*\([^)]*\))?$/iu;
const SIDE_ONLY_COMPACT_PATTERN = /^(?:주먹밥|공기밥|감자튀김|웨지감자|치즈볼|치즈스틱|콘샐러드|소떡소떡|군만두|닭꼬치|어묵(?:\d+개)?|오뎅(?:\d+개)?|콜라|사이다|소스|토핑)$/iu;
const ENGLISH_SIDE_ONLY_PATTERN = /^(?:fries|fried\s+potatoes|cheese\s*balls?|rice|cola|soda|sauce|toppings?)$/iu;
const PORK_SKIN_SIDE_ONLY_PATTERN = /^(?:[가-힣a-z0-9]+\s*)?껍데기(?:\s*\(?\d{2,3}\s*g\)?)?$/iu;

// The third tuple value marks an explicit meal format that is stronger than a
// restaurant's usual category. This lets a burger shop's clearly named pasta
// remain 양식 while terse brand products such as 한솥 "치킨마요" still use the
// restaurant signal. Keeping the precedence flag beside the rule prevents the
// two classification passes from drifting apart.
const MENU_CATEGORY_RULES = Object.freeze([
  ["피자", /(?:피자(?!돈까스|돈가스|돈카츠|김밥)|pizza(?!cutlet))/iu, true],
  // Cuisine-defining preparations outrank their ingredients. A salmon
  // futomaki or seafood udon is Japanese food, not a generic seafood dish.
  ["일식", /(?:초밥|스시|후토마(?:키|끼)|마(?:키|끼)|라멘|우동|소바|모밀|가츠동|규동|돈부리|텐동|카이센동|오야코동|가라아게|오코노미야(?:키|끼)|야키소바|스키야키|오니기리|차슈|일본식|sushi|ramen|udon|soba|donburi|futomaki|maki)/iu, true],
  ["양식", /(?:파마지아나|파르미자나|parmigiana|parmesana)/iu, true],
  ["족발/보쌈", /(?:족발|보쌈|족보세트)/u, true],
  ["치킨", /(?:치킨|통닭|닭강정|후라이드(?:치킨)?|양념치킨|뿌링클|파닭|닭다리|치킨윙|점보윙|chicken|zinger|tenders?|wings?)/iu],
  // A cutlet topping does not turn a curry rice dish into a cutlet plate.
  ["일식", /(?:카레)/u, true],
  // A cutlet can itself be a filling. The outer meal format still wins:
  // 돈까스김밥 is 분식 and 치킨카츠버거 is 버거.
  ["돈까스", /(?:(?:돈까스|돈가스|돈카츠|카츠|롤까스|뎃판까스|생선까스)(?!김밥|버거|샌드위치)|(?:katsu|cutlet)(?!burger|sandwich))/iu, true],
  ["샐러드", /(?:샐러드|포케|포키볼|그린볼|salad|poke)/iu, true],
  ["샌드위치", /(?:샌드위치|파니니|당근라페|통밀랩|치아바타|sandwich|panini|ciabatta|wrap)/iu, true],
  ["멕시칸", /(?:타코(?!야끼)|부리토|브리또|퀘사디아|파히타|엔칠라다|tacos?|burritos?|quesadilla|fajita|enchilada)/iu, true],
  ["죽", /(?:^|\s|[가-힣])죽(?:$|\s|[(&])/u, true],
  ["도시락", /(?:도시락|밥버거)/u, true],
  ["버거", /(?:버거|와퍼|빅맥|burger|whopper|bigmac)/iu, true],
  ["중식", /(?:짜장|짬뽕|마라|탕수육|깐풍|유린기|양꼬치|쏸라|중화)/u, true],
  ["아시안", /(?:쌀국수|팟타이|분짜|반미|똠얌|나시고랭|미고랭|커리|탄두리|케밥|pho|padthai|buncha|banhmi|curry|tandoori|kebab)/iu, true],
  ["회/해물", /(?:사시미|(?<!육)회덮밥|광어|연어|물회|해물|낙지|꽃게|문어|오징어|새우장|게장|sashimi|salmon|seafood)/iu, true],
  ["분식", /(?:떡볶이|떡볶|김밥|라볶이|순대(?!국)|튀김만두)/u, true],
  ["찜/탕", /(?:찜|탕|전골|국밥|해장국|찌개|설렁탕|곰탕|육개장|나베|두루치기|국물닭발)/u, true],
  ["한식", /(?:비빔밥|덮밥|제육|불고기|김치|백반|간장밥|쌈밥|된장|보리밥|냉면|칼국수|막국수|메밀국수|잔치국수|비빔국수|메밀전병|bibimbap|bulgogi|naengmyeon)/iu],
  ["양식", /(?:파스타|스파게티|리조또|리소토|도리아|그라탕|오므라이스|함박|pasta|spaghetti|risotto|gratin|omelette)/iu, true],
  ["구이", /(?:구이|삼겹|갈비|닭갈비|막창|곱창|껍데기|숯불|스테이크|steak)/iu],
]);

// Some brands define the meal format more reliably than an ingredient word in
// the menu.  For example, "한솥 치킨마요" is a lunch box, not fried chicken.
const FORCED_RESTAURANT_CATEGORY_RULES = Object.freeze([
  ["일식", /(?:모퉁이덮밥)/u],
  ["도시락", /(?:한솥|본도시락|봉구스밥버거)/u],
  ["피자", /(?:파파존스|도미노피자|피자스쿨|피자마루|고피자|빅스타피자|청년피자|반올림피자|미스터피자|피자헛|7번가피자)/u],
  ["버거", /(?:버거킹|롯데리아|맥도날드|맘스터치|프랭크버거|벤티버거|코지버거|왓더버거|버거피아|burgerking|lotteria|mcdonalds|momstouch|frankburger)/iu],
  ["샌드위치", /(?:서브웨이|샌드위치|subway)/iu],
  ["양식", /(?:롤링파스타|파스타)/u],
  ["구이", /(?:꾸꾸삼겹)/u],
  ["한식", /(?:뜸들이다)/u],
]);

// Reviewed product identities are stronger than a broad brand guess. These
// preserve repairs of old misclassified records without treating every item
// sold by a mixed-menu franchise as its usual cuisine.
const AUDITED_PRODUCT_CATEGORY_RULES = Object.freeze([
  ["피자", /파파존스/u, /^(?:수퍼|슈퍼)파파스(?:[slmr]|라지|레귤러|패밀리)?$/u],
  ["피자", /도미노피자/u, /^(?:오|더블)?(?:포테이토|리얼불고기|블랙타이거슈림프)(?:[slmr])?$/u],
  ["일식", /모퉁이덮밥/u, /^모퉁이덮밥$/u],
  ["도시락", /본도시락/u, /^매콤직화제육덮밥$/u],
]);

const RESTAURANT_CATEGORY_RULES = Object.freeze([
  ["일식", /(?:초밥|스시|후토루)/u],
  ["분식", /(?:김밥|떡볶이|청년다방)/u],
  ["죽", /(?:본죽|죽이야기)/u],
  ["아시안", /(?:케밥|kebab)/iu],
  ["치킨", /(?:교촌|푸라닭|충만치킨|bhc|bbq치킨|네네치킨|굽네치킨|처갓집양념치킨|페리카나|멕시카나|호식이두마리치킨|다사랑치킨|kfc|popeyes)/iu],
  ["중식", /(?:반점|중화요리)/u],
  ["구이", /(?:막창|곱창|닭발)/u]
]);

const JAPANESE_RESTAURANT_PATTERN = /(?:초밥|스시|후토루)/u;
const EXPLICIT_SEAFOOD_PREPARATION_PATTERN = /(?:사시미|(?<!육)회덮밥|물회|해물|새우장|게장|sashimi|seafood)/iu;
const KOREAN_RICE_PREPARATION_PATTERN = /(?:비빔밥|제육|불고기|김치볶음밥|백반|간장밥|쌈밥|보리밥|bibimbap|bulgogi)/iu;
// 회/해물 tokens often describe a topping rather than the dish format
// (해물 파스타, 새우 피자). Every other explicit override rule describes the
// structural dish and must be resolved before ingredient/cuisine context.
const INGREDIENT_LED_OVERRIDE_CATEGORIES = new Set(["회/해물"]);

function normalizedCategory(value) {
  const category = String(value || "").trim();
  return CATEGORY_ALIASES[category] || category;
}

export function isAllowedCategory(category) {
  return FOOD_CATEGORIES.includes(normalizedCategory(category));
}

export function isExcludedMealCandidate({ category = "", menu = "" } = {}) {
  const normalized = normalizedCategory(category);
  if (EXCLUDED_FOOD_CATEGORIES.includes(normalized)) return true;
  const menuText = String(menu || "").trim();
  if (!menuText) return false;
  const compactMenu = normalizeMenuKey(menuText);
  return NON_MEAL_PATTERN.test(menuText)
    || NON_MEAL_COMPACT_PATTERN.test(compactMenu)
    || SIDE_ONLY_PATTERN.test(menuText)
    || SIDE_ONLY_COMPACT_PATTERN.test(compactMenu)
    || ENGLISH_SIDE_ONLY_PATTERN.test(menuText)
    || PORK_SKIN_SIDE_ONLY_PATTERN.test(menuText);
}

// Multiple dish formats need semantic review when the model chooses a
// different matching format. A first regex hit is not a proof of precedence.
export function structuralMenuCategories(menu = "") {
  const key = normalizeKey(menu);
  return [...new Set(MENU_CATEGORY_RULES
    .filter(([category, pattern, structural]) => structural
      && !INGREDIENT_LED_OVERRIDE_CATEGORIES.has(category) && pattern.test(key))
    .map(([category]) => category))];
}

export function classifyFoodCategoryDecision({ category = "", restaurant = "", menu = "" } = {}, {
  allowDeclaredCategory = false
} = {}) {
  const result = (resolvedCategory, authority) => ({ category: resolvedCategory, authority });
  if (isExcludedMealCandidate({ category, menu })) return result(null, "excluded");
  const restaurantKey = normalizeKey(restaurant);
  const menuKey = normalizeKey(menu);
  const forcedRestaurantCategory = FORCED_RESTAURANT_CATEGORY_RULES
    .find(([, pattern]) => pattern.test(restaurantKey))?.[0] || null;
  const dominantMenuCategory = MENU_CATEGORY_RULES.find(
    ([candidateCategory, pattern, overridesRestaurant]) => overridesRestaurant
      && !INGREDIENT_LED_OVERRIDE_CATEGORIES.has(candidateCategory)
      && pattern.test(menuKey)
  )?.[0] || null;
  if (dominantMenuCategory) return result(dominantMenuCategory, "structural-menu");
  // A brand helps interpret terse product names, but is only a semantic hint:
  // burger shops can also sell chicken, and pizza shops can sell pasta.
  const auditedProductCategory = AUDITED_PRODUCT_CATEGORY_RULES.find(
    ([, brand, product]) => brand.test(restaurantKey) && product.test(menuKey)
  )?.[0];
  if (auditedProductCategory) return result(auditedProductCategory, "audited-product");
  if (forcedRestaurantCategory) return result(forcedRestaurantCategory, "restaurant-format-hint");
  // Context fills in terse menu names only when no audited brand-format rule
  // already applies. Structural formats such as 피자, 카레, 파스타, and 버거
  // have already won above. Korean rice preparations outrank a seafood topping, and
  // a sushi restaurant supplies the format for piece-count menus such as
  // "연어3 + 광어3". Explicit raw-fish preparations remain 회/해물.
  if (KOREAN_RICE_PREPARATION_PATTERN.test(menuKey)
      && !EXPLICIT_SEAFOOD_PREPARATION_PATTERN.test(menuKey)) {
    return result("한식", "semantic-menu-heuristic");
  }
  if (JAPANESE_RESTAURANT_PATTERN.test(restaurantKey)
      && !EXPLICIT_SEAFOOD_PREPARATION_PATTERN.test(menuKey)) {
    return result("일식", "semantic-restaurant-heuristic");
  }
  for (const [candidateCategory, pattern, overridesRestaurant] of MENU_CATEGORY_RULES) {
    if (overridesRestaurant && pattern.test(menuKey)) {
      return result(candidateCategory, "semantic-menu-heuristic");
    }
  }
  for (const [candidateCategory, pattern] of MENU_CATEGORY_RULES) {
    if (pattern.test(menuKey)) return result(candidateCategory, "semantic-menu-heuristic");
  }
  for (const [candidateCategory, pattern] of RESTAURANT_CATEGORY_RULES) {
    if (pattern.test(restaurantKey)) return result(candidateCategory, "semantic-restaurant-heuristic");
  }
  if (!allowDeclaredCategory) return result(null, "unknown");
  const normalized = normalizedCategory(category);
  return FOOD_CATEGORIES.includes(normalized)
    ? result(normalized, "declared-semantic")
    : result(null, "unknown");
}

export function classifyFoodCategory(input = {}, options = {}) {
  return classifyFoodCategoryDecision(input, options).category;
}

export function categoryEmoji(category) {
  return CATEGORY_EMOJI[normalizedCategory(category)] || "🍽️";
}
