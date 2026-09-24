import test from "node:test";
import assert from "node:assert/strict";
import { logError, logInfo, logWarn } from "../src/logger.js";

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u;

test("every logger level starts with an ISO timestamp and still redacts secrets", () => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const calls = [];
  console.log = (...args) => calls.push(["info", ...args]);
  console.warn = (...args) => calls.push(["warn", ...args]);
  console.error = (...args) => calls.push(["error", ...args]);
  try {
    logInfo("info xoxb-secret-token", "xapp-secret-token");
    logWarn("warn sk-secret", "plain");
    logError("error xoxb-secret-token", new Error("xapp-secret-token"));
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.deepEqual(calls.map(([level]) => level), ["info", "warn", "error"]);
  for (const call of calls) {
    assert.match(call[1], ISO_PREFIX);
    assert.ok(Number.isFinite(Date.parse(call[1].slice(0, 24))));
    assert.doesNotMatch(call.join(" "), /secret-token/u);
    assert.match(call.join(" "), /\[REDACTED\]/u);
  }
});
