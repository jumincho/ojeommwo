import { SERVICE_VERSION } from "./version.js";
import { readBoundedResponseBytes } from "./bounded-response.js";
import { parseDiningCodeCoordinates, parseTablingCoordinates } from "./evidence-coordinates.js";
import { candidateIdFor } from "./verified-candidates.js";
import { isAuditedLocationBranch } from "./audited-location-branches.js";
import { normalizeKey, normalizeMenuKey } from "./text.js";

const EVIDENCE_HTML_LIMIT_BYTES = 1_000_000;
const EVIDENCE_VERIFICATION_CONCURRENCY = 2;
const MENU_PRICE_PROXIMITY_CHARS = 120;
const MENU_PRICE_BLOCK_LIMIT_CHARS = 2_000;

class EvidenceFetchError extends Error {
  constructor(message, { status, disposition, reason }) {
    super(message);
    this.name = "EvidenceFetchError";
    this.status = status;
    this.disposition = disposition;
    this.reason = reason;
  }
}

const INACTIVE_STATUS_KEYS = Object.freeze([
  "closed",
  "permanentlyclosed",
  "temporarilyclosed",
  "폐업",
  "폐점",
  "휴업",
  "영업종료",
  "영업중단"
]);

function evidenceKind(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if ((hostname === "tabling.co.kr" || hostname === "www.tabling.co.kr")
      && /^\/place\/[a-z0-9]+$/iu.test(url.pathname)
      && !url.search
      && !url.hash) {
      url.hostname = "www.tabling.co.kr";
      return { url, kind: "tabling" };
    }
    const diningCodeRid = url.searchParams.get("rid");
    if (hostname === "www.diningcode.com"
      && url.pathname === "/profile.php"
      && url.searchParams.size === 1
      && /^[a-z0-9_-]{1,128}$/iu.test(diningCodeRid || "")
      && !url.hash) {
      return { url, kind: "diningcode" };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchEvidenceHtml(source, fetchImpl) {
  const response = await fetchImpl(source.url, {
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: { "user-agent": `ojeommwo-v2/${SERVICE_VERSION} candidate evidence verifier` }
  });
  if (!response.ok) {
    const status = Number(response.status);
    const unavailable = status === 404 || status === 410;
    throw new EvidenceFetchError(`Evidence page returned HTTP ${status}`, {
      status,
      disposition: unavailable ? "unavailable" : "transient",
      reason: unavailable ? "http-unavailable" : "http-transient"
    });
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: EVIDENCE_HTML_LIMIT_BYTES,
    label: "Evidence page"
  });
  return new TextDecoder().decode(bytes);
}

function coordinatesFor(source, html) {
  return source.kind === "tabling"
    ? parseTablingCoordinates(html)
    : parseDiningCodeCoordinates(html);
}

function streetAddressKey(value) {
  return normalizeKey(value).replace(
    /^(?:(?:전북특별자치도|전라북도|전북))?전주시(?:덕진구|완산구)?/u,
    ""
  );
}

function hasExplicitDeliverySignal(source, html) {
  if (source.kind === "tabling") {
    return /<li\b[^>]*\bHome_tag__[^>]*>\s*배달\s*<\/li>/iu.test(html)
      || /\\?"classifications\\?"\s*:\s*\[[^\]]*\\?"배달\\?"/iu.test(html);
  }
  return /<span>\s*배달\s*<b>\s*\d+\s*<\/b>\s*<\/span>/iu.test(html)
    || /<a\b[^>]*href=["'][^"']*\/list\.dc\?query=[^"']*배달[^"']*["'][^>]*>\s*배달\s*<\/a>/iu.test(html);
}

function nearbyNormalizedValues(html, leftValue, rightValue) {
  const haystack = normalizeKey(html);
  const left = normalizeKey(leftValue);
  const right = normalizeKey(rightValue);
  if (!left || !right) return false;
  const leftIndexes = [];
  const rightIndexes = [];
  for (let index = haystack.indexOf(left); index >= 0; index = haystack.indexOf(left, index + left.length)) {
    leftIndexes.push(index);
    if (leftIndexes.length >= 32) break;
  }
  for (let index = haystack.indexOf(right); index >= 0; index = haystack.indexOf(right, index + right.length)) {
    rightIndexes.push(index);
    if (rightIndexes.length >= 32) break;
  }
  return leftIndexes.some((leftIndex) => rightIndexes.some((rightIndex) => {
    const gap = leftIndex <= rightIndex
      ? rightIndex - (leftIndex + left.length)
      : leftIndex - (rightIndex + right.length);
    return gap <= MENU_PRICE_PROXIMITY_CHARS;
  }));
}

function sameBoundedEvidenceBlock(html, menu, priceText) {
  const sourceHtml = String(html || "");
  const recordPattern = /<(li|tr|article|dl|dd)\b[^>]*>([\s\S]*?)<\/\1>/giu;
  const namedBlockPattern = /<(div|section)\b[^>]*(?:class|id)=["'][^"']*(?:menu|price|item|product|dish|메뉴|가격)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/giu;
  for (const match of [...sourceHtml.matchAll(recordPattern), ...sourceHtml.matchAll(namedBlockPattern)]) {
    const block = match[0];
    if (block.length > MENU_PRICE_BLOCK_LIMIT_CHARS) continue;
    const normalized = normalizeMenuKey(block);
    if (normalized.includes(normalizeMenuKey(menu))
      && normalized.includes(normalizeKey(priceText))) return true;
  }
  return false;
}

function hasCoupledMenuPriceSignal(html, candidate) {
  return sameBoundedEvidenceBlock(html, candidate.menu, candidate.priceText)
    || nearbyNormalizedValues(html, candidate.menu, candidate.priceText);
}

function unambiguousCurrentMenuPrice(html, candidate) {
  const expectedMenu = normalizeMenuKey(candidate.menu);
  const prices = new Set();
  const addPrice = (value, currency) => {
    if (currency && !/^(?:KRW|원)$/iu.test(String(currency))) return;
    const raw = String(value ?? "").trim().replace(/\s/gu, "");
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d{3,6})(?:원)?$/u.test(raw)) return;
    const amount = Number(raw.replace(/[^\d]/gu, ""));
    if (amount >= 1000 && amount <= 1_000_000) prices.add(amount);
  };
  let visited = 0;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12 || visited++ > 20_000) return;
    if (!Array.isArray(value)) {
      const name = value.menuName ?? value.productName ?? value.dishName ?? value.menu ?? value.name;
      if (typeof name === "string" && normalizeMenuKey(name) === expectedMenu) {
        // A direct scalar price belongs to this exact product. Nested size/
        // option lists and other menu names do not establish a changed price.
        addPrice(value.price ?? value.menuPrice, value.priceCurrency);
        if (value.offers && !Array.isArray(value.offers)) {
          addPrice(value.offers.price, value.offers.priceCurrency);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (/review|comment|description|related|recommendation/iu.test(key)) continue;
      visit(child, depth + 1);
    }
  };
  for (const match of String(html || "").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)) {
    const body = match[1].trim();
    if (body[0] !== "{" && body[0] !== "[") continue;
    try { visit(JSON.parse(body)); } catch { /* Non-JSON provider scripts. */ }
  }
  // Only a row containing exactly the canonical product and one KRW amount
  // qualifies. Size suffixes, descriptions, crossed-out prices, and multiple
  // products cannot turn a heuristic price mismatch into a factual change.
  for (const match of String(html || "").matchAll(/<(li|tr|article|dl|dd)\b[^>]*>([\s\S]*?)<\/\1>/giu)) {
    if (match[0].length > MENU_PRICE_BLOCK_LIMIT_CHARS || /<script\b/iu.test(match[0])) continue;
    const plain = match[2].replace(/<[^>]*>/gu, " ").replace(/&nbsp;|&#160;/giu, " ").trim();
    const row = plain.match(/^(.*?)\s*(\d{1,3}(?:,\d{3})+|\d{3,6})\s*원$/u);
    if (row && normalizeMenuKey(row[1]) === expectedMenu) addPrice(row[2]);
  }
  return prices.size === 1 ? [...prices][0] : null;
}

function inactiveStatusValue(value) {
  return INACTIVE_STATUS_KEYS.includes(normalizeKey(value));
}

function hasStructuredInactiveSignal(html) {
  const sourceHtml = String(html || "");
  const structuredStatusPattern = /\\?"(?:status|businessStatus|businessState|operationStatus|operationState|storeStatus|storeState|placeStatus|placeState|closureStatus)\\?"\s*:\s*\\?"([^"\\]{2,40})\\?"/giu;
  for (const match of sourceHtml.matchAll(structuredStatusPattern)) {
    if (inactiveStatusValue(match[1])) return true;
  }
  if (/\\?"(?:isClosed|isPermanentlyClosed|isTemporarilyClosed|isShutdown|isOutOfBusiness)\\?"\s*:\s*true\b/iu.test(sourceHtml)) {
    return true;
  }
  if (/\bdata-(?:business-|operation-|store-|place-)?status\s*=\s*["'](?:closed|permanently[-_ ]?closed|temporarily[-_ ]?closed|폐업|폐점|휴업|영업\s*(?:종료|중단))["']/iu.test(sourceHtml)) {
    return true;
  }

  const statusElementPattern = /<(?:div|span|p|li|em|strong|dd)\b([^>]*)>([\s\S]{0,160}?)<\/(?:div|span|p|li|em|strong|dd)>/giu;
  for (const match of sourceHtml.matchAll(statusElementPattern)) {
    const attributes = match[1];
    if (/(?:review|comment|reply|후기|리뷰)/iu.test(attributes)) continue;
    const statusAttribute = /(?:class|id)\s*=\s*["'][^"']*(?:closed|closure|shutdown|business[-_ ]?(?:status|state)|operation[-_ ]?(?:status|state)|store[-_ ]?(?:status|state)|place[-_ ]?(?:status|state))[^"']*["']/iu.test(attributes);
    if (!statusAttribute) continue;
    const directText = match[2].replace(/<[^>]+>/gu, " ");
    if (inactiveStatusValue(directText)) return true;
  }

  // Both supported providers put permanent closure in title metadata on some
  // profile variants. Keep this narrow so review prose such as "폐업 전 방문"
  // is never treated as a business-status fact.
  const titleValues = [
    ...[...sourceHtml.matchAll(/<title\b[^>]*>([^<]{0,160})<\/title>/giu)].map((match) => match[1]),
    ...[...sourceHtml.matchAll(/<meta\b[^>]*(?:(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']{0,160})["']|content=["']([^"']{0,160})["'][^>]*(?:property|name)=["'](?:og:title|twitter:title)["'])[^>]*>/giu)]
      .map((match) => match[1] || match[2])
  ];
  for (const value of titleValues) {
    const title = normalizeKey(value);
    if (/(?:폐업|폐점|휴업|영업종료|영업중단)$/u.test(title)) return true;
  }
  return false;
}

function structuredBusinessIdentities(html) {
  const result = [];
  const seen = new Set();
  let visited = 0;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 32 || visited >= 20_000) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const type = normalizeKey(value["@type"] || value.type || "");
    const nonBusinessType = /^(?:menu|menuitem|offer|product|review|person|imageobject)$/u.test(type);
    const name = [
      value.restaurantName,
      value.storeName,
      value.placeName,
      value.businessName,
      value.shopName,
      value.name
    ].find((item) => typeof item === "string" && item.trim());
    const rawAddress = value.address ?? value.roadAddress ?? value.streetAddress
      ?? value.restaurantAddress ?? value.storeAddress ?? value.placeAddress;
    const address = typeof rawAddress === "string"
      ? rawAddress
      : rawAddress && typeof rawAddress === "object"
        ? [rawAddress.streetAddress, rawAddress.addressLocality, rawAddress.addressRegion]
          .filter((item) => typeof item === "string" && item.trim())
          .join(" ")
        : "";
    if (!nonBusinessType && name && address) {
      const branch = [
        value.branch,
        value.branchName,
        value.storeBranch,
        value.placeBranch
      ].find((item) => typeof item === "string" && item.trim()) || "";
      const key = `${normalizeKey(name)}:${streetAddressKey(address)}:${normalizeKey(branch)}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name, address, branch });
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of String(html || "").matchAll(scriptPattern)) {
    const body = match[1].trim();
    if (!body || (body[0] !== "{" && body[0] !== "[")) continue;
    try {
      visit(JSON.parse(body));
    } catch {
      // Non-JSON application scripts are handled by the bounded field parser below.
    }
    if (visited >= 20_000) break;
  }
  return result.slice(0, 64);
}

function structuredIdentityValues(html) {
  const fields = {
    restaurant: new Set(["restaurantname", "storename", "placename", "businessname", "shopname"]),
    address: new Set(["address", "roadaddress", "streetaddress", "restaurantaddress", "storeaddress", "placeaddress"]),
    branch: new Set(["branch", "branchname", "storebranch", "placebranch"])
  };
  const businesses = structuredBusinessIdentities(html);
  const values = {
    restaurant: businesses.map((item) => item.name),
    address: businesses.map((item) => item.address),
    branch: businesses.map((item) => item.branch).filter(Boolean),
    businesses
  };
  const sourceHtml = String(html || "");
  const jsonFieldPattern = /\\?"([a-z][a-z0-9_-]{0,40})\\?"\s*:\s*\\?"([^"\\]{1,240})\\?"/giu;
  for (const match of sourceHtml.matchAll(jsonFieldPattern)) {
    const field = normalizeKey(match[1]);
    for (const [kind, allowed] of Object.entries(fields)) {
      if (allowed.has(field)) values[kind].push(match[2]);
    }
  }
  const dataFieldPattern = /\bdata-([a-z][a-z0-9_-]{0,50})\s*=\s*["']([^"']{1,240})["']/giu;
  for (const match of sourceHtml.matchAll(dataFieldPattern)) {
    const field = normalizeKey(match[1]);
    for (const [kind, allowed] of Object.entries(fields)) {
      if (allowed.has(field)) values[kind].push(match[2]);
    }
  }
  return values;
}

function structuredValueMatches(kind, value, candidate) {
  const normalized = kind === "address" ? streetAddressKey(value) : normalizeKey(value);
  const expected = kind === "address"
    ? streetAddressKey(candidate.address)
    : normalizeKey(candidate[kind]);
  if (!normalized || !expected) return false;
  if (kind === "address") return expected.length >= 4 && normalized.includes(expected);
  return normalized.includes(expected);
}

function pageSignals(source, html, candidate) {
  const normalized = normalizeKey(String(html || ""));
  const addressKey = streetAddressKey(candidate.address);
  return {
    restaurant: normalized.includes(normalizeKey(candidate.restaurant)),
    address: addressKey.length >= 4 && normalized.includes(addressKey),
    branch: !normalizeKey(candidate.branch)
      || isAuditedLocationBranch(candidate)
      || nearbyNormalizedValues(html, candidate.restaurant, candidate.branch),
    menuPrice: hasCoupledMenuPriceSignal(html, candidate),
    delivery: hasExplicitDeliverySignal(source, html)
  };
}

function pageIdentityState(source, html, candidate) {
  const signals = pageSignals(source, html, candidate);
  const explicit = structuredIdentityValues(html);
  const branchMatch = explicit.branch.some((value) =>
    structuredValueMatches("branch", value, candidate));
  const hasProviderCoordinates = Boolean(coordinatesFor(source, html));
  const businessMatch = explicit.businesses.some((business) =>
    structuredValueMatches("restaurant", business.name, candidate)
    && (structuredValueMatches("address", business.address, candidate) || signals.address));

  // A hard identity mismatch requires explicit provider fields. A generic 200
  // maintenance, bot-block, or access-denied document is indeterminate and
  // must never evict a valid restaurant from the candidate store.
  if (explicit.businesses.length && hasProviderCoordinates && !businessMatch) {
    return { state: "explicit-mismatch", signals };
  }
  if (normalizeKey(candidate.branch)
      && explicit.branch.length
      && !branchMatch
      && hasProviderCoordinates
      && signals.restaurant
      && signals.address) {
    return { state: "explicit-mismatch", signals };
  }
  if (signals.restaurant && signals.address && (signals.branch || branchMatch)) {
    return { state: "matched", signals };
  }
  if (normalizeKey(candidate.branch) && signals.restaurant && signals.address) {
    return { state: "branch-unverified", signals };
  }
  return { state: "indeterminate", signals };
}

function candidateDiagnostic(candidate, reason, sourceDiagnostics = [], disposition = "rejected") {
  return {
    candidateId: candidate?.candidateId || candidateIdFor(candidate || {}),
    restaurant: String(candidate?.restaurant || "").slice(0, 100),
    menu: String(candidate?.menu || "").slice(0, 100),
    reason,
    disposition,
    sources: sourceDiagnostics
  };
}

async function verifyOneCandidate(candidate, { now, fetchImpl }) {
  const sources = [...new Set([
    candidate?.priceEvidenceUrl,
    candidate?.deliveryEvidenceUrl,
    ...(Array.isArray(candidate?.evidence) ? candidate.evidence : [])
  ].filter(Boolean))].map(evidenceKind).filter(Boolean).slice(0, 4);
  let coordinates = null;
  let priceEvidenceUrl = "";
  let deliveryEvidenceUrl = "";
  const evidence = [];
  const sourceDiagnostics = [];
  if (!sources.length) {
    return { candidate: null, diagnostic: candidateDiagnostic(candidate, "no-supported-evidence-url") };
  }
  for (const source of sources) {
    try {
      const html = await fetchEvidenceHtml(source, fetchImpl);
      const identity = pageIdentityState(source, html, candidate);
      const { signals } = identity;
      if (identity.state === "explicit-mismatch") {
        sourceDiagnostics.push({
          url: source.url.toString(),
          reason: "identity-mismatch",
          disposition: "hard-negative"
        });
        continue;
      }
      if (identity.state === "branch-unverified") {
        sourceDiagnostics.push({
          url: source.url.toString(),
          reason: "branch-unverified",
          disposition: "unavailable"
        });
        continue;
      }
      if (identity.state !== "matched") {
        sourceDiagnostics.push({
          url: source.url.toString(),
          reason: "provider-page-unavailable",
          disposition: "transient"
        });
        continue;
      }
      if (hasStructuredInactiveSignal(html)) {
        sourceDiagnostics.push({ url: source.url.toString(), reason: "structured-inactive-business" });
        return {
          candidate: null,
          diagnostic: candidateDiagnostic(
            candidate,
            "structured-inactive-business",
            sourceDiagnostics,
            "hard-negative"
          )
        };
      }
      const currentMenuPrice = unambiguousCurrentMenuPrice(html, candidate);
      const storedMenuPrice = Number(String(candidate.priceText || "").replace(/[^\d]/gu, ""));
      if (currentMenuPrice !== null && currentMenuPrice !== storedMenuPrice) {
        sourceDiagnostics.push({ url: source.url.toString(), reason: "current-menu-price-changed" });
        return {
          candidate: null,
          diagnostic: candidateDiagnostic(
            candidate,
            "current-menu-price-changed",
            sourceDiagnostics,
            "unavailable"
          )
        };
      }
      const parsedCoordinates = coordinatesFor(source, html);
      if (parsedCoordinates) coordinates = parsedCoordinates;
      if (signals.menuPrice && !priceEvidenceUrl) priceEvidenceUrl = source.url.toString();
      if (signals.delivery && !deliveryEvidenceUrl) deliveryEvidenceUrl = source.url.toString();
      evidence.push(source.url.toString());
      sourceDiagnostics.push({
        url: source.url.toString(),
        reason: "matched",
        coordinates: Boolean(parsedCoordinates),
        menuPrice: signals.menuPrice,
        delivery: signals.delivery
      });
    } catch (error) {
      if (error instanceof EvidenceFetchError) {
        sourceDiagnostics.push({
          url: source.url.toString(),
          reason: error.reason,
          disposition: error.disposition,
          status: error.status
        });
      } else {
        sourceDiagnostics.push({
          url: source.url.toString(),
          reason: "fetch-failed",
          disposition: "transient"
        });
      }
    }
  }
  if (!coordinates || !priceEvidenceUrl || !deliveryEvidenceUrl) {
    const matchedPage = sourceDiagnostics.some((source) => source.reason === "matched");
    const identityMismatch = sourceDiagnostics.some((source) => source.reason === "identity-mismatch");
    const allUnavailable = sourceDiagnostics.length > 0
      && sourceDiagnostics.every((source) => source.disposition === "unavailable");
    const onlyTransientOrUnavailable = sourceDiagnostics.length > 0
      && sourceDiagnostics.every((source) => ["transient", "unavailable"].includes(source.disposition));
    if (!matchedPage && !identityMismatch && allUnavailable) {
      const branchUnverified = sourceDiagnostics.every(
        (source) => source.reason === "branch-unverified"
      );
      return {
        candidate: null,
        diagnostic: candidateDiagnostic(
          candidate,
          branchUnverified ? "branch-unverified" : "evidence-url-unavailable",
          sourceDiagnostics,
          "unavailable"
        )
      };
    }
    if (!matchedPage && !identityMismatch && onlyTransientOrUnavailable) {
      const providerPageUnavailable = sourceDiagnostics.some(
        (source) => source.reason === "provider-page-unavailable"
      );
      return {
        candidate: null,
        diagnostic: candidateDiagnostic(
          candidate,
          providerPageUnavailable ? "provider-page-unavailable" : "all-fetch-failed",
          sourceDiagnostics,
          "transient"
        )
      };
    }
    const missing = [
      !coordinates ? "coordinates" : "",
      !priceEvidenceUrl ? "coupled-menu-price" : "",
      !deliveryEvidenceUrl ? "delivery" : ""
    ].filter(Boolean).join("+");
    const reason = matchedPage
      ? `matched-page-missing-${missing}`
      : identityMismatch ? "identity-mismatch" : `missing-${missing}`;
    return {
      candidate: null,
      diagnostic: candidateDiagnostic(
        candidate,
        reason,
        sourceDiagnostics,
        identityMismatch ? "hard-negative" : matchedPage ? "transient" : "rejected"
      )
    };
  }
  return {
    candidate: {
      ...candidate,
      ...coordinates,
      priceCheckedAt: now.toISOString(),
      deliveryCheckedAt: now.toISOString(),
      evidenceVerifiedAt: now.toISOString(),
      evidenceVerification: "deterministic-html",
      priceEvidenceUrl,
      deliveryEvidenceUrl,
      evidence: [...new Set([
        priceEvidenceUrl,
        deliveryEvidenceUrl,
        ...(Array.isArray(candidate.evidence) ? candidate.evidence : []),
        ...evidence
      ])].slice(0, 6)
    },
    diagnostic: null
  };
}

export async function verifyCandidateResearchEvidence(candidates, {
  now = new Date(),
  fetchImpl = globalThis.fetch,
  diagnostics
} = {}) {
  if (typeof fetchImpl !== "function") return [];
  const input = Array.isArray(candidates) ? candidates : [];
  const checked = new Array(input.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(EVIDENCE_VERIFICATION_CONCURRENCY, input.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= input.length) return;
        checked[index] = await verifyOneCandidate(input[index], { now, fetchImpl });
      }
    }
  );
  await Promise.all(workers);

  const verified = [];
  for (const result of checked) {
    if (result.candidate) verified.push(result.candidate);
    if (result.diagnostic && Array.isArray(diagnostics)) diagnostics.push(result.diagnostic);
  }
  return verified;
}
