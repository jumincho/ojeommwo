import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneRuntimeArtifacts } from "../src/runtime-maintenance.js";

test("runtime maintenance removes only allowlisted expired artifacts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-maintenance-"));
  try {
    const logs = path.join(rootDir, "logs");
    const runs = path.join(rootDir, "data", "codex-cli-runs");
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(runs, { recursive: true });
    const oldLog = path.join(logs, "scheduled-lunch-20260101-112500.log");
    const liveLog = path.join(logs, "interaction-listener.log");
    const oldRun = path.join(runs, "candidate-refresh-2026-01-01-output.json");
    const oldEnvTemp = path.join(rootDir, ".env.123.456.tmp");
    const oldDataTemp = path.join(rootDir, "data", "sent-messages.json.123.456.tmp");
    const unrelatedTemp = path.join(rootDir, "do-not-remove.tmp");
    fs.writeFileSync(oldLog, "old");
    fs.writeFileSync(liveLog, "keep");
    fs.writeFileSync(oldRun, "old");
    fs.writeFileSync(oldEnvTemp, "secret");
    fs.writeFileSync(oldDataTemp, "data");
    fs.writeFileSync(unrelatedTemp, "keep");
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    fs.utimesSync(oldLog, oldTime, oldTime);
    fs.utimesSync(liveLog, oldTime, oldTime);
    fs.utimesSync(oldRun, oldTime, oldTime);
    fs.utimesSync(oldEnvTemp, oldTime, oldTime);
    fs.utimesSync(oldDataTemp, oldTime, oldTime);
    fs.utimesSync(unrelatedTemp, oldTime, oldTime);
    const result = pruneRuntimeArtifacts({
      rootDir,
      now: new Date("2026-07-12T00:00:00.000Z"),
      logRetentionDays: 45,
      codexRunRetentionDays: 30
    });
    assert.equal(result.totalRemoved, 4);
    assert.equal(fs.existsSync(oldLog), false);
    assert.equal(fs.existsSync(oldRun), false);
    assert.equal(fs.existsSync(liveLog), true);
    assert.equal(fs.existsSync(oldEnvTemp), false);
    assert.equal(fs.existsSync(oldDataTemp), false);
    assert.equal(fs.existsSync(unrelatedTemp), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime maintenance uses embedded timestamps after copied files receive a new mtime", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-maintenance-copy-"));
  try {
    const logs = path.join(rootDir, "logs");
    const runs = path.join(rootDir, "data", "codex-cli-runs");
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(runs, { recursive: true });
    const oldLog = path.join(logs, "scheduled-lunch-20260505-112501.log");
    const legacyRun = path.join(runs, "2026-05-05T02-57-29-846Z.log");
    const recentRun = path.join(runs, "candidate-refresh-2026-07-11T05-52-59-978Z-output.json");
    for (const file of [oldLog, legacyRun, recentRun]) fs.writeFileSync(file, "artifact");

    const copiedTime = new Date("2026-07-12T00:00:00.000Z");
    for (const file of [oldLog, legacyRun, recentRun]) fs.utimesSync(file, copiedTime, copiedTime);
    const result = pruneRuntimeArtifacts({
      rootDir,
      now: new Date("2026-07-12T00:00:00.000Z"),
      logRetentionDays: 45,
      codexRunRetentionDays: 30
    });

    assert.equal(result.totalRemoved, 2);
    assert.equal(fs.existsSync(oldLog), false);
    assert.equal(fs.existsSync(legacyRun), false);
    assert.equal(fs.existsSync(recentRun), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime maintenance keeps accepting legacy research artifact names", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-maintenance-legacy-"));
  try {
    const logs = path.join(rootDir, "logs");
    const runs = path.join(rootDir, "data", "codex-cli-runs");
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(runs, { recursive: true });
    const legacyLog = path.join(logs, "research-20260101-010101.log");
    const legacyRun = path.join(runs, "research-2026-01-01-output.json");
    fs.writeFileSync(legacyLog, "old");
    fs.writeFileSync(legacyRun, "old");

    const result = pruneRuntimeArtifacts({
      rootDir,
      now: new Date("2026-07-12T00:00:00.000Z"),
      logRetentionDays: 45,
      codexRunRetentionDays: 30
    });
    assert.equal(result.totalRemoved, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

 test("auth-check logs and provider telemetry expire without touching live credentials", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-auth-retention-"));
  try {
    fs.mkdirSync(path.join(rootDir, "logs"));
    const runDir = path.join(rootDir, "data", "codex-cli-runs");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "logs", "codex-auth-check-20260101-074000.log"), "fixture");
    fs.writeFileSync(path.join(runDir, "auth-check-2026-01-01T00-00-00-000Z-telemetry.log"), "fixture");
    fs.writeFileSync(path.join(runDir, "auth.json"), "preserve");
    assert.equal(pruneRuntimeArtifacts({ rootDir, now: new Date("2026-09-12T00:00:00Z") }).totalRemoved, 2);
    assert.equal(fs.readFileSync(path.join(runDir, "auth.json"), "utf8"), "preserve");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});
