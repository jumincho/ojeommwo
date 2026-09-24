import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BOT_ROOT } from "../scripts/lib/bot-contract.mjs";
import { SNAPSHOT_INPUT_FILES } from "../scripts/lib/observatory-snapshot.mjs";
import { validateSnapshot } from "../scripts/lib/snapshot-schema.mjs";
import {
  parseCliArgs,
  startLocalEmergencyViewer,
  validatePort,
} from "../scripts/run-local-emergency-viewer.mjs";

const SOURCE_FILES = [...SNAPSHOT_INPUT_FILES, "coffee-participation.json", "delivery-outbox.json"];

function createFixture({ withOut = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-local-emergency-"));
  const botRoot = path.join(root, "ojeommwo-v2");
  const dataDir = path.join(botRoot, "data");
  const runtimeDir = path.join(root, "runtime");
  const outDir = path.join(root, "out");
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of SOURCE_FILES) fs.copyFileSync(path.join(BOT_ROOT, "data", name), path.join(dataDir, name));
  fs.copyFileSync(path.join(BOT_ROOT, "package.json"), path.join(botRoot, "package.json"));

  const generatedAt = new Date();
  const checkedAt = new Date(generatedAt.getTime() - 60_000).toISOString();
  const verifiedPath = path.join(dataDir, "verified-candidates.json");
  const verified = JSON.parse(fs.readFileSync(verifiedPath, "utf8"));
  verified.generatedAt = checkedAt;
  verified.catalogUpdatedAt = checkedAt;
  for (const candidate of verified.candidates) {
    candidate.priceCheckedAt = checkedAt;
    candidate.deliveryCheckedAt = checkedAt;
    candidate.evidenceVerifiedAt = checkedAt;
  }
  fs.writeFileSync(verifiedPath, `${JSON.stringify(verified, null, 2)}\n`, "utf8");

  if (withOut) {
    fs.mkdirSync(path.join(outDir, "_next"), { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "index.html"),
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main id="full-static-marker">FULL STATIC UI</main><script>globalThis.__fullFixture = true;</script></body></html>',
      "utf8",
    );
    fs.writeFileSync(path.join(outDir, "_next", "fixture.js"), "globalThis.__assetFixture = true;\n", "utf8");
  }
  return { root, dataDir, runtimeDir, outDir, generatedAt: generatedAt.toISOString() };
}

function sourceBytes(dataDir) {
  return new Map(SOURCE_FILES.map((name) => [name, fs.readFileSync(path.join(dataDir, name))]));
}

function assertSourceBytesEqual(dataDir, before) {
  for (const [name, expected] of before) {
    assert.deepEqual(fs.readFileSync(path.join(dataDir, name)), expected, `${name} changed`);
  }
}

function request(viewer, requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: viewer.host,
      port: viewer.port,
      path: requestPath,
      method,
      headers: { Host: `${viewer.host}:${viewer.port}` },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("fallback viewer is loopback-only, sanitized, hardened, searchable, and leaves source data byte-identical", async (t) => {
  const fixture = createFixture();
  const before = sourceBytes(fixture.dataDir);
  const viewer = await startLocalEmergencyViewer({
    port: 0,
    dataDir: fixture.dataDir,
    runtimeDir: fixture.runtimeDir,
    outDir: fixture.outDir,
    generatedAt: fixture.generatedAt,
  });
  t.after(async () => {
    await viewer.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  assert.equal(viewer.host, "127.0.0.1");
  assert.equal(viewer.server.address().address, "127.0.0.1");
  assert.equal(viewer.mode, "fallback");
  assert.ok(viewer.port > 0);

  const health = await request(viewer, "/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), {
    status: "ok",
    service: "ojeommwo-observatory-local-emergency-viewer",
    mode: "local-emergency-read-only",
    ui: "fallback",
    schemaVersion: 2,
    generatedAt: fixture.generatedAt,
    menus: viewer.snapshot.stats.menus,
    restaurants: viewer.snapshot.stats.restaurants,
  });
  assert.match(health.headers["cache-control"], /no-store/u);
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.equal(health.headers["x-frame-options"], "DENY");
  assert.equal(health.headers["referrer-policy"], "no-referrer");
  assert.equal(health.headers["cross-origin-resource-policy"], "same-origin");
  assert.match(health.headers["permissions-policy"], /geolocation=\(\)/u);
  assert.match(health.headers["content-security-policy"], /default-src 'none'/u);
  assert.match(health.headers["content-security-policy"], /script-src 'self'/u);
  assert.doesNotMatch(health.headers["content-security-policy"], /unsafe-eval/u);

  const snapshotResponse = await request(viewer, "/data/snapshot.json");
  assert.equal(snapshotResponse.status, 200);
  const publicSnapshot = JSON.parse(snapshotResponse.body);
  assert.equal(validateSnapshot(publicSnapshot), publicSnapshot);
  assert.doesNotMatch(snapshotResponse.body, /https?:\/\//iu);
  assert.doesNotMatch(snapshotResponse.body, /"(?:address|channel|messageTs|respondentId|userId)"/iu);

  const persisted = JSON.parse(fs.readFileSync(viewer.snapshotPath, "utf8"));
  assert.equal(validateSnapshot(persisted), persisted);
  assert.deepEqual(persisted, publicSnapshot);
  assert.equal(path.dirname(viewer.snapshotPath), path.resolve(fixture.runtimeDir));

  const page = await request(viewer, "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /로컬은 비상용입니다/u);
  assert.match(page.body, /id="menu-search"/u);
  assert.match(page.body, /재료 태그/u);
  assert.match(page.body, /pork/u);
  assert.match(page.body, /<table>/u);
  const fallbackScript = await request(viewer, "/local-emergency-viewer.js");
  assert.equal(fallbackScript.status, 200);
  assert.match(fallbackScript.body, /fetch\("\/data\/snapshot\.json"/u);
  assert.match(fallbackScript.body, /textContent/u);
  assert.match(fallbackScript.body, /menu\.ingredientFamilies/u);

  for (const unsafePath of [
    "/%2e%2e/package.json",
    "/_next/%252e%252e%252fpackage.json",
    "/C:%5cWindows%5cwin.ini",
  ]) {
    const response = await request(viewer, unsafePath);
    assert.equal(response.status, 400, unsafePath);
    assert.doesNotMatch(response.body, /ojeommwo-observatory/u);
  }
  assert.equal((await request(viewer, "/package.json")).status, 404);
  assert.equal((await request(viewer, "/healthz", "POST")).status, 405);
  assert.equal((await request(viewer, "/healthz", "HEAD")).body, "");
  assertSourceBytesEqual(fixture.dataDir, before);
});

test("prebuilt out serves the full static UI with a visible emergency banner and hashed script CSP", async (t) => {
  const fixture = createFixture({ withOut: true });
  const viewer = await startLocalEmergencyViewer({
    port: 0,
    dataDir: fixture.dataDir,
    runtimeDir: fixture.runtimeDir,
    outDir: fixture.outDir,
    generatedAt: fixture.generatedAt,
  });
  t.after(async () => {
    await viewer.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  assert.equal(viewer.mode, "full-static");
  const page = await request(viewer, "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /FULL STATIC UI/u);
  assert.match(page.body, /로컬은 비상용입니다/u);
  assert.match(page.body, /local-emergency-viewer\.css/u);
  assert.match(page.headers["content-security-policy"], /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/u);
  assert.doesNotMatch(page.headers["content-security-policy"], /script-src[^;]*unsafe-inline/u);
  assert.doesNotMatch(page.headers["content-security-policy"], /unsafe-eval/u);

  const asset = await request(viewer, "/_next/fixture.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(asset.body, /__assetFixture/u);
});

test("unsafe ports, external bind options, and source-overlapping runtime paths fail closed", async () => {
  for (const value of [-1, 65_536, "1.5", "abc", ""] ) assert.throws(() => validatePort(value), /port/u);
  assert.equal(validatePort(0), 0);
  assert.equal(validatePort("65535"), 65_535);
  assert.throws(() => parseCliArgs(["--host", "0.0.0.0"], {}), /unknown option/u);
  assert.throws(() => parseCliArgs(["--port", "1", "--port", "2"], {}), /duplicate option/u);

  const fixture = createFixture();
  try {
    await assert.rejects(() => startLocalEmergencyViewer({
      port: 0,
      dataDir: fixture.dataDir,
      runtimeDir: path.join(fixture.dataDir, "runtime"),
      outDir: fixture.outDir,
      generatedAt: fixture.generatedAt,
    }), /runtimeDir.*outside/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
