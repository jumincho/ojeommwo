import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import { assessLocalEmergencyReadiness } from "../src/local-emergency-readiness.js";
import { getKstParts, loadHolidayDates } from "../src/scheduler.js";

function parseArguments(argv) {
  const values = new Map();
  const supported = new Set(["--lease-expires-at", "--current-meal", "--data-dir", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!supported.has(option)) throw new Error(`unknown argument: ${option}`);
    if (values.has(option)) throw new Error(`${option} may be specified only once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    values.set(option, value);
    index += 1;
  }
  if (!values.has("--lease-expires-at")) throw new Error("--lease-expires-at is required");
  return values;
}

function readStore(dataDir, fileName, property) {
  const filePath = path.join(dataDir, fileName);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed[property])) {
    throw new Error(`${fileName} must contain a ${property} array`);
  }
  return parsed;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const now = args.has("--now") ? new Date(args.get("--now")) : new Date();
  const expiresAt = new Date(args.get("--lease-expires-at"));
  const currentMeal = String(args.get("--current-meal") || "").trim().toLowerCase();
  const dataDir = path.resolve(args.get("--data-dir") || DATA_DIR);
  if (!Number.isFinite(now.getTime())) throw new Error("--now must be a valid timestamp");
  if (!fs.statSync(dataDir).isDirectory()) throw new Error("--data-dir must be a directory");
  const holidayPath = path.join(DATA_DIR, "holiday-skip-dates.json");
  const holidayDates = loadHolidayDates(holidayPath, {
    requiredYear: getKstParts(now).dateKey.slice(0, 4)
  });
  const verifiedStore = readStore(dataDir, "verified-candidates.json", "candidates");
  const history = readStore(dataDir, "recommendation-history.json", "items");
  const mealEvents = readStore(dataDir, "meal-events.json", "events");
  const report = assessLocalEmergencyReadiness({
    now,
    expiresAt,
    holidayDates,
    currentMeal,
    verifiedCandidates: verifiedStore.candidates,
    history,
    mealEvents
  });
  if (!report.ready) throw new Error(report.detail);
  console.log(`[local-emergency-readiness] PASS: ${report.detail}`);
  for (const slot of report.slots) {
    console.log(`[local-emergency-readiness] ${slot.meal} ${slot.at}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[local-emergency-readiness] FAIL: ${error?.message || error}`);
  process.exitCode = 1;
}
