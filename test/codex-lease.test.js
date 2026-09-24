import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireCodexLease } from "../src/codex-lease.js";

test("Codex-heavy jobs are serialized and release only their own lease", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lease-test-"));
  const filePath = path.join(directory, ".codex-heavy.lock");
  try {
    const release = await acquireCodexLease({ filePath, waitMs: 20, pollMs: 5, staleMs: 30_000 });
    await assert.rejects(
      () => acquireCodexLease({ filePath, waitMs: 20, pollMs: 5, staleMs: 30_000 }),
      /Another Codex-heavy job/u
    );
    release();
    const releaseAgain = await acquireCodexLease({ filePath, waitMs: 20, pollMs: 5, staleMs: 30_000 });
    releaseAgain();
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale heartbeat lease is reaped even when its PID has been reused", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lease-reuse-test-"));
  const filePath = path.join(directory, ".codex-heavy.lock");
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      version: 2,
      pid: process.pid,
      nonce: "stale-owner",
      startedAt: "2026-01-01T00:00:00.000Z",
      heartbeat: true
    }));
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(filePath, stale, stale);
    const release = await acquireCodexLease({
      filePath,
      waitMs: 50,
      pollMs: 5,
      staleMs: 30_000
    });
    release();
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy non-heartbeat lease has a conservative PID-reuse recovery bound", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lease-legacy-test-"));
  const filePath = path.join(directory, ".codex-heavy.lock");
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: "legacy-reused-pid",
      startedAt: "2026-01-01T00:00:00.000Z"
    }));
    const stale = new Date(Date.now() - 61 * 60_000);
    fs.utimesSync(filePath, stale, stale);
    const release = await acquireCodexLease({
      filePath,
      waitMs: 50,
      pollMs: 5,
      staleMs: 30_000,
      legacyStaleMs: 60 * 60_000
    });
    release();
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a parseable but schema-invalid lease is recovered after the stale bound", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lease-invalid-test-"));
  const filePath = path.join(directory, ".codex-heavy.lock");
  try {
    fs.writeFileSync(filePath, JSON.stringify({}));
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(filePath, stale, stale);
    const release = await acquireCodexLease({
      filePath,
      waitMs: 50,
      pollMs: 5,
      staleMs: 30_000
    });
    release();
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("lease metadata guard blocks concurrent create/reap/release and recovers when stale", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lease-guard-test-"));
  const filePath = path.join(directory, ".codex-heavy.lock");
  const guardPath = `${filePath}.reap`;
  try {
    fs.writeFileSync(guardPath, JSON.stringify({ pid: process.pid, token: "active-guard" }));
    await assert.rejects(
      () => acquireCodexLease({ filePath, waitMs: 20, pollMs: 5, staleMs: 30_000 }),
      /Another Codex-heavy job/u
    );
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(guardPath, stale, stale);
    const release = await acquireCodexLease({ filePath, waitMs: 50, pollMs: 5, staleMs: 30_000 });
    release();
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(guardPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
