import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { MAX_CHUNK_BYTES, uploadSnapshotChunk } from "../../worker/snapshot-edge.mjs";

export const TOKEN = "fixture-token-with-at-least-thirty-two-bytes";

// Models R2's atomic conditional put and metadata-only head, not just a Map.
export class MemoryBucket {
  entries = new Map();
  reads = 0;
  writes = 0;
  deletes = 0;

  async head(key) {
    const entry = this.entries.get(key);
    return entry ? { ...entry.metadata } : null;
  }

  async get(key) {
    this.reads++;
    const entry = this.entries.get(key);
    if (!entry) return null;
    return { ...entry.metadata, body: new Blob([entry.bytes]).stream() };
  }

  async put(key, value, options = {}) {
    const current = this.entries.get(key);
    if (options.onlyIf?.etagMatches && current?.metadata.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match") === "*" && current) return null;
    const bytes = new Uint8Array(value);
    const etag = crypto.createHash("sha256").update(bytes).digest("hex");
    const metadata = { key, etag, httpEtag: `"${etag}"`, size: bytes.byteLength, customMetadata: options.customMetadata };
    this.entries.set(key, { bytes, metadata });
    this.writes++;
    return metadata;
  }

  async delete(keys) {
    this.deletes++;
    for (const key of Array.isArray(keys) ? keys : [keys]) this.entries.delete(key);
  }
}

export function snapshotFixture(offsetMs = 0) {
  const snapshot = JSON.parse(fs.readFileSync(new URL("../../public/data/snapshot.json", import.meta.url), "utf8"));
  snapshot.generatedAt = new Date(Date.parse(snapshot.generatedAt) + offsetMs).toISOString();
  return snapshot;
}

export function fixtureEnvironment(bucket = new MemoryBucket()) {
  return { bucket, env: { SNAPSHOTS: bucket, SNAPSHOT_PUSH_TOKEN: TOKEN } };
}

export async function stageSnapshot(env, snapshot = snapshotFixture()) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const uploadId = crypto.createHash("sha256").update(bytes).digest("hex");
  const encoded = zlib.gzipSync(bytes, { level: 9 });
  const total = Math.ceil(encoded.byteLength / MAX_CHUNK_BYTES);
  const headers = { Authorization: `Bearer ${TOKEN}`, "X-Snapshot-Upload": uploadId,
    "X-Snapshot-SHA256": uploadId, "X-Snapshot-Total": String(total), "X-Snapshot-Encoding": "gzip" };
  for (let index = 0; index < total; index++) {
    const response = await uploadSnapshotChunk(new Request("https://example.test/api/snapshot/chunk", {
      headers: { ...headers, "X-Snapshot-Index": String(index),
        "X-Snapshot-Chunk": encoded.subarray(index * MAX_CHUNK_BYTES, (index + 1) * MAX_CHUNK_BYTES).toString("base64url") },
    }), env);
    if (response.status !== 200) throw new Error(await response.text());
  }
  return { snapshot, bytes, uploadId, total, headers,
    request: () => new Request("https://example.test/api/snapshot/commit", { headers }),
    now: () => Date.parse(snapshot.generatedAt) + 60_000 };
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
