import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { requestSitesJson } from "./lib/sites-http.mjs";

const STATE_ROOT = process.env.OJEOMMWO_OBSERVATORY_STATE
  ?? "/root/.ojeommwo-v2-state/observatory";
const SNAPSHOT_PATH = `${STATE_ROOT}/snapshot.json`;
const URL_PATH = `${STATE_ROOT}/public-url.txt`;
const TOKEN_PATH = `${STATE_ROOT}/sites-push-token`;
// Keep the encoded custom header comfortably below common 8 KiB per-header
// limits. The sanitized snapshot remains bounded to 512 KiB end to end.
const CHUNK_BYTES = 2 * 1024;
const MAX_BYTES = 512 * 1024;
const MAX_CHUNKS = 256;
const ENCODING = "gzip";

function readSingleLine(filePath, label) {
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.includes("\0") || raw.trim().split(/\r?\n/u).length !== 1) {
    throw new Error(`${label} must contain exactly one line`);
  }
  return raw.trim();
}


// Exported for transport fault-injection tests without filesystem credentials.
export async function pushSnapshotSites({ snapshot, publicUrl, token }, {
  requestJson = requestSitesJson, signal,
} = {}) {
  if (snapshot.byteLength === 0 || snapshot.byteLength > MAX_BYTES) {
    throw new Error("snapshot size is outside the Sites upload limit");
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+\/$/u.test(publicUrl)) throw new Error("Sites public URL is invalid");
  if (!/^[A-Za-z0-9_.~-]{32,512}$/u.test(token)) throw new Error("Sites push token is invalid");

  const uploadId = crypto.createHash("sha256").update(snapshot).digest("hex");
  const encodedSnapshot = zlib.gzipSync(snapshot, { level: 9 });
  const total = Math.ceil(encodedSnapshot.byteLength / CHUNK_BYTES);
  if (total < 1 || total > MAX_CHUNKS) throw new Error("snapshot requires too many upload chunks");
  const authorization = `Bearer ${token}`;
  const deadline = AbortSignal.timeout(120_000);
  const uploadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const startedAt = Date.now();
  let commitStartedAt;
  let commitAttempts = 0;
  const attemptSummary = { retries: 0, timeouts: 0 };
  function recordAttempt(event) {
    if (event.attempt > 1) attemptSummary.retries += 1;
    if (event.error === "TimeoutError") attemptSummary.timeouts += 1;
  }

  async function abortUpload() {
    try {
      await requestJson(`${publicUrl}api/snapshot/abort`, {
        Authorization: authorization,
        "X-Snapshot-Upload": uploadId,
        "X-Snapshot-Total": String(total),
      }, { attempts: 1, timeoutMs: 5_000 });
    } catch {
      // A later upload with a different content hash cannot consume these keys.
    }
  }

  try {
    for (let index = 0; index < total; index += 1) {
      const start = index * CHUNK_BYTES;
      const chunk = encodedSnapshot.subarray(start, Math.min(encodedSnapshot.byteLength, start + CHUNK_BYTES));
      await requestJson(`${publicUrl}api/snapshot/chunk`, {
        Authorization: authorization,
        "X-Snapshot-Upload": uploadId,
        "X-Snapshot-Index": String(index),
        "X-Snapshot-Total": String(total),
        "X-Snapshot-Encoding": ENCODING,
        "X-Snapshot-Chunk": chunk.toString("base64url"),
      }, { signal: uploadSignal, onAttempt: recordAttempt });
    }
    commitStartedAt = Date.now();
    const receipt = await requestJson(`${publicUrl}api/snapshot/commit`, {
      Authorization: authorization,
      "X-Snapshot-Upload": uploadId,
      "X-Snapshot-SHA256": uploadId,
      "X-Snapshot-Total": String(total),
      "X-Snapshot-Encoding": ENCODING,
    }, { signal: uploadSignal, timeoutMs: 45_000, onAttempt: (event) => {
      commitAttempts = event.attempt;
      recordAttempt(event);
    } });
    if (receipt.sha256 !== uploadId) throw new Error("Sites receipt SHA-256 does not match the snapshot");
    return { ...receipt, chunks: total, elapsedMs: Date.now() - startedAt,
      commitElapsedMs: Date.now() - commitStartedAt, commitAttempts, ...attemptSummary };
  } catch (error) {
    await abortUpload();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = await pushSnapshotSites({
    snapshot: fs.readFileSync(SNAPSHOT_PATH),
    publicUrl: readSingleLine(URL_PATH, "Sites public URL"),
    token: readSingleLine(TOKEN_PATH, "Sites push token"),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
