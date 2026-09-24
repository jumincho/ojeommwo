import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_LUNCH_CHANNEL_ID,
  REQUIRED_OPERATOR_DM_CHANNEL_ID
} from "../src/config.js";
import {
  parseDinnerDmPreviewArguments,
  runDinnerDmPreviewCli
} from "../scripts/send-dinner-dm-preview.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("DM preview CLI defaults to a pinned operator-DM dry run", () => {
  assert.deepEqual(parseDinnerDmPreviewArguments([]), {
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    mode: "cache",
    send: false,
    dryRun: true
  });
  assert.deepEqual(parseDinnerDmPreviewArguments([
    "--dry-run",
    "--channel", REQUIRED_OPERATOR_DM_CHANNEL_ID,
    "--mode", "cache"
  ]), {
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    mode: "cache",
    send: false,
    dryRun: true
  });
});

test("DM preview CLI requires the explicit --send flag for a live run", () => {
  assert.equal(parseDinnerDmPreviewArguments(["--send"]).send, true);
  assert.equal(parseDinnerDmPreviewArguments(["--send"]).dryRun, false);
  assert.throws(
    () => parseDinnerDmPreviewArguments(["--send", "--dry-run"]),
    /cannot be used together/u
  );
});

test("DM preview CLI rejects unknown, duplicate, and incomplete arguments", () => {
  const invalidArguments = [
    ["--unknown"],
    ["positional"],
    ["--send=true"],
    ["--send", "--send"],
    ["--dry-run", "--dry-run"],
    ["--channel"],
    ["--channel", "--send"],
    ["--channel", REQUIRED_OPERATOR_DM_CHANNEL_ID, "--channel", REQUIRED_OPERATOR_DM_CHANNEL_ID],
    ["--mode"],
    ["--mode", "--send"],
    ["--mode", "cache", "--mode", "cache"]
  ];
  for (const argv of invalidArguments) {
    assert.throws(() => parseDinnerDmPreviewArguments(argv));
  }
});

test("DM preview CLI accepts only cache mode and the code-pinned operator DM", () => {
  for (const argv of [
    ["--channel", REQUIRED_LUNCH_CHANNEL_ID],
    ["--channel", "DOTHER"],
    ["--send", "--channel", REQUIRED_LUNCH_CHANNEL_ID],
    ["--send", "--channel", "DOTHER"],
    ["--mode", "static"],
    ["--send", "--mode", "codex-cli"]
  ]) {
    assert.throws(() => parseDinnerDmPreviewArguments(argv));
  }
});

test("the existing npm DM preview command remains explicitly dry-run only", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  const command = packageJson.scripts?.["preview:dm:dinner"] || "";
  assert.match(command, /(?:^|\s)--dry-run(?:\s|$)/u);
  assert.doesNotMatch(command, /(?:^|\s)--send(?:\s|$)/u);
});

test("DM preview CLI runner keeps an invocation without --send offline", async () => {
  const runtimeChecks = [];
  const previewCalls = [];
  const logs = [];
  const result = await runDinnerDmPreviewCli({
    argv: ["--mode", "cache"],
    assertRuntimeConfigFn: (options) => runtimeChecks.push(options),
    validateStaticFallbackFn: () => ({ ok: true }),
    sendDinnerDmPreviewFn: async (options) => {
      previewCalls.push(options);
      return {
        text: "dry-run dinner preview",
        delivery: { sent: false, channel: options.channel }
      };
    },
    log: (line) => logs.push(line)
  });

  assert.deepEqual(runtimeChecks, [{ dryRun: true, requireBotToken: false }]);
  assert.deepEqual(previewCalls, [{
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    mode: "cache",
    dryRun: true,
    protectedMealChannel: REQUIRED_LUNCH_CHANNEL_ID,
    operatorDmChannel: REQUIRED_OPERATOR_DM_CHANNEL_ID
  }]);
  assert.equal(result.delivery.sent, false);
  assert.match(logs.at(-1), /dry-run only/u);
});
