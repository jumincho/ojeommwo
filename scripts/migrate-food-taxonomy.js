import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import { validateOperatingSnapshotDirectory } from "../src/operating-snapshot.js";
import { readJsonAt, writeJsonAt } from "../src/storage.js";
import { migrateTaxonomyStores } from "../src/taxonomy-migration.js";

const argumentsList = process.argv.slice(2);
const allowedFlags = new Set(["--apply", "--dry-run", "--data-dir", "--externally-fenced"]);
const values = new Map();
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (!allowedFlags.has(argument)) throw new Error(`Unknown argument: ${argument}`);
  if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
  if (argument === "--data-dir") {
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--data-dir requires a path");
    values.set(argument, value);
    index += 1;
  } else {
    values.set(argument, true);
  }
}
if (values.has("--apply") && values.has("--dry-run")) {
  throw new Error("--apply and --dry-run cannot be combined");
}

const apply = values.has("--apply");
const externallyFenced = values.has("--externally-fenced");
if (externallyFenced && !apply) {
  throw new Error("--externally-fenced requires --apply");
}
const dataDir = path.resolve(values.get("--data-dir") || DATA_DIR);
const storeFiles = Object.freeze({
  recommendations: "recommendations.json",
  recommendationHistory: "recommendation-history.json",
  sentMessages: "sent-messages.json",
  mealEvents: "meal-events.json",
  candidatePreferences: "candidate-preferences.json",
  verifiedCandidates: "verified-candidates.json",
});
const originalStores = Object.fromEntries(Object.entries(storeFiles).map(([key, fileName]) => [
  key,
  readJsonAt(dataDir, fileName, key === "recommendations" ? [] : undefined),
]));
const migrated = migrateTaxonomyStores(originalStores);

function writeStoreSet(targetDir, stores) {
  for (const [key, fileName] of Object.entries(storeFiles)) {
    writeJsonAt(targetDir, fileName, stores[key], { synchronizeBackup: true });
  }
}

function validateStagedStores(stores) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-taxonomy-"));
  try {
    for (const fileName of ["coffee-participation.json", "delivery-outbox.json"]) {
      const source = path.join(dataDir, fileName);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, fileName));
    }
    writeStoreSet(stage, stores);
    validateOperatingSnapshotDirectory(stage, { now: new Date() });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

validateStagedStores(migrated.stores);

if (apply) {
  const maintenancePath = path.join(dataDir, ".operating-maintenance");
  let markerOwned = false;
  const fenceToken = externallyFenced
    ? String(process.env.OJEOMMWO_MAINTENANCE_TOKEN || "")
    : "";
  if (externallyFenced && !/^[a-f0-9]{32}$/u.test(fenceToken)) {
    throw new Error("Externally fenced taxonomy migration requires a valid maintenance token");
  }
  const backupDir = path.join(
    dataDir,
    "migration-backups",
    externallyFenced
      ? `taxonomy-deploy-${fenceToken}`
      : `taxonomy-${new Date().toISOString().replace(/[:.]/gu, "-")}`
  );
  try {
    if (externallyFenced) {
      const stat = fs.lstatSync(maintenancePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Externally fenced maintenance marker is unsafe");
      }
      const marker = JSON.parse(fs.readFileSync(maintenancePath, "utf8"));
      if (marker?.version !== 1
        || marker?.operation !== "integrated-source-deployment"
        || marker?.token !== fenceToken) {
        throw new Error("Externally fenced maintenance marker does not match the deployment");
      }
    } else {
      const descriptor = fs.openSync(maintenancePath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({
        version: 1,
        operation: "food-taxonomy-migration",
        pid: process.pid,
        issuedAt: new Date().toISOString(),
      })}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      markerOwned = true;
      const activeLocks = Object.values(storeFiles)
        .map((fileName) => path.join(dataDir, `${fileName}.lock`))
        .filter((fileName) => fs.existsSync(fileName));
      if (activeLocks.length) {
        throw new Error(`Operating store lock is active: ${path.basename(activeLocks[0])}`);
      }
    }

    // The initial plan is computed before a standalone fence is acquired.
    // A user response arriving in that interval must never be overwritten.
    for (const [key, fileName] of Object.entries(storeFiles)) {
      const current = readJsonAt(dataDir, fileName, key === "recommendations" ? [] : undefined);
      if (JSON.stringify(current) !== JSON.stringify(originalStores[key])) {
        throw new Error(`Taxonomy migration source changed before commit: ${fileName}; retry from current data`);
      }
    }
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (const fileName of Object.values(storeFiles)) {
      for (const suffix of ["", ".bak"]) {
        const source = path.join(dataDir, `${fileName}${suffix}`);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupDir, `${fileName}${suffix}`));
      }
    }
    writeStoreSet(dataDir, migrated.stores);
    validateOperatingSnapshotDirectory(dataDir, { now: new Date() });
  } catch (error) {
    if (fs.existsSync(backupDir)) {
      for (const fileName of Object.values(storeFiles)) {
        const source = path.join(backupDir, fileName);
        if (!fs.existsSync(source)) continue;
        const original = JSON.parse(fs.readFileSync(source, "utf8"));
        writeJsonAt(dataDir, fileName, original, { synchronizeBackup: true });
      }
    }
    throw error;
  } finally {
    if (markerOwned) fs.rmSync(maintenancePath, { force: true });
  }
  console.log(`[taxonomy-migration] applied; recovery snapshot: ${backupDir}`);
} else {
  console.log("[taxonomy-migration] dry run; no files changed");
}

console.log(JSON.stringify({
  dataDir,
  droppedMessageKeys: migrated.droppedMessageKeys,
  ...migrated.report,
}, null, 2));
