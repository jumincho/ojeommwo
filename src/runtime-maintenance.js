import fs from "node:fs";
import path from "node:path";
import { config, ROOT_DIR } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_PATTERN = /^(?:scheduled-(?:lunch|dinner|meal)-|candidate-refresh-|codex-auth-check-|research-|local-emergency-|socket-bot-|interaction-listener-).+\.log$/u;
const CODEX_RUN_PATTERN = /^(?:(?:meal|meal-normalization|candidate-refresh|auth-check|research)-.+|\d{4}-\d{2}-\d{2}T.+)(?:-prompt\.txt|-output\.json|\.log)$/u;
const ENV_TEMP_PATTERN = /^\.env\.\d+\.\d+\.tmp$/u;
const DATA_TEMP_PATTERN = /^[A-Za-z0-9._-]+\.json\.\d+\.\d+\.tmp$/u;

function timestampFromArtifactName(name) {
  const compact = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/u);
  if (compact) {
    return Date.UTC(
      Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]),
      Number(compact[4]), Number(compact[5]), Number(compact[6])
    );
  }

  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z)?/u);
  if (!iso) return Number.NaN;
  return Date.UTC(
    Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
    Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0), Number(iso[7] ?? 0)
  );
}

function pruneDirectory(directory, pattern, cutoff, { dryRun }) {
  if (!fs.existsSync(directory)) return { scanned: 0, removed: 0, bytes: 0 };
  let scanned = 0;
  let removed = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    scanned += 1;
    const namedTimestamp = timestampFromArtifactName(entry.name);
    const artifactTimeMs = Number.isFinite(namedTimestamp) ? namedTimestamp : stat.mtimeMs;
    if (artifactTimeMs >= cutoff) continue;
    removed += 1;
    bytes += stat.size;
    if (!dryRun) fs.rmSync(filePath, { force: true });
  }
  return { scanned, removed, bytes };
}

export function pruneRuntimeArtifacts({
  rootDir = ROOT_DIR,
  now = new Date(),
  dryRun = false,
  logRetentionDays = config.runtimeLogRetentionDays,
  codexRunRetentionDays = config.codexRunRetentionDays
} = {}) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Runtime maintenance requires a valid date");
  const logs = pruneDirectory(
    path.join(rootDir, "logs"),
    LOG_PATTERN,
    nowMs - logRetentionDays * DAY_MS,
    { dryRun }
  );
  const codexRuns = pruneDirectory(
    path.join(rootDir, "data", "codex-cli-runs"),
    CODEX_RUN_PATTERN,
    nowMs - codexRunRetentionDays * DAY_MS,
    { dryRun }
  );
  const envTemps = pruneDirectory(rootDir, ENV_TEMP_PATTERN, nowMs - DAY_MS, { dryRun });
  const dataTemps = pruneDirectory(path.join(rootDir, "data"), DATA_TEMP_PATTERN, nowMs - DAY_MS, { dryRun });
  const temporaryFiles = {
    scanned: envTemps.scanned + dataTemps.scanned,
    removed: envTemps.removed + dataTemps.removed,
    bytes: envTemps.bytes + dataTemps.bytes
  };
  return {
    dryRun,
    retentionDays: { logs: logRetentionDays, codexRuns: codexRunRetentionDays },
    logs,
    codexRuns,
    temporaryFiles,
    totalRemoved: logs.removed + codexRuns.removed + temporaryFiles.removed,
    totalBytes: logs.bytes + codexRuns.bytes + temporaryFiles.bytes
  };
}
