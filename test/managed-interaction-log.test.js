import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTERACTION_LISTENER_ARCHIVE_LIMIT,
  installManagedInteractionLog
} from "../scripts/managed-interaction-log.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("managed listener logging atomically renames and reopens before the overflowing write", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-managed-log-"));
  const logPath = path.join(directory, "interaction-listener.log");
  const initial = "bootstrap\n";
  fs.writeFileSync(logPath, initial, { mode: 0o600 });
  const initialStat = fs.statSync(logPath);
  const clock = () => new Date("2026-07-17T03:04:05.000Z");
  let installation;
  try {
    installation = installManagedInteractionLog({ logPath, maxBytes: 128, now: clock });
    console.log("A".repeat(100));
    console.warn("B".repeat(40));
    console.error(`token=xoxb-${"s".repeat(40)} ${"C".repeat(200)}`);
    const archives = installation.archivePaths;
    installation.close();
    installation = null;

    assert.equal(archives.length, 2);
    assert.equal(fs.readFileSync(archives[0], "utf8"), `${initial}${"A".repeat(100)}\n`);
    assert.equal(fs.readFileSync(archives[1], "utf8"), `${"B".repeat(40)}\n`);
    const active = fs.readFileSync(logPath, "utf8");
    assert.match(active, /\[REDACTED\]/u);
    assert.match(active, /\[log entry truncated\]/u);
    assert.ok(Buffer.byteLength(active) <= 128);
    for (const archivePath of archives) {
      assert.ok(fs.statSync(archivePath).size <= 128);
      if (process.platform !== "win32") assert.equal(fs.statSync(archivePath).mode & 0o777, 0o600);
    }
    if (process.platform !== "win32") assert.notEqual(fs.statSync(logPath).ino, initialStat.ino);
  } finally {
    installation?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("managed listener logging bounds an oversized legacy active file on installation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-managed-log-legacy-"));
  const logPath = path.join(directory, "interaction-listener.log");
  fs.writeFileSync(logPath, "legacy".repeat(64), { mode: 0o600 });
  let installation;
  try {
    installation = installManagedInteractionLog({
      logPath,
      maxBytes: 128,
      now: () => new Date("2026-07-17T03:04:05.000Z")
    });
    assert.equal(installation.archivePaths.length, 1);
    assert.equal(fs.statSync(logPath).size, 0);
  } finally {
    installation?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("managed listener logging hard-bounds regular archives after repeated rotation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-managed-log-count-"));
  const logPath = path.join(directory, "interaction-listener.log");
  fs.writeFileSync(logPath, "", { mode: 0o600 });
  const similarlyNamedDirectory = path.join(directory, "interaction-listener-20260101-010101.log");
  fs.mkdirSync(similarlyNamedDirectory);
  let installation;
  try {
    let tick = 0;
    installation = installManagedInteractionLog({
      logPath,
      maxBytes: 64,
      now: () => new Date(Date.UTC(2026, 6, 17, 3, 4, 5 + tick++))
    });
    for (let index = 0; index < 9; index += 1) console.log(`${index}:${"X".repeat(46)}`);
    installation.close();
    installation = null;

    const archives = fs.readdirSync(directory).filter((name) =>
      /^interaction-listener-\d{8}-\d{6}(?:-\d+(?:-\d+)?)?\.log$/u.test(name)
      && fs.lstatSync(path.join(directory, name)).isFile()
    );
    assert.equal(archives.length, INTERACTION_LISTENER_ARCHIVE_LIMIT);
    assert.equal(fs.existsSync(similarlyNamedDirectory), true,
      "archive pruning must never remove a non-regular entry");
    assert.ok(fs.statSync(logPath).size <= 64);
    for (const name of archives) assert.ok(fs.statSync(path.join(directory, name)).size <= 64);
  } finally {
    installation?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("server wrapper activates managed logging with null stdio while direct runs stay opt-in", () => {
  const wrapper = fs.readFileSync(path.join(ROOT, "scripts", "run-interaction-listener.sh"), "utf8");
  const runner = fs.readFileSync(path.join(ROOT, "scripts", "run-interaction-listener.js"), "utf8");
  assert.match(wrapper, /export OJEOMMWO_MANAGED_INTERACTION_LOG=1/u);
  assert.match(wrapper, /run-interaction-listener\.js >\/dev\/null 2>&1/u);
  assert.doesNotMatch(wrapper, /interaction-listener\.log" 2>&1|rotate-interaction-listener-log|copytruncate/u);
  assert.match(runner, /OJEOMMWO_MANAGED_INTERACTION_LOG === "1"/u);
  const installIndex = runner.indexOf("installManagedInteractionLog()");
  const configImportIndex = runner.indexOf('import("../src/config.js")');
  assert.ok(installIndex >= 0 && configImportIndex > installIndex,
    "the managed sink must be installed before application modules are dynamically imported");
});
