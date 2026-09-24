import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../src/config.js";
import { removeEnvKeys } from "../src/env-file.js";
import { replaceSensitiveTextFile } from "../src/secure-file.js";

const OBSOLETE_KEYS = new Set([
  "CODEX_RECOMMENDATIONS_MAX_AGE_HOURS",
  "LIVE_SEARCH_FETCH_TIMEOUT_MS",
  "LIVE_SEARCH_RESULTS_PER_QUERY",
  "LIVE_SEARCH_PAGES_PER_QUERY",
  "LIVE_SEARCH_RESTAURANT_CANDIDATES",
  "LIVE_SEARCH_MAX_CANDIDATES",
  "LIVE_SEARCH_ENABLE_PLATFORM_CHECKS",
  "LIVE_SEARCH_NAVER_DELAY_MS",
  "LIVE_SEARCH_CACHE_TTL_MINUTES",
  "NAVER_SEARCH_CLIENT_ID",
  "NAVER_SEARCH_CLIENT_SECRET",
  "WEATHER_PROVIDER",
  "WEATHER_UV_THRESHOLD"
]);

const envPath = path.join(ROOT_DIR, ".env");
if (!fs.existsSync(envPath)) throw new Error(`Environment file is missing: ${envPath}`);
const current = fs.readFileSync(envPath, "utf8");
const result = removeEnvKeys(current, OBSOLETE_KEYS);
if (result.removed.length > 0) {
  replaceSensitiveTextFile(envPath, result.text);
}
console.log(`[env] removed obsolete keys: ${result.removed.join(", ") || "none"}`);
