const MAX_STREAM_CHUNKS = 16_384;

function tooLarge(label) {
  return new Error(`${label} is too large`);
}

async function cancelQuietly(target) {
  try {
    await target?.cancel?.();
  } catch {
    // The size violation is the useful failure; cancellation is best-effort.
  }
}

function declaredContentLength(response) {
  const value = response?.headers?.get?.("content-length");
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export async function readBoundedResponseBytes(response, {
  maxBytes,
  label = "Response"
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  const declaredLength = declaredContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelQuietly(response?.body);
    throw tooLarge(label);
  }

  const reader = response?.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge(label);
    return bytes;
  }

  const chunks = [];
  let totalBytes = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      if (chunkCount > MAX_STREAM_CHUNKS) {
        await cancelQuietly(reader);
        throw new Error(`${label} stream is too fragmented`);
      }
      if (!(value instanceof Uint8Array)) {
        await cancelQuietly(reader);
        throw new Error(`${label} stream returned an invalid byte chunk`);
      }
      if (value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelQuietly(reader);
        throw tooLarge(label);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // A failed or cancelled stream may already have released its lock.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
