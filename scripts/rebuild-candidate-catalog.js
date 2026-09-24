import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import { mergeCandidateCatalog, updateVerifiedCandidateCatalog } from "../src/candidate-research.js";
import { readJson } from "../src/storage.js";

const argumentsList = process.argv.slice(2);
const allowed = new Set(["--apply", "--dry-run"]);
for (const argument of argumentsList) {
  if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
  if (argumentsList.filter((item) => item === argument).length > 1) {
    throw new Error(`Duplicate argument: ${argument}`);
  }
}
if (argumentsList.includes("--apply") && argumentsList.includes("--dry-run")) {
  throw new Error("--apply and --dry-run cannot be combined");
}
const apply = argumentsList.includes("--apply");
const runDir = path.join(DATA_DIR, "codex-cli-runs");
const historicalCandidates = [];

if (fs.existsSync(runDir)) {
  for (const name of fs.readdirSync(runDir)) {
    if (!/(?:candidate-refresh|research).*?-output\.json$/u.test(name)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(runDir, name), "utf8"));
      if (Array.isArray(parsed?.candidates)) historicalCandidates.push(...parsed.candidates);
    } catch {
      // A corrupt or legacy-incompatible artifact is not a trustworthy seed.
    }
  }
}

let catalog;
if (apply) {
  const saved = updateVerifiedCandidateCatalog(historicalCandidates, {
    now: new Date(),
    includeActiveCandidates: true
  });
  catalog = saved.catalog;
} else {
  const store = readJson("verified-candidates.json", { version: 1, candidates: [], catalog: [] });
  catalog = mergeCandidateCatalog(
    Array.isArray(store.catalog) ? store.catalog : [],
    [...(Array.isArray(store.candidates) ? store.candidates : []), ...historicalCandidates]
  );
}
console.log(
  `[candidate-catalog] ${apply ? "saved" : "validated without changes"} ${catalog.length} seeds `
  + `from ${historicalCandidates.length} historical candidates`
);
