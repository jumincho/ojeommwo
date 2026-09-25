import fs from "node:fs";
import path from "node:path";
import { BOT_ROOT } from "../../scripts/lib/bot-contract.mjs";
import { SNAPSHOT_INPUT_FILES, buildSnapshot } from "../../scripts/lib/observatory-snapshot.mjs";

export const operatingDataDirectory = path.resolve(process.env.OJEOMMWO_DATA_DIR || path.join(BOT_ROOT, "data"));
export const hasOperatingData = [...SNAPSHOT_INPUT_FILES, "coffee-participation.json", "delivery-outbox.json"]
  .every((name) => fs.existsSync(path.join(operatingDataDirectory, name)));

// Unit tests in a source-only checkout use the already sanitized public sample.
// Production verification still executes the complete live-store integration suite.
export function testSnapshot(generatedAt = new Date().toISOString()) {
  if (hasOperatingData) return buildSnapshot({ dataDir: operatingDataDirectory, generatedAt });
  if (process.env.OJEOMMWO_DATA_DIR) throw new Error("Explicit test operating data is incomplete");
  return JSON.parse(fs.readFileSync(new URL("../../public/data/snapshot.json", import.meta.url), "utf8"));
}
