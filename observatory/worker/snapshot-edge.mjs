import releaseMetadata from "../package.json" with { type: "json" };
import { validateSnapshot } from "../app/lib/snapshot-validator.mjs";

export const SNAPSHOT_KEY = "snapshot.json";
export const SNAPSHOT_PATH = "/api/snapshot/current";
export const SNAPSHOT_FALLBACK_PATH = "/data/snapshot.json";
export const SNAPSHOT_UPLOAD_PATH = "/api/snapshot";
export const SNAPSHOT_CHUNK_PATH = "/api/snapshot/chunk";
export const SNAPSHOT_COMMIT_PATH = "/api/snapshot/commit";
export const SNAPSHOT_ABORT_PATH = "/api/snapshot/abort";
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_CHUNKS = 256;
export const MAX_CHUNK_BYTES = 2 * 1024;
export const MAX_ENCODED_BYTES = MAX_SNAPSHOT_BYTES + 64 * 1024;
export const MAX_UPLOAD_AGE_MS = 30 * 60 * 1000;
export const MAX_HTML_SECURITY_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_SCRIPT_COUNT = 128;
export const EXPECTED_RELEASE = releaseMetadata.version;

function contentSecurityPolicy(scriptHashes = []) {
  const scriptSources = ["'self'", ...new Set(scriptHashes).values()].join(" ");
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'none'",
  ].join("; ");
}

export function securityHeaders(headers = new Headers(), { scriptHashes = [] } = {}) {
  headers.set(
    "Content-Security-Policy",
    contentSecurityPolicy(scriptHashes),
  );
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return headers;
}

export function jsonResponse(body, status = 200, extraHeaders) {
  const headers = securityHeaders(new Headers(extraHeaders));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256CspSource(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function readBodyBounded(body, declaredLength, maximumBytes, label = "HTML response") {
  if (declaredLength && /^(0|[1-9][0-9]*)$/u.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
      throw new Error(`${label} exceeds the security processing limit`);
    }
  }
  const reader = body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) throw new Error(`${label} exceeds the security processing limit`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function inlineScriptHashes(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();
  const html = decoder.decode(bytes);
  if (!sameBytes(encoder.encode(html), bytes)) throw new Error("HTML response is not byte-exact UTF-8");

  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
  const sources = [];
  for (const match of html.matchAll(scriptPattern)) {
    if (/(?:^|\s)src\s*=/iu.test(match[1])) continue;
    sources.push(match[2]);
    if (sources.length > MAX_INLINE_SCRIPT_COUNT) {
      throw new Error("HTML response contains too many inline scripts");
    }
  }
  return Promise.all(sources.map((source) => sha256CspSource(encoder.encode(source))));
}

function htmlSecurityFailureResponse() {
  const headers = securityHeaders(new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  }));
  return new Response("Service unavailable", { status: 503, headers });
}

export async function tokenMatches(request, configuredToken) {
  if (!configuredToken || configuredToken.length < 32) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const suppliedToken = header.slice("Bearer ".length);
  const encoder = new TextEncoder();
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(configuredToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(suppliedToken)),
  ]);
  const left = new Uint8Array(expected);
  const right = new Uint8Array(supplied);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function readBoundedSnapshot(request) {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("content type must be application/json");
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("snapshot exceeds the upload limit");
  }
  const bytes = request.body
    ? await readBodyBounded(request.body, request.headers.get("Content-Length"), MAX_SNAPSHOT_BYTES, "snapshot")
    : new Uint8Array();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("snapshot size is outside the upload limit");
  }
  return bytes;
}

async function publishSnapshotBytes(bytes, env, now, expectedSha256) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error("snapshot size is outside the upload limit");
    }
    const snapshot = validateSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (snapshot.source.releaseVersion !== EXPECTED_RELEASE) {
      throw new Error("snapshot release does not match the deployed site");
    }
    const generatedAtMs = Date.parse(snapshot.generatedAt);
    const ageMs = now() - generatedAtMs;
    if (!Number.isFinite(ageMs) || ageMs < -5 * 60 * 1000 || ageMs > MAX_UPLOAD_AGE_MS) {
      throw new Error("snapshot is not fresh enough to publish");
    }
    const sha256 = await sha256Hex(bytes);
    if (expectedSha256 && sha256 !== expectedSha256) throw new Error("snapshot SHA-256 does not match");
    await env.SNAPSHOTS.put(SNAPSHOT_KEY, bytes, {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-store, max-age=0, must-revalidate",
      },
      customMetadata: {
        sha256,
        generatedAt: snapshot.generatedAt,
        releaseVersion: snapshot.source.releaseVersion,
      },
    });
    return { status: "ok", sha256, generatedAt: snapshot.generatedAt };
}

export async function uploadSnapshot(request, env, { now = Date.now } = {}) {
  if (!(await tokenMatches(request, env.SNAPSHOT_PUSH_TOKEN))) {
    return jsonResponse({ status: "error", reason: "unauthorized" }, 401);
  }
  try {
    return jsonResponse(await publishSnapshotBytes(await readBoundedSnapshot(request), env, now));
  } catch (error) {
    return jsonResponse({
      status: "error",
      reason: error instanceof Error ? error.message : "snapshot validation failed",
    }, 400);
  }
}

function integerHeader(request, name, { minimum, maximum }) {
  const raw = request.headers.get(name) ?? "";
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the allowed range`);
  }
  return value;
}

function uploadIdHeader(request) {
  const uploadId = request.headers.get("X-Snapshot-Upload") ?? "";
  if (!/^[a-f0-9]{64}$/u.test(uploadId)) throw new Error("snapshot upload id is invalid");
  return uploadId;
}

function encodingHeader(request) {
  const encoding = request.headers.get("X-Snapshot-Encoding") ?? "";
  if (encoding !== "gzip") throw new Error("snapshot encoding must be gzip");
  return encoding;
}

function chunkKey(uploadId, index) {
  return `uploads/${uploadId}/${String(index).padStart(2, "0")}`;
}

function decodeChunk(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > Math.ceil(MAX_CHUNK_BYTES * 4 / 3) + 2) {
    throw new Error("snapshot chunk encoding is invalid");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new Error("snapshot chunk size is outside the allowed range");
  }
  return bytes;
}

async function storedObjectBytes(stored) {
  if (typeof stored.arrayBuffer === "function") return new Uint8Array(await stored.arrayBuffer());
  if (stored.body instanceof Uint8Array) return stored.body;
  if (stored.body instanceof ArrayBuffer) return new Uint8Array(stored.body);
  return new Uint8Array(await new Response(stored.body).arrayBuffer());
}

async function cleanupChunks(env, uploadId, total) {
  if (typeof env.SNAPSHOTS.delete !== "function") return;
  await Promise.allSettled(Array.from({ length: total }, (_, index) => (
    env.SNAPSHOTS.delete(chunkKey(uploadId, index))
  )));
}

async function decompressGzipBounded(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_SNAPSHOT_BYTES) throw new Error("snapshot exceeds the upload limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function uploadSnapshotChunk(request, env) {
  if (!(await tokenMatches(request, env.SNAPSHOT_PUSH_TOKEN))) {
    return jsonResponse({ status: "error", reason: "unauthorized" }, 401);
  }
  try {
    const uploadId = uploadIdHeader(request);
    const encoding = encodingHeader(request);
    const total = integerHeader(request, "X-Snapshot-Total", { minimum: 1, maximum: MAX_SNAPSHOT_CHUNKS });
    const index = integerHeader(request, "X-Snapshot-Index", { minimum: 0, maximum: total - 1 });
    const bytes = decodeChunk(request.headers.get("X-Snapshot-Chunk") ?? "");
    await env.SNAPSHOTS.put(chunkKey(uploadId, index), bytes, {
      customMetadata: { uploadId, index: String(index), total: String(total), encoding },
    });
    return jsonResponse({ status: "ok", uploadId, index, total });
  } catch (error) {
    return jsonResponse({
      status: "error",
      reason: error instanceof Error ? error.message : "snapshot chunk validation failed",
    }, 400);
  }
}

export async function commitSnapshotChunks(request, env, { now = Date.now } = {}) {
  if (!(await tokenMatches(request, env.SNAPSHOT_PUSH_TOKEN))) {
    return jsonResponse({ status: "error", reason: "unauthorized" }, 401);
  }
  let uploadId;
  let total;
  try {
    uploadId = uploadIdHeader(request);
    total = integerHeader(request, "X-Snapshot-Total", { minimum: 1, maximum: MAX_SNAPSHOT_CHUNKS });
    const expectedSha256 = request.headers.get("X-Snapshot-SHA256") ?? "";
    const encoding = encodingHeader(request);
    if (expectedSha256 !== uploadId) throw new Error("snapshot commit SHA-256 is invalid");
    const chunks = [];
    let byteLength = 0;
    for (let index = 0; index < total; index += 1) {
      const stored = await env.SNAPSHOTS.get(chunkKey(uploadId, index));
      if (!stored
          || stored.customMetadata?.uploadId !== uploadId
          || stored.customMetadata?.index !== String(index)
          || stored.customMetadata?.total !== String(total)
          || stored.customMetadata?.encoding !== encoding) {
        throw new Error(`snapshot chunk ${index} is missing or mismatched`);
      }
      const bytes = await storedObjectBytes(stored);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_ENCODED_BYTES) throw new Error("encoded snapshot exceeds the upload limit");
      chunks.push(bytes);
    }
    const snapshotBytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      snapshotBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const receipt = await publishSnapshotBytes(
      await decompressGzipBounded(snapshotBytes), env, now, expectedSha256,
    );
    await cleanupChunks(env, uploadId, total);
    return jsonResponse(receipt);
  } catch (error) {
    if (uploadId && total) await cleanupChunks(env, uploadId, total);
    return jsonResponse({
      status: "error",
      reason: error instanceof Error ? error.message : "snapshot commit validation failed",
    }, 400);
  }
}

export async function abortSnapshotChunks(request, env) {
  if (!(await tokenMatches(request, env.SNAPSHOT_PUSH_TOKEN))) {
    return jsonResponse({ status: "error", reason: "unauthorized" }, 401);
  }
  try {
    const uploadId = uploadIdHeader(request);
    const total = integerHeader(request, "X-Snapshot-Total", { minimum: 1, maximum: MAX_SNAPSHOT_CHUNKS });
    await cleanupChunks(env, uploadId, total);
    return jsonResponse({ status: "ok", uploadId, removed: total });
  } catch (error) {
    return jsonResponse({
      status: "error",
      reason: error instanceof Error ? error.message : "snapshot abort validation failed",
    }, 400);
  }
}

export async function serveSnapshot(request, env) {
  const stored = await env.SNAPSHOTS.get(SNAPSHOT_KEY);
  if (!stored) {
    const fallbackRequest = new Request(new URL(SNAPSHOT_FALLBACK_PATH, request.url), request);
    if (env.ASSETS?.fetch) {
      const response = await env.ASSETS.fetch(fallbackRequest);
      const headers = securityHeaders(new Headers(response.headers));
      headers.set("Cache-Control", "no-store, max-age=0, must-revalidate");
      return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
    }
    return jsonResponse({
      status: "starting",
      service: "ojeommwo-observatory",
      reason: "snapshot is not available yet",
    }, 503);
  }
  const headers = securityHeaders(new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    ETag: stored.httpEtag,
  }));
  const sha256 = stored.customMetadata?.sha256;
  if (sha256) headers.set("X-Snapshot-SHA256", sha256);
  return new Response(request.method === "HEAD" ? null : stored.body, { status: 200, headers });
}

export async function healthResponse(env, { now = Date.now } = {}) {
  const stored = await env.SNAPSHOTS.get(SNAPSHOT_KEY);
  if (!stored) return jsonResponse({ status: "starting", service: "ojeommwo-observatory" }, 503);
  const generatedAt = stored.customMetadata?.generatedAt ?? "";
  const signedAgeSeconds = Math.floor((now() - Date.parse(generatedAt)) / 1000);
  const ageSeconds = Math.max(0, signedAgeSeconds);
  const releaseMatches = stored.customMetadata?.releaseVersion === EXPECTED_RELEASE;
  const fresh = Number.isFinite(ageSeconds) && signedAgeSeconds >= -300 && ageSeconds <= 20 * 60 && releaseMatches;
  return jsonResponse({
    status: fresh ? "ok" : releaseMatches ? "stale" : "release-mismatch",
    service: "ojeommwo-observatory",
    releaseVersion: stored.customMetadata?.releaseVersion ?? "unknown",
    generatedAt,
    ageSeconds,
  }, fresh ? 200 : 503);
}

export async function addResponseSecurity(response, url, { method = "GET" } = {}) {
  const headers = new Headers(response.headers);
  const contentType = (headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const isHtml = contentType === "text/html";
  if (url.pathname.startsWith("/_next/static/")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (isHtml) {
    // Keep Cloudflare's JavaScript Detections from rewriting the HTML after
    // the byte-exact inline-script hashes below have been sealed into CSP.
    headers.set("Cache-Control", "no-store, no-transform");
  }
  if (!isHtml || method === "HEAD" || !response.body) {
    securityHeaders(headers);
    return new Response(method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  try {
    const bytes = await readBodyBounded(
      response.body,
      headers.get("Content-Length"),
      MAX_HTML_SECURITY_BYTES,
    );
    securityHeaders(headers, { scriptHashes: await inlineScriptHashes(bytes) });
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return htmlSecurityFailureResponse();
  }
}
