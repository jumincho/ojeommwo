#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOT_ROOT } from "./lib/bot-contract.mjs";
import { buildSnapshot, writeSnapshotAtomic } from "./lib/observatory-snapshot.mjs";
import { validateSnapshot } from "./lib/snapshot-schema.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

const dataDir = path.resolve(option(
  "--data-dir",
  process.env.OJEOMMWO_DATA_DIR || path.resolve(BOT_ROOT, "data"),
));
const outputPath = path.resolve(option("--output", path.join(projectRoot, "public", "data", "snapshot.json")));
const generatedAt = option("--generated-at", new Date().toISOString());
const snapshot = validateSnapshot(buildSnapshot({ dataDir, generatedAt }));
const written = writeSnapshotAtomic(snapshot, outputPath);

process.stdout.write(
  `snapshot-v${snapshot.schemaVersion}: ${snapshot.stats.menus} menus, `
  + `${snapshot.stats.restaurants} restaurants, ${snapshot.stats.recommendationMessages} messages -> ${written}\n`,
);
