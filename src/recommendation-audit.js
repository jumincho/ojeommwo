import {
  canonicalizeRestaurantIdentity,
  normalizeKey,
  normalizeMenuKey,
  normalizeRestaurantKey
} from "./text.js";
import {
  isLearningCandidatePreferenceResponse,
  isLearningRecommendationHistoryItem
} from "./history-policy.js";
import { validateCandidatePreferenceStore } from "./interaction-data-integrity.js";
import { choiceDiversityViolations } from "./choice-diversity.js";
import { MAX_FUTURE_CLOCK_SKEW_MS } from "./time-integrity.js";
import { cooldownAgeDays, isCooldownActive } from "./cooldown.js";

function countBy(items, keyFor) {
  const counts = new Map();
  for (const item of items) {
    const key = String(keyFor(item) ?? "unknown");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function evidenceList(item) {
  return (Array.isArray(item.evidence) ? item.evidence : [item.evidence]).filter(Boolean);
}

function candidateIdentitySet(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const identity = canonicalizeRestaurantIdentity(item);
      return [
        normalizeKey(identity.restaurant),
        normalizeKey(identity.branch),
        normalizeMenuKey(item.menu),
      ].join(":");
    })
    .sort();
}

function sameIdentitySet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isStandardPrice(value) {
  return /^(?:\d{1,3}(?:,\d{3})+|\d{4,6})원(?:\s*\/\s*\d+g)?$/.test(String(value || "").trim());
}

function cooldownViolations(items) {
  const sorted = [...items].sort((a, b) => Date.parse(a.recommendedAt) - Date.parse(b.recommendedAt));
  const previous = { restaurant: new Map(), menu: new Map() };
  const windows = { restaurant: 14, menu: 7 };
  const violations = [];

  for (const item of sorted) {
    const currentTime = Date.parse(item.recommendedAt);
    if (!Number.isFinite(currentTime)) continue;

    for (const kind of Object.keys(windows)) {
      const comparisonKey = kind === "menu"
        ? normalizeMenuKey(item.menu)
        : normalizeRestaurantKey(item.restaurant);
      const prior = previous[kind].get(comparisonKey);
      if (prior) {
        const ageDays = cooldownAgeDays(prior.item.recommendedAt, item.recommendedAt);
        if (isCooldownActive(prior.item.recommendedAt, item.recommendedAt, windows[kind])) {
          violations.push({
            kind,
            ageDays: Number(ageDays.toFixed(2)),
            restaurant: item.restaurant,
            menu: item.menu,
            recommendedAt: item.recommendedAt,
            previousRestaurant: prior.item.restaurant,
            previousMenu: prior.item.menu,
            previousRecommendedAt: prior.item.recommendedAt
          });
        }
      }
      previous[kind].set(comparisonKey, { time: currentTime, item });
    }
  }
  return violations;
}

export function auditRecommendationData({
  history,
  sentMessages,
  candidatePreferences = { version: 1, responses: [] },
  now = new Date(),
  windowDays = 30,
  policyEnforcementSince = null,
  choiceDiversityEnforcementSince = null,
  preferenceHistoryRetentionDays = 90
}) {
  const items = Array.isArray(history?.items) ? history.items : [];
  const messages = Array.isArray(sentMessages?.messages) ? sentMessages.messages : [];
  const preferenceResponses = Array.isArray(candidatePreferences?.responses) ? candidatePreferences.responses : [];
  const preferenceRatings = preferenceResponses.flatMap((response) => Array.isArray(response?.ratings) ? response.ratings : []);
  let candidatePreferenceIntegrityError = "";
  try {
    validateCandidatePreferenceStore(candidatePreferences);
  } catch (error) {
    candidatePreferenceIntegrityError = error.message;
  }
  const groups = new Map();
  for (const item of items) {
    const key = `${item.channel || ""}:${item.messageTs || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const historyKeys = new Set(groups.keys());
  const sentKeys = new Set(messages.map((item) => `${item.channel || ""}:${item.ts || ""}`));
  const sentByKey = new Map(messages.map((item) => [`${item.channel || ""}:${item.ts || ""}`, item]));
  const temporalCausalityViolations = [];
  for (const [key, group] of groups) {
    const sent = sentByKey.get(key);
    if (!sent) continue;
    const sentAt = Date.parse(sent.sentAt || "");
    const slackAt = Number(sent.ts) * 1000;
    for (const item of group) {
      const recommendedAt = Date.parse(item.recommendedAt || "");
      if (Number.isFinite(sentAt) && Number.isFinite(recommendedAt)
        && recommendedAt < sentAt - MAX_FUTURE_CLOCK_SKEW_MS) {
        temporalCausalityViolations.push({ key, kind: "recommendation-before-send" });
      }
      if (Number.isFinite(slackAt) && Number.isFinite(sentAt)
        && sentAt < slackAt - MAX_FUTURE_CLOCK_SKEW_MS) {
        temporalCausalityViolations.push({ key, kind: "send-before-slack-message" });
      }
      if (Number.isFinite(slackAt) && Number.isFinite(recommendedAt)
        && recommendedAt < slackAt - MAX_FUTURE_CLOCK_SKEW_MS) {
        temporalCausalityViolations.push({ key, kind: "recommendation-before-slack-message" });
      }
    }
  }
  const allViolations = cooldownViolations(items.filter(isLearningRecommendationHistoryItem));
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const recentViolations = allViolations.filter((item) => Date.parse(item.recommendedAt) >= cutoff);
  const policyEnforcementTime = Date.parse(policyEnforcementSince || "");
  const enforcementConfigurationErrors = [];
  if (policyEnforcementSince !== null && policyEnforcementSince !== undefined) {
    if (!Number.isFinite(policyEnforcementTime)) {
      enforcementConfigurationErrors.push("policy enforcement timestamp is invalid");
    } else if (policyEnforcementTime > now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS) {
      enforcementConfigurationErrors.push("policy enforcement timestamp is in the future");
    }
  }
  const enforcedViolations = Number.isFinite(policyEnforcementTime)
    ? allViolations.filter((item) => Date.parse(item.recommendedAt) >= policyEnforcementTime)
    : [];
  const allChoiceDiversityViolations = choiceDiversityViolations(items.filter(isLearningRecommendationHistoryItem));
  const recentChoiceDiversityViolations = allChoiceDiversityViolations
    .filter((item) => Date.parse(item.recommendedAt) >= cutoff);
  const choiceEnforcementTime = Date.parse(choiceDiversityEnforcementSince || "");
  if (choiceDiversityEnforcementSince !== null && choiceDiversityEnforcementSince !== undefined) {
    if (!Number.isFinite(choiceEnforcementTime)) {
      enforcementConfigurationErrors.push("choice-diversity enforcement timestamp is invalid");
    } else if (choiceEnforcementTime > now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS) {
      enforcementConfigurationErrors.push("choice-diversity enforcement timestamp is in the future");
    }
  }
  const enforcedChoiceDiversityViolations = Number.isFinite(choiceEnforcementTime)
    ? allChoiceDiversityViolations.filter((item) => Date.parse(item.recommendedAt) >= choiceEnforcementTime)
    : [];
  const evidence = items.flatMap(evidenceList);
  const evidenceWithoutUrl = evidence.filter((item) => !/https?:\/\//i.test(String(item)));
  const preferenceOrphans = [];
  const preferenceMismatches = [];
  const preferenceRetentionCutoff = now.getTime() - preferenceHistoryRetentionDays * 24 * 60 * 60 * 1000;
  for (const response of preferenceResponses.filter(isLearningCandidatePreferenceResponse)) {
    const key = `${response.channel || ""}:${response.messageTs || ""}`;
    const group = groups.get(key);
    const responseTime = Date.parse(response.updatedAt || response.submittedAt || response.createdAt || "");
    if (!group) {
      if (Number.isFinite(responseTime) && responseTime >= preferenceRetentionCutoff) {
        preferenceOrphans.push({ responseId: response.responseId, key });
      }
      continue;
    }
    const sameSource = group.every((item) => item.source === response.source);
    const sameMealType = group.every((item) => item.mealType === response.mealType);
    const sameCandidates = sameIdentitySet(
      candidateIdentitySet(group),
      candidateIdentitySet(response.ratings)
    );
    if (!sameSource || !sameMealType || !sameCandidates) {
      preferenceMismatches.push({ responseId: response.responseId, key, sameSource, sameMealType, sameCandidates });
    }
    const latestRecommendationTime = Math.max(...group.map((item) => Date.parse(item.recommendedAt || "")));
    if (Number.isFinite(responseTime) && Number.isFinite(latestRecommendationTime)
      && responseTime < latestRecommendationTime - MAX_FUTURE_CLOCK_SKEW_MS) {
      temporalCausalityViolations.push({ key, kind: "preference-before-recommendation" });
    }
  }

  const priceGroups = new Map();
  for (const item of items) {
    const key = `${normalizeRestaurantKey(item.restaurant)}:${normalizeMenuKey(item.menu)}`;
    if (!priceGroups.has(key)) priceGroups.set(key, { restaurant: item.restaurant, menu: item.menu, prices: new Set() });
    priceGroups.get(key).prices.add(item.priceText);
  }
  const changedPrices = [...priceGroups.values()]
    .filter((item) => item.prices.size > 1)
    .map((item) => ({ restaurant: item.restaurant, menu: item.menu, prices: [...item.prices] }));

  const provenanceItems = items.filter((item) => item.generationMode);
  return {
    version: 1,
    generatedAt: now.toISOString(),
    windowDays,
    totals: {
      recommendationItems: items.length,
      historyMessageGroups: groups.size,
      sentMessages: messages.length,
      candidatePreferenceResponses: preferenceResponses.length,
      candidatePreferenceRatings: preferenceRatings.length,
      uniqueRestaurants: new Set(items.map((item) => normalizeRestaurantKey(item.restaurant))).size,
      uniqueMenus: new Set(items.map((item) => normalizeMenuKey(item.menu))).size
    },
    integrity: {
      groupSizes: countBy([...groups.values()], (group) => group.length),
      historyGroupsWithoutSent: [...historyKeys].filter((key) => !sentKeys.has(key)).length,
      sentWithoutHistory: [...sentKeys].filter((key) => !historyKeys.has(key)).length,
      invalidDates: items.filter((item) => !Number.isFinite(Date.parse(item.recommendedAt))).length,
      enforcementConfigurationErrors,
      temporalCausalityViolations,
      candidatePreferenceError: candidatePreferenceIntegrityError,
      candidatePreferenceOrphans: preferenceOrphans,
      candidatePreferenceMismatches: preferenceMismatches
    },
    cooldowns: {
      allViolationEvents: allViolations.length,
      recentViolationEvents: recentViolations.length,
      enforcedViolationEvents: enforcedViolations.length,
      recentByKind: countBy(recentViolations, (item) => item.kind),
      recentViolations,
      enforcedViolations
    },
    choiceDiversity: {
      allViolationEvents: allChoiceDiversityViolations.length,
      recentViolationEvents: recentChoiceDiversityViolations.length,
      enforcedViolationEvents: enforcedChoiceDiversityViolations.length,
      recentByFamily: countBy(
        recentChoiceDiversityViolations.flatMap((item) => item.families),
        (family) => family
      ),
      recentViolations: recentChoiceDiversityViolations,
      enforcedViolations: enforcedChoiceDiversityViolations
    },
    provenance: {
      legacyItemsWithoutGenerationMode: items.length - provenanceItems.length,
      source: countBy(items, (item) => item.source),
      requestedMode: countBy(provenanceItems, (item) => item.requestedMode),
      generationMode: countBy(provenanceItems, (item) => item.generationMode),
      fallbackItems: provenanceItems.filter((item) => item.fallbackUsed).length
    },
    evidence: {
      entries: evidence.length,
      entriesWithoutUrl: evidenceWithoutUrl.length,
      itemsWithoutEvidence: items.filter((item) => evidenceList(item).length === 0).length
    },
    prices: {
      unknown: items.filter((item) => item.priceText === "가격 확인 필요").length,
      nonStandard: items.filter((item) => !isStandardPrice(item.priceText)).length,
      changedRestaurantMenuPairs: changedPrices
    },
    candidatePreferences: {
      ratingDistribution: countBy(preferenceRatings, (item) => item.rating),
      source: countBy(preferenceResponses, (item) => item.source),
      excludedPrivateTestResponses: preferenceResponses.filter((item) => item?.source === "manual-private-test").length,
      excludedRespondentlessResponses: preferenceResponses.filter((item) => !String(item?.respondentId || "").trim()).length,
      excludedNonLearningResponses: preferenceResponses.filter((item) => !isLearningCandidatePreferenceResponse(item)).length
    }
  };
}

export function formatAuditReport(report) {
  const lines = [
    `Recommendation audit (${report.generatedAt}, recent window ${report.windowDays}d)`,
    `- items/messages: ${report.totals.recommendationItems}/${report.totals.sentMessages}`,
    `- history groups: ${report.totals.historyMessageGroups} (without sent=${report.integrity.historyGroupsWithoutSent}, sent without history=${report.integrity.sentWithoutHistory})`,
    `- enforcement configuration errors: ${report.integrity.enforcementConfigurationErrors.length}`,
    `- temporal causality violations: ${report.integrity.temporalCausalityViolations.length}`,
    `- unique restaurants/menus: ${report.totals.uniqueRestaurants}/${report.totals.uniqueMenus}`,
    `- cooldown violations: all=${report.cooldowns.allViolationEvents}, recent=${report.cooldowns.recentViolationEvents}, enforced=${report.cooldowns.enforcedViolationEvents}`,
    `- choice-diversity violations: all=${report.choiceDiversity.allViolationEvents}, recent=${report.choiceDiversity.recentViolationEvents}, enforced=${report.choiceDiversity.enforcedViolationEvents}`,
    `- provenance: legacy=${report.provenance.legacyItemsWithoutGenerationMode}, fallback=${report.provenance.fallbackItems}`,
    `- candidate preferences: responses=${report.totals.candidatePreferenceResponses}, ratings=${report.totals.candidatePreferenceRatings}, non-learning excluded=${report.candidatePreferences.excludedNonLearningResponses}, recent orphan=${report.integrity.candidatePreferenceOrphans.length}, mismatch=${report.integrity.candidatePreferenceMismatches.length}`,
    `- evidence: entries=${report.evidence.entries}, without URL=${report.evidence.entriesWithoutUrl}, items missing=${report.evidence.itemsWithoutEvidence}`,
    `- prices: unknown=${report.prices.unknown}, non-standard=${report.prices.nonStandard}, changed pairs=${report.prices.changedRestaurantMenuPairs.length}`
  ];
  return lines.join("\n");
}

export function auditHasStructuralFailure(report) {
  return report.integrity.historyGroupsWithoutSent > 0
    || report.integrity.sentWithoutHistory > 0
    || report.integrity.invalidDates > 0
    || report.integrity.enforcementConfigurationErrors.length > 0
    || report.integrity.temporalCausalityViolations.length > 0
    || Boolean(report.integrity.candidatePreferenceError)
    || report.integrity.candidatePreferenceOrphans.length > 0
    || report.integrity.candidatePreferenceMismatches.length > 0
    || Object.keys(report.integrity.groupSizes).some((size) => Number(size) !== 3);
}

export function auditHasIntegrityFailure(report) {
  return auditHasStructuralFailure(report)
    || Number(report.cooldowns?.enforcedViolationEvents || 0) > 0
    || Number(report.choiceDiversity?.enforcedViolationEvents || 0) > 0;
}
