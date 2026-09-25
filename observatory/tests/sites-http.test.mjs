import test from "node:test";
import assert from "node:assert/strict";
import { requestSitesJson } from "../scripts/lib/sites-http.mjs";

test("Sites transport retries transient gateway responses with the same request", async () => {
  const requests = [];
  const result = await requestSitesJson("https://example.test/chunk", { "X-Test": "idempotent" }, {
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers, method: options.method });
      return requests.length < 3 ? new Response("gateway", { status: 502 }) : Response.json({ status: "ok", accepted: true });
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], requests[2]);
});

test("Sites transport never retries rejected credentials and caps transient retries", async () => {
  let calls = 0;
  await assert.rejects(requestSitesJson("https://example.test/chunk", {}, {
    sleep: async () => {}, fetchImpl: async () => { calls++; return Response.json({ status: "error" }, { status: 401 }); },
  }), /401/u);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(requestSitesJson("https://example.test/chunk", {}, {
    sleep: async () => {}, fetchImpl: async () => { calls++; throw new Error("network down"); },
  }), /network down/u);
  assert.equal(calls, 3);
});

test("Sites transport respects whole-upload cancellation", async () => {
  const controller = new AbortController();
  let requestSignal;
  const pending = requestSitesJson("https://example.test/commit", {}, {
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    },
  });
  controller.abort(new Error("upload deadline"));
  await assert.rejects(pending, /upload deadline/u);
  assert.equal(requestSignal.aborted, true);
});

test("per-attempt timeout retries while the whole-upload deadline remains authoritative", async () => {
  const events = [];
  let calls = 0;
  const keeper = setTimeout(() => {}, 2_000);
  try {
    const result = await requestSitesJson("https://example.test/commit", {}, {
      timeoutMs: 10, sleep: async () => {}, onAttempt: (event) => events.push(event),
      fetchImpl: async (_url, { signal }) => {
        if (++calls === 2) return Response.json({ status: "ok" });
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(calls, 2);
    assert.equal(events[0].error, "TimeoutError");
    assert.equal(events[1].ok, true);
  } finally { clearTimeout(keeper); }
});

test("diagnostic observer cannot break a successful request and permanent conflicts are not retried", async () => {
  const result = await requestSitesJson("https://example.test/commit", {}, {
    onAttempt: () => { throw new Error("observer failed"); },
    fetchImpl: async () => Response.json({ status: "ok" }),
  });
  assert.equal(result.status, "ok");
  let calls = 0;
  await assert.rejects(requestSitesJson("https://example.test/commit", {}, {
    fetchImpl: async () => { calls++; return Response.json({ status: "error", reason: "superseded" }, { status: 409 }); },
  }), /409.*superseded/u);
  assert.equal(calls, 1);
});
