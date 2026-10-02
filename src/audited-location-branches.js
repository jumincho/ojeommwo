import {
  canonicalizeRestaurantIdentity,
  normalizeKey,
} from "./text.js";

// These are deliberately narrow, manually audited physical-location identities.
// A branch or reviewed identity correction is applied only when the restaurant
// matches and either an exact provider place identity or the road/building
// number matches. Expanding this list requires another evidence review; fuzzy
// branch invention is not allowed.
const AUDITED_LOCATIONS = Object.freeze([
  Object.freeze({
    restaurantKey: normalizeKey("본도시락"),
    branch: "전북대점",
    diningCodeRid: "QPwXHDtb7lGP",
    addressToken: "조경단로 83",
  }),
  Object.freeze({
    restaurantKey: normalizeKey("광장수산"),
    branch: "덕진광장로점",
    diningCodeRid: "bzDOMtvnugZq",
    addressToken: "덕진광장로 1-11",
  }),
  Object.freeze({
    restaurantKey: normalizeKey("하나요리당고"),
    branch: "전북대점",
    diningCodeRid: "2xHNItG0xclL",
    addressToken: "권삼득로 333",
  }),
  Object.freeze({
    restaurantKey: normalizeKey("더 담다"),
    branch: "전북대점",
    tablingPlaceId: "677ccbd066de5f06987decbb",
    addressToken: "권삼득로 333",
  }),
  Object.freeze({
    restaurantKey: normalizeKey("주모"),
    branch: "전북대점",
    diningCodeRid: "kQsMWwrcahu3",
    addressToken: "명륜5길 8",
  }),
  Object.freeze({
    restaurantKey: normalizeKey("코지버거"),
    branch: "전북대점",
    diningCodeRid: "t1SdeO793r5P",
    addressToken: "명륜3길 9-4",
  }),
  Object.freeze({
    restaurantKey: normalizeKey("모퉁이"),
    canonicalRestaurant: "모퉁이덮밥",
    branch: "",
    correctIdentity: true,
    diningCodeRid: "ugffp3S7d2Yl",
    tablingPlaceId: "677cd7fa66de5f069893b106",
    addressToken: "삼송3길 42 107호",
  }),
]);

function diningCodeRid(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:"
      || url.hostname.toLowerCase() !== "www.diningcode.com"
      || url.port
      || url.username
      || url.password
      || url.pathname !== "/profile.php") return "";
    return String(url.searchParams.get("rid") || "").trim();
  } catch {
    return "";
  }
}

function tablingPlaceId(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:"
      || !["tabling.co.kr", "www.tabling.co.kr"].includes(url.hostname.toLowerCase())
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash) return "";
    const match = url.pathname.match(/^\/place\/([a-z0-9]+)$/iu);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function evidenceUrls(record) {
  return [
    record?.priceEvidenceUrl,
    record?.deliveryEvidenceUrl,
    record?.normalization?.restaurantEvidenceUrl,
    ...(Array.isArray(record?.normalization?.menuEvidence)
      ? record.normalization.menuEvidence.map((item) => item?.evidenceUrl)
      : []),
    ...(Array.isArray(record?.evidence) ? record.evidence : []),
  ].filter(Boolean);
}

function matchesAuditedAddress(value, token) {
  // Preserve road/building-number boundaries: removing punctuation first made
  // 83 match 830, 9-4 match 9-40, and 1-11 match 111. Unit/floor suffixes remain
  // valid after an exact building number, but cannot extend that number.
  const normalized = String(value || "").normalize("NFKC").replace(/,/gu, " ");
  const pattern = token.split(/\s+/u).map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\d+(?:-\d+)*/gu, "$&(?![\\d-])")
  ).join("\\s*");
  return new RegExp(pattern, "iu").test(normalized);
}

function auditedLocationFor(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "";
  const identity = canonicalizeRestaurantIdentity(record);
  const restaurantKey = normalizeKey(identity.restaurant);

  const urls = evidenceUrls(record);
  const rids = new Set(urls.map(diningCodeRid).filter(Boolean));
  const tablingPlaceIds = new Set(urls.map(tablingPlaceId).filter(Boolean));
  return AUDITED_LOCATIONS.find((item) => (
    item.restaurantKey === restaurantKey
    && ((item.diningCodeRid && rids.has(item.diningCodeRid))
      || (item.tablingPlaceId && tablingPlaceIds.has(item.tablingPlaceId))
      || matchesAuditedAddress(record.address, item.addressToken))
  )) || null;
}

export function auditedIdentityCorrectionForLocation(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const location = auditedLocationFor(record);
  if (!location?.correctIdentity) return null;
  const identity = canonicalizeRestaurantIdentity(record);
  return {
    restaurant: location.canonicalRestaurant || identity.restaurant,
    branch: location.branch,
  };
}

export function auditedBranchForLocation(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "";
  const identity = canonicalizeRestaurantIdentity(record);
  // Never replace a supplied or suffix-derived branch, even when it disagrees
  // with an audited location. Conflicts must remain visible for human review.
  if (identity.branch) return "";
  const location = auditedLocationFor(record);
  return location?.branch || "";
}

export function isAuditedLocationBranch(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const identity = canonicalizeRestaurantIdentity(record);
  const location = auditedLocationFor(record);
  return Boolean(location) && normalizeKey(identity.branch) === normalizeKey(location.branch);
}

export function enrichAuditedLocationBranch(record) {
  const branch = auditedBranchForLocation(record);
  return branch ? { ...record, branch } : record;
}

export const AUDITED_LOCATION_BRANCH_COUNT = AUDITED_LOCATIONS.length;
