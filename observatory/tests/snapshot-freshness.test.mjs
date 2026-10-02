import assert from "node:assert/strict";
import test from "node:test";
import { projectSnapshotFreshness, nextFactExpiry } from "../app/lib/snapshot-freshness.mjs";
import { loadSnapshotFromEndpoints } from "../app/lib/snapshot-loader.mjs";
import { testSnapshot } from "./helpers/snapshot-fixture.mjs";

const now = Date.parse("2026-10-03T00:00:00Z");
const stamp = (delta) => new Date(now + delta).toISOString();
function facts() {
  return { menus: [{ id: "dish", priceText: "8,300원", priceCheckedAt: stamp(-1_000), priceExpiresAt: stamp(1_000),
    availabilityCheckedAt: stamp(-1_000), availabilityExpiresAt: stamp(2_000), deliveryStatus: "likely", deliveryFreshness: "current", availableNow: true,
    sources: ["verified", "history"], taste: { mean: 0.65 }, occurrences: 10 }], stats: { freshCandidates: 1, menus: 1 } };
}

test("fact expiry clears price at boundary, delivery independently, preserves history and source object", () => {
  const source = facts();
  assert.equal(projectSnapshotFreshness(source, now).menus[0].priceText, "8,300원");
  const expiredPrice = projectSnapshotFreshness(source, now + 1_000);
  assert.equal(expiredPrice.menus[0].priceText, "가격 정보 없음");
  assert.equal(expiredPrice.menus[0].deliveryStatus, "likely");
  assert.equal(expiredPrice.stats.freshCandidates, 0);
  const expiredAll = projectSnapshotFreshness(source, now + 2_000);
  assert.equal(expiredAll.menus[0].deliveryStatus, null);
  assert.equal(expiredAll.menus[0].availabilityExpiresAt, null);
  assert.deepEqual(expiredAll.menus[0].taste, source.menus[0].taste);
  assert.equal(expiredAll.menus[0].occurrences, 10);
  assert.equal(source.menus[0].priceText, "8,300원");
  assert.equal(nextFactExpiry(source, now), now + 1_000);
  assert.equal(nextFactExpiry(source, now + 2_000), null);
});

test("legacy price without evidence is hidden, current catalog price stays visible independently of active pool", () => {
  const snapshot = facts();
  snapshot.menus[0].availableNow = false;
  snapshot.menus[0].sources = ["catalog"];
  assert.equal(projectSnapshotFreshness(snapshot, now).menus[0].priceText, "8,300원");
  snapshot.menus[0].priceCheckedAt = null;
  snapshot.menus[0].priceExpiresAt = null;
  assert.equal(projectSnapshotFreshness(snapshot, now).menus[0].priceText, "가격 정보 없음");
});

test("API timeout still attempts static fallback with a fresh signal", async () => {
  const fixture = testSnapshot(); const calls = [];
  const result = await loadSnapshotFromEndpoints({ deadlines: [5, 1000], fetchImpl: async (endpoint, { signal }) => {
    calls.push(endpoint);
    if (calls.length === 1) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    assert.equal(signal.aborted, false);
    return new Response(JSON.stringify(fixture), { status: 200 });
  }});
  assert.deepEqual(calls, ["/api/snapshot/current", "/data/snapshot.json"]);
  assert.deepEqual(result.menus, fixture.menus);
});

test("unmount cancellation never attempts a fallback", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(loadSnapshotFromEndpoints({ signal: controller.signal, deadlines: [1000, 1000], fetchImpl: async () => {
    calls++; controller.abort(); throw new DOMException("Aborted", "AbortError");
  }}), /Aborted/);
  assert.equal(calls, 1);
});
