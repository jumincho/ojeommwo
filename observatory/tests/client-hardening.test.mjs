import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTasteBeeswarm,
  nearestTasteTarget,
  sortMenusByTastePreference,
} from "../app/lib/taste-beeswarm.mjs";
import { nextCategorySelection } from "../app/lib/category-selection.mjs";
import { validateSnapshot as validateBrowserSnapshot } from "../app/lib/snapshot-validator.mjs";
import { BOT_ROOT } from "../scripts/lib/bot-contract.mjs";
import { buildSnapshot } from "../scripts/lib/observatory-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("browser validator accepts the production projection and rejects nested corruption", () => {
  const snapshot = buildSnapshot({
    dataDir: path.resolve(process.env.OJEOMMWO_DATA_DIR || path.join(BOT_ROOT, "data")),
    generatedAt: new Date().toISOString(),
  });
  assert.equal(validateBrowserSnapshot(snapshot), snapshot);

  const previousSnapshot = structuredClone(snapshot);
  for (const menu of previousSnapshot.menus) {
    delete menu.deliveryStatus;
    delete menu.deliveryFreshness;
    if (!menu.availableNow) {
      menu.availabilityCheckedAt = null;
      menu.availabilityExpiresAt = null;
    }
  }
  const normalizedPrevious = validateBrowserSnapshot(previousSnapshot);
  for (const menu of normalizedPrevious.menus) {
    assert.equal(menu.deliveryStatus, menu.availableNow ? "likely" : null);
    assert.equal(menu.deliveryFreshness, menu.availableNow ? "current" : null);
  }

  const brokenPosterior = structuredClone(snapshot);
  brokenPosterior.menus[0].taste.alpha += 1;
  assert.throws(() => validateBrowserSnapshot(brokenPosterior), /베타 분포 모수와 일치/u);

  const brokenReference = structuredClone(snapshot);
  brokenReference.menus[0].restaurantId = "restaurant_0000000000000000";
  assert.throws(() => validateBrowserSnapshot(brokenReference), /존재하지 않는 상호/u);

  const leakedIdentifier = structuredClone(snapshot);
  leakedIdentifier.channelId = "C123456789";
  assert.throws(() => validateBrowserSnapshot(leakedIdentifier), /금지된 개인정보 필드/u);
});

test("category selection narrows first, then supports additive multi-selection", () => {
  const all = ["한식", "치킨", "피자", "일식"];
  let selected = new Set(all);
  selected = nextCategorySelection(selected, "피자", all);
  assert.deepEqual([...selected], ["피자"]);

  selected = nextCategorySelection(selected, "일식", all);
  assert.deepEqual([...selected], ["피자", "일식"]);

  selected = nextCategorySelection(selected, "피자", all);
  assert.deepEqual([...selected], ["일식"]);

  selected = nextCategorySelection(selected, "일식", all);
  assert.deepEqual([...selected], all);
});

test("taste beeswarm is deterministic and collision-free for a dense equal-mean lane", () => {
  const taxonomy = [{ id: "한식" }, { id: "치킨" }];
  const menus = Array.from({ length: 64 }, (_, index) => ({
    id: `menu_${index.toString(16).padStart(16, "0")}`,
    category: index < 56 ? "한식" : "치킨",
    occurrences: index % 9,
    taste: { mean: index < 56 ? 0.5 : 0.5005, confidence: (index % 10) / 10 },
  }));
  const first = buildTasteBeeswarm(menus, taxonomy, 390);
  const second = buildTasteBeeswarm(menus, taxonomy, 390);
  assert.deepEqual(first, second);
  assert.ok(first.height > 420, "dense lanes should expand into a scrollable surface");
  assert.deepEqual(new Set(first.points.map((point) => point.size)), new Set([12]));

  for (let leftIndex = 0; leftIndex < first.points.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < first.points.length; rightIndex += 1) {
      const left = first.points[leftIndex];
      const right = first.points[rightIndex];
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      assert.ok(distance + 1e-7 >= left.radius + right.radius + 2, `${left.id} overlaps ${right.id}`);
    }
  }
});

test("taste list ordering is posterior-descending, deterministic, and non-mutating", () => {
  const menus = [
    { id: "d", menu: "라면", restaurantLabel: "라", taste: { mean: 0.4, confidence: 1, evidenceWeight: 20 } },
    { id: "c", menu: "김밥", restaurantLabel: "나", taste: { mean: 0.7, confidence: 0.8, evidenceWeight: 3 } },
    { id: "b", menu: "김밥", restaurantLabel: "가", taste: { mean: 0.7, confidence: 0.8, evidenceWeight: 2 } },
    { id: "a", menu: "국밥", restaurantLabel: "다", taste: { mean: 0.7, confidence: 0.2, evidenceWeight: 9 } },
  ];
  const originalIds = menus.map((menu) => menu.id);
  const first = sortMenusByTastePreference(menus);
  const second = sortMenusByTastePreference(menus);

  assert.deepEqual(first.map((menu) => menu.id), ["c", "b", "a", "d"]);
  assert.deepEqual(second, first);
  assert.deepEqual(menus.map((menu) => menu.id), originalIds);
  for (let index = 1; index < first.length; index += 1) {
    assert.ok(first[index - 1].taste.mean >= first[index].taste.mean);
  }
});

test("taste-map hit testing selects the geometrically nearest overlapping point", () => {
  const targets = [
    { id: "selected", x: 100, y: 100 },
    { id: "adjacent", x: 112, y: 100 },
  ];
  assert.equal(nearestTasteTarget(targets, 111, 100), "adjacent");
  assert.equal(nearestTasteTarget(targets, 101, 100), "selected");
  assert.equal(nearestTasteTarget(targets, 150, 100), null);
  assert.equal(nearestTasteTarget([...targets].reverse(), 106, 100), "adjacent");
});

test("mobile panels, snapshot fallback, map keyboard controls, and readable CSS remain wired", () => {
  const observatory = read("app/components/Observatory.tsx");
  const taste = read("app/components/TasteMap.tsx");
  const cosmos = read("app/components/MenuCosmos.tsx");
  const reroll = read("app/components/RerollShop.tsx");
  const css = read("app/globals.css");

  assert.match(observatory, /role=\{controlsAreOverlay \? "dialog"/u);
  assert.match(observatory, /aria-modal=\{detailsAreOverlay && detailOpen/u);
  assert.match(observatory, /inert=\{\(detailsAreOverlay && !detailOpen\)/u);
  assert.match(observatory, /event\.key !== "Tab"/u);
  assert.match(observatory, /lastSelectionTriggerRef[\s\S]*\.focus\(\)/u);
  assert.match(observatory, /validateSnapshot\(JSON\.parse\(snapshotText\)\)/u);
  assert.match(observatory, /MAX_SNAPSHOT_TEXT_LENGTH/u);
  assert.match(observatory, /window\.localStorage\.setItem\(SNAPSHOT_CACHE_KEY/u);
  assert.match(observatory, /class SnapshotRenderBoundary/u);
  assert.match(observatory, /const selectionStillExists/u);
  assert.match(observatory, /nextCategorySelection\(selectedCategories, category, categoryIds\)/u);
  assert.doesNotMatch(observatory, /setInterval|visibilitychange|최초 추천일 필터|현재 근거/u);
  assert.doesNotMatch(observatory, />신규 후보/u);

  assert.match(taste, /buildTasteBeeswarm/u);
  assert.match(taste, /ResizeObserver/u);
  assert.match(taste, /ArrowLeft/u);
  assert.match(taste, /tabIndex=\{focusedId ===/u);
  assert.match(taste, /onClickCapture=\{selectNearestPointerTarget\}/u);
  assert.match(taste, /Math\.max\(24, point\.size\)/u);
  assert.match(css, /\.taste-map__plot\s*\{[^}]*overflow:\s*auto/su);
  assert.match(css, /\.taste-map__star\s*\{[^}]*min-width:\s*24px[^}]*min-height:\s*24px/su);
  assert.match(css, /\.taste-map__star\.is-selected\s*\{[^}]*pointer-events:\s*none/su);
  assert.match(css, /\.observatory-grid\s*\{[^}]*z-index:\s*auto/su);
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.detail-panel\s*\{[^}]*z-index:\s*44[\s\S]*\.panel-backdrop\s*\{[^}]*z-index:\s*40/su);
  assert.match(css, /\.taste-map__list-grid\s*\{[^}]*grid-template-columns:\s*1fr/su);
  assert.doesNotMatch(css, /font-size:\s*11px|font:\s*[^;{}]*\b11px/u);
  assert.match(css, /\.reroll-shop__cards\s*\{[^}]*overflow-y:\s*hidden/su);
  assert.doesNotMatch(reroll, /"신규 후보"/u);

  assert.match(cosmos, /cameraDistanceForViewport/u);
  assert.match(cosmos, /categoryLabelHeight/u);
  assert.match(cosmos, /focusDistanceForViewport/u);
  assert.match(cosmos, /maximumLensRadius/u);
});

test("responsive state reconciliation stays event-driven or derived without effect cascades", () => {
  const observatory = read("app/components/Observatory.tsx");
  const taste = read("app/components/TasteMap.tsx");
  const reroll = read("app/components/RerollShop.tsx");

  assert.match(observatory, /const selectedId = selectionStillExists/u);
  assert.match(observatory, /closeSidebarWhenControlsBecomeInline[\s\S]*addEventListener\("change"/u);
  assert.doesNotMatch(observatory, /if \(!controlsAreOverlay\) setSidebarOpen/u);
  assert.doesNotMatch(observatory, /setSelectedId/u);
  assert.doesNotMatch(observatory, /knownCategoryIdsRef/u);

  assert.match(taste, /const focusedId = focusState\.selectedId === selectedId/u);
  assert.match(taste, /setFocusState\(\{ id: nextId, selectedId \}\)/u);
  assert.doesNotMatch(taste, /setFocusedId/u);

  assert.match(reroll, /const announcement = roll > 0/u);
  assert.match(reroll, /\$\{roll\}번째 다시 뽑기/u);
  assert.match(reroll, /새 메뉴 \$\{cards\.length\}개를 표시했습니다/u);
  assert.doesNotMatch(reroll, /\.join\([^\n]+\)\}을 표시했습니다/u);
  assert.doesNotMatch(reroll, /setAnnouncement/u);
});
