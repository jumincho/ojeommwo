import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveCodexAuthHealth } from "../src/codex-auth-health.js";

const now = new Date("2026-09-25T08:00:00Z");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth-health-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (stamp, fields = {}) => fs.writeFileSync(path.join(directory, `auth-check-${stamp.replaceAll(":", "-").replace(".000", "")}-telemetry.log`),
    JSON.stringify({ version: 1, job: "auth-check", model: "gpt-6-luna", reasoningEffort: "xhigh", useSearch: false,
      recordedAt: stamp, success: true, ...fields }));
  return { directory, write };
}
test("live probe health accepts a recent real success and rejects missing evidence", (t) => {
  const { directory, write } = fixture(t);
  assert.throws(() => liveCodexAuthHealth({ directory, now }), /No live/u);
  write("2026-09-25T07:00:00Z");
  assert.equal(liveCodexAuthHealth({ directory, now }).status, "pass");
});
test("a newer failed probe cannot be hidden by a previous successful token check", (t) => {
  const { directory, write } = fixture(t);
  write("2026-09-25T06:00:00Z"); write("2026-09-25T07:00:00Z", { success: false });
  assert.throws(() => liveCodexAuthHealth({ directory, now }), /latest.*failed/u);
  write("2026-09-25T07:30:00Z");
  assert.equal(liveCodexAuthHealth({ directory, now }).status, "pass");
});
test("stale, future, wrong-model and malformed authentication evidence fail closed", (t) => {
  const { directory, write } = fixture(t);
  write("2026-09-23T07:00:00Z");
  assert.throws(() => liveCodexAuthHealth({ directory, now }), /stale/u);
  write("2026-09-25T07:00:00Z", { model: "another-model" });
  assert.throws(() => liveCodexAuthHealth({ directory, now }), /contract/u);
  write("2026-09-26T07:00:00Z");
  assert.throws(() => liveCodexAuthHealth({ directory, now }), /future/u);
  fs.writeFileSync(path.join(directory, "auth-check-2026-09-27T07-00-00Z-telemetry.log"), "{");
  assert.throws(() => liveCodexAuthHealth({ directory, now }), /Malformed/u);
});
