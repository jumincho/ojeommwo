import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  config,
  DEFAULT_CODEX_CLI_AUTH_PATH,
  DEFAULT_OBSERVATORY_URL_FILE,
  REQUIRED_LUNCH_CHANNEL_ID,
  ROOT_DIR,
  validateRuntimeConfig
} from "../src/config.js";

function validConfig(overrides = {}) {
  return {
    ...config,
    slackBotToken: "xoxb-test-token",
    lunchChannelId: REQUIRED_LUNCH_CHANNEL_ID,
    operationsAlertChannelId: "D0123456789",
    recommendationMode: "cache",
    codexCliSandbox: "read-only",
    slackApiTimeoutMs: 15000,
    codexCliTimeoutMs: 180000,
    keepRecentMessages: 10,
    cacheFallbackMinCandidates: 20,
    cacheHistoryMaxAgeDays: 30,
    recommendationCount: 3,
    restaurantCooldownDays: 14,
    menuCooldownDays: 7,
    historyRetentionDays: 90,
    weatherEnabled: true,
    publicDataServiceKey: "test-service-key",
    airKoreaStationName: "노송동",
    ...overrides
  };
}

test("validateRuntimeConfig accepts the production-shaped configuration", () => {
  const candidate = validConfig();
  assert.equal(validateRuntimeConfig(candidate), candidate);
  assert.equal(
    DEFAULT_OBSERVATORY_URL_FILE,
    path.join(ROOT_DIR, "observatory", "runtime", "public-url.txt")
  );
  assert.equal(
    DEFAULT_CODEX_CLI_AUTH_PATH,
    path.join(path.dirname(ROOT_DIR), ".ojeommwo-v2-state", "codex", "auth.json")
  );
  assert.match(
    fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8"),
    /^OBSERVATORY_URL_FILE=observatory\/runtime\/public-url\.txt$/mu
  );
  assert.match(
    fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8"),
    /^CODEX_CLI_AUTH_PATH=\/root\/\.ojeommwo-v2-state\/codex\/auth\.json$/mu
  );
});

test("validateRuntimeConfig allows a tokenless dry-run", () => {
  assert.doesNotThrow(() => validateRuntimeConfig(validConfig({ slackBotToken: "" }), { dryRun: true }));
});

test("validateRuntimeConfig rejects unsafe or mistyped values", () => {
  assert.throws(() => validateRuntimeConfig(validConfig({ recommendationMode: "typo" })), /recommendation mode/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ codexCliModel: "unsupported-model" })), /CODEX_CLI_MODEL/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ codexCliReasoningEffort: "none" })), /CODEX_CLI_REASONING_EFFORT/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ codexCliSandbox: "danger-full-access" })), /CODEX_CLI_SANDBOX/u);
  assert.throws(
    () => validateRuntimeConfig(validConfig({
      codexCliAuthPath: path.join(os.homedir(), ".codex", "auth.json")
    })),
    /interactive user's default Codex home/u
  );
  assert.throws(
    () => validateRuntimeConfig(validConfig({ codexCliAuthPath: path.join(ROOT_DIR, "auth.json") })),
    /outside the deployable source tree/u
  );
  assert.throws(
    () => validateRuntimeConfig(validConfig({ lunchChannelId: "CWRONG" })),
    /LUNCH_CHANNEL_ID must be the protected lunch channel C0123456789/u
  );
  assert.throws(
    () => validateRuntimeConfig(validConfig({ operationsAlertChannelId: "C123ABC" })),
    /OPERATIONS_ALERT_CHANNEL_ID must be the protected operator DM D0123456789/u
  );
  assert.throws(() => validateRuntimeConfig(validConfig({ codexCliTimeoutMs: 0 })), /CODEX_CLI_TIMEOUT_MS/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ recommendationCount: 4 })), /RECOMMENDATION_COUNT/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ researchMinCandidates: 4 })), /RESEARCH_MIN_CANDIDATES/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ cacheHistoryMaxAgeDays: 0 })), /CACHE_HISTORY_MAX_AGE_DAYS/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ choiceDiversityEnforcementSince: "not-a-date" })), /CHOICE_DIVERSITY_ENFORCEMENT_SINCE/u);
  assert.throws(
    () => validateRuntimeConfig(validConfig({ policyEnforcementSince: "2099-01-01T00:00:00+09:00" })),
    /POLICY_ENFORCEMENT_SINCE must remain/u
  );
  assert.throws(() => validateRuntimeConfig(validConfig({ enableMealFeedback: true, slackAppToken: "" })), /SLACK_APP_TOKEN/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ observatoryUrl: "javascript:alert(1)" })), /must use HTTPS/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ observatoryUrl: "http://user:pass@example.com/" })), /credentials/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ observatoryUrl: "http://example.com/" })), /must use HTTPS/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ observatoryUrl: "https://127.0.0.1/" })), /public HTTPS hostname/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ observatoryUrl: "https://example.com:8443/" })), /custom port/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ observatoryUrl: "http://203.0.113.10:8788/" })), /must use HTTPS/u);
  assert.doesNotThrow(() => validateRuntimeConfig(validConfig({ enableObservatoryLink: false, observatoryUrl: "" })));
  assert.throws(() => validateRuntimeConfig(validConfig({ slackAppToken: "wrong" })), /must start with xapp-/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ tasteExplorationRate: 2 })), /TASTE_EXPLORATION_RATE/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ tastePriorAlpha: 2 })), /TASTE_PRIOR_ALPHA/u);
  assert.throws(
    () => validateRuntimeConfig(validConfig({ candidatePreferenceWeight: 0.5 })),
    /Taste contract must remain Beta\(3,3\), exploration 0\.18, half-life 180 days, and survey weight 0\.9/u
  );
  assert.throws(() => validateRuntimeConfig(validConfig({ tasteHalfLifeDays: 90 })), /Taste contract/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ enableSchedule: "false" })), /ENABLE_SCHEDULE/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ enableSchedule: true })), /must remain false/u);
  assert.throws(() => validateRuntimeConfig(validConfig({ timezone: "Mars/Olympus" })), /TIMEZONE/u);
  assert.throws(
    () => validateRuntimeConfig(validConfig({ publicDataServiceKey: "" })),
    /PUBLIC_DATA_SERVICE_KEY is required/u
  );
  assert.throws(
    () => validateRuntimeConfig(validConfig({ airKoreaStationName: "송천동" })),
    /AIRKOREA_STATION_NAME must be 노송동/u
  );
  assert.doesNotThrow(() => validateRuntimeConfig(validConfig({
    weatherEnabled: false,
    publicDataServiceKey: "",
    airKoreaStationName: "노송동"
  })));
  assert.throws(
    () => validateRuntimeConfig(validConfig({ enableCleanup: true, keepRecentMessages: 0 })),
    /at least 1/u
  );
});

test("environment parsing fails fast on malformed booleans and numbers", () => {
  const configUrl = pathToFileURL(path.resolve("src/config.js")).href;
  const runImport = (environment) => spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import(${JSON.stringify(configUrl)})`
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: "utf8"
  });

  const invalidBoolean = runImport({ ENABLE_SCHEDULE: "tru" });
  assert.notEqual(invalidBoolean.status, 0);
  assert.match(invalidBoolean.stderr, /ENABLE_SCHEDULE must be a boolean value/u);

  const invalidInteger = runImport({ SLACK_API_TIMEOUT_MS: "15000ms" });
  assert.notEqual(invalidInteger.status, 0);
  assert.match(invalidInteger.stderr, /SLACK_API_TIMEOUT_MS must be an integer/u);
});

test("NODE_ENV=test keeps configuration hermetic and ignores the production env file", () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, "src", "config.js"), "utf8");
  assert.match(
    source,
    /process\.env\.NODE_ENV === "test"[\s\S]*?\? \{\}[\s\S]*?: parseEnvFile\(path\.join\(ROOT_DIR, "\.env"\)\)/u
  );

  const configUrl = pathToFileURL(path.resolve("src/config.js")).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import(${JSON.stringify(configUrl)}).then(({ config }) => console.log(config.codexCliModel))`
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      CODEX_CLI_MODEL: "gpt-6-luna"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "gpt-6-luna");
});

test("configuration prefers one validated live observatory URL file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-observatory-url-"));
  const urlFile = path.join(directory, "public-url.txt");
  const configUrl = pathToFileURL(path.resolve("src/config.js")).href;
  const runImport = () => spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import(${JSON.stringify(configUrl)}).then(({ config }) => console.log(config.observatoryUrl))`
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSERVATORY_URL: "https://fallback.example.com/",
      OBSERVATORY_URL_FILE: urlFile
    },
    encoding: "utf8"
  });

  try {
    fs.writeFileSync(urlFile, "https://observatory.example.test/\n", "utf8");
    const valid = runImport();
    assert.equal(valid.status, 0);
    assert.equal(valid.stdout.trim(), "https://observatory.example.test/");

    fs.writeFileSync(urlFile, "https://one.example.test/\nhttps://two.example.test/\n", "utf8");
    const multiline = runImport();
    assert.notEqual(multiline.status, 0);
    assert.match(multiline.stderr, /exactly one URL/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
