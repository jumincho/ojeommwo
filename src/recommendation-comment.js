import { cleanText, normalizeRestaurantKey, normalizeMenuKey } from "./text.js";

const POLITE_ENDING_PATTERN = /(?:니다|요|죠|세요)[.!?]$/u;
const PLAIN_DECLARATIVE_SENTENCE_PATTERN = /(?<!니)다[.!?](?:\s|$)/u;
const MEAL_REFERENCE_REPLACEMENTS = Object.freeze([
  [/(?:점심|저녁)\s+한 끼/gu, "한 끼"],
  [/(?:점심|저녁)으로/gu, "한 끼로"],
  [/(?:점심|저녁)은/gu, "한 끼는"],
  [/(?:점심|저녁)을/gu, "한 끼를"],
  [/(?:점심|저녁)과/gu, "한 끼와"],
  [/(?:점심|저녁)이/gu, "한 끼가"],
  [/(?:점심|저녁)의/gu, "한 끼의"],
  [/(?:점심|저녁)에/gu, "한 끼에"],
  [/(?:점심|저녁)도/gu, "한 끼도"],
  [/(?:점심|저녁)/gu, "한 끼"]
]);
const STYLE_REPLACEMENTS = Object.freeze([
  [/(?<![A-Za-z])earthy(?:한)?(?![A-Za-z])/giu, "향긋한"],
]);

const CATEGORY_FALLBACKS = Object.freeze({
  "구이": "노릇하게 구운 고기의 육즙과 불향이 어우러져, 따뜻할 때 한입 먹으면 입맛이 확 살아납니다.",
  "중식": "진한 소스와 풍성한 건더기가 어우러져, 따뜻한 밥이나 면과 함께 먹을수록 감칠맛이 살아납니다.",
  "찜/탕": "깊게 밴 양념과 뜨끈한 국물이 재료의 감칠맛을 끌어올려, 든든한 한 끼로 잘 어울립니다.",
  "치킨": "바삭한 튀김옷과 촉촉한 닭고기가 어우러져, 한입 베어 물수록 고소한 풍미가 또렷해집니다.",
  "돈까스": "바삭한 튀김옷과 촉촉한 고기에 진한 소스가 어우러져, 한입마다 고소한 풍미가 살아납니다.",
  "피자": "고소한 치즈와 쫄깃한 도우가 풍성한 토핑을 감싸, 따뜻할 때 먹을수록 풍미가 진해집니다.",
  "회/해물": "탱글한 해산물의 식감과 산뜻한 곁들임이 어우러져, 한입마다 깔끔한 감칠맛이 살아납니다.",
  "샌드위치": "신선한 채소의 아삭함과 담백한 속재료가 부드러운 빵과 어우러져, 산뜻하게 즐기기 좋습니다.",
  "버거": "육즙 가득한 패티와 부드러운 번에 소스가 어우러져, 한입 베어 물수록 고소한 풍미가 진해집니다.",
  "도시락": "따뜻한 밥과 알찬 반찬이 조화롭게 어우러져, 여러 맛을 한 끼에 든든하게 즐길 수 있습니다."
});

export function isPoliteRecommendationComment(value) {
  const comment = cleanText(value);
  return comment.length >= 35
    && comment.length <= 120
    && POLITE_ENDING_PATTERN.test(comment)
    && !PLAIN_DECLARATIVE_SENTENCE_PATTERN.test(comment);
}

export function fallbackRecommendationComment(item = {}) {
  return CATEGORY_FALLBACKS[cleanText(item.category)]
    || `${cleanText(item.menu) || "이 메뉴"}의 풍미와 식감을 조화롭게 즐길 수 있어, 입맛을 돋우는 한 끼로 잘 어울립니다.`;
}

export function recommendationCommentForDisplay(item = {}) {
  // Historical generic kebab rows cannot establish the chicken/lamb option.
  // Keep an appetizing description without asserting an unrecorded choice.
  const comment = cleanText(item.comment).replace(
    normalizeRestaurantKey(item.restaurant) === "레반트" && normalizeMenuKey(item.menu) === "케밥"
      ? /양고기|닭고기/gu : /$^/u,
    "고기"
  );
  let displayComment = isPoliteRecommendationComment(comment) ? comment : fallbackRecommendationComment(item);
  for (const [pattern, replacement] of MEAL_REFERENCE_REPLACEMENTS) {
    displayComment = displayComment.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of STYLE_REPLACEMENTS) {
    displayComment = displayComment.replace(pattern, replacement);
  }
  return displayComment.replace(/한 끼(?:\s+한 끼)+/gu, "한 끼");
}
