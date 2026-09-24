import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectOperatingMaintenanceMarker,
  OPERATING_MAINTENANCE_MAX_AGE_MS
} from "../src/maintenance-marker.js";

function withMarker(value, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-maintenance-marker-"));
  const markerPath = path.join(directory, ".operating-maintenance");
  try {
    if (value !== undefined) fs.writeFileSync(markerPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return callback(markerPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("maintenance marker distinguishes absent, fresh, owned, and stale states", () => {
  const now = new Date("2026-08-24T08:48:32.000Z");
  withMarker(undefined, (markerPath) => {
    assert.equal(inspectOperatingMaintenanceMarker({ markerPath, now }).state, "absent");
  });
  withMarker({
    version: 1,
    operation: "integrated-source-deployment",
    token: "a".repeat(32),
    issuedAt: new Date(now.getTime() - 1000).toISOString()
  }, (markerPath) => {
    const active = inspectOperatingMaintenanceMarker({ markerPath, now, expectedToken: "a".repeat(32) });
    assert.equal(active.state, "active");
    assert.equal(active.owned, true);
  });
  withMarker({
    version: 1,
    operation: "food-taxonomy-migration",
    issuedAt: new Date(now.getTime() - OPERATING_MAINTENANCE_MAX_AGE_MS - 1).toISOString()
  }, (markerPath) => {
    assert.equal(inspectOperatingMaintenanceMarker({ markerPath, now }).state, "stale");
  });
});

test("maintenance marker fails closed on malformed, unknown, future, or tokenless data", () => {
  const now = new Date("2026-08-24T08:48:32.000Z");
  for (const marker of [
    { version: 1, operation: "unknown", issuedAt: now.toISOString() },
    { version: 1, operation: "food-taxonomy-migration", issuedAt: "bad" },
    { version: 1, operation: "food-taxonomy-migration", issuedAt: "2026-08-24T09:00:00.000Z" },
    { version: 1, operation: "local-emergency-reconciliation", issuedAt: now.toISOString() }
  ]) {
    withMarker(marker, (markerPath) => {
      assert.equal(inspectOperatingMaintenanceMarker({ markerPath, now }).state, "invalid");
    });
  }
});
