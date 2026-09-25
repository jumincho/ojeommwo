import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimeConfig } from "../src/config.js";
import { refreshVerifiedCandidates } from "../src/candidate-research.js";

export function parseCandidateRefreshArgs(args = []) {
  if (!Array.isArray(args)) throw new Error("Candidate refresh arguments must be an array");
  const parsed = { dryRun: false, force: false, exploreNewRestaurants: false, requiredReadySets: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--force" || argument === "--explore") {
      if (seen.has(argument)) throw new Error(`Duplicate candidate refresh argument: ${argument}`);
      seen.add(argument);
      parsed[argument === "--dry-run" ? "dryRun" : argument === "--force" ? "force" : "exploreNewRestaurants"] = true;
      continue;
    }
    if (argument === "--required-ready-sets") {
      if (seen.has(argument)) throw new Error(`Duplicate candidate refresh argument: ${argument}`);
      seen.add(argument);
      const value = args[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error("--required-ready-sets requires 1 or 2");
      }
      if (!/^[12]$/u.test(String(value))) throw new Error("--required-ready-sets must be 1 or 2");
      parsed.requiredReadySets = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown candidate refresh argument: ${argument}`);
  }
  return parsed;
}

export async function runCandidateRefreshCli({
  args = process.argv.slice(2),
  assertConfig = assertRuntimeConfig,
  refresh = refreshVerifiedCandidates,
  log = console.log
} = {}) {
  const options = parseCandidateRefreshArgs(args);
  assertConfig({ dryRun: true, requireBotToken: false });
  const result = await refresh(options);
  if (result.skipped) {
    log(`[candidate-refresh] skipped reason=${result.skipReason} eligible=${result.eligibleCount}`);
  } else {
    log(
      `[candidate-refresh] ${options.dryRun ? "validated" : "saved"} ${result.candidates.length} candidates `
      + `at ${result.generatedAt} source=${result.refreshSource || "model"}`
    );
    if (result.explorationStatus && result.explorationStatus !== "not-requested") {
      log(`[candidate-refresh] exploration=${result.explorationStatus} new=${result.exploredCandidateCount || 0}`);
      if (result.explorationDiagnostics) log(`[candidate-refresh] discovery=${JSON.stringify(result.explorationDiagnostics)}`);
    }
  }
  return result;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await runCandidateRefreshCli();
