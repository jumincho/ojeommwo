import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedResponseBytes } from "../src/bounded-response.js";

function streamResponse(chunks, { contentLength = null } = {}) {
  let index = 0;
  let cancelled = false;
  let released = false;
  let arrayBufferCalled = false;
  const reader = {
    async read() {
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
    async cancel() { cancelled = true; },
    releaseLock() { released = true; }
  };
  return {
    headers: { get: (name) => name === "content-length" ? contentLength : null },
    body: { getReader: () => reader, cancel: async () => { cancelled = true; } },
    async arrayBuffer() {
      arrayBufferCalled = true;
      return new ArrayBuffer(0);
    },
    state: () => ({ cancelled, released, arrayBufferCalled })
  };
}

test("readBoundedResponseBytes streams and combines a bounded body", async () => {
  const response = streamResponse([
    new Uint8Array([1, 2]),
    new Uint8Array([3])
  ]);
  const bytes = await readBoundedResponseBytes(response, { maxBytes: 3, label: "Fixture" });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.deepEqual(response.state(), { cancelled: false, released: true, arrayBufferCalled: false });
});

test("readBoundedResponseBytes cancels a chunked body immediately after its limit", async () => {
  const response = streamResponse([
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4])
  ]);
  await assert.rejects(
    readBoundedResponseBytes(response, { maxBytes: 3, label: "Fixture" }),
    /Fixture is too large/u
  );
  assert.deepEqual(response.state(), { cancelled: true, released: true, arrayBufferCalled: false });
});

test("readBoundedResponseBytes rejects an oversized declared length before reading", async () => {
  const response = streamResponse([], { contentLength: "4" });
  await assert.rejects(
    readBoundedResponseBytes(response, { maxBytes: 3, label: "Fixture" }),
    /Fixture is too large/u
  );
  assert.deepEqual(response.state(), { cancelled: true, released: false, arrayBufferCalled: false });
});

test("readBoundedResponseBytes keeps bounded compatibility with arrayBuffer-only mocks", async () => {
  const response = {
    headers: { get: () => null },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
  };
  await assert.rejects(
    readBoundedResponseBytes(response, { maxBytes: 3, label: "Fixture" }),
    /Fixture is too large/u
  );
});
