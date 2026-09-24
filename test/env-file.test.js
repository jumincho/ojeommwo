import test from "node:test";
import assert from "node:assert/strict";
import { mergeEnvText, parseEnvUpdates, removeEnvKeys } from "../src/env-file.js";

test("operating env updates are allowlisted and merged without losing secrets", () => {
  const updates = parseEnvUpdates("ENABLE_MEAL_FEEDBACK=true\nSLACK_APP_TOKEN=xapp-test\n", new Set(["ENABLE_MEAL_FEEDBACK", "SLACK_APP_TOKEN"]));
  const merged = mergeEnvText("SLACK_BOT_TOKEN=xoxb-existing\nENABLE_MEAL_FEEDBACK=false\n", updates);
  assert.match(merged, /SLACK_BOT_TOKEN=xoxb-existing/u);
  assert.match(merged, /ENABLE_MEAL_FEEDBACK=true/u);
  assert.match(merged, /SLACK_APP_TOKEN=xapp-test/u);
  assert.throws(() => parseEnvUpdates("UNSAFE=value", new Set()), /not allowed/u);
});

test("obsolete environment keys are removed without exposing or changing secrets", () => {
  const result = removeEnvKeys("SLACK_BOT_TOKEN=secret\nLIVE_SEARCH_MAX_CANDIDATES=12\nKEEP=1\n", new Set(["LIVE_SEARCH_MAX_CANDIDATES"]));
  assert.equal(result.text, "SLACK_BOT_TOKEN=secret\nKEEP=1\n");
  assert.deepEqual(result.removed, ["LIVE_SEARCH_MAX_CANDIDATES"]);
});
