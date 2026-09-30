import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fetchHttp, TransportWebSocket } from "../src/http-transport.js";

test("the patched HTTP transport remains compatible with bounded local responses", async (t) => {
  const server = createServer((_request, response) => response.end("transport-ok"));
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetchHttp(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "transport-ok");
});

test("an unrequested WebSocket subprotocol reports an error without an uncaught process crash", async (t) => {
  const sockets = new Set();
  const server = createServer();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: unrequested\r\n\r\n`);
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const ws = new TransportWebSocket(`ws://127.0.0.1:${server.address().port}/`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("protocol rejection did not complete")), 2000);
    ws.addEventListener("open", () => { clearTimeout(timeout); reject(new Error("invalid protocol was accepted")); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
  assert.notEqual(ws.readyState, TransportWebSocket.OPEN);
});
