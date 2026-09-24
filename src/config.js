import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OBSERVATORY_URL, normalizeObservatoryUrl } from "./observatory-link.js";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const DEFAULT_OBSERVATORY_URL_FILE = path.join(ROOT_DIR, "observatory", "runtime", "public-url.txt");
export const DEFAULT_CODEX_CLI_AUTH_PATH = path.join(
  path.dirname(ROOT_DIR),
  ".ojeommwo-v2-state",
  "codex",
  "auth.json"
);
export const RECOMMENDATION_MODES = Object.freeze(["codex-cli", "cache", "static"]);
export const CODEX_SANDBOX_MODES = Object.freeze(["read-only"]);
export const REQUIRED_CODEX_MODEL = "gpt-6-luna";
export const REQUIRED_CODEX_REASONING_EFFORT = "xhigh";
export const VERIFIED_NORMALIZATION_REASONING_EFFORTS = Object.freeze(["medium", "high", "xhigh"]);
export const VERIFIED_NORMALIZATION_MODELS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-6-luna"
]);
export const REQUIRED_TASTE_EXPLORATION_RATE = 0.18;
export const REQUIRED_TASTE_HALF_LIFE_DAYS = 180;
export const REQUIRED_TASTE_PRIOR_ALPHA = 3;
export const REQUIRED_CANDIDATE_PREFERENCE_WEIGHT = 0.9;
export const REQUIRED_LUNCH_CHANNEL_ID = "C0123456789";
export const REQUIRED_OPERATOR_DM_CHANNEL_ID = "D0123456789";
export const REQUIRED_POLICY_ENFORCEMENT_SINCE = "2026-07-12T00:00:00+09:00";
// This semantic window preserves earlier immutable sends while enforcing the
// audited protein rules for current recommendations.
export const REQUIRED_CHOICE_DIVERSITY_ENFORCEMENT_SINCE = "2026-08-21T00:00:00+09:00";
export const PRODUCTION_TIMEZONE = "Asia/Seoul";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const parsed = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }

  return parsed;
}

// Tests must be hermetic: they may supply explicit process variables, but they
// must never read production credentials or depend on the production .env ACL.
const fileEnv = process.env.NODE_ENV === "test"
  ? {}
  : parseEnvFile(path.join(ROOT_DIR, ".env"));

function env(name, fallback = "") {
  return process.env[name] ?? fileEnv[name] ?? fallback;
}

function boolEnv(name, fallback = false) {
  const value = env(name, String(fallback)).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean value`);
}

function intEnv(name, fallback) {
  const raw = env(name, String(fallback)).trim();
  if (!raw) return fallback;
  if (!/^[+-]?\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function floatEnv(name, fallback) {
  const raw = env(name, String(fallback)).trim();
  if (!raw) return fallback;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw)) {
    throw new Error(`${name} must be a number`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function pathEnv(name, fallback) {
  const raw = env(name, fallback).trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT_DIR, raw);
}

function normalizedPathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function urlFromFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("OBSERVATORY_URL_FILE must point to a regular file");
  if (stat.size > 4096) throw new Error("OBSERVATORY_URL_FILE cannot exceed 4096 bytes");
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (/\r|\n/u.test(raw)) throw new Error("OBSERVATORY_URL_FILE must contain exactly one URL");
  return normalizeObservatoryUrl(raw);
}

const observatoryUrlFile = pathEnv(
  "OBSERVATORY_URL_FILE",
  DEFAULT_OBSERVATORY_URL_FILE
);
const liveObservatoryUrl = urlFromFile(observatoryUrlFile);

export const config = {
  slackBotToken: env("SLACK_BOT_TOKEN"),
  slackAppToken: env("SLACK_APP_TOKEN"),
  lunchChannelId: env("LUNCH_CHANNEL_ID", REQUIRED_LUNCH_CHANNEL_ID),
  operationsAlertChannelId: env("OPERATIONS_ALERT_CHANNEL_ID"),
  slackApiTimeoutMs: intEnv("SLACK_API_TIMEOUT_MS", 15000),
  enableMealFeedback: boolEnv("ENABLE_MEAL_FEEDBACK", false),
  enableObservatoryLink: boolEnv("ENABLE_OBSERVATORY_LINK", true),
  observatoryUrlFile,
  observatoryUrl: liveObservatoryUrl || env("OBSERVATORY_URL", DEFAULT_OBSERVATORY_URL),
  interactionReconnectMaxMs: intEnv("INTERACTION_RECONNECT_MAX_MS", 30000),
  enableSchedule: boolEnv("ENABLE_SCHEDULE", false),
  enableCleanup: boolEnv("ENABLE_CLEANUP", false),
  keepRecentMessages: intEnv("KEEP_RECENT_MESSAGES", 10),
  recommendationMode: env("RECOMMENDATION_MODE", "cache"),
  codexCliPath: env("CODEX_CLI_PATH"),
  codexCliAuthPath: pathEnv("CODEX_CLI_AUTH_PATH", DEFAULT_CODEX_CLI_AUTH_PATH),
  codexCliModel: env("CODEX_CLI_MODEL", REQUIRED_CODEX_MODEL),
  codexCliReasoningEffort: env("CODEX_CLI_REASONING_EFFORT", REQUIRED_CODEX_REASONING_EFFORT),
  codexCliSandbox: env("CODEX_CLI_SANDBOX", "read-only"),
  codexCliIsolateLinux: boolEnv("CODEX_CLI_ISOLATE_LINUX", true),
  codexCliIsolationUid: intEnv("CODEX_CLI_ISOLATION_UID", 65534),
  codexCliIsolationGid: intEnv("CODEX_CLI_ISOLATION_GID", 65534),
  codexCliTimeoutMs: intEnv("CODEX_CLI_TIMEOUT_MS", 180000),
  codexCliUseSearch: boolEnv("CODEX_CLI_USE_SEARCH", true),
  codexCliFallbackToCache: boolEnv("CODEX_CLI_FALLBACK_TO_CACHE", true),
  cacheFallbackMinCandidates: intEnv("CACHE_FALLBACK_MIN_CANDIDATES", 20),
  cacheHistoryMaxAgeDays: intEnv("CACHE_HISTORY_MAX_AGE_DAYS", 30),
  allowUnverifiedFallback: boolEnv("ALLOW_UNVERIFIED_FALLBACK", false),
  policyEnforcementSince: env("POLICY_ENFORCEMENT_SINCE", REQUIRED_POLICY_ENFORCEMENT_SINCE),
  choiceDiversityEnforcementSince: env(
    "CHOICE_DIVERSITY_ENFORCEMENT_SINCE",
    REQUIRED_CHOICE_DIVERSITY_ENFORCEMENT_SINCE
  ),
  runtimeLogRetentionDays: intEnv("RUNTIME_LOG_RETENTION_DAYS", 45),
  codexRunRetentionDays: intEnv("CODEX_RUN_RETENTION_DAYS", 30),
  timezone: env("TIMEZONE", PRODUCTION_TIMEZONE),
  locationName: env("LOCATION_NAME", "전북대학교 공과대학 7호관"),
  recommendationCount: intEnv("RECOMMENDATION_COUNT", 3),
  restaurantCooldownDays: intEnv("RESTAURANT_COOLDOWN_DAYS", 14),
  menuCooldownDays: intEnv("MENU_COOLDOWN_DAYS", 7),
  historyRetentionDays: intEnv("HISTORY_RETENTION_DAYS", 90),
  mealEventRetentionDays: intEnv("MEAL_EVENT_RETENTION_DAYS", 730),
  tasteExplorationRate: floatEnv("TASTE_EXPLORATION_RATE", REQUIRED_TASTE_EXPLORATION_RATE),
  tasteHalfLifeDays: intEnv("TASTE_HALF_LIFE_DAYS", REQUIRED_TASTE_HALF_LIFE_DAYS),
  tastePriorAlpha: intEnv("TASTE_PRIOR_ALPHA", REQUIRED_TASTE_PRIOR_ALPHA),
  candidatePreferenceWeight: floatEnv("CANDIDATE_PREFERENCE_WEIGHT", REQUIRED_CANDIDATE_PREFERENCE_WEIGHT),
  candidatePreferenceRetentionDays: intEnv("CANDIDATE_PREFERENCE_RETENTION_DAYS", 730),
  coffeeParticipationRetentionDays: intEnv("COFFEE_PARTICIPATION_RETENTION_DAYS", 30),
  mealNormalizationEnabled: boolEnv("MEAL_NORMALIZATION_ENABLED", true),
  mealNormalizationTimeoutMs: intEnv("MEAL_NORMALIZATION_TIMEOUT_MS", 240000),
  mealNormalizationMaxAttempts: intEnv("MEAL_NORMALIZATION_MAX_ATTEMPTS", 3),
  mealNormalizationRetryIntervalMs: intEnv("MEAL_NORMALIZATION_RETRY_INTERVAL_MS", 1800000),
  targetLatitude: floatEnv("TARGET_LATITUDE", 35.8461205),
  targetLongitude: floatEnv("TARGET_LONGITUDE", 127.1340012),
  researchDistanceKm: floatEnv("RESEARCH_DISTANCE_KM", 6),
  researchPriceTtlDays: intEnv("RESEARCH_PRICE_TTL_DAYS", 7),
  researchDeliveryTtlDays: intEnv("RESEARCH_DELIVERY_TTL_DAYS", 3),
  researchMinCandidates: intEnv("RESEARCH_MIN_CANDIDATES", 3),
  researchCodexTimeoutMs: intEnv("RESEARCH_CODEX_TIMEOUT_MS", 600000),
  weatherEnabled: boolEnv("WEATHER_ENABLED", false),
  weatherFetchTimeoutMs: intEnv("WEATHER_FETCH_TIMEOUT_MS", 15000),
  weatherRainThresholdPercent: intEnv("WEATHER_RAIN_THRESHOLD_PERCENT", 50),
  weatherPm10Threshold: floatEnv("WEATHER_PM10_THRESHOLD", 80),
  weatherPm25Threshold: floatEnv("WEATHER_PM25_THRESHOLD", 35),
  publicDataServiceKey: env("PUBLIC_DATA_SERVICE_KEY"),
  airKoreaStationName: env("AIRKOREA_STATION_NAME", "노송동")
};

function assertIntegerInRange(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

function assertNumberInRange(value, name, { min, max }) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
}

function assertBoolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

export function assertRecommendationMode(mode) {
  if (!RECOMMENDATION_MODES.includes(mode)) {
    throw new Error(`recommendation mode must be one of: ${RECOMMENDATION_MODES.join(", ")}`);
  }
  return mode;
}

export function validateRuntimeConfig(runtimeConfig, {
  dryRun = false,
  requireBotToken = !dryRun
} = {}) {
  const missing = [];
  if (requireBotToken && !runtimeConfig.slackBotToken) missing.push("SLACK_BOT_TOKEN");

  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.join(", ")}`);
  }

  if (runtimeConfig.slackBotToken && !runtimeConfig.slackBotToken.startsWith("xoxb-")) {
    throw new Error("SLACK_BOT_TOKEN must start with xoxb-");
  }
  if (runtimeConfig.slackAppToken && !runtimeConfig.slackAppToken.startsWith("xapp-")) {
    throw new Error("SLACK_APP_TOKEN must start with xapp-");
  }
  if (runtimeConfig.enableMealFeedback && !runtimeConfig.slackAppToken) {
    throw new Error("SLACK_APP_TOKEN is required when ENABLE_MEAL_FEEDBACK is enabled");
  }

  if (runtimeConfig.lunchChannelId !== REQUIRED_LUNCH_CHANNEL_ID) {
    throw new Error(`LUNCH_CHANNEL_ID must be the protected lunch channel ${REQUIRED_LUNCH_CHANNEL_ID}`);
  }
  if (runtimeConfig.operationsAlertChannelId !== REQUIRED_OPERATOR_DM_CHANNEL_ID) {
    throw new Error(`OPERATIONS_ALERT_CHANNEL_ID must be the protected operator DM ${REQUIRED_OPERATOR_DM_CHANNEL_ID}`);
  }

  assertRecommendationMode(runtimeConfig.recommendationMode);

  if (!CODEX_SANDBOX_MODES.includes(runtimeConfig.codexCliSandbox)) {
    throw new Error(`CODEX_CLI_SANDBOX must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`);
  }
  if (runtimeConfig.codexCliModel !== REQUIRED_CODEX_MODEL) {
    throw new Error(`CODEX_CLI_MODEL must be ${REQUIRED_CODEX_MODEL}`);
  }
  if (runtimeConfig.codexCliReasoningEffort !== REQUIRED_CODEX_REASONING_EFFORT) {
    throw new Error(`CODEX_CLI_REASONING_EFFORT must be ${REQUIRED_CODEX_REASONING_EFFORT}`);
  }
  if (!runtimeConfig.codexCliAuthPath || !path.isAbsolute(runtimeConfig.codexCliAuthPath)) {
    throw new Error("CODEX_CLI_AUTH_PATH must resolve to an absolute path");
  }
  if (path.basename(runtimeConfig.codexCliAuthPath) !== "auth.json") {
    throw new Error("CODEX_CLI_AUTH_PATH must name a dedicated auth.json file");
  }
  const interactiveCodexHome = path.join(os.homedir(), ".codex");
  if (isPathWithin(interactiveCodexHome, runtimeConfig.codexCliAuthPath)) {
    throw new Error("CODEX_CLI_AUTH_PATH must not use the interactive user's default Codex home");
  }
  if (isPathWithin(ROOT_DIR, runtimeConfig.codexCliAuthPath)) {
    throw new Error("CODEX_CLI_AUTH_PATH must be outside the deployable source tree");
  }
  if (normalizedPathIdentity(runtimeConfig.codexCliAuthPath)
      === normalizedPathIdentity(DEFAULT_OBSERVATORY_URL_FILE)) {
    throw new Error("CODEX_CLI_AUTH_PATH collides with Observatory state");
  }

  for (const [name, value] of [
    ["ENABLE_MEAL_FEEDBACK", runtimeConfig.enableMealFeedback],
    ["ENABLE_OBSERVATORY_LINK", runtimeConfig.enableObservatoryLink],
    ["ENABLE_SCHEDULE", runtimeConfig.enableSchedule],
    ["ENABLE_CLEANUP", runtimeConfig.enableCleanup],
    ["CODEX_CLI_ISOLATE_LINUX", runtimeConfig.codexCliIsolateLinux],
    ["CODEX_CLI_USE_SEARCH", runtimeConfig.codexCliUseSearch],
    ["CODEX_CLI_FALLBACK_TO_CACHE", runtimeConfig.codexCliFallbackToCache],
    ["ALLOW_UNVERIFIED_FALLBACK", runtimeConfig.allowUnverifiedFallback],
    ["MEAL_NORMALIZATION_ENABLED", runtimeConfig.mealNormalizationEnabled],
    ["WEATHER_ENABLED", runtimeConfig.weatherEnabled]
  ]) assertBoolean(value, name);
  if (runtimeConfig.enableSchedule) {
    throw new Error("ENABLE_SCHEDULE must remain false; production delivery authority is the fenced external cron path");
  }
  normalizeObservatoryUrl(runtimeConfig.observatoryUrl, { allowEmpty: !runtimeConfig.enableObservatoryLink });
  if (runtimeConfig.observatoryUrlFile && !path.isAbsolute(runtimeConfig.observatoryUrlFile)) {
    throw new Error("OBSERVATORY_URL_FILE must resolve to an absolute path");
  }
  if (!runtimeConfig.codexCliUseSearch) {
    throw new Error("CODEX_CLI_USE_SEARCH must be true for candidate discovery and meal normalization");
  }

  try {
    new Intl.DateTimeFormat("en", { timeZone: runtimeConfig.timezone }).format(new Date(0));
  } catch {
    throw new Error("TIMEZONE must be a valid IANA time zone");
  }

  assertIntegerInRange(runtimeConfig.slackApiTimeoutMs, "SLACK_API_TIMEOUT_MS", { min: 1000, max: 120000 });
  assertIntegerInRange(runtimeConfig.codexCliTimeoutMs, "CODEX_CLI_TIMEOUT_MS", { min: 1000, max: 1800000 });
  assertIntegerInRange(runtimeConfig.codexCliIsolationUid, "CODEX_CLI_ISOLATION_UID", { min: 1, max: 2147483647 });
  assertIntegerInRange(runtimeConfig.codexCliIsolationGid, "CODEX_CLI_ISOLATION_GID", { min: 1, max: 2147483647 });
  assertIntegerInRange(runtimeConfig.keepRecentMessages, "KEEP_RECENT_MESSAGES", { min: 0, max: 1000 });
  if (runtimeConfig.enableCleanup && runtimeConfig.keepRecentMessages < 1) {
    throw new Error("KEEP_RECENT_MESSAGES must be at least 1 when ENABLE_CLEANUP is enabled");
  }
  assertIntegerInRange(runtimeConfig.cacheFallbackMinCandidates, "CACHE_FALLBACK_MIN_CANDIDATES", { min: 3, max: 10000 });
  assertIntegerInRange(runtimeConfig.cacheHistoryMaxAgeDays, "CACHE_HISTORY_MAX_AGE_DAYS", { min: 1, max: 365 });
  assertIntegerInRange(runtimeConfig.recommendationCount, "RECOMMENDATION_COUNT", { min: 3, max: 3 });
  assertIntegerInRange(runtimeConfig.restaurantCooldownDays, "RESTAURANT_COOLDOWN_DAYS", { min: 0, max: 365 });
  assertIntegerInRange(runtimeConfig.menuCooldownDays, "MENU_COOLDOWN_DAYS", { min: 0, max: 365 });
  assertIntegerInRange(runtimeConfig.historyRetentionDays, "HISTORY_RETENTION_DAYS", { min: 1, max: 3650 });
  assertIntegerInRange(runtimeConfig.mealEventRetentionDays, "MEAL_EVENT_RETENTION_DAYS", { min: 30, max: 3650 });
  assertIntegerInRange(runtimeConfig.runtimeLogRetentionDays, "RUNTIME_LOG_RETENTION_DAYS", { min: 7, max: 3650 });
  assertIntegerInRange(runtimeConfig.codexRunRetentionDays, "CODEX_RUN_RETENTION_DAYS", { min: 7, max: 3650 });
  if (runtimeConfig.policyEnforcementSince !== REQUIRED_POLICY_ENFORCEMENT_SINCE) {
    throw new Error(`POLICY_ENFORCEMENT_SINCE must remain ${REQUIRED_POLICY_ENFORCEMENT_SINCE}`);
  }
  if (runtimeConfig.choiceDiversityEnforcementSince !== REQUIRED_CHOICE_DIVERSITY_ENFORCEMENT_SINCE) {
    throw new Error(
      `CHOICE_DIVERSITY_ENFORCEMENT_SINCE must remain ${REQUIRED_CHOICE_DIVERSITY_ENFORCEMENT_SINCE}`
    );
  }
  assertIntegerInRange(runtimeConfig.interactionReconnectMaxMs, "INTERACTION_RECONNECT_MAX_MS", { min: 1000, max: 300000 });
  assertNumberInRange(runtimeConfig.tasteExplorationRate, "TASTE_EXPLORATION_RATE", { min: 0, max: 1 });
  assertIntegerInRange(runtimeConfig.tasteHalfLifeDays, "TASTE_HALF_LIFE_DAYS", { min: 7, max: 3650 });
  assertIntegerInRange(runtimeConfig.tastePriorAlpha, "TASTE_PRIOR_ALPHA", { min: 3, max: 50 });
  assertNumberInRange(runtimeConfig.candidatePreferenceWeight, "CANDIDATE_PREFERENCE_WEIGHT", { min: 0, max: 1 });
  if (runtimeConfig.tasteExplorationRate !== REQUIRED_TASTE_EXPLORATION_RATE
    || runtimeConfig.tasteHalfLifeDays !== REQUIRED_TASTE_HALF_LIFE_DAYS
    || runtimeConfig.tastePriorAlpha !== REQUIRED_TASTE_PRIOR_ALPHA
    || runtimeConfig.candidatePreferenceWeight !== REQUIRED_CANDIDATE_PREFERENCE_WEIGHT) {
    throw new Error(
      `Taste contract must remain Beta(${REQUIRED_TASTE_PRIOR_ALPHA},${REQUIRED_TASTE_PRIOR_ALPHA}), `
      + `exploration ${REQUIRED_TASTE_EXPLORATION_RATE}, half-life ${REQUIRED_TASTE_HALF_LIFE_DAYS} days, `
      + `and survey weight ${REQUIRED_CANDIDATE_PREFERENCE_WEIGHT}`
    );
  }
  assertIntegerInRange(runtimeConfig.candidatePreferenceRetentionDays, "CANDIDATE_PREFERENCE_RETENTION_DAYS", { min: 30, max: 3650 });
  assertIntegerInRange(runtimeConfig.coffeeParticipationRetentionDays, "COFFEE_PARTICIPATION_RETENTION_DAYS", { min: 1, max: 365 });
  assertIntegerInRange(runtimeConfig.mealNormalizationTimeoutMs, "MEAL_NORMALIZATION_TIMEOUT_MS", { min: 30000, max: 600000 });
  assertIntegerInRange(runtimeConfig.mealNormalizationMaxAttempts, "MEAL_NORMALIZATION_MAX_ATTEMPTS", { min: 1, max: 10 });
  assertIntegerInRange(runtimeConfig.mealNormalizationRetryIntervalMs, "MEAL_NORMALIZATION_RETRY_INTERVAL_MS", { min: 300000, max: 86400000 });
  assertNumberInRange(runtimeConfig.targetLatitude, "TARGET_LATITUDE", { min: -90, max: 90 });
  assertNumberInRange(runtimeConfig.targetLongitude, "TARGET_LONGITUDE", { min: -180, max: 180 });
  assertNumberInRange(runtimeConfig.researchDistanceKm, "RESEARCH_DISTANCE_KM", { min: 0.5, max: 50 });
  assertIntegerInRange(runtimeConfig.researchPriceTtlDays, "RESEARCH_PRICE_TTL_DAYS", { min: 1, max: 90 });
  assertIntegerInRange(runtimeConfig.researchDeliveryTtlDays, "RESEARCH_DELIVERY_TTL_DAYS", { min: 1, max: 30 });
  // The delivery contract, diversity selector, research prompt, and schema are
  // intentionally sealed to one three-menu set. Accepting a larger value here
  // would validate a configuration the rest of the pipeline cannot satisfy.
  assertIntegerInRange(runtimeConfig.researchMinCandidates, "RESEARCH_MIN_CANDIDATES", { min: 3, max: 3 });
  assertIntegerInRange(runtimeConfig.researchCodexTimeoutMs, "RESEARCH_CODEX_TIMEOUT_MS", { min: 10000, max: 1800000 });
  assertIntegerInRange(runtimeConfig.weatherFetchTimeoutMs, "WEATHER_FETCH_TIMEOUT_MS", { min: 1000, max: 120000 });
  assertIntegerInRange(runtimeConfig.weatherRainThresholdPercent, "WEATHER_RAIN_THRESHOLD_PERCENT", { min: 0, max: 100 });
  assertNumberInRange(runtimeConfig.weatherPm10Threshold, "WEATHER_PM10_THRESHOLD", { min: 0, max: 1000 });
  assertNumberInRange(runtimeConfig.weatherPm25Threshold, "WEATHER_PM25_THRESHOLD", { min: 0, max: 1000 });
  if (runtimeConfig.weatherEnabled && !String(runtimeConfig.publicDataServiceKey || "").trim()) {
    throw new Error("PUBLIC_DATA_SERVICE_KEY is required when WEATHER_ENABLED is true");
  }
  if (runtimeConfig.airKoreaStationName !== "노송동") {
    throw new Error("AIRKOREA_STATION_NAME must be 노송동 for the JBNU target");
  }

  return runtimeConfig;
}

export function assertRuntimeConfig({
  dryRun = false,
  requireBotToken = !dryRun
} = {}) {
  return validateRuntimeConfig(config, { dryRun, requireBotToken });
}
