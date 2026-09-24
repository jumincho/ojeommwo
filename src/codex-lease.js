import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const LEASE_GUARD_STALE_MS = 30_000;
const LEASE_GUARD_RELEASE_WAIT_MS = 5000;
const LEGACY_LEASE_STALE_MS = 2 * 60 * 60_000;
const GUARD_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function ownerFor(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isValidLeaseOwner(owner) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  if (!Number.isInteger(owner.pid) || owner.pid < 1) return false;
  if (typeof owner.nonce !== "string" || owner.nonce.length < 1 || owner.nonce.length > 128) return false;
  if (typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt))) return false;
  if (owner.version === 2) return owner.heartbeat === true;
  return owner.version === 1 && !Object.hasOwn(owner, "heartbeat");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(GUARD_SLEEP_ARRAY, 0, 0, Math.max(1, milliseconds));
}

function acquireLeaseMetadataGuard(filePath, {
  deadline = Date.now(),
  pollMs = 5,
  staleMs = LEASE_GUARD_STALE_MS
} = {}) {
  const guardPath = `${filePath}.reap`;
  const token = crypto.randomUUID();
  for (;;) {
    let descriptor;
    let created = false;
    try {
      descriptor = fs.openSync(guardPath, "wx", 0o600);
      created = true;
      fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, pid: process.pid, token })}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return { path: guardPath, token };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error?.code !== "EEXIST") {
        if (created) fs.rmSync(guardPath, { force: true });
        throw error;
      }
      try {
        const ageMs = Math.max(0, Date.now() - fs.statSync(guardPath).mtimeMs);
        if (ageMs >= staleMs) {
          fs.rmSync(guardPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseLeaseMetadataGuard(guard) {
  if (!guard) return;
  try {
    const current = JSON.parse(fs.readFileSync(guard.path, "utf8"));
    if (current?.token === guard.token) fs.rmSync(guard.path, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sameLeaseSnapshot(filePath, snapshot, stat) {
  try {
    const currentStat = fs.statSync(filePath);
    return currentStat.size === stat.size
      && currentStat.mtimeMs === stat.mtimeMs
      && JSON.stringify(ownerFor(filePath)) === JSON.stringify(snapshot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function moveStaleLease(filePath, snapshot, stat) {
  if (!sameLeaseSnapshot(filePath, snapshot, stat)) return false;
  const stalePath = `${filePath}.${process.pid}.${crypto.randomUUID()}.stale`;
  try {
    fs.renameSync(filePath, stalePath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  try {
    if (!sameLeaseSnapshot(stalePath, snapshot, stat)) {
      if (!fs.existsSync(filePath)) fs.renameSync(stalePath, filePath);
      return false;
    }
    fs.rmSync(stalePath, { force: true });
    return true;
  } finally {
    fs.rmSync(stalePath, { force: true });
  }
}

export async function acquireCodexLease({
  filePath = path.join(DATA_DIR, ".codex-heavy.lock"),
  waitMs = 75_000,
  staleMs = 20 * 60_000,
  pollMs = 250,
  now = () => Date.now(),
  legacyStaleMs = LEGACY_LEASE_STALE_MS
} = {}) {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10 * 60_000
      || !Number.isInteger(staleMs) || staleMs < 30_000 || staleMs > 2 * 60 * 60_000
      || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 5000
      || !Number.isInteger(legacyStaleMs) || legacyStaleMs < 60 * 60_000 || legacyStaleMs > 24 * 60 * 60_000
      || typeof now !== "function") {
    throw new Error("Codex lease timing is invalid");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const startedWaiting = now();
  const nonce = crypto.randomUUID();
  const owner = {
    version: 2,
    pid: process.pid,
    nonce,
    startedAt: new Date(startedWaiting).toISOString(),
    heartbeat: true
  };

  for (;;) {
    const guard = acquireLeaseMetadataGuard(filePath, {
      deadline: Date.now() + Math.min(5000, Math.max(0, waitMs)),
      pollMs: Math.min(25, pollMs)
    });
    if (!guard) {
      if (now() - startedWaiting >= waitMs) {
        throw new Error(`Another Codex-heavy job is still running after ${waitMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    let acquired = false;
    let retry = false;
    try {
      try {
        const descriptor = fs.openSync(filePath, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      if (!acquired) {
        const existing = ownerFor(filePath);
        const validOwner = isValidLeaseOwner(existing);
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch (error) {
          if (error?.code === "ENOENT") retry = true;
          else throw error;
        }
        if (stat) {
          const ageMs = Math.max(0, now() - stat.mtimeMs);
          const deadOwner = validOwner && !processIsAlive(existing.pid) && ageMs > 30_000;
          const malformedOwner = !validOwner && ageMs > staleMs;
          const missedHeartbeat = validOwner
            && existing.version === 2
            && ageMs > staleMs;
          // Version 1 had no heartbeat. Its maximum supported Codex runtime was
          // far below this conservative bound, so a two-hour-old lease can be
          // recovered even if an unrelated process has reused the PID.
          const expiredLegacyOwner = validOwner
            && existing.version === 1
            && ageMs > legacyStaleMs;
          if (deadOwner || malformedOwner || missedHeartbeat || expiredLegacyOwner) {
            retry = moveStaleLease(filePath, existing, stat);
          }
        }
      }
    } finally {
      releaseLeaseMetadataGuard(guard);
    }

    if (acquired) {
      const heartbeatIntervalMs = Math.max(5000, Math.min(60_000, Math.floor(staleMs / 4)));
      const heartbeat = setInterval(() => {
        const heartbeatGuard = acquireLeaseMetadataGuard(filePath, { deadline: Date.now() });
        if (!heartbeatGuard) return;
        try {
          const current = ownerFor(filePath);
          if (current?.nonce !== nonce || current?.pid !== process.pid) {
            clearInterval(heartbeat);
            return;
          }
          const timestamp = new Date();
          fs.utimesSync(filePath, timestamp, timestamp);
        } catch (error) {
          if (error?.code !== "ENOENT") clearInterval(heartbeat);
        } finally {
          releaseLeaseMetadataGuard(heartbeatGuard);
        }
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
      return () => {
        clearInterval(heartbeat);
        const releaseGuard = acquireLeaseMetadataGuard(filePath, {
          deadline: Date.now() + LEASE_GUARD_RELEASE_WAIT_MS
        });
        if (!releaseGuard) throw new Error("Timed out releasing the Codex-heavy job lease");
        try {
          const current = ownerFor(filePath);
          if (current?.nonce === nonce && current?.pid === process.pid) fs.rmSync(filePath, { force: true });
        } finally {
          releaseLeaseMetadataGuard(releaseGuard);
        }
      };
    }
    if (retry) continue;
    if (now() - startedWaiting >= waitMs) {
      throw new Error(`Another Codex-heavy job is still running after ${waitMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
