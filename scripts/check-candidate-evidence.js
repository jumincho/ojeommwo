import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterCandidatesEligibleThroughNextSend,
  filterResearchCooldownEligible,
  hasViableRecommendationSet,
  mergeCandidateCatalog
} from "../src/candidate-research.js";
import { verifyCandidateResearchEvidence } from "../src/candidate-evidence.js";
import { readJson } from "../src/storage.js";

export function evidenceCheckHasReadiness(candidates, recommendationCount = 3) {
  return hasViableRecommendationSet(
    Array.isArray(candidates) ? candidates : [],
    recommendationCount
  );
}

export async function runCandidateEvidenceCheck({
  now = new Date(),
  loadStore = () => readJson("verified-candidates.json", {
    version: 1,
    candidates: [],
    catalog: []
  }),
  verify = verifyCandidateResearchEvidence,
  log = console.log
} = {}) {
  const store = loadStore();
  const candidates = mergeCandidateCatalog(
    Array.isArray(store.catalog) ? store.catalog : [],
    Array.isArray(store.candidates) ? store.candidates : []
  );
  const cooldownEligible = filterResearchCooldownEligible(candidates, { now });
  const diagnostics = [];
  const verified = await verify(cooldownEligible, { now, diagnostics });
  const eligible = filterCandidatesEligibleThroughNextSend(verified, { now });
  const viableRecommendationSet = evidenceCheckHasReadiness(eligible);
  const rejectionReasons = Object.fromEntries(
    [...diagnostics.reduce((counts, item) => {
      const reason = String(item?.reason || "unknown");
      counts.set(reason, (counts.get(reason) || 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right, "en"))
  );
  const report = {
    checkedAt: now.toISOString(),
    cooldownEligible: cooldownEligible.length,
    evidenceVerified: verified.length,
    nextSendEligible: eligible.length,
    viableRecommendationSet,
    rejectionReasons,
    candidates: eligible.map((candidate) => ({
      category: candidate.category,
      restaurant: candidate.restaurant,
      branch: candidate.branch,
      menu: candidate.menu,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      priceEvidenceUrl: candidate.priceEvidenceUrl,
      deliveryEvidenceUrl: candidate.deliveryEvidenceUrl
    }))
  };
  log(JSON.stringify(report, null, 2));
  if (!viableRecommendationSet) {
    throw new Error(
      `Candidate evidence check found ${eligible.length} next-send candidates and no viable three-menu set`
    );
  }
  return report;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCandidateEvidenceCheck().catch((error) => {
    console.error(`[candidate-evidence-check] FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
