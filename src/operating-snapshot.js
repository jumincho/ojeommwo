import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  validateMealEventStore,
  validateRecommendationHistoryStore,
  validateSentMessageStore
} from "./operating-data-integrity.js";
import {
  validateCandidatePreferenceStore,
  validateCoffeeParticipationStore
} from "./interaction-data-integrity.js";
import {
  auditHasIntegrityFailure,
  auditRecommendationData
} from "./recommendation-audit.js";
import { hasCurrentDeterministicEvidence, normalizeVerifiedCandidate } from "./verified-candidates.js";
import { MAX_JSON_STORE_BYTES, validateDeliveryOutboxStore } from "./storage.js";
import { currentTimeMs, MAX_FUTURE_CLOCK_SKEW_MS, timestampMs } from "./time-integrity.js";
import { RECOMMENDATION_LIMITS } from "./recommendation-limits.js";

function readStore(dataDir, fileName, { optional = false, fallback } = {}) {
  const filePath = path.join(dataDir, fileName);
  if (path.dirname(filePath) !== dataDir) throw new Error(`Unsafe snapshot file path: ${fileName}`);
  if (!fs.existsSync(filePath)) {
    if (optional) return structuredClone(fallback);
    throw new Error(`Snapshot is missing ${fileName}`);
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("must be a regular non-link file");
    }
    if (stat.size > MAX_JSON_STORE_BYTES) {
      throw new Error(`exceeds the ${MAX_JSON_STORE_BYTES}-byte safety limit`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Snapshot contains invalid JSON in ${fileName}: ${error.message}`);
  }
}

function validateVerifiedCandidateStore(store, now) {
  const nowMs = currentTimeMs(now, "verified candidate snapshot");
  if (!store || store.version !== 1 || !Array.isArray(store.candidates)
      || store.candidates.length > RECOMMENDATION_LIMITS.activeCandidates) {
    throw new Error(
      `verified candidate snapshot must use version 1 with at most ${RECOMMENDATION_LIMITS.activeCandidates} candidates`
    );
  }
  const catalog = store.catalog ?? [];
  if (!Array.isArray(catalog) || catalog.length > RECOMMENDATION_LIMITS.candidateCatalog) {
    throw new Error(
      `verified candidate snapshot catalog must contain at most ${RECOMMENDATION_LIMITS.candidateCatalog} candidates`
    );
  }
  let generatedAt = null;
  let catalogUpdatedAt = null;
  if (store.candidates.length > 0 || catalog.length > 0) {
    generatedAt = timestampMs(store.generatedAt, {
      label: "verified candidate snapshot generation",
      now: new Date(nowMs)
    });
    catalogUpdatedAt = timestampMs(store.catalogUpdatedAt || store.generatedAt, {
      label: "verified candidate snapshot catalog update",
      now: new Date(nowMs)
    });
    if (catalogUpdatedAt < generatedAt) {
      throw new Error("verified candidate snapshot catalog update predates its generation");
    }
    const target = store.target;
    if (!target || target.name !== config.locationName
        || !Number.isFinite(target.latitude)
        || !Number.isFinite(target.longitude)
        || !Number.isFinite(target.maxDistanceKm)
        || Math.abs(target.latitude - config.targetLatitude) > 1e-7
        || Math.abs(target.longitude - config.targetLongitude) > 1e-7
        || Math.abs(target.maxDistanceKm - config.researchDistanceKm) > 1e-7) {
      throw new Error("verified candidate snapshot target does not match the runtime location contract");
    }
  }
  const activeIds = new Set();
  for (const candidate of store.candidates) {
    for (const [field, label] of [
      ["priceCheckedAt", "price check"],
      ["deliveryCheckedAt", "delivery check"],
      ["evidenceVerifiedAt", "evidence verification"]
    ]) {
      if (candidate?.[field] !== undefined) {
        timestampMs(candidate[field], {
          label: `verified candidate snapshot ${label}`,
          now: new Date(generatedAt)
        });
      }
    }
    const normalized = normalizeVerifiedCandidate(candidate, { now });
    if (!normalized || !hasCurrentDeterministicEvidence(candidate, { now })) {
      throw new Error(`verified candidate snapshot contains an invalid active candidate: ${candidate?.restaurant || "unknown"}`);
    }
    if (activeIds.has(normalized.candidateId)) throw new Error("verified candidate snapshot contains duplicate active candidates");
    activeIds.add(normalized.candidateId);
  }
  const catalogIds = new Set();
  for (const candidate of catalog) {
    for (const [field, label] of [
      ["priceCheckedAt", "price check"],
      ["deliveryCheckedAt", "delivery check"],
      ["evidenceVerifiedAt", "evidence verification"]
    ]) {
      if (candidate?.[field] !== undefined) {
        timestampMs(candidate[field], {
          label: `verified candidate catalog ${label}`,
          now: new Date(catalogUpdatedAt)
        });
      }
    }
    const normalized = normalizeVerifiedCandidate(candidate, {
      now: new Date(nowMs),
      priceTtlDays: 3650,
      deliveryTtlDays: 3650
    });
    if (!normalized) throw new Error(`verified candidate catalog contains an invalid candidate: ${candidate?.restaurant || "unknown"}`);
    if (catalogIds.has(normalized.candidateId)) throw new Error("verified candidate catalog contains duplicate candidates");
    catalogIds.add(normalized.candidateId);
  }
  return { candidateCount: store.candidates.length, catalogCount: catalog.length };
}

export function validateOperatingSnapshotDirectory(inputDirectory, { now = new Date() } = {}) {
  const dataDir = path.resolve(inputDirectory);
  const dataDirStat = fs.lstatSync(dataDir);
  if (!dataDirStat.isDirectory() || dataDirStat.isSymbolicLink()) {
    throw new Error("Operating snapshot path must be a regular non-link directory");
  }

  const history = readStore(dataDir, "recommendation-history.json");
  const sentMessages = readStore(dataDir, "sent-messages.json");
  const mealEvents = readStore(dataDir, "meal-events.json");
  const verifiedCandidates = readStore(dataDir, "verified-candidates.json");
  const candidatePreferences = readStore(dataDir, "candidate-preferences.json");
  const coffeeParticipation = readStore(dataDir, "coffee-participation.json");
  const deliveryOutbox = readStore(dataDir, "delivery-outbox.json", {
    optional: true,
    fallback: { version: 1, deliveries: [] }
  });

  const counts = {
    history: validateRecommendationHistoryStore(history, { now }),
    sentMessages: validateSentMessageStore(sentMessages, { now }),
    mealEvents: validateMealEventStore(mealEvents, { now }),
    verifiedCandidates: validateVerifiedCandidateStore(verifiedCandidates, now),
    candidatePreferences: validateCandidatePreferenceStore(candidatePreferences, { now }),
    coffeeParticipation: validateCoffeeParticipationStore(coffeeParticipation, { now }),
    deliveryOutbox: validateDeliveryOutboxStore(deliveryOutbox, { now })
  };
  const audit = auditRecommendationData({
    history,
    sentMessages,
    candidatePreferences,
    now,
    policyEnforcementSince: config.policyEnforcementSince,
    // Reconciliation deliberately validates point-in-time snapshots. A
    // snapshot captured before a newly announced diversity policy cannot be
    // judged against that future policy, while current production snapshots
    // must enforce it in full. Direct audit callers still reject an accidental
    // future cutoff, so this exception is confined to historical snapshots.
    choiceDiversityEnforcementSince:
      Date.parse(config.choiceDiversityEnforcementSince) <= now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS
        ? config.choiceDiversityEnforcementSince
        : null,
    preferenceHistoryRetentionDays: config.historyRetentionDays
  });
  if (auditHasIntegrityFailure(audit)) {
    throw new Error("Operating snapshot failed cross-store recommendation integrity");
  }
  return { version: 1, dataDir, counts, audit };
}
