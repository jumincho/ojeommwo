import { classifyFoodCategory, isExcludedMealCandidate } from "./categories.js";
import { ingredientFamiliesFor } from "./choice-diversity.js";
import {
  canonicalizeMenuForRestaurant,
  canonicalizeMenuName,
  canonicalizeRestaurantIdentity,
  normalizeKey,
  normalizeMenuKey,
} from "./text.js";
import {
  auditedBranchForLocation,
  auditedIdentityCorrectionForLocation,
  enrichAuditedLocationBranch,
} from "./audited-location-branches.js";
import {
  MODEL_CATEGORY_AUTHORITY,
  resolveOperationalCategory,
  resolveTrustedSemanticCategory,
} from "./category-arbitration.js";

const AUDITED_LEGACY_BRANCH_RESTAURANTS = new Set([
  "고씨네",
  "충만치킨",
  "춘리마라탕",
  "프랭크버거",
  "홍콩반점0410",
  "피자스쿨",
  "더 담다",
].map(normalizeKey));

function messageKey(channel, timestamp) {
  return `${String(channel || "").trim()}:${String(timestamp || "").trim()}`;
}

function migrationReport() {
  return {
    categoryChanges: {},
    menuNameChanges: {},
    restaurantNameChanges: {},
    branchNameChanges: {},
    candidateIdChanges: 0,
    ingredientFamilyChanges: {},
    categoryAuthorityChanges: {},
    deduplicatedActiveCandidates: 0,
    deduplicatedCatalogCandidates: 0,
    removedRecommendationGroups: 0,
    removedRecommendationItems: 0,
    removedSentMessages: 0,
    removedMealEvents: 0,
    removedMealParticipantCounts: 0,
    removedPreferenceResponses: 0,
    removedPreferenceRatings: 0,
    removedStaticRecommendations: 0,
    removedActiveCandidates: 0,
    removedCatalogCandidates: 0,
  };
}

function recordIngredientFamilyChange(report, previous, next) {
  const before = Array.isArray(previous) ? previous.join(",") : "미지정";
  const after = next.join(",");
  if (before === after) return;
  const key = `${before || "미지정"} -> ${after}`;
  report.ingredientFamilyChanges[key] = (report.ingredientFamilyChanges[key] || 0) + 1;
}

function recordCategoryChange(report, previous, next) {
  const before = String(previous || "미분류").trim() || "미분류";
  if (before === next) return;
  const key = `${before} -> ${next}`;
  report.categoryChanges[key] = (report.categoryChanges[key] || 0) + 1;
}

function recordCategoryAuthorityChange(report, previous, next) {
  const before = String(previous || "미지정").trim() || "미지정";
  if (before === next) return;
  const key = `${before} -> ${next}`;
  report.categoryAuthorityChanges[key] = (report.categoryAuthorityChanges[key] || 0) + 1;
}

function recordMenuNameChange(report, previous, next) {
  const before = String(previous || "").trim();
  if (!before || before === next) return;
  const key = `${before} -> ${next}`;
  report.menuNameChanges[key] = (report.menuNameChanges[key] || 0) + 1;
}

function recordIdentityNameChange(report, field, previous, next) {
  const before = String(previous || "").trim();
  const after = String(next || "").trim();
  if (before === after || (!before && !after)) return;
  const key = `${before || "미지정"} -> ${after || "미지정"}`;
  report[field][key] = (report[field][key] || 0) + 1;
}

function migrationRestaurantIdentity(record) {
  const auditedCorrection = auditedIdentityCorrectionForLocation(record);
  if (auditedCorrection) return auditedCorrection;
  const locationEnrichedRecord = enrichAuditedLocationBranch(record);
  const rawRestaurant = String(locationEnrichedRecord?.restaurant || "").trim();
  const rawBranch = String(locationEnrichedRecord?.branch || "").trim();
  const parsed = canonicalizeRestaurantIdentity({
    restaurant: rawRestaurant,
    branch: rawBranch
  });
  if (rawBranch) return parsed;
  // Legacy history encoded most branches inside restaurant. Re-splitting every
  // old row would retroactively change the documented restaurant cooldown
  // identity. Only collapse audited aliases that actually produced duplicate
  // stores in the live Observatory.
  if (AUDITED_LEGACY_BRANCH_RESTAURANTS.has(normalizeKey(parsed.restaurant))) return parsed;
  return { restaurant: rawRestaurant, branch: "" };
}

function candidateIdForRecord(record) {
  const identity = migrationRestaurantIdentity(record || {});
  return [
    normalizeKey(identity.restaurant),
    normalizeKey(identity.branch),
    normalizeMenuKey(record?.menu),
  ].filter(Boolean).join(":");
}

function collectAuditedCandidateIdentityMigrations(collections) {
  const migrations = new Map();
  const ambiguous = new Set();
  for (const items of collections) {
    for (const record of Array.isArray(items) ? items : []) {
      const correction = auditedIdentityCorrectionForLocation(record);
      const branch = auditedBranchForLocation(record);
      const previousCandidateId = String(record?.candidateId || "").trim();
      if ((!branch && !correction) || !previousCandidateId || ambiguous.has(previousCandidateId)) continue;
      const enriched = correction ? { ...record, ...correction } : { ...record, branch };
      const identity = migrationRestaurantIdentity(enriched);
      const candidateId = candidateIdForRecord(enriched);
      if (!candidateId) continue;
      const migration = {
        restaurant: identity.restaurant,
        branch: identity.branch,
        candidateId,
      };
      const previous = migrations.get(previousCandidateId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(migration)) {
        migrations.delete(previousCandidateId);
        ambiguous.add(previousCandidateId);
      } else {
        migrations.set(previousCandidateId, migration);
      }
    }
  }
  return migrations;
}

function canonicalRecord(record, report, {
  allowUnknown = false,
  allowDeclaredCategory = false,
  allowSemanticAdjudication = false,
  backfillIngredientFamilies = false,
  auditedCandidateIdentityMigrations = new Map(),
} = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (isExcludedMealCandidate(record)) return null;
  const linkedIdentity = auditedCandidateIdentityMigrations.get(String(record.candidateId || "").trim());
  const identityRecord = linkedIdentity ? {
    ...record,
    restaurant: linkedIdentity.restaurant,
    branch: linkedIdentity.branch,
  } : record;
  const identity = migrationRestaurantIdentity(identityRecord);
  const menu = canonicalizeMenuForRestaurant({
    restaurant: identity.restaurant,
    menu: record.menu,
  });
  const categoryInput = {
    ...record,
    restaurant: identity.restaurant,
    branch: identity.branch,
    menu
  };
  const semanticResolution = allowSemanticAdjudication
    ? resolveOperationalCategory(categoryInput)
    : null;
  // A valid identity-bound model decision is durable. Unstamped legacy rows
  // still need the deterministic migration repair used before this metadata
  // existed; otherwise one old mismatch could delete an entire history group.
  const categoryResolution = semanticResolution?.authority === MODEL_CATEGORY_AUTHORITY
    ? semanticResolution
    : {
        category: classifyFoodCategory(categoryInput, { allowDeclaredCategory }),
        authority: "deterministic",
      };
  const category = categoryResolution.category;
  if (!category) return allowUnknown ? { ...record } : null;
  recordCategoryChange(report, record.category, category);
  recordMenuNameChange(report, record.menu, menu);
  recordIdentityNameChange(report, "restaurantNameChanges", record.restaurant, identity.restaurant);
  recordIdentityNameChange(report, "branchNameChanges", record.branch, identity.branch);
  const canonical = {
    ...record,
    category,
    restaurant: identity.restaurant,
    ...(identity.branch || record.branch !== undefined ? { branch: identity.branch } : {}),
    menu
  };
  if (categoryResolution.authority === MODEL_CATEGORY_AUTHORITY) {
    recordCategoryAuthorityChange(report, record.categoryAuthority, MODEL_CATEGORY_AUTHORITY);
    canonical.categoryAuthority = MODEL_CATEGORY_AUTHORITY;
  } else {
    delete canonical.categoryAuthority;
    delete canonical.categoryAdjudicatedAt;
    delete canonical.categoryAdjudicationKey;
  }
  if (record.candidateId) {
    const candidateId = candidateIdForRecord(canonical);
    if (candidateId && candidateId !== record.candidateId) {
      canonical.candidateId = candidateId;
      report.candidateIdChanges += 1;
    }
  }
  if (backfillIngredientFamilies || Array.isArray(record.ingredientFamilies)) {
    const ingredientFamilies = ingredientFamiliesFor(canonical);
    recordIngredientFamilyChange(report, record.ingredientFamilies, ingredientFamilies);
    canonical.ingredientFamilies = ingredientFamilies;
  }
  return canonical;
}

function groupedHistory(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = messageKey(item?.channel, item?.messageTs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export function migrateTaxonomyStores({
  recommendations,
  recommendationHistory,
  sentMessages,
  mealEvents,
  candidatePreferences,
  verifiedCandidates,
} = {}) {
  const report = migrationReport();
  const droppedMessageKeys = new Set();
  const auditedCandidateIdentityMigrations = collectAuditedCandidateIdentityMigrations([
    recommendations,
    recommendationHistory?.items,
    verifiedCandidates?.candidates,
    verifiedCandidates?.catalog,
  ]);
  const canonicalOptions = { auditedCandidateIdentityMigrations };

  const nextRecommendations = [];
  for (const item of Array.isArray(recommendations) ? recommendations : []) {
    const canonical = canonicalRecord(item, report, {
      ...canonicalOptions,
      backfillIngredientFamilies: true,
    });
    if (canonical) nextRecommendations.push(canonical);
    else report.removedStaticRecommendations += 1;
  }

  const nextHistoryItems = [];
  for (const [key, group] of groupedHistory(recommendationHistory?.items)) {
    const migrated = group.map((item) => canonicalRecord(item, report, {
      ...canonicalOptions,
      // Historical recommendation taxonomy follows the same hybrid authority
      // as a new send: structural formats, agreement, or a bound model stamp.
      allowSemanticAdjudication: true,
      backfillIngredientFamilies: true,
    }));
    if (migrated.some((item) => !item)) {
      droppedMessageKeys.add(key);
      report.removedRecommendationGroups += 1;
      report.removedRecommendationItems += group.length;
      continue;
    }
    // Current taxonomy drives learning/display, while the immutable send
    // category records what was actually delivered. A taxonomy correction
    // must not erase a valid historical group or pretend it was sent anew.
    nextHistoryItems.push(...migrated.map((item, index) => (
      item.category !== group[index].category
        ? { ...item, categoryAtSend: group[index].categoryAtSend || group[index].category }
        : item
    )));
  }
  const nextRecommendationHistory = {
    ...recommendationHistory,
    items: nextHistoryItems,
  };

  const nextSentMessageRows = [];
  for (const item of Array.isArray(sentMessages?.messages) ? sentMessages.messages : []) {
    if (droppedMessageKeys.has(messageKey(item.channel, item.ts))) {
      report.removedSentMessages += 1;
      continue;
    }
    nextSentMessageRows.push({ ...item });
  }
  const nextSentMessages = { ...sentMessages, messages: nextSentMessageRows };

  const nextMealEventRows = [];
  for (const originalEvent of Array.isArray(mealEvents?.events) ? mealEvents.events : []) {
    const event = { ...originalEvent };
    if (Object.hasOwn(event, "participantCount")) {
      delete event.participantCount;
      report.removedMealParticipantCounts += 1;
    }
    const customInput = Boolean(event?.inputText || event?.inputNormalization || event?.rawMenu);
    const verifiedCustomInput = ["verified", "verified-source"].includes(event?.normalizationStatus);
    // Unverified custom text has no deterministic authority. Preserve it for
    // audit or explicit correction, but never promote its words to taxonomy.
    if (customInput && !verifiedCustomInput) {
      nextMealEventRows.push({ ...event });
      continue;
    }
    if (isExcludedMealCandidate(event)) {
      report.removedMealEvents += 1;
      continue;
    }
    const firstMenu = Array.isArray(event.menus)
      ? event.menus.find((item) => String(
          typeof item === "string" ? item : item?.canonicalName || item?.input || ""
        ).trim())
      : null;
    const firstMenuName = typeof firstMenu === "string"
      ? firstMenu
      : firstMenu?.canonicalName || firstMenu?.input;
    const menuNames = Array.isArray(event.menus)
      ? event.menus.map((item) => canonicalizeMenuForRestaurant({
          restaurant: event.restaurant || event.rawRestaurant,
          menu: typeof item === "string" ? item : item?.canonicalName || item?.input,
        }))
      : [];
    const record = {
      ...event,
      restaurant: event.restaurant || event.rawRestaurant,
      menu: firstMenuName || event.menu,
    };
    const linkedIdentity = auditedCandidateIdentityMigrations.get(String(event.candidateId || "").trim());
    const identity = migrationRestaurantIdentity(linkedIdentity ? {
      ...record,
      restaurant: linkedIdentity.restaurant,
      branch: linkedIdentity.branch,
    } : record);
    const categoryInput = {
      ...record,
      restaurant: identity.restaurant,
      branch: identity.branch
    };
    const category = verifiedCustomInput
      ? resolveTrustedSemanticCategory(categoryInput).category
      : classifyFoodCategory(categoryInput);
    if (category) {
      recordCategoryChange(report, event.category, category);
      recordIdentityNameChange(report, "restaurantNameChanges", event.restaurant, identity.restaurant);
      recordIdentityNameChange(report, "branchNameChanges", event.branch, identity.branch);
      const menus = menuNames.filter(Boolean);
      const menu = menus.length ? menus.join(" · ") : canonicalizeMenuForRestaurant({
        restaurant: identity.restaurant,
        menu: event.menu,
      });
      recordMenuNameChange(report, event.menu, menu);
      const canonicalEvent = {
        ...event,
        category,
        restaurant: identity.restaurant,
        ...(identity.branch || event.branch !== undefined ? { branch: identity.branch } : {}),
        ...(menu ? { menu } : {}),
        ...(menus.length ? { menus } : {}),
      };
      if (event.normalization?.menuEvidence && menus.length) {
        canonicalEvent.normalization = {
          ...event.normalization,
          menuEvidence: event.normalization.menuEvidence.map((item, index) => ({
            ...item,
            canonicalName: menus[index] || canonicalizeMenuForRestaurant({
              restaurant: identity.restaurant,
              menu: item?.canonicalName,
            }),
          })),
        };
      }
      if (event.candidateId) {
        const candidateId = candidateIdForRecord(canonicalEvent);
        if (candidateId && candidateId !== event.candidateId) {
          canonicalEvent.candidateId = candidateId;
          report.candidateIdChanges += 1;
        }
      }
      nextMealEventRows.push(canonicalEvent);
    } else {
      nextMealEventRows.push({ ...event });
    }
  }
  const nextMealEvents = { ...mealEvents, events: nextMealEventRows };

  const nextPreferenceResponses = [];
  for (const response of Array.isArray(candidatePreferences?.responses) ? candidatePreferences.responses : []) {
    const linkedToDroppedMessage = droppedMessageKeys.has(messageKey(response.channel, response.messageTs));
    const ratings = Array.isArray(response.ratings)
      ? response.ratings.map((item) => canonicalRecord(item, report, {
          ...canonicalOptions,
          // Preference metadata must never preserve a category that would be
          // rejected at the recommendation boundary.
          allowSemanticAdjudication: true,
        }))
      : [];
    if (linkedToDroppedMessage || ratings.length !== 3 || ratings.some((item) => !item)) {
      report.removedPreferenceResponses += 1;
      report.removedPreferenceRatings += Array.isArray(response.ratings) ? response.ratings.length : 0;
      continue;
    }
    nextPreferenceResponses.push({ ...response, ratings });
  }
  const nextCandidatePreferences = {
    ...candidatePreferences,
    responses: nextPreferenceResponses,
  };

  function migrateCandidateCollection(items, removalField, dedupeField) {
    const nextByIdentity = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const canonical = canonicalRecord(item, report, {
        ...canonicalOptions,
        // Evidence verification does not prove cuisine. Candidate and catalog
        // taxonomy therefore require structural authority, agreement, or a
        // separately bound model adjudication and otherwise fail closed.
        allowSemanticAdjudication: true,
        backfillIngredientFamilies: true,
      });
      if (!canonical) {
        report[removalField] += 1;
        continue;
      }
      const key = candidateIdForRecord(canonical);
      const previous = nextByIdentity.get(key);
      if (!previous) {
        nextByIdentity.set(key, canonical);
        continue;
      }
      report[dedupeField] += 1;
      const freshness = (value) => Math.max(
        Date.parse(value?.evidenceVerifiedAt || "") || 0,
        Date.parse(value?.deliveryCheckedAt || "") || 0,
        Date.parse(value?.priceCheckedAt || "") || 0
      );
      if (freshness(canonical) > freshness(previous)) nextByIdentity.set(key, canonical);
    }
    return [...nextByIdentity.values()];
  }
  const nextVerifiedCandidates = {
    ...verifiedCandidates,
    candidates: migrateCandidateCollection(
      verifiedCandidates?.candidates,
      "removedActiveCandidates",
      "deduplicatedActiveCandidates"
    ),
    catalog: migrateCandidateCollection(
      verifiedCandidates?.catalog,
      "removedCatalogCandidates",
      "deduplicatedCatalogCandidates"
    ),
  };

  return {
    stores: {
      recommendations: nextRecommendations,
      recommendationHistory: nextRecommendationHistory,
      sentMessages: nextSentMessages,
      mealEvents: nextMealEvents,
      candidatePreferences: nextCandidatePreferences,
      verifiedCandidates: nextVerifiedCandidates,
    },
    droppedMessageKeys: [...droppedMessageKeys].sort(),
    report: {
      ...report,
      categoryChanges: Object.fromEntries(Object.entries(report.categoryChanges).sort()),
      menuNameChanges: Object.fromEntries(Object.entries(report.menuNameChanges).sort()),
      restaurantNameChanges: Object.fromEntries(Object.entries(report.restaurantNameChanges).sort()),
      branchNameChanges: Object.fromEntries(Object.entries(report.branchNameChanges).sort()),
      ingredientFamilyChanges: Object.fromEntries(Object.entries(report.ingredientFamilyChanges).sort()),
      categoryAuthorityChanges: Object.fromEntries(Object.entries(report.categoryAuthorityChanges).sort()),
    },
  };
}
