import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  MAX_JSON_STORE_BYTES,
  finalizeSentMessageCleanup,
  mergeCandidatePreferenceResponse,
  mergeMealEvent,
  mutateCoffeeParticipation,
  prepareSentMessageCleanup,
  readJson,
  readJsonAt,
  updateMealEventById,
  updateMealEventsByIdAtomically,
  updateVerifiedCandidateStore,
  validateDeliveryOutboxStore,
  withJsonStoreLockAt,
  writeJson,
  writeJsonAt
} from "../src/storage.js";

const RESPONDENT_ID = "12345678-1234-5abc-adef-123456789abc";

test("storage rejects paths outside the managed data directory", () => {
  assert.throws(() => readJson("../secret.json", {}), /Invalid data file name/u);
  assert.throws(() => writeJson("not-json.txt", {}), /Invalid data file name/u);
});

test("storage writes atomically and reads a cloned JSON value", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-storage-"));
  try {
    writeJsonAt(dataDir, "state.json", { version: 1, values: [1, 2, 3] });
    assert.deepEqual(readJsonAt(dataDir, "state.json", {}), { version: 1, values: [1, 2, 3] });
    assert.equal(fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("storage returns a clone of the fallback for a missing file", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-storage-"));
  try {
    const fallback = { items: [] };
    const result = readJsonAt(dataDir, "missing.json", fallback);
    result.items.push("changed");
    assert.deepEqual(fallback, { items: [] });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("storage recovers a corrupt primary from the last valid backup", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-storage-"));
  try {
    writeJsonAt(dataDir, "state.json", { version: 1, value: "first" });
    writeJsonAt(dataDir, "state.json", { version: 1, value: "second" });
    fs.writeFileSync(path.join(dataDir, "state.json"), "{broken", "utf8");
    assert.deepEqual(readJsonAt(dataDir, "state.json", {}), { version: 1, value: "first" });
    writeJsonAt(dataDir, "state.json", { version: 1, value: "repaired" });
    assert.deepEqual(readJsonAt(dataDir, "state.json", {}), { version: 1, value: "repaired" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "state.json.bak"), "utf8")), { version: 1, value: "first" });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("storage fails closed when primary and backup are both invalid", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-storage-"));
  try {
    fs.writeFileSync(path.join(dataDir, "state.json"), "{broken", "utf8");
    fs.writeFileSync(path.join(dataDir, "state.json.bak"), "{also-broken", "utf8");
    assert.throws(() => readJsonAt(dataDir, "state.json", {}), /primary and backup are invalid/u);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("candidate preference storage is first-write-wins per pseudonymous response ID", () => {
  const response = {
    responseId: "response-1",
    date: "2026-07-14",
    mealType: "저녁",
    source: "scheduled-cache",
    channel: "C123ABC",
    messageTs: "123.456",
    ratings: [
      { category: "도시락", restaurant: "밥집", menu: "제육", rating: 5 },
      { category: "중식", restaurant: "반점", menu: "짬뽕", rating: 3 },
      { category: "돈까스", restaurant: "카츠집", menu: "돈카츠", rating: 1 }
    ],
    submittedAt: "2026-07-14T00:00:00.000Z"
  };
  const first = mergeCandidatePreferenceResponse({ version: 1, responses: [] }, response, {
    now: new Date("2026-07-14T00:00:01.000Z")
  });
  const changed = {
    ...response,
    ratings: response.ratings.map((item) => ({ ...item, rating: 1 })),
    submittedAt: "2026-07-14T00:01:00.000Z"
  };
  const duplicate = mergeCandidatePreferenceResponse(first.store, changed, {
    now: new Date("2026-07-14T00:01:01.000Z")
  });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.store.responses.length, 1);
  assert.deepEqual(duplicate.response.ratings.map((item) => item.rating), [5, 3, 1]);
  assert.equal(duplicate.response.updatedAt, "2026-07-14T00:00:00.000Z");
});

test("meal storage is first-write-wins per user, date, and meal slot", () => {
  const event = {
    eventId: "meal-1",
    respondentId: RESPONDENT_ID,
    date: "2026-07-14",
    mealType: "저녁",
    source: "scheduled-cache",
    restaurant: "밥집",
    menu: "제육",
    rating: 5,
    tags: [],
    channel: "C123ABC",
    messageTs: "123.456",
    createdAt: "2026-07-14T00:00:00.000Z"
  };
  const first = mergeMealEvent({ version: 1, events: [] }, event, {
    now: new Date("2026-07-14T00:00:01.000Z")
  });
  const duplicate = mergeMealEvent(first.store, {
    ...event,
    eventId: "meal-2",
    menu: "조작된 반복 입력",
    messageTs: "999.999",
    createdAt: "2026-07-14T00:01:00.000Z"
  }, { now: new Date("2026-07-14T00:01:01.000Z") });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.store.events.length, 1);
  assert.equal(duplicate.event.menu, "제육");
  assert.equal(duplicate.event.eventId, "meal-1");
});

test("storage merge helpers validate new records against the operation clock", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  assert.throws(() => mergeMealEvent({ version: 1, events: [] }, {
    eventId: "meal-future",
    menu: "제육",
    mealType: "점심",
    tags: [],
    createdAt: "2026-07-14T00:05:00.001Z"
  }, { now }), /more than five minutes in the future/u);

  assert.throws(() => mergeCandidatePreferenceResponse({ version: 1, responses: [] }, {
    responseId: "preference-future",
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt: "2026-07-14T00:05:00.001Z",
    ratings: [
      { category: "도시락", restaurant: "밥집", menu: "제육", rating: 5 },
      { category: "중식", restaurant: "반점", menu: "짬뽕", rating: 3 },
      { category: "돈까스", restaurant: "카츠집", menu: "돈카츠", rating: 1 }
    ]
  }, { now }), /more than five minutes in the future/u);
});

test("durable delivery outbox validates the exact scheduled payload contract", () => {
  const valid = {
    version: 1,
    deliveries: [{
      clientMsgId: "12345678-1234-5abc-adef-123456789abc",
      channel: "C123ABC",
      mealType: "점심",
      source: "scheduled-cache",
      requestedMode: "cache",
      preparedAt: "2026-07-16T00:00:00.000Z",
      response: {
        text: "추천 본문",
        blocks: [{ type: "section" }],
        recommendations: [
          { category: "도시락", restaurant: "한식집", menu: "제육덮밥", priceText: "9,000원", comment: "매콤한 제육 양념과 따뜻한 밥이 든든하게 어우러져, 한입마다 진한 감칠맛을 즐길 수 있습니다.", evidence: ["test fixture evidence"] },
          { category: "중식", restaurant: "중식집", menu: "짬뽕", priceText: "10,000원", comment: "칼칼한 국물과 풍성한 해물이 조화롭게 어우러져, 따뜻하게 먹을수록 깊은 풍미가 살아납니다.", evidence: ["test fixture evidence"] },
          { category: "돈까스", restaurant: "일식집", menu: "돈카츠", priceText: "11,000원", comment: "바삭한 튀김옷과 촉촉한 고기가 진한 소스와 어우러져, 한입마다 고소한 풍미가 살아납니다.", evidence: ["test fixture evidence"] }
        ],
        generationMode: "cache",
        fallbackUsed: false
      }
    }]
  };
  assert.deepEqual(validateDeliveryOutboxStore(valid), { deliveryCount: 1 });
  assert.throws(
    () => validateDeliveryOutboxStore(valid, { now: new Date("2026-07-15T23:54:59.999Z") }),
    /more than five minutes in the future/u
  );
  assert.throws(
    () => validateDeliveryOutboxStore({ ...valid, deliveries: [valid.deliveries[0], valid.deliveries[0]] }),
    /valid and unique/u
  );
  const oversizedBlocks = structuredClone(valid);
  oversizedBlocks.deliveries[0].response.blocks = [{
    type: "actions",
    block_id: "x".repeat(256),
    elements: []
  }];
  assert.throws(() => validateDeliveryOutboxStore(oversizedBlocks), /exceeds 255/u);
});

test("per-store locks time out on live or fresh malformed owners and reap safe stale owners", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lock-"));
  const lockPath = path.join(dataDir, "state.json.lock");
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live" }));
    assert.throws(
      () => withJsonStoreLockAt(dataDir, "state.json", () => {}, { waitMs: 20, pollMs: 5 }),
      /Timed out/u
    );
    fs.rmSync(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "reused-pid" }));
    const reusedPidStale = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, reusedPidStale, reusedPidStale);
    assert.equal(withJsonStoreLockAt(dataDir, "state.json", () => "live-stale-reaped", {
      liveStaleMs: 30000
    }), "live-stale-reaped");
    fs.writeFileSync(lockPath, "{");
    assert.throws(
      () => withJsonStoreLockAt(dataDir, "state.json", () => {}, { waitMs: 20, pollMs: 5 }),
      /Timed out/u
    );
    const stale = new Date(Date.now() - 61_000);
    fs.utimesSync(lockPath, stale, stale);
    assert.equal(withJsonStoreLockAt(dataDir, "state.json", () => "reaped"), "reaped");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "dead" }));
    assert.equal(withJsonStoreLockAt(dataDir, "state.json", () => "dead-reaped"), "dead-reaped");
    const guardPath = `${lockPath}.reap`;
    fs.writeFileSync(guardPath, JSON.stringify({ pid: process.pid, token: "guard" }));
    assert.throws(
      () => withJsonStoreLockAt(dataDir, "state.json", () => {}, { waitMs: 20, pollMs: 5 }),
      /Timed out/u
    );
    const staleGuard = new Date(Date.now() - 120000);
    fs.utimesSync(guardPath, staleGuard, staleGuard);
    assert.equal(withJsonStoreLockAt(dataDir, "state.json", () => "guard-reaped"), "guard-reaped");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("JSON stores reject oversized primaries before parsing and can recover a bounded backup", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-store-size-"));
  try {
    fs.writeFileSync(path.join(dataDir, "state.json"), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    assert.throws(() => readJsonAt(dataDir, "state.json", {}), /safety limit/u);
    fs.writeFileSync(path.join(dataDir, "state.json.bak"), '{"ok":true}\n');
    assert.deepEqual(readJsonAt(dataDir, "state.json", {}), { ok: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("per-store locks serialize read-modify-write across processes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lock-process-"));
  const statePath = path.join(dataDir, "counter.json");
  fs.writeFileSync(statePath, JSON.stringify({ count: 0 }));
  const storageUrl = pathToFileURL(path.resolve("src/storage.js")).href;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { withJsonStoreLockAt } from ${JSON.stringify(storageUrl)};
    const dataDir = process.argv[1];
    withJsonStoreLockAt(dataDir, "counter.json", () => {
      const file = path.join(dataDir, "counter.json");
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
      fs.writeFileSync(file, JSON.stringify({ count: value.count + 1 }));
    });
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  try {
    await Promise.all([run(), run()]);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { count: 2 });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Windows lock contention serializes three processes", async () => {
  if (process.platform !== "win32") return;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-lock-eperm-"));
  const statePath = path.join(dataDir, "counter.json");
  fs.writeFileSync(statePath, JSON.stringify({ count: 0 }));
  const storageUrl = pathToFileURL(path.resolve("src/storage.js")).href;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { withJsonStoreLockAt } from ${JSON.stringify(storageUrl)};
    const dataDir = process.argv[1];
    withJsonStoreLockAt(dataDir, "counter.json", () => {
      const file = path.join(dataDir, "counter.json");
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      fs.writeFileSync(file, JSON.stringify({ count: value.count + 1 }));
    });
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  try {
    await Promise.all([run(), run(), run()]);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { count: 3 });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("atomic coffee mutations preserve different messages across processes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-coffee-process-"));
  const storageUrl = pathToFileURL(path.resolve("src/storage.js")).href;
  const script = `
    import { mutateCoffeeParticipation } from ${JSON.stringify(storageUrl)};
    const dataDir = process.argv[1];
    const channel = process.argv[2];
    mutateCoffeeParticipation((store) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
      store.messages.push({
        channel,
        messageTs: channel === "C111AAA" ? "111.111" : "222.222",
        userIds: [channel === "C111AAA" ? "U111AAA" : "U222BBB"],
        updatedAt: "2026-07-16T00:00:00.000Z"
      });
    }, { dataDir });
  `;
  const run = (channel) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir, channel], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  try {
    await Promise.all([run("C111AAA"), run("C222BBB")]);
    const saved = readJsonAt(dataDir, "coffee-participation.json", null);
    assert.deepEqual(saved.messages.map((item) => item.channel).sort(), ["C111AAA", "C222BBB"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("atomic coffee mutation helper validates before committing", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-coffee-validate-"));
  try {
    assert.throws(() => mutateCoffeeParticipation((store) => {
      store.messages.push({ channel: "invalid", messageTs: "nope", userIds: [], updatedAt: "invalid" });
    }, { dataDir }), /coffee participation/u);
    assert.equal(fs.existsSync(path.join(dataDir, "coffee-participation.json")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cleanup intent is durable before deletion and finalization preserves its tombstone", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-cleanup-store-"));
  const base = (ts) => ({
    channel: "C123ABC", ts, mealType: "점심", source: "scheduled-cache", sentAt: "2026-07-16T00:00:00.000Z"
  });
  try {
    writeJsonAt(dataDir, "sent-messages.json", {
      version: 1,
      messages: [base("100.1"), base("300.1"), base("200.1")]
    });
    const intended = prepareSentMessageCleanup("C123ABC", {
      keepRecentMessages: 1,
      now: new Date("2026-07-16T01:00:00.000Z"),
      dataDir
    });
    assert.deepEqual(intended.map((item) => item.ts).sort(), ["100.1", "200.1"]);
    assert.ok(intended.every((item) => item.deletionRequestedAt));
    finalizeSentMessageCleanup({ channel: "C123ABC", ts: "100.1" }, {
      now: new Date("2026-07-16T01:01:00.000Z"),
      dataDir
    });
    const saved = readJsonAt(dataDir, "sent-messages.json", null);
    assert.ok(saved.messages.find((item) => item.ts === "100.1").deletedAt);
    assert.ok(saved.messages.find((item) => item.ts === "200.1").deletionRequestedAt);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("atomic meal event update preserves other concurrently present feedback rows", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-meal-update-"));
  const event = (eventId, menu) => ({
    eventId, menu, mealType: "점심", tags: [], createdAt: "2026-07-16T00:00:00.000Z"
  });
  try {
    writeJsonAt(dataDir, "meal-events.json", { version: 1, events: [event("E1", "제육"), event("E2", "짬뽕")] });
    updateMealEventById("E1", (current) => ({ ...current, normalizationStatus: "pending" }), { dataDir });
    const saved = readJsonAt(dataDir, "meal-events.json", null);
    assert.equal(saved.events.length, 2);
    assert.equal(saved.events.find((item) => item.eventId === "E1").normalizationStatus, "pending");
    assert.equal(saved.events.find((item) => item.eventId === "E2").menu, "짬뽕");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("atomic meal event batch update commits all rows once or leaves every row unchanged", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-meal-batch-"));
  const event = (eventId, menu) => ({
    eventId, menu, mealType: "점심", tags: [], createdAt: "2026-07-16T00:00:00.000Z"
  });
  const now = new Date("2026-07-16T01:00:00.000Z");
  try {
    const initial = { version: 1, events: [event("E1", "제육"), event("E2", "짬뽕")] };
    writeJsonAt(dataDir, "meal-events.json", initial);
    assert.throws(() => updateMealEventsByIdAtomically(["E1", "E2"], (current, eventId) => {
      if (eventId === "E2") throw new Error("semantic validation failed");
      return { ...current, normalizationStatus: "pending" };
    }, { dataDir, now }), /semantic validation failed/u);
    assert.deepEqual(readJsonAt(dataDir, "meal-events.json", null), initial);

    const updated = updateMealEventsByIdAtomically(["E1", "E2"], (current) => ({
      ...current,
      normalizationStatus: "pending"
    }), { dataDir, now });
    assert.equal(updated.length, 2);
    assert.ok(readJsonAt(dataDir, "meal-events.json", null).events.every(
      (item) => item.normalizationStatus === "pending"
    ));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("atomic verified candidate mutation validates before and after mutation without partial writes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-candidate-update-"));
  const initial = { version: 1, candidates: [], catalog: [] };
  const validate = (store) => {
    if (store?.version !== 1 || !Array.isArray(store.candidates) || !Array.isArray(store.catalog)) {
      throw new Error("invalid candidate store");
    }
  };
  try {
    writeJsonAt(dataDir, "verified-candidates.json", initial);
    const saved = updateVerifiedCandidateStore((current) => ({
      ...current,
      catalog: [{ restaurant: "새 카탈로그" }]
    }), { dataDir, validate });
    assert.equal(saved.catalog[0].restaurant, "새 카탈로그");

    assert.throws(() => updateVerifiedCandidateStore((current) => ({
      ...current,
      catalog: null
    }), { dataDir, validate }), /invalid candidate store/u);
    assert.deepEqual(readJsonAt(dataDir, "verified-candidates.json", null), saved);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("oversized UTF-8 and non-JSON writes preserve the primary and recovery copy", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-store-write-bound-"));
  try {
    writeJsonAt(dataDir, "state.json", { version: 1, value: "backup" });
    writeJsonAt(dataDir, "state.json", { version: 1, value: "primary" });
    const primaryPath = path.join(dataDir, "state.json");
    const backupPath = path.join(dataDir, "state.json.bak");
    const primaryBefore = fs.readFileSync(primaryPath);
    const backupBefore = fs.readFileSync(backupPath);
    const oversized = { value: "한".repeat(Math.floor(MAX_JSON_STORE_BYTES / 3) + 1) };
    assert.ok(oversized.value.length < MAX_JSON_STORE_BYTES);
    for (const synchronizeBackup of [false, true]) {
      assert.throws(
        () => writeJsonAt(dataDir, "state.json", oversized, { synchronizeBackup }),
        /byte safety limit/u
      );
      assert.deepEqual(fs.readFileSync(primaryPath), primaryBefore);
      assert.deepEqual(fs.readFileSync(backupPath), backupBefore);
    }
    assert.throws(() => writeJsonAt(dataDir, "state.json", undefined), /serializable JSON value/u);
    assert.deepEqual(fs.readFileSync(primaryPath), primaryBefore);
    assert.deepEqual(fs.readFileSync(backupPath), backupBefore);
    assert.deepEqual(fs.readdirSync(dataDir).sort(), ["state.json", "state.json.bak"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
