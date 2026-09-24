import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_LUNCH_CHANNEL_ID } from "../src/config.js";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "send-scheduled-meal.js");

function runScheduled(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      SLACK_BOT_TOKEN: "xoxb-test-suite",
      SLACK_APP_TOKEN: "xapp-test-suite",
      LUNCH_CHANNEL_ID: REQUIRED_LUNCH_CHANNEL_ID,
      OPERATIONS_ALERT_CHANNEL_ID: "D0123456789",
      WEATHER_ENABLED: "false",
      RECOMMENDATION_MODE: "cache",
      // CLI argument-safety tests must not depend on whatever production
      // candidates and cooldown history happen to exist in the deployment
      // validation snapshot.
      ALLOW_UNVERIFIED_FALLBACK: "true",
      RESTAURANT_COOLDOWN_DAYS: "0",
      MENU_COOLDOWN_DAYS: "0"
    }
  });
}

test("scheduled CLI rejects a bare live invocation before starting work", () => {
  const result = runScheduled([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--meal is required/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\[scheduled\] starting/u);
});

test("scheduled CLI rejects generic live meal and an implicit live channel", () => {
  const generic = runScheduled(["--meal", "meal", "--channel", REQUIRED_LUNCH_CHANNEL_ID]);
  assert.notEqual(generic.status, 0);
  assert.match(generic.stderr, /requires --meal lunch or --meal dinner/u);

  const noChannel = runScheduled(["--meal", "lunch"]);
  assert.notEqual(noChannel.status, 0);
  assert.match(noChannel.stderr, /requires an explicit --channel/u);
});

test("scheduled CLI rejects live model and static modes before any external work", () => {
  for (const mode of ["codex-cli", "static"]) {
    const result = runScheduled(["--meal", "lunch", "--channel", REQUIRED_LUNCH_CHANNEL_ID, "--mode", mode]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires --mode cache/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\[scheduled\] starting/u);
  }
});

test("scheduled CLI permits live delivery only to the exact configured meal channel", () => {
  for (const channel of ["COTHER", "GOTHER", "D123ABC"]) {
    const result = runScheduled(["--meal", "lunch", "--channel", channel, "--mode", "cache"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly match LUNCH_CHANNEL_ID/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\[scheduled\] starting|network access is disabled/u);
  }
});

test("scheduled CLI lets an explicitly requested generic dry-run pass the live-send guard", () => {
  const result = runScheduled(["--meal", "meal", "--dry-run"]);
  assert.match(result.stdout, /starting 식사 recommendation for .* using cache/u);
  assert.doesNotMatch(result.stderr, /live scheduled delivery|explicit --channel|network access is disabled/u);
});

test("scheduled CLI keeps non-production destinations available only for dry-run diagnostics", () => {
  const result = runScheduled(["--meal", "lunch", "--channel", "D123ABC", "--mode", "cache", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /starting 점심 recommendation for D123ABC using cache/u);
  assert.doesNotMatch(result.stderr, /exactly match LUNCH_CHANNEL_ID|network access is disabled/u);
});

test("scheduled shell wrapper has fail-closed live defaults", () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, "scripts", "run-scheduled-meal.sh"), "utf8");
  assert.match(source, /^meal=""$/mu);
  assert.match(source, /^mode="cache"$/mu);
  assert.match(source, /^meal_explicit=0$/mu);
  assert.match(source, /^channel_explicit=0$/mu);
  assert.match(source, /live scheduled delivery requires --meal lunch or --meal dinner/u);
  assert.match(source, /live scheduled delivery requires an explicit --channel/u);
  assert.match(source, /live scheduled delivery requires --mode cache/u);
  assert.match(source, /import \{ config, PRODUCTION_TIMEZONE \} from "\.\/src\/config\.js"/u);
  assert.match(source, /TIMEZONE must be \$\{PRODUCTION_TIMEZONE\} for production scheduling/u);
  assert.match(source, /import \{ loadHolidayDates \} from "\.\/src\/scheduler\.js"/u);
});

test("scheduled live delivery performs the read-only Slack target preflight before executeMeal", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  const preflightOffset = source.indexOf("await verifySlackDeliveryTarget");
  const deliveryOffset = source.indexOf("await executeMeal");
  assert.ok(preflightOffset >= 0, "Slack target preflight must be present");
  assert.ok(deliveryOffset > preflightOffset, "Slack target preflight must run before executeMeal");
  assert.match(source, /if \(!dryRun\) \{\s+const capability = await verifySlackDeliveryTarget/u);
});
