import fs from "node:fs";
import path from "node:path";
import { mergeCandidateCatalog, updateVerifiedCandidateCatalog } from "../src/candidate-research.js";
import { verifyCandidateResearchEvidence } from "../src/candidate-evidence.js";
import { readJson } from "../src/storage.js";
import { candidateIdFor } from "../src/verified-candidates.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const inputArg = args.find((arg) => !arg.startsWith("--"));

if (!inputArg) {
  throw new Error("Usage: node scripts/add-candidate-catalog-seeds.js <candidate-json> [--apply]");
}

const inputPath = path.resolve(inputArg);
const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const supplied = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.candidates) ? parsed.candidates : [parsed];
if (supplied.length < 1 || supplied.length > 12) {
  throw new Error("Candidate catalog seed input must contain 1-12 candidates");
}

const now = new Date();
const verified = await verifyCandidateResearchEvidence(supplied, { now });
if (verified.length !== supplied.length) {
  const acceptedIds = new Set(verified.map(candidateIdFor));
  const rejected = supplied
    .filter((candidate) => !acceptedIds.has(candidateIdFor(candidate)))
    .map((candidate) => `${String(candidate?.restaurant || "?").slice(0, 60)}/${String(candidate?.menu || "?").slice(0, 80)}`);
  throw new Error(
    `Candidate catalog seed verification rejected ${supplied.length - verified.length} of ${supplied.length} `
    + `(${rejected.join(", ")}); no data changed.`
  );
}

let catalog;
if (apply) {
  catalog = updateVerifiedCandidateCatalog(verified, { now }).catalog;
} else {
  const store = readJson("verified-candidates.json", { version: 1, candidates: [], catalog: [] });
  catalog = mergeCandidateCatalog(
    Array.isArray(store.catalog) ? store.catalog : [],
    verified
  );
}

console.log(JSON.stringify({
  applied: apply,
  checkedAt: now.toISOString(),
  verifiedSeeds: verified.length,
  catalogSize: catalog.length,
  candidates: verified.map((candidate) => ({
    category: candidate.category,
    restaurant: candidate.restaurant,
    branch: candidate.branch,
    menu: candidate.menu,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    evidenceVerification: candidate.evidenceVerification
  }))
}, null, 2));
