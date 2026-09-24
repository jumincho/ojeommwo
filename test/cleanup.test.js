import test from "node:test";
import assert from "node:assert/strict";
import { cleanupOldMessages } from "../src/cleanup.js";

test("cleanupOldMessages is side-effect free when disabled", async () => {
  const forbidden = () => { throw new Error("dependency reached"); };
  assert.deepEqual(await cleanupOldMessages("C123", {
    enabled: false,
    getMessages: forbidden,
    saveMessages: forbidden,
    deleteMessageFn: forbidden
  }), { deleted: 0, failed: 0 });
});

test("cleanupOldMessages keeps the newest messages and preserves deletion tombstones", async () => {
  const calls = [];
  const intended = [
    { channel: "C123", ts: "200.1", deletionRequestedAt: "2026-07-16T00:00:00.000Z" },
    { channel: "C123", ts: "100.1", deletionRequestedAt: "2026-07-16T00:00:00.000Z" }
  ];

  const result = await cleanupOldMessages("C123", {
    enabled: true,
    keepRecentMessages: 1,
    prepareMessages: (channel, options) => {
      calls.push(["prepare", channel, options.keepRecentMessages]);
      return structuredClone(intended);
    },
    deleteMessageFn: async (message) => calls.push(["delete", message.ts]),
    finalizeMessage: (message) => calls.push(["finalize", message.ts]),
    logDeleted: () => {},
    now: new Date("2026-07-16T00:00:00.000Z")
  });

  assert.deepEqual(result, { deleted: 2, failed: 0 });
  assert.deepEqual(calls, [
    ["prepare", "C123", 1],
    ["delete", "200.1"],
    ["finalize", "200.1"],
    ["delete", "100.1"],
    ["finalize", "100.1"]
  ]);
});

test("cleanupOldMessages retries a durable intent after a finalize crash and accepts message_not_found", async () => {
  const intended = [{ channel: "C123", ts: "100.1", deletionRequestedAt: "2026-07-16T00:00:00.000Z" }];
  let finalizeAttempts = 0;
  let deleteAttempts = 0;
  const options = {
    enabled: true,
    prepareMessages: () => structuredClone(intended),
    deleteMessageFn: async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 2) throw new Error("chat.delete failed: message_not_found");
    },
    finalizeMessage: () => {
      finalizeAttempts += 1;
      if (finalizeAttempts === 1) throw new Error("disk full after Slack delete");
    },
    logDeleted: () => {},
    logFailure: () => {},
    now: new Date("2026-07-16T00:00:00.000Z")
  };
  await assert.rejects(() => cleanupOldMessages("C123", options), /disk full/u);
  assert.deepEqual(await cleanupOldMessages("C123", options), { deleted: 1, failed: 0 });
  assert.equal(deleteAttempts, 2);
  assert.equal(finalizeAttempts, 2);
});
