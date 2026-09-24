import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../src/config.js";
import { mergeEnvText, parseEnvUpdates } from "../src/env-file.js";
import { replaceSensitiveTextFile } from "../src/secure-file.js";

const ALLOWED_KEYS = new Set([
  "SLACK_APP_TOKEN", "ENABLE_MEAL_FEEDBACK", "INTERACTION_RECONNECT_MAX_MS",
  "RECOMMENDATION_MODE", "ENABLE_SCHEDULE", "CODEX_CLI_SANDBOX", "CODEX_CLI_USE_SEARCH",
  "CODEX_CLI_FALLBACK_TO_CACHE",
  "ENABLE_OBSERVATORY_LINK", "OBSERVATORY_URL", "OBSERVATORY_URL_FILE",
  "OPERATIONS_ALERT_CHANNEL_ID",
  "CODEX_CLI_MODEL", "CODEX_CLI_REASONING_EFFORT", "CODEX_CLI_TIMEOUT_MS",
  "CODEX_CLI_ISOLATE_LINUX", "CODEX_CLI_ISOLATION_UID", "CODEX_CLI_ISOLATION_GID",
  "ALLOW_UNVERIFIED_FALLBACK", "POLICY_ENFORCEMENT_SINCE",
  "RUNTIME_LOG_RETENTION_DAYS", "CODEX_RUN_RETENTION_DAYS",
  "TARGET_LATITUDE", "TARGET_LONGITUDE", "RESEARCH_DISTANCE_KM", "RESEARCH_PRICE_TTL_DAYS",
  "RESEARCH_DELIVERY_TTL_DAYS", "RESEARCH_MIN_CANDIDATES", "RESEARCH_CODEX_TIMEOUT_MS",
  "MEAL_EVENT_RETENTION_DAYS", "TASTE_EXPLORATION_RATE", "TASTE_HALF_LIFE_DAYS", "TASTE_PRIOR_ALPHA", "WEATHER_ENABLED",
  "CANDIDATE_PREFERENCE_WEIGHT", "CANDIDATE_PREFERENCE_RETENTION_DAYS", "COFFEE_PARTICIPATION_RETENTION_DAYS",
  "MEAL_NORMALIZATION_ENABLED", "MEAL_NORMALIZATION_TIMEOUT_MS", "MEAL_NORMALIZATION_MAX_ATTEMPTS", "MEAL_NORMALIZATION_RETRY_INTERVAL_MS",
  "WEATHER_FETCH_TIMEOUT_MS", "WEATHER_RAIN_THRESHOLD_PERCENT",
  "WEATHER_PM10_THRESHOLD", "WEATHER_PM25_THRESHOLD", "PUBLIC_DATA_SERVICE_KEY", "AIRKOREA_STATION_NAME"
]);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const updates = parseEnvUpdates(Buffer.concat(chunks).toString("utf8"), ALLOWED_KEYS);
if (!updates.size) throw new Error("No environment updates were provided");

const envPath = path.join(ROOT_DIR, ".env");
const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
replaceSensitiveTextFile(envPath, mergeEnvText(current, updates));
console.log(`[env] updated keys: ${[...updates.keys()].join(", ")}`);
