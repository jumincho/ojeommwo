import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CHUNK_READ_CONCURRENCY, MAX_CHUNK_BYTES, SNAPSHOT_KEY,
  abortSnapshotChunks, commitSnapshotChunks, healthResponse, uploadSnapshotChunk } from "../worker/snapshot-edge.mjs";
import { pushSnapshotSites } from "../scripts/push-snapshot-sites.mjs";
import { requestSitesJson } from "../scripts/lib/sites-http.mjs";
import { TOKEN, deferred, fixtureEnvironment, snapshotFixture, stageSnapshot } from "./helpers/r2-snapshot-fixture.mjs";

test("commit replay succeeds after cleanup without reading chunks or refreshing snapshot age", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  const first = await commitSnapshotChunks(staged.request(), env, staged);
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.equal(bucket.entries.size, 1);
  const reads = bucket.reads;
  const writes = bucket.writes;
  const replay = await commitSnapshotChunks(staged.request(), env, { now: () => staged.now() + 3_600_000 });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), receipt);
  assert.equal(bucket.reads, reads);
  assert.equal(bucket.writes, writes);
  assert.equal((await healthResponse(env, { now: () => staged.now() + 3_600_000 })).status, 503);
});

test("chunk reads overlap within the concurrency cap and assemble in original order", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  assert.ok(staged.total > CHUNK_READ_CONCURRENCY);
  const get = bucket.get.bind(bucket);
  let active = 0;
  let peak = 0;
  bucket.get = async (key) => {
    active++;
    peak = Math.max(peak, active);
    await delay(Number(key.split("/").at(-1)) % 3 + 1);
    try { return await get(key); } finally { active--; }
  };
  const response = await commitSnapshotChunks(staged.request(), env, staged);
  assert.equal(response.status, 200, await response.text());
  assert.equal(peak, CHUNK_READ_CONCURRENCY);
  assert.equal(active, 0);
  assert.deepEqual(Buffer.from(bucket.entries.get(SNAPSHOT_KEY).bytes), staged.bytes);
});

test("successful response does not wait for batched chunk cleanup", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  const gate = deferred();
  const remove = bucket.delete.bind(bucket);
  let keys;
  bucket.delete = async (requested) => { keys = requested; await gate.promise; return remove(requested); };
  const background = [];
  const response = await commitSnapshotChunks(staged.request(), env, { ...staged, waitUntil: (task) => background.push(task) });
  assert.equal(response.status, 200);
  assert.equal(background.length, 1);
  assert.equal(keys.length, staged.total);
  assert.ok(bucket.entries.size > 1);
  gate.resolve();
  await Promise.all(background);
  assert.equal(bucket.entries.size, 1);
  assert.equal(bucket.deletes, 1);
});

test("cleanup failure cannot turn publication into failure and replay retries cleanup", async (t) => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  const remove = bucket.delete.bind(bucket);
  const warnings = t.mock.method(console, "warn", () => {});
  bucket.delete = async () => { throw new Error("R2 temporary delete failure"); };
  assert.equal((await commitSnapshotChunks(staged.request(), env, staged)).status, 200);
  assert.equal(warnings.mock.callCount(), 1);
  assert.ok(bucket.entries.size > 1);
  bucket.delete = remove;
  assert.equal((await commitSnapshotChunks(staged.request(), env, staged)).status, 200);
  assert.equal(bucket.entries.size, 1);
});

test("transient R2 read failure preserves all staged chunks for the next commit", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  const get = bucket.get.bind(bucket);
  let active = 0;
  bucket.get = async () => { active++; await delay(1); active--; throw new Error("storage failure with private detail"); };
  const response = await commitSnapshotChunks(staged.request(), env, staged);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private detail/u);
  assert.equal(active, 0);
  assert.equal(bucket.entries.size, staged.total);
  assert.equal(bucket.deletes, 0);
  bucket.get = get;
  assert.equal((await commitSnapshotChunks(staged.request(), env, staged)).status, 200);
});

test("commit whose R2 put succeeded but acknowledgement failed replays successfully", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  const put = bucket.put.bind(bucket);
  bucket.put = async (...args) => { await put(...args); throw new Error("R2 acknowledgement lost"); };
  assert.equal((await commitSnapshotChunks(staged.request(), env, staged)).status, 503);
  const writes = bucket.writes;
  bucket.put = put;
  assert.equal((await commitSnapshotChunks(staged.request(), env, staged)).status, 200);
  assert.equal(bucket.writes, writes);
  assert.equal(bucket.entries.size, 1);
});

test("overlapping commit succeeds if another attempt removes chunks before its reads", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  const get = bucket.get.bind(bucket);
  const entered = deferred();
  const release = deferred();
  bucket.get = async (key) => { entered.resolve(); await release.promise; return get(key); };
  const slow = commitSnapshotChunks(staged.request(), env, staged);
  await entered.promise;
  bucket.get = get;
  assert.equal((await commitSnapshotChunks(staged.request(), env, staged)).status, 200);
  release.resolve();
  assert.equal((await slow).status, 200);
});

for (const seeded of [false, true]) {
  test(`atomic publication rejects a late older commit (${seeded ? "existing" : "empty"} bucket)`, async () => {
    const { bucket, env } = fixtureEnvironment();
    if (seeded) {
      const initial = await stageSnapshot(env, snapshotFixture(-10_000));
      assert.equal((await commitSnapshotChunks(initial.request(), env, initial)).status, 200);
    }
    const older = await stageSnapshot(env);
    const newer = await stageSnapshot(env, snapshotFixture(1_000));
    const put = bucket.put.bind(bucket);
    const entered = deferred();
    const release = deferred();
    bucket.put = async (...args) => {
      if (args[0] === SNAPSHOT_KEY && args[2]?.customMetadata?.sha256 === older.uploadId) {
        entered.resolve(); await release.promise;
      }
      return put(...args);
    };
    const slow = commitSnapshotChunks(older.request(), env, older);
    await entered.promise;
    assert.equal((await commitSnapshotChunks(newer.request(), env, newer)).status, 200);
    release.resolve();
    assert.equal((await slow).status, 409);
    assert.equal((await bucket.head(SNAPSHOT_KEY)).customMetadata.sha256, newer.uploadId);
  });
}

test("concurrent identical commits both succeed with only one snapshot write", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  const put = bucket.put.bind(bucket);
  const ready = deferred();
  let arrivals = 0;
  bucket.put = async (...args) => {
    if (args[0] === SNAPSHOT_KEY) { if (++arrivals === 2) ready.resolve(); await ready.promise; }
    return put(...args);
  };
  const writes = bucket.writes;
  const replies = await Promise.all([commitSnapshotChunks(staged.request(), env, staged), commitSnapshotChunks(staged.request(), env, staged)]);
  assert.deepEqual(replies.map((response) => response.status), [200, 200]);
  assert.equal(bucket.writes, writes + 1);
});

test("storage outages in chunk upload and abort remain retryable", async () => {
  const { bucket, env } = fixtureEnvironment();
  const staged = await stageSnapshot(env);
  bucket.put = async () => { throw new Error("unavailable"); };
  const chunk = new Request("https://example.test/api/snapshot/chunk", { headers: {
    ...staged.headers, "X-Snapshot-Index": "0", "X-Snapshot-Chunk": "YQ",
  } });
  assert.equal((await uploadSnapshotChunk(chunk, env)).status, 503);
  bucket.delete = async () => { throw new Error("unavailable"); };
  assert.equal((await abortSnapshotChunks(new Request("https://example.test/api/snapshot/abort", { headers: staged.headers }), env)).status, 503);
});

test("invalid commit and damaged chunks cannot replace a published snapshot", async () => {
  const { bucket, env } = fixtureEnvironment();
  const good = await stageSnapshot(env);
  assert.equal((await commitSnapshotChunks(good.request(), env, good)).status, 200);
  const next = await stageSnapshot(env, snapshotFixture(1_000));
  const key = `uploads/${next.uploadId}/00`;
  bucket.entries.get(key).bytes = new Uint8Array(MAX_CHUNK_BYTES + 1);
  assert.equal((await commitSnapshotChunks(next.request(), env, next)).status, 400);
  const wrongHash = next.request();
  wrongHash.headers.set("X-Snapshot-SHA256", "0".repeat(64));
  assert.equal((await commitSnapshotChunks(wrongHash, env, next)).status, 400);
  const unauthorized = good.request();
  unauthorized.headers.delete("Authorization");
  assert.equal((await commitSnapshotChunks(unauthorized, env, good)).status, 401);
  assert.equal((await bucket.head(SNAPSHOT_KEY)).customMetadata.sha256, good.uploadId);
});

test("client recovers a lost successful commit response with the exact same content hash", async () => {
  const { bucket, env } = fixtureEnvironment();
  const snapshot = snapshotFixture();
  let commits = 0;
  let commitTimeout;
  const receipt = await pushSnapshotSites({ snapshot: Buffer.from(JSON.stringify(snapshot)), publicUrl: "https://example.test/", token: TOKEN }, {
    requestJson: (url, headers, options) => {
      if (url.endsWith("/commit")) commitTimeout = options.timeoutMs;
      return requestSitesJson(url, headers, { ...options, sleep: async () => {}, fetchImpl: async (url, init) => {
        const request = new Request(url, init);
        if (url.endsWith("/chunk")) return uploadSnapshotChunk(request, env);
        if (url.endsWith("/abort")) return abortSnapshotChunks(request, env);
        const response = await commitSnapshotChunks(request, env, { now: () => Date.parse(snapshot.generatedAt) });
        assert.equal(response.status, 200);
        if (++commits === 1) throw new TypeError("successful response lost in transit");
        return response;
      } });
    },
  });
  assert.equal(commitTimeout, 45_000);
  assert.equal(receipt.commitAttempts, 2);
  assert.equal(receipt.retries, 1);
  assert.equal(receipt.timeouts, 0);
  assert.equal(receipt.sha256, (await bucket.head(SNAPSHOT_KEY)).customMetadata.sha256);
  assert.equal(bucket.entries.size, 1);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(TOKEN, "u"));
});

test("client aborts staged chunks on a permanent rejection without masking the original error", async () => {
  const requests = [];
  await assert.rejects(pushSnapshotSites({ snapshot: Buffer.from("{}"), publicUrl: "https://example.test/", token: TOKEN }, {
    requestJson: async (url, _headers, options) => {
      requests.push({ url, options });
      if (url.endsWith("/abort")) throw new Error("abort also unavailable");
      throw new Error("original rejection");
    },
  }), /original rejection/u);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/abort$/u);
  assert.equal(requests[1].options.timeoutMs, 5_000);
  assert.equal(requests[1].options.attempts, 1);
});
