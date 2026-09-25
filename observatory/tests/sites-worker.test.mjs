import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  EXPECTED_RELEASE,
  MAX_SNAPSHOT_BYTES,
  MAX_CHUNK_BYTES,
  MAX_HTML_SECURITY_BYTES,
  addResponseSecurity,
  commitSnapshotChunks,
  healthResponse,
  serveSnapshot,
  uploadSnapshot,
  uploadSnapshotChunk,
} from "../worker/snapshot-edge.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "fixture-token-with-at-least-thirty-two-bytes";

import { MemoryBucket } from "./helpers/r2-snapshot-fixture.mjs";

function loadCurrentSnapshot() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "public", "data", "snapshot.json"), "utf8"));
}

function requestFor(snapshot, { token = TOKEN, headers = {} } = {}) {
  return new Request("https://observatory.example/api/snapshot", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(snapshot),
  });
}

function fixtureEnvironment() {
  const bucket = new MemoryBucket();
  return {
    bucket,
    env: {
      SNAPSHOT_PUSH_TOKEN: TOKEN,
      SNAPSHOTS: bucket,
      ASSETS: { fetch: async () => new Response("static fallback", { status: 200 }) },
    },
  };
}

test("Sites snapshot upload validates, stores, serves, and health-checks one exact release", async () => {
  const snapshot = loadCurrentSnapshot();
  const clock = () => Date.parse(snapshot.generatedAt) + 60_000;
  const { env } = fixtureEnvironment();
  const upload = await uploadSnapshot(requestFor(snapshot), env, { now: clock });
  const receipt = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(receipt));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u);

  const served = await serveSnapshot(new Request("https://observatory.example/api/snapshot/current"), env);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("cache-control"), "no-store, max-age=0, must-revalidate");
  assert.equal(served.headers.get("x-snapshot-sha256"), receipt.sha256);
  assert.deepEqual(await served.json(), snapshot);

  const health = await healthResponse(env, { now: clock });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "ojeommwo-observatory",
    releaseVersion: EXPECTED_RELEASE,
    generatedAt: snapshot.generatedAt,
    ageSeconds: 60,
  });
});

test("missing local asset binding returns a bounded starting response instead of throwing", async () => {
  const env = {
    SNAPSHOTS: { get: async () => null },
  };
  const served = await serveSnapshot(new Request("http://localhost:3000/api/snapshot/current"), env);
  assert.equal(served.status, 503);
  assert.deepEqual(await served.json(), {
    status: "starting",
    service: "ojeommwo-observatory",
    reason: "snapshot is not available yet",
  });
});

test("Sites chunked GET transport reconstructs and publishes one byte-exact snapshot", async () => {
  const snapshot = loadCurrentSnapshot();
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const uploadId = crypto.createHash("sha256").update(bytes).digest("hex");
  const encoded = zlib.gzipSync(bytes, { level: 9 });
  const chunks = [];
  for (let offset = 0; offset < encoded.byteLength; offset += MAX_CHUNK_BYTES) {
    chunks.push(encoded.subarray(offset, Math.min(encoded.byteLength, offset + MAX_CHUNK_BYTES)));
  }
  const { env } = fixtureEnvironment();
  const clock = () => Date.parse(snapshot.generatedAt) + 60_000;

  for (const [index, chunk] of chunks.entries()) {
    const response = await uploadSnapshotChunk(new Request("https://observatory.example/api/snapshot/chunk", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "X-Snapshot-Upload": uploadId,
        "X-Snapshot-Index": String(index),
        "X-Snapshot-Total": String(chunks.length),
        "X-Snapshot-Encoding": "gzip",
        "X-Snapshot-Chunk": chunk.toString("base64url"),
      },
    }), env);
    assert.equal(response.status, 200, await response.text());
  }

  const commit = await commitSnapshotChunks(new Request("https://observatory.example/api/snapshot/commit", {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Snapshot-Upload": uploadId,
      "X-Snapshot-SHA256": uploadId,
      "X-Snapshot-Total": String(chunks.length),
      "X-Snapshot-Encoding": "gzip",
    },
  }), env, { now: clock });
  const commitBody = await commit.json();
  assert.equal(commit.status, 200, JSON.stringify(commitBody));
  assert.equal(commitBody.sha256, uploadId);

  const served = await serveSnapshot(new Request("https://observatory.example/api/snapshot/current"), env);
  assert.equal(served.headers.get("x-snapshot-sha256"), uploadId);
  assert.deepEqual(await served.json(), snapshot);
});

test("Sites snapshot upload fails closed on authentication, size, private data, and release drift", async () => {
  const snapshot = loadCurrentSnapshot();
  const clock = () => Date.parse(snapshot.generatedAt) + 60_000;

  const unauthorized = await uploadSnapshot(requestFor(snapshot, { token: "wrong-token-that-is-still-long-enough-to-hash" }), fixtureEnvironment().env, { now: clock });
  assert.equal(unauthorized.status, 401);

  const oversized = await uploadSnapshot(requestFor(snapshot, {
    headers: { "Content-Length": String(MAX_SNAPSHOT_BYTES + 1) },
  }), fixtureEnvironment().env, { now: clock });
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).reason, /upload limit/u);

  const privateSnapshot = structuredClone(snapshot);
  privateSnapshot.source.channelId = "C0123456789";
  const privateResponse = await uploadSnapshot(requestFor(privateSnapshot), fixtureEnvironment().env, { now: clock });
  assert.equal(privateResponse.status, 400);
  assert.match((await privateResponse.json()).reason, /금지된 개인정보/u);

  const oldRelease = structuredClone(snapshot);
  oldRelease.source.releaseVersion = "0.0.0";
  const oldReleaseResponse = await uploadSnapshot(requestFor(oldRelease), fixtureEnvironment().env, { now: clock });
  assert.equal(oldReleaseResponse.status, 400);
  assert.match((await oldReleaseResponse.json()).reason, /release/u);
});

test("Sites hosting manifest and worker keep persistence scoped to the sanitized snapshot", () => {
  const hosting = JSON.parse(fs.readFileSync(path.join(ROOT, ".openai", "hosting.json"), "utf8"));
  assert.equal(hosting.project_id, "appgprj_6a5dac95abb88191ae8971c41ad2372c");
  assert.equal(hosting.d1, null);
  assert.equal(hosting.r2, "SNAPSHOTS");

  const worker = fs.readFileSync(path.join(ROOT, "worker", "index.ts"), "utf8");
  const edge = fs.readFileSync(path.join(ROOT, "worker", "snapshot-edge.mjs"), "utf8");
  assert.match(worker, /url\.pathname === SNAPSHOT_UPLOAD_PATH/u);
  assert.match(worker, /url\.pathname === SNAPSHOT_CHUNK_PATH/u);
  assert.match(worker, /url\.pathname === SNAPSHOT_COMMIT_PATH/u);
  assert.match(worker, /url\.pathname === "\/robots\.txt"[\s\S]*url\.pathname === "\/robots\.txt\/"/u);
  assert.match(worker, /User-agent: \*\\nDisallow: \/\\n/u);
  assert.match(worker, /url\.pathname === "\/icon\.svg\/"[\s\S]*env\.ASSETS\.fetch/u);
  assert.match(edge, /validateSnapshot\(JSON\.parse/u);
  assert.match(edge, /SNAPSHOT_PUSH_TOKEN/u);
  assert.match(edge, /MAX_SNAPSHOT_BYTES/u);
  assert.match(edge, /DecompressionStream\("gzip"\)/u);
  assert.doesNotMatch(`${worker}\n${edge}`, /SLACK_|recommendation-history|candidate-preferences/u);
});

test("Sites HTML security hashes byte-exact inline scripts without script unsafe-inline", async () => {
  const inlineScript = "window.__관측소 = '정상';\r\nwindow.__ready = true;";
  const externalFallback = "window.__mustNotHash = true;";
  const html = `<!doctype html><html><head><script src="/_next/static/app.js">${externalFallback}</script><script data-src="inline">${inlineScript}</script></head><body>관측소</body></html>`;
  const expectedHash = crypto.createHash("sha256").update(Buffer.from(inlineScript, "utf8")).digest("base64");
  const response = await addResponseSecurity(new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }), new URL("https://observatory.example/"));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  const csp = response.headers.get("content-security-policy") ?? "";
  const scriptDirective = csp.split(";").map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src ")) ?? "";
  assert.match(scriptDirective, /script-src 'self'/u);
  assert.ok(scriptDirective.includes(`'sha256-${expectedHash}'`), scriptDirective);
  assert.doesNotMatch(scriptDirective, /unsafe-inline/u);
  assert.ok(!scriptDirective.includes(
    crypto.createHash("sha256").update(Buffer.from(externalFallback, "utf8")).digest("base64"),
  ));
  assert.match(csp, /style-src 'self' 'unsafe-inline'/u);
});

test("Sites HTML security skips body buffering for HEAD and fails closed above its cap", async () => {
  const oversizedLength = String(MAX_HTML_SECURITY_BYTES + 1);
  const head = await addResponseSecurity(new Response("ignored", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": oversizedLength,
    },
  }), new URL("https://observatory.example/"), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.doesNotMatch(
    (head.headers.get("content-security-policy") ?? "").split(";")
      .find((directive) => directive.trim().startsWith("script-src ")) ?? "",
    /unsafe-inline/u,
  );

  const oversized = await addResponseSecurity(new Response("too large", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": oversizedLength,
    },
  }), new URL("https://observatory.example/"));
  assert.equal(oversized.status, 503);
  assert.equal(oversized.headers.get("cache-control"), "no-store");
  assert.equal(await oversized.text(), "Service unavailable");
});

test("Sites response security leaves non-HTML bodies unbuffered", async () => {
  const origin = new Response('{"status":"ok"}', {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  const secured = await addResponseSecurity(origin, new URL("https://observatory.example/api/example"));
  assert.equal(origin.bodyUsed, false);
  assert.equal(await secured.text(), '{"status":"ok"}');
  assert.doesNotMatch(
    (secured.headers.get("content-security-policy") ?? "").split(";")
      .find((directive) => directive.trim().startsWith("script-src ")) ?? "",
    /unsafe-inline/u,
  );
});


test("authenticated streaming upload stops at the byte budget before buffering the rest", async () => {
  const { env } = fixtureEnvironment();
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(128 * 1024));
      if (pulled === 20) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://observatory.example/api/snapshot", {
    method: "POST", duplex: "half", body,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
  const response = await uploadSnapshot(request, env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).reason, /snapshot.*limit/u);
  assert.ok(cancelled);
  assert.ok(pulled < 20, "must not read the complete oversized upload");
});

test("health rejects a fresh snapshot from another release and impossible future timestamps", async () => {
  const snapshot = loadCurrentSnapshot();
  const clock = () => Date.parse(snapshot.generatedAt);
  const { bucket, env } = fixtureEnvironment();
  for (const [releaseVersion, generatedAt, expectedStatus] of [
    ["older-release", snapshot.generatedAt, "release-mismatch"],
    [snapshot.source.releaseVersion, new Date(clock() + 301_000).toISOString(), "stale"],
  ]) {
    await bucket.put("snapshot.json", new TextEncoder().encode(JSON.stringify(snapshot)), {
      customMetadata: { releaseVersion, generatedAt },
    });
    const response = await healthResponse(env, { now: clock });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, expectedStatus);
  }
});

test("snapshot HEAD has no body and static fallback retains security and no-store", async () => {
  const snapshot = loadCurrentSnapshot();
  const { env } = fixtureEnvironment();
  const fallback = await serveSnapshot(new Request("https://observatory.example/api/snapshot/current", { method: "HEAD" }), env);
  assert.equal(await fallback.text(), "");
  assert.match(fallback.headers.get("cache-control"), /no-store/u);
  assert.ok(fallback.headers.get("content-security-policy"));
  await uploadSnapshot(requestFor(snapshot), env, { now: () => Date.parse(snapshot.generatedAt) });
  const stored = await serveSnapshot(new Request("https://observatory.example/api/snapshot/current", { method: "HEAD" }), env);
  assert.equal(await stored.text(), "");
  assert.ok(stored.headers.get("x-snapshot-sha256"));
});
