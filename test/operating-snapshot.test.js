import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateOperatingSnapshotDirectory } from "../src/operating-snapshot.js";
import { config } from "../src/config.js";

function writeStore(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeEmptySnapshot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-snapshot-"));
  writeStore(directory, "recommendation-history.json", { version: 1, items: [] });
  writeStore(directory, "sent-messages.json", { version: 1, messages: [] });
  writeStore(directory, "meal-events.json", { version: 1, events: [] });
  writeStore(directory, "verified-candidates.json", { version: 1, candidates: [] });
  writeStore(directory, "candidate-preferences.json", { version: 1, responses: [] });
  writeStore(directory, "coffee-participation.json", { version: 1, messages: [] });
  return directory;
}

test("operating snapshot deeply validates every required store and an optional empty outbox", () => {
  const directory = makeEmptySnapshot();
  try {
    const result = validateOperatingSnapshotDirectory(directory, {
      now: new Date("2026-07-16T00:00:00.000Z")
    });
    assert.equal(result.version, 1);
    assert.equal(result.counts.history.itemCount, 0);
    assert.equal(result.counts.deliveryOutbox.deliveryCount, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("operating snapshot fails closed when a core store is missing", () => {
  const directory = makeEmptySnapshot();
  try {
    fs.rmSync(path.join(directory, "candidate-preferences.json"));
    assert.throws(
      () => validateOperatingSnapshotDirectory(directory),
      /missing candidate-preferences\.json/u
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("operating snapshot rejects a malformed durable delivery outbox", () => {
  const directory = makeEmptySnapshot();
  try {
    writeStore(directory, "delivery-outbox.json", {
      version: 1,
      deliveries: [{ clientMsgId: "not-a-uuid" }]
    });
    assert.throws(
      () => validateOperatingSnapshotDirectory(directory),
      /client message IDs must be valid/u
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("operating snapshot rejects more than 12 persisted active candidates", () => {
  const directory = makeEmptySnapshot();
  try {
    writeStore(directory, "verified-candidates.json", {
      version: 1,
      candidates: Array.from({ length: 13 }, () => ({}))
    });
    assert.throws(
      () => validateOperatingSnapshotDirectory(directory),
      /at most 12 candidates/u
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("operating snapshot prevents catalog timestamps from choosing their own future validation clock", () => {
  const directory = makeEmptySnapshot();
  const now = new Date("2026-07-16T00:00:00.000Z");
  const catalogCandidate = {
    category: "도시락",
    restaurant: "밥집",
    branch: "전북대점",
    address: "전주시 덕진구 테스트로 1",
    latitude: 35.848,
    longitude: 127.134,
    menu: "제육덮밥",
    priceText: "9,000원",
    priceChannel: "store",
    priceCheckedAt: "2026-07-17T00:00:00.000Z",
    deliveryStatus: "likely",
    deliveryCheckedAt: "2026-07-17T00:00:00.000Z",
    priceEvidenceUrl: "https://example.com/price",
    deliveryEvidenceUrl: "https://example.com/delivery",
    comment: "매콤한 제육 양념이 따뜻한 밥과 든든하게 어우러져, 한입마다 진한 감칠맛을 즐길 수 있습니다.",
    evidence: ["https://example.com/source"]
  };
  try {
    writeStore(directory, "verified-candidates.json", {
      version: 1,
      generatedAt: now.toISOString(),
      catalogUpdatedAt: now.toISOString(),
      target: {
        name: config.locationName,
        latitude: config.targetLatitude,
        longitude: config.targetLongitude,
        maxDistanceKm: config.researchDistanceKm
      },
      candidates: [],
      catalog: [catalogCandidate]
    });
    assert.throws(
      () => validateOperatingSnapshotDirectory(directory, { now }),
      /more than five minutes in the future/u
    );

    writeStore(directory, "verified-candidates.json", {
      version: 1,
      generatedAt: "2026-07-16T00:00:00.000Z",
      catalogUpdatedAt: "2026-07-15T23:59:59.999Z",
      target: {
        name: config.locationName,
        latitude: config.targetLatitude,
        longitude: config.targetLongitude,
        maxDistanceKm: config.researchDistanceKm
      },
      candidates: [],
      catalog: [{
        ...catalogCandidate,
        priceCheckedAt: "2026-07-15T23:00:00.000Z",
        deliveryCheckedAt: "2026-07-15T23:00:00.000Z"
      }]
    });
    assert.throws(
      () => validateOperatingSnapshotDirectory(directory, { now }),
      /catalog update predates its generation/u
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("snapshot location contract rejects missing, non-numeric, and coerced coordinates", () => {
  const directory = makeEmptySnapshot();
  const now = new Date("2026-07-16T00:00:00.000Z");
  const target = {
    name: config.locationName,
    latitude: config.targetLatitude,
    longitude: config.targetLongitude,
    maxDistanceKm: config.researchDistanceKm
  };
  const store = {
    version: 1,
    generatedAt: now.toISOString(),
    target,
    candidates: [],
    catalog: [{
      category: "한식", restaurant: "밥집", branch: "전북대점",
      address: "전주시 덕진구 테스트로 1", latitude: 35.848, longitude: 127.134,
      menu: "제육덮밥", priceText: "9,000원", priceChannel: "store",
      priceCheckedAt: now.toISOString(), deliveryStatus: "likely",
      deliveryCheckedAt: now.toISOString(),
      priceEvidenceUrl: "https://example.com/price",
      deliveryEvidenceUrl: "https://example.com/delivery",
      comment: "매콤한 제육 양념이 부드러운 고기에 고르게 배어, 따뜻한 밥과 함께 먹을수록 감칠맛이 살아납니다.",
      evidence: ["https://example.com/source"]
    }]
  };
  try {
    writeStore(directory, "verified-candidates.json", store);
    assert.equal(validateOperatingSnapshotDirectory(directory, { now }).counts.verifiedCandidates.catalogCount, 1);
    for (const field of ["latitude", "longitude", "maxDistanceKm"]) {
      for (const value of [undefined, null, "unknown", String(target[field]), {}]) {
        writeStore(directory, "verified-candidates.json", {
          ...store, target: { ...target, [field]: value }
        });
        assert.throws(
          () => validateOperatingSnapshotDirectory(directory, { now }),
          /target does not match the runtime location contract/u,
          field + " " + String(value)
        );
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
