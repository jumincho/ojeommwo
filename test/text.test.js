import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeBranchName,
  canonicalizeMenuForRestaurant,
  canonicalizeMenuName,
  canonicalizeRestaurantIdentity,
  canonicalizeRestaurantName,
  cleanText,
  daysSince,
  normalizeKey,
  normalizeMenuKey,
  normalizeRestaurantKey,
} from "../src/text.js";

test("text helpers normalize display text and comparison keys", () => {
  assert.equal(cleanText("  전북대\n  메뉴  "), "전북대 메뉴");
  assert.equal(normalizeKey("BHC 전북대점 (본점)"), "bhc전북대점본점");
});

test("menu keys merge harmless spacing and orthographic variants", () => {
  assert.equal(normalizeMenuKey("연어 후토마키"), normalizeMenuKey("연어후토마끼"));
  assert.equal(normalizeMenuKey("김치 돈가스"), normalizeMenuKey("김치돈까스"));
  assert.equal(normalizeMenuKey("냉메밀"), normalizeMenuKey("냉모밀"));
  assert.equal(normalizeMenuKey("오코노미야키"), normalizeMenuKey("오코노미야끼"));
  assert.equal(canonicalizeMenuName("연어후토마끼"), "연어 후토마키");
  assert.equal(canonicalizeMenuName("소바후토마끼"), "소바 후토마키");
  assert.equal(canonicalizeMenuName("빅맥세트"), "빅맥 세트");
  assert.equal(canonicalizeMenuName("흑돼지인생돈까스"), "흑돼지인생돈까스");
  assert.equal(canonicalizeMenuName("Cozy Burger"), "코지버거");
  assert.equal(normalizeMenuKey("Cozy Burger"), normalizeMenuKey("코지버거"));
});

test("restaurant-scoped menu aliases merge audited live labels without global overreach", () => {
  assert.equal(
    canonicalizeMenuForRestaurant({ restaurant: "광장수산 덕진광장로점", menu: "광어" }),
    "광어(소)"
  );
  assert.equal(
    canonicalizeMenuForRestaurant({ restaurant: "로충칭 마라탕 전북대점", menu: "마라탕" }),
    "마라탕 1인"
  );
  assert.equal(
    canonicalizeMenuForRestaurant({ restaurant: "다른 횟집", menu: "광어" }),
    "광어"
  );
});

test("restaurant and branch aliases converge on one visible identity", () => {
  assert.deepEqual(
    canonicalizeRestaurantIdentity({ restaurant: "고씨네 카레 전북대점" }),
    { restaurant: "고씨네", branch: "전북대점" }
  );
  assert.deepEqual(
    canonicalizeRestaurantIdentity({
      restaurant: "충만치킨 전주전북대점",
      branch: "전북대점",
    }),
    { restaurant: "충만치킨", branch: "전북대점" }
  );
  assert.equal(canonicalizeRestaurantName("고씨네 카레"), "고씨네");
  assert.equal(canonicalizeRestaurantName("THE담다"), "더 담다");
  assert.deepEqual(
    canonicalizeRestaurantIdentity({ restaurant: "더 담다 전북대점" }),
    { restaurant: "더 담다", branch: "전북대점" }
  );
  assert.equal(canonicalizeRestaurantName("춘리 마라탕"), "춘리마라탕");
  assert.equal(canonicalizeRestaurantName("프랭크 버거"), "프랭크버거");
  assert.equal(canonicalizeRestaurantName("홍콩반점 0410"), "홍콩반점0410");
  assert.equal(canonicalizeRestaurantName("피자 스쿨"), "피자스쿨");
  assert.equal(canonicalizeBranchName("전주 전북대점"), "전북대점");
  assert.equal(normalizeRestaurantKey("고씨네 카레"), normalizeRestaurantKey("고씨네"));
  assert.equal(normalizeRestaurantKey("김피라 전북대점"), normalizeRestaurantKey("김피라"));
});

test("daysSince handles valid and invalid timestamps", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  assert.equal(daysSince("2026-07-10T00:00:00.000Z", now), 2);
  assert.equal(daysSince("not-a-date", now), Number.POSITIVE_INFINITY);
});

test("bilingual translations share identity without erasing product variants", () => {
  assert.equal(canonicalizeMenuForRestaurant({ restaurant: "에머이", menu: "매운쌀국수 Spicy Pho" }), "매운쌀국수");
  assert.equal(normalizeMenuKey("매운 쌀국수 (Spicy Pho)"), normalizeMenuKey("매운쌀국수"));
  assert.equal(normalizeMenuKey("불고기 피자 Bulgogi Pizza"), normalizeMenuKey("불고기피자"));
  assert.notEqual(normalizeMenuKey("치킨 Black Label"), normalizeMenuKey("치킨"));
  assert.notEqual(normalizeMenuKey("불고기 피자 L"), normalizeMenuKey("불고기 피자 M"));
});
