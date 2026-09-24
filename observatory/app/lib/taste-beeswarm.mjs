export const TASTE_DOMAIN_START = 20;
export const TASTE_DOMAIN_END = 92;

const HEADER_HEIGHT = 132;
const MIN_LANE_HEIGHT = 40;
const LANE_PADDING = 8;
const FOOTER_HEIGHT = 54;
const COLLISION_GAP = 2;
const Y_STEP = 2;

function clampTaste(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function compareText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

/**
 * Returns a new array ordered by the displayed posterior preference. Exact
 * ties prefer stronger evidence, then stable user-facing names and the id so
 * the list cannot jump between renders or runtimes.
 *
 * @template {{id:string,menu:string,restaurantLabel:string,taste:{mean:number,confidence:number,evidenceWeight:number}}} T
 * @param {T[]} menus
 * @returns {T[]}
 */
export function sortMenusByTastePreference(menus) {
  return [...menus].sort((left, right) => (
    finiteNumber(right.taste?.mean) - finiteNumber(left.taste?.mean)
    || finiteNumber(right.taste?.confidence) - finiteNumber(left.taste?.confidence)
    || finiteNumber(right.taste?.evidenceWeight) - finiteNumber(left.taste?.evidenceWeight)
    || compareText(left.menu, right.menu)
    || compareText(left.restaurantLabel, right.restaurantLabel)
    || compareText(left.id, right.id)
  ));
}

/**
 * Resolves overlapping pointer targets by geometric proximity instead of DOM
 * paint order. This keeps a selected or later-rendered point from masking the
 * adjacent point the user actually aimed at.
 *
 * @param {Array<{id:string,x:number,y:number}>} targets
 * @param {number} x
 * @param {number} y
 * @param {number} maximumDistance
 * @returns {string|null}
 */
export function nearestTasteTarget(targets, x, y, maximumDistance = 18) {
  const pointerX = Number(x);
  const pointerY = Number(y);
  const limit = Number(maximumDistance);
  if (!Array.isArray(targets)
      || !Number.isFinite(pointerX)
      || !Number.isFinite(pointerY)
      || !Number.isFinite(limit)
      || limit <= 0) return null;
  let nearest = null;
  let nearestDistance = limit;
  for (const target of targets) {
    const targetX = Number(target?.x);
    const targetY = Number(target?.y);
    const id = String(target?.id || "");
    if (!id || !Number.isFinite(targetX) || !Number.isFinite(targetY)) continue;
    const distance = Math.hypot(pointerX - targetX, pointerY - targetY);
    if (distance > nearestDistance + 1e-7) continue;
    if (distance < nearestDistance - 1e-7 || nearest === null || id < nearest) {
      nearest = id;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function radiusFor() {
  return 6;
}

function candidateOffset(attempt) {
  if (attempt === 0) return 0;
  const distance = Math.ceil(attempt / 2) * Y_STEP;
  return attempt % 2 === 1 ? distance : -distance;
}

function overlaps(candidate, placed) {
  return placed.some((point) => {
    const minimum = candidate.radius + point.radius + COLLISION_GAP;
    return Math.hypot(candidate.x - point.x, candidate.localY - point.localY) < minimum - 1e-7;
  });
}

/**
 * A deterministic vertical beeswarm. The taste mean keeps its exact x
 * position; collisions expand only the category lane's height, so dense data
 * remains truthful and scrollable instead of being painted on top of itself.
 *
 * @param {Array<{id:string,category:string,taste:{mean:number}}>} menus
 * @param {Array<{id:string}>} taxonomy
 * @param {number} requestedWidth
 */
export function buildTasteBeeswarm(menus, taxonomy, requestedWidth) {
  const width = Math.max(280, Number(requestedWidth) || 800);
  const points = [];
  const rows = [];
  let cursor = HEADER_HEIGHT;

  for (const category of taxonomy) {
    const categoryMenus = menus
      .filter((menu) => menu.category === category.id)
      .map((menu) => ({
        menu,
        x: width * (TASTE_DOMAIN_START + clampTaste(menu.taste.mean) * (TASTE_DOMAIN_END - TASTE_DOMAIN_START)) / 100,
        radius: radiusFor(menu),
      }))
      .sort((left, right) => left.x - right.x || left.menu.id.localeCompare(right.menu.id));

    const placed = [];
    for (const item of categoryMenus) {
      let localY = 0;
      let accepted = false;
      const maximumAttempts = Math.max(120, categoryMenus.length * 80);
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        localY = candidateOffset(attempt);
        if (!overlaps({ ...item, localY }, placed)) {
          accepted = true;
          break;
        }
      }
      if (!accepted) localY = (placed.length + 1) * (item.radius * 2 + COLLISION_GAP);
      placed.push({ ...item, localY });
    }

    const minimumTop = placed.length ? Math.min(...placed.map((point) => point.localY - point.radius)) : 0;
    const maximumBottom = placed.length ? Math.max(...placed.map((point) => point.localY + point.radius)) : 0;
    const occupiedHeight = maximumBottom - minimumTop;
    const laneHeight = Math.max(MIN_LANE_HEIGHT, Math.ceil(occupiedHeight + LANE_PADDING * 2));
    const baseline = cursor + LANE_PADDING - minimumTop;
    rows.push({ category: category.id, y: baseline, height: laneHeight });
    for (const point of placed) {
      points.push({
        id: point.menu.id,
        x: point.x,
        left: point.x / width * 100,
        y: baseline + point.localY,
        radius: point.radius,
        size: point.radius * 2,
      });
    }
    cursor += laneHeight;
  }

  return {
    width,
    height: Math.max(420, Math.ceil(cursor + FOOTER_HEIGHT)),
    points,
    rows,
  };
}
