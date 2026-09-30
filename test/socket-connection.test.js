import test from "node:test";
import assert from "node:assert/strict";
import { waitForSocketConnection } from "../src/interaction-listener.js";

class SocketFixture extends EventTarget {
  static latest;
  closeCalls = 0;
  constructor() { super(); SocketFixture.latest = this; }
  close() { this.closeCalls++; this.dispatchEvent(new Event("close")); }
  message(payload) { const event = new Event("message"); event.data = JSON.stringify(payload); this.dispatchEvent(event); }
}

const url = "wss://wss-primary.slack.com/link/";
test("a stalled Socket Mode handshake closes the old transport before reconnecting", async () => {
  const connection = waitForSocketConnection(url, { WebSocketImpl: SocketFixture, connectTimeoutMs: 10 });
  const socket = SocketFixture.latest;
  await assert.rejects(connection, /timed out/u);
  assert.equal(socket.closeCalls, 1);
});

test("a Socket Mode error closes exactly once and late events cannot process payloads", async () => {
  let calls = 0;
  const connection = waitForSocketConnection(url, { WebSocketImpl: SocketFixture, handleEnvelope: async () => { calls++; } });
  const socket = SocketFixture.latest;
  socket.dispatchEvent(new Event("open"));
  socket.dispatchEvent(new Event("error"));
  await assert.rejects(connection, /connection error/u);
  socket.message({ envelope_id: "late" });
  assert.equal(socket.closeCalls, 1);
  assert.equal(calls, 0);
});

test("Slack disconnect resolves an opened connection and cleans up its deadline", async () => {
  let opens = 0;
  const connection = waitForSocketConnection(url, { WebSocketImpl: SocketFixture, onOpen: () => { opens++; }, connectTimeoutMs: 10 });
  const socket = SocketFixture.latest;
  socket.dispatchEvent(new Event("open"));
  socket.message({ type: "disconnect" });
  await connection;
  assert.equal(opens, 1);
  assert.equal(socket.closeCalls, 1);
});

test("a connection closed before its handshake fails promptly", async () => {
  const connection = waitForSocketConnection(url, { WebSocketImpl: SocketFixture });
  SocketFixture.latest.close();
  await assert.rejects(connection, /closed before opening/u);
});
