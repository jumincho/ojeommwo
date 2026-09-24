import test from "node:test";
import assert from "node:assert/strict";
import { buildMealMessage, buildMealText } from "../src/message.js";

const recommendations = [
  {
    category: "도시락",
    restaurant: "밥집",
    menu: "제육덮밥",
    priceText: "9,000원",
    comment: "매콤한 제육 양념이 따뜻한 밥알에 진하게 배어, 한입마다 감칠맛과 든든함이 또렷하게 살아납니다."
  },
  {
    category: "중식",
    restaurant: "반점",
    menu: "짬뽕",
    priceText: "10,000원",
    comment: "칼칼한 국물에 해물 향과 탱글한 면발이 어우러져, 한 젓가락마다 진한 감칠맛이 살아납니다."
  },
  {
    category: "돈까스",
    restaurant: "카츠집",
    menu: "돈카츠",
    priceText: "11,000원",
    comment: "바삭한 튀김옷 안에 촉촉한 고기가 어우러져, 소스를 곁들일수록 고소한 풍미가 또렷해집니다."
  }
];

test("buildMealText renders the lunch Slack format", () => {
  const text = buildMealText({
    mealType: "점심",
    recommendations,
    headerEmoji: "🌧️",
    weatherAlert: "🌧️ 점심 무렵 비 70%\n☔ 내일 비 예보 80% · 예상 12mm",
    now: new Date("2026-07-13T03:00:00.000Z")
  });

  assert.match(text, /^🌧️ \*오늘 점심 드실 분\?\*/u);
  assert.match(text, /점심 드실 분은 ✅ 이모지를 눌러주세요!/u);
  assert.match(text, /🌧️ 점심 무렵 비 70%/u);
  assert.match(text, /☔ 내일 비 예보 80% · 예상 12mm/u);
  assert.match(text, /\*오늘의 배달 추천\*/u);
  assert.match(text, /🍱 \*도시락:\* 밥집 - 제육덮밥\n>9,000원\n>매콤한 제육 양념/u);
  assert.doesNotMatch(text, /1\. 🍚/u);
});

test("buildMealText renders the manual meal header", () => {
  const text = buildMealText({ mealType: "식사", recommendations });

  assert.match(text, /^🍽️ \*오늘 식사 드실 분\?\*/u);
  assert.match(text, /식사 드실 분은 ✅ 이모지를 눌러주세요!/u);
});

test("buildMealText normalizes an English dinner alias", () => {
  const text = buildMealText({
    mealType: "dinner",
    recommendations: recommendations.map((item, index) => index === 0
      ? { ...item, comment: "따뜻한 밥과 매콤한 양념이 어우러져 든든한 점심으로 즐기기 좋고, 마지막 한입까지 감칠맛이 살아납니다." }
      : item)
  });
  assert.match(text, /^🍽️ \*오늘 저녁 드실 분\?\*/u);
  assert.doesNotMatch(text, /dinner/u);
  assert.doesNotMatch(text, /점심으로/u);
  assert.match(text, /든든한 한 끼로 즐기기 좋고/u);
});

test("meal-specific comments normalize without repeating 한 끼", () => {
  const text = buildMealText({
    mealType: "저녁",
    recommendations: recommendations.map((item, index) => index === 0
      ? { ...item, comment: "완도산 광어의 담백한 맛과 쫀득한 식감이 살아 있어 깔끔한 저녁 한 끼로 잘 어울립니다." }
      : item)
  });
  assert.match(text, /깔끔한 한 끼로 잘 어울립니다/u);
  assert.doesNotMatch(text, /한 끼\s+한 끼/u);
});

test("mixed English food adjectives normalize to readable Korean", () => {
  const text = buildMealText({
    mealType: "저녁",
    recommendations: recommendations.map((item, index) => index === 0
      ? { ...item, comment: "버섯의 깊고 earthy한 풍미와 트러플 향이 부드러운 크림소스에 배어 면의 쫄깃함과 잘 어울립니다." }
      : item)
  });
  assert.match(text, /버섯의 깊고 향긋한 풍미/u);
  assert.doesNotMatch(text, /earthy/iu);
});

test("store prices are labeled without expanding the message layout", () => {
  const items = recommendations.map((item, index) => index === 0 ? { ...item, branch: "전북대점", priceChannel: "store" } : item);
  const text = buildMealText({ mealType: "점심", recommendations: items });
  assert.match(text, /밥집 전북대점 - 제육덮밥/u);
  assert.match(text, />9,000원 · 매장가\n/u);
});

test("buildMealMessage keeps details compact and adds all interaction buttons", () => {
  const message = buildMealMessage({ mealType: "저녁", recommendations, headerEmoji: "☀️", feedbackEnabled: true });
  assert.equal(message.blocks.length, 6);
  const buttons = message.blocks.at(-1).elements;
  assert.deepEqual(buttons.map((button) => button.action_id), [
    "record_actual_meal",
    "survey_recommended_preferences",
    "toggle_coffee_participation",
    "open_menu_observatory"
  ]);
  assert.deepEqual(buttons.map((button) => button.text.text), [
    "먹은 메뉴 기록",
    "추천된 메뉴 선호도 조사",
    "이따 커피 마실 분?",
    "🪐 메뉴 관측소"
  ]);
  assert.ok(buttons.slice(0, 2).every((button) => JSON.parse(button.value).recommendations.length === 3));
  assert.equal(buttons.at(-1).url, "https://ojeommwo-observatory.jumincho.chatgpt.site/");
  assert.equal(buttons.at(-1).accessibility_label, "메뉴 관측소 열기");
  assert.match(message.text, /^☀️ \*오늘 저녁 드실 분\?\*/u);
  assert.ok(message.text.includes(recommendations[0].comment));
});

test("buildMealMessage can disable only the observatory link", () => {
  const message = buildMealMessage({
    mealType: "저녁",
    recommendations,
    feedbackEnabled: true,
    observatoryEnabled: false,
    observatoryUrl: ""
  });
  assert.deepEqual(message.blocks.at(-1).elements.map((button) => button.action_id), [
    "record_actual_meal",
    "survey_recommended_preferences",
    "toggle_coffee_participation"
  ]);
});

test("buildMealText rejects output that is not exactly three complete recommendations", () => {
  assert.throws(
    () => buildMealText({ mealType: "점심", recommendations: recommendations.slice(0, 2) }),
    /exactly 3/u
  );
  assert.throws(
    () => buildMealText({ mealType: "점심", recommendations: [{}, ...recommendations.slice(1)] }),
    /missing category/u
  );
});

test("buildMealText rejects oversized recommendation fields before Slack delivery", () => {
  assert.throws(
    () => buildMealText({
      mealType: "점심",
      recommendations: [{ ...recommendations[0], restaurant: "식".repeat(101) }, ...recommendations.slice(1)]
    }),
    /oversized display fields/u
  );
  assert.throws(
    () => buildMealText({
      mealType: "점심",
      recommendations,
      weatherAlert: "비".repeat(3001)
    }),
    /Weather alert exceeds/u
  );
});

test("buildMealText escapes Slack control syntax in generated fields", () => {
  const text = buildMealText({
    mealType: "점심",
    recommendations: [
      { ...recommendations[0], restaurant: "<!channel>", comment: "<https://example.com|click> & eat 문구와 매콤한 양념이 함께 보여도, 안전하게 표시되며 감칠맛이 살아납니다." },
      recommendations[1],
      recommendations[2]
    ],
    weatherAlert: "<script>"
  });
  assert.ok(!text.includes("<!channel>"));
  assert.ok(!text.includes("<https://example.com|click>"));
  assert.match(text, /&lt;!channel&gt;/u);
  assert.match(text, /&amp; eat/u);
  assert.match(text, /&lt;script&gt;/u);
});

test("plain ~다 style comments are replaced with an appetizing polite fallback", () => {
  const text = buildMealText({
    mealType: "저녁",
    recommendations: recommendations.map((item, index) => index === 0
      ? { ...item, comment: "직화 패티와 탱글한 새우가 어우러져 끝맛을 잡아준다." }
      : item)
  });
  assert.doesNotMatch(text, /잡아준다\./u);
  assert.match(text, /든든하게 즐길 수 있습니다\./u);
});
