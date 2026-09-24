import test from "node:test";
import assert from "node:assert/strict";
import {
  COFFEE_STATUS_BLOCK_ID,
  buildCoffeeMessageUpdate,
  restoreCoffeeParticipation,
  toggleCoffeeParticipation
} from "../src/coffee-participation.js";

function memoryStore(initial = { version: 1, messages: [] }) {
  let value = structuredClone(initial);
  return {
    mutate: (mutate) => {
      const draft = structuredClone(value);
      const result = mutate(draft);
      value = structuredClone(draft);
      return structuredClone(result);
    },
    value: () => structuredClone(value)
  };
}

test("coffee participation toggles each real Slack user independently", () => {
  const store = memoryStore();
  const common = {
    channel: "C123ABC",
    messageTs: "123.456",
    now: new Date("2026-07-14T00:00:00.000Z"),
    mutateStore: store.mutate
  };
  const first = toggleCoffeeParticipation({ ...common, userId: "U111AAA" });
  const second = toggleCoffeeParticipation({ ...common, userId: "U222BBB" });
  const leave = toggleCoffeeParticipation({ ...common, userId: "U111AAA" });

  assert.equal(first.joined, true);
  assert.deepEqual(second.userIds, ["U111AAA", "U222BBB"]);
  assert.equal(leave.joined, false);
  assert.deepEqual(leave.userIds, ["U222BBB"]);
  assert.deepEqual(store.value().messages[0].userIds, ["U222BBB"]);
});

test("the 101st coffee join fails without claiming or storing a false join", () => {
  const userIds = Array.from({ length: 100 }, (_, index) => `U${String(index).padStart(3, "0")}AAA`);
  const initial = {
    version: 1,
    messages: [{
      channel: "C123ABC",
      messageTs: "123.456",
      userIds,
      updatedAt: "2026-07-14T00:00:00.000Z"
    }]
  };
  const store = memoryStore(initial);
  const common = {
    channel: "C123ABC",
    messageTs: "123.456",
    now: new Date("2026-07-14T01:00:00.000Z"),
    mutateStore: store.mutate
  };

  assert.throws(
    () => toggleCoffeeParticipation({ ...common, userId: "U101BBB" }),
    /queue is full \(100 users\)/u
  );
  assert.deepEqual(store.value(), initial);

  const leave = toggleCoffeeParticipation({ ...common, userId: userIds[0] });
  assert.equal(leave.joined, false);
  assert.equal(leave.count, 99);
});

test("the final coffee cancellation leaves a retained empty-state tombstone", () => {
  const store = memoryStore();
  const common = {
    channel: "C123ABC",
    messageTs: "123.456",
    userId: "U111AAA",
    mutateStore: store.mutate
  };
  toggleCoffeeParticipation({ ...common, now: new Date("2026-07-14T00:00:00.000Z") });
  const leave = toggleCoffeeParticipation({ ...common, now: new Date("2026-07-14T01:00:00.000Z") });

  assert.equal(leave.count, 0);
  assert.deepEqual(store.value().messages, [{
    channel: "C123ABC",
    messageTs: "123.456",
    userIds: [],
    updatedAt: "2026-07-14T01:00:00.000Z"
  }]);
});

test("coffee empty-state tombstones expire through the existing 30-day retention window", () => {
  const store = memoryStore({
    version: 1,
    messages: [{
      channel: "COLD123",
      messageTs: "111.111",
      userIds: [],
      updatedAt: "2026-06-01T00:00:00.000Z"
    }]
  });
  toggleCoffeeParticipation({
    channel: "C123ABC",
    messageTs: "123.456",
    userId: "U111AAA",
    now: new Date("2026-07-14T00:00:00.000Z"),
    retentionDays: 30,
    mutateStore: store.mutate
  });

  assert.deepEqual(store.value().messages.map((item) => item.channel), ["C123ABC"]);
});

test("coffee message update shows the queue count and native Slack user mentions", () => {
  const payload = {
    message: {
      text: "fallback",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "original" } },
        { type: "context", block_id: COFFEE_STATUS_BLOCK_ID, elements: [{ type: "mrkdwn", text: "old" }] }
      ]
    }
  };
  const update = buildCoffeeMessageUpdate(payload, {
    channel: "D123ABC",
    messageTs: "123.456",
    count: 2,
    userIds: ["U111AAA", "U222BBB"]
  });
  assert.equal(update.blocks.filter((block) => block.block_id === COFFEE_STATUS_BLOCK_ID).length, 1);
  assert.match(update.blocks.at(-1).elements[0].text, /커피 대기열 2명/u);
  assert.match(update.blocks.at(-1).elements[0].text, /<@U111AAA> <@U222BBB>/u);
});

test("coffee state can be restored when Slack message update fails", () => {
  const store = memoryStore({
    version: 1,
    messages: [{ channel: "C123ABC", messageTs: "123.456", userIds: ["U111AAA"], updatedAt: "2026-07-14T00:00:00.000Z" }]
  });
  const state = toggleCoffeeParticipation({
    channel: "C123ABC",
    messageTs: "123.456",
    userId: "U222BBB",
    now: new Date("2026-07-14T01:00:00.000Z"),
    mutateStore: store.mutate
  });
  restoreCoffeeParticipation(state, {
    now: new Date("2026-07-14T01:00:01.000Z"),
    mutateStore: store.mutate
  });
  assert.deepEqual(store.value().messages[0].userIds, ["U111AAA"]);
});

test("coffee rollback to an empty state also keeps the tombstone", () => {
  const store = memoryStore();
  const state = toggleCoffeeParticipation({
    channel: "C123ABC",
    messageTs: "123.456",
    userId: "U222BBB",
    now: new Date("2026-07-14T01:00:00.000Z"),
    mutateStore: store.mutate
  });
  restoreCoffeeParticipation(state, {
    now: new Date("2026-07-14T01:00:01.000Z"),
    mutateStore: store.mutate
  });
  assert.deepEqual(store.value().messages, [{
    channel: "C123ABC",
    messageTs: "123.456",
    userIds: [],
    updatedAt: "2026-07-14T01:00:01.000Z"
  }]);
});

test("coffee rollback refuses to overwrite a newer revision of the same message", () => {
  const store = memoryStore({
    version: 1,
    messages: [{ channel: "C123ABC", messageTs: "123.456", userIds: ["U111AAA"], updatedAt: "2026-07-14T00:00:00.000Z" }]
  });
  const common = { channel: "C123ABC", messageTs: "123.456", mutateStore: store.mutate };
  const stale = toggleCoffeeParticipation({
    ...common,
    userId: "U222BBB",
    now: new Date("2026-07-14T01:00:00.000Z")
  });
  toggleCoffeeParticipation({
    ...common,
    userId: "U333CCC",
    now: new Date("2026-07-14T01:00:01.000Z")
  });
  const rollback = restoreCoffeeParticipation(stale, {
    now: new Date("2026-07-14T01:00:02.000Z"),
    mutateStore: store.mutate
  });

  assert.deepEqual(rollback, { restored: false });
  assert.deepEqual(store.value().messages[0].userIds, ["U111AAA", "U222BBB", "U333CCC"]);
  assert.equal(store.value().messages[0].updatedAt, "2026-07-14T01:00:01.000Z");
});

test("coffee revisions remain unique when two mutations request the same timestamp", () => {
  const store = memoryStore();
  const common = {
    channel: "C123ABC",
    messageTs: "123.456",
    now: new Date("2026-07-14T01:00:00.000Z"),
    mutateStore: store.mutate
  };
  const first = toggleCoffeeParticipation({ ...common, userId: "U111AAA" });
  const second = toggleCoffeeParticipation({ ...common, userId: "U222BBB" });

  assert.equal(first.revision, "2026-07-14T01:00:00.000Z");
  assert.equal(second.revision, "2026-07-14T01:00:00.001Z");
});
