import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
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


const snapshot = fs.readFileSync(SNAPSHOT_PATH);
if (snapshot.byteLength === 0 || snapshot.byteLength > MAX_BYTES) {
  throw new Error("snapshot size is outside the Sites upload limit");
}
const publicUrl = readSingleLine(URL_PATH, "Sites public URL");
if (!/^https:\/\/[A-Za-z0-9.-]+\/$/u.test(publicUrl)) throw new Error("Sites public URL is invalid");
const token = readSingleLine(TOKEN_PATH, "Sites push token");
if (!/^[A-Za-z0-9_.~-]{32,512}$/u.test(token)) throw new Error("Sites push token is invalid");

const uploadId = crypto.createHash("sha256").update(snapshot).digest("hex");
const encodedSnapshot = zlib.gzipSync(snapshot, { level: 9 });
const total = Math.ceil(encodedSnapshot.byteLength / CHUNK_BYTES);
if (total < 1 || total > MAX_CHUNKS) throw new Error("snapshot requires too many upload chunks");
const authorization = `Bearer ${token}`;
const uploadSignal = AbortSignal.timeout(120_000);

async function abortUpload() {
  try {
    await requestSitesJson(`${publicUrl}api/snapshot/abort`, {
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
    await requestSitesJson(`${publicUrl}api/snapshot/chunk`, {
      Authorization: authorization,
      "X-Snapshot-Upload": uploadId,
      "X-Snapshot-Index": String(index),
      "X-Snapshot-Total": String(total),
      "X-Snapshot-Encoding": ENCODING,
      "X-Snapshot-Chunk": chunk.toString("base64url"),
    }, { signal: uploadSignal });
  }
  const receipt = await requestSitesJson(`${publicUrl}api/snapshot/commit`, {
    Authorization: authorization,
    "X-Snapshot-Upload": uploadId,
    "X-Snapshot-SHA256": uploadId,
    "X-Snapshot-Total": String(total),
    "X-Snapshot-Encoding": ENCODING,
  }, { signal: uploadSignal });
  if (receipt.sha256 !== uploadId) throw new Error("Sites receipt SHA-256 does not match the snapshot");
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  await abortUpload();
  throw error;
}
