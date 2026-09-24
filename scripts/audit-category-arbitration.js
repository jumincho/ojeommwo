import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditCategoryArbitrationStores } from "../src/category-arbitration.js";
import { readJson } from "../src/storage.js";

export function categoryArbitrationAudit({
  verifiedCandidates = readJson("verified-candidates.json", { version: 1, candidates: [], catalog: [] }),
  recommendationHistory = readJson("recommendation-history.json", { version: 1, items: [] }),
  candidatePreferences = readJson("candidate-preferences.json", { version: 1, responses: [] }),
} = {}) {
  return auditCategoryArbitrationStores({
    verifiedCandidates,
    recommendationHistory,
    candidatePreferences,
  });
}

export function main(argv = process.argv.slice(2)) {
  const allowed = new Set(["--strict"]);
  if (argv.some((item) => !allowed.has(item)) || new Set(argv).size !== argv.length) {
    throw new Error("Usage: node scripts/audit-category-arbitration.js [--strict]");
  }
  const report = categoryArbitrationAudit();
  console.log(JSON.stringify(report, null, 2));
  if (argv.includes("--strict")
      && Object.values(report).some((group) => group.unresolved.length > 0)) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[category-audit] ${error.message}`);
    process.exitCode = 1;
  }
}
