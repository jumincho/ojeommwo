import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { postMessage, slackApi } from "../src/slack.js";

test("slackApi returns parsed Slack data", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, team: "T" }), { status: 200 });
  };

  const data = await slackApi("auth.test", {}, "xoxb-test", { fetchImpl });
  assert.equal(data.team, "T");
  assert.equal(request.url, "https://slack.com/api/auth.test");
  assert.equal(request.options.headers.Authorization, "Bearer xoxb-test");
});

test("slackApi supports documented GET query methods without a request body", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      ok: true,
      channel: { id: "C0123456789", is_member: true, is_archived: false }
    }), { status: 200 });
  };

  const data = await slackApi(
    "conversations.info",
    { channel: "C0123456789" },
    "xoxb-test",
    { fetchImpl, requestMethod: "GET" }
  );
  assert.equal(data.channel.is_member, true);
  assert.equal(new URL(request.url).searchParams.get("channel"), "C0123456789");
  assert.equal(request.options.method, "GET");
  assert.equal(Object.hasOwn(request.options, "body"), false);
  assert.equal(Object.hasOwn(request.options.headers, "Content-Type"), false);
});

test("slackApi includes Slack error names", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });

  await assert.rejects(
    () => slackApi("auth.test", {}, "xoxb-test", { fetchImpl }),
    /auth\.test failed: invalid_auth/
  );
});

test("slackApi includes bounded Slack argument diagnostics", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    ok: false,
    error: "invalid_arguments",
    response_metadata: { messages: ["[ERROR] missing required field: channel"] }
  }), { status: 200 });

  await assert.rejects(
    () => slackApi("conversations.info", {}, "xoxb-test", { fetchImpl }),
    /invalid_arguments.*missing required field: channel/u
  );
});

test("slackApi handles non-JSON responses", async () => {
  const fetchImpl = async () => new Response("not json", { status: 502 });

  await assert.rejects(
    () => slackApi("auth.test", {}, "xoxb-test", { fetchImpl }),
    /HTTP 502 returned a non-JSON response/
  );
});

test("slackApi rejects an oversized response before buffering or parsing it", async () => {
  const fetchImpl = async () => new Response("{}", {
    status: 200,
    headers: { "content-length": "1000001" }
  });
  await assert.rejects(
    () => slackApi("auth.test", {}, "xoxb-test", { fetchImpl, maxAttempts: 1 }),
    /Slack API response is too large/u
  );
});

test("slackApi reports network timeouts without exposing the token", async () => {
  const fetchImpl = async () => { throw new DOMException("timed out", "TimeoutError"); };
  await assert.rejects(
    () => slackApi("auth.test", {}, "xoxb-secret-value", { fetchImpl, timeoutMs: 1234 }),
    (error) => error.message.includes("timed out after 1234ms") && !error.message.includes("secret-value")
  );
});

test("slackApi rejects missing tokens before network access", async () => {
  await assert.rejects(
    () => slackApi("auth.test", {}, "", { fetchImpl: async () => { throw new Error("network reached"); } }),
    /missing Slack bot token/
  );
});

test("NODE_ENV=test blocks Slack network access unless fetch is explicitly injected", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let networkReached = false;
  process.env.NODE_ENV = "test";
  globalThis.fetch = async () => {
    networkReached = true;
    throw new Error("network reached");
  };

  try {
    await assert.rejects(
      () => slackApi("chat.update", {}, "xoxb-test"),
      /network access is disabled in NODE_ENV=test/u
    );
    assert.equal(networkReached, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("postMessage protects the meal channel and requires an explicit purpose", async () => {
  await assert.rejects(
    () => postMessage({
      channel: config.lunchChannelId,
      text: "operational failure",
      messagePurpose: "operations-alert"
    }),
    /only meal recommendations/u
  );
  await assert.rejects(
    () => postMessage({ channel: "D123ABC", text: "missing purpose" }),
    /explicit message purpose/u
  );
});

test("postMessage generates one UUID and keeps it unchanged across Slack API retries", async () => {
  const requestBodies = [];
  let calls = 0;
  const result = await postMessage({
    channel: "D123ABC",
    text: "private preview",
    messagePurpose: "dm-preview"
  }, {
    slackCall: (method, payload) => slackApi(method, payload, "xoxb-test", {
      fetchImpl: async (_url, options) => {
        calls += 1;
        requestBodies.push(JSON.parse(options.body));
        if (calls === 1) {
          return new Response(JSON.stringify({ ok: false, error: "internal_error" }), { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true, channel: "D123ABC", ts: "1.2" }), { status: 200 });
      },
      sleep: async () => {}
    })
  });

  assert.equal(result.ok, true);
  assert.equal(requestBodies.length, 2);
  assert.match(requestBodies[0].client_msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(requestBodies[1].client_msg_id, requestBodies[0].client_msg_id);
  assert.deepEqual(requestBodies[1], requestBodies[0]);
});

test("postMessage preserves a caller-provided deterministic client message ID", async () => {
  const deterministicId = "12345678-1234-5abc-adef-123456789abc";
  let payload;
  await postMessage({
    channel: "C123ABC",
    text: "scheduled meal",
    messagePurpose: "meal-recommendation",
    clientMsgId: deterministicId
  }, {
    slackCall: async (_method, value) => {
      payload = value;
      return { ok: true, channel: value.channel, ts: "1.2" };
    }
  });
  assert.equal(payload.client_msg_id, deterministicId);
});

test("postMessage rejects oversized fallback and Block Kit payloads before network access", async () => {
  let calls = 0;
  const slackCall = async () => {
    calls += 1;
    return { ok: true };
  };
  await assert.rejects(() => postMessage({
    channel: "D123",
    text: "x".repeat(12001),
    messagePurpose: "dm-preview"
  }, { slackCall }), /cannot exceed 12000/u);
  await assert.rejects(() => postMessage({
    channel: "D123",
    text: "fallback",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "x".repeat(3001) } }],
    messagePurpose: "dm-preview"
  }, { slackCall }), /exceeds 3000/u);
  assert.equal(calls, 0);
});

test("postMessage enforces Slack field-specific Block Kit limits", async () => {
  let calls = 0;
  const slackCall = async () => {
    calls += 1;
    return { ok: true };
  };
  const button = {
    type: "button",
    action_id: "action",
    text: { type: "plain_text", text: "열기" },
    accessibility_label: "열기",
    value: "open"
  };
  const invalidBlocks = [
    [{ type: "actions", block_id: "b".repeat(256), elements: [button] }],
    [{ type: "actions", elements: [{ ...button, action_id: "a".repeat(256) }] }],
    [{ type: "actions", elements: [{ ...button, text: { type: "plain_text", text: "x".repeat(76) } }] }],
    [{ type: "actions", elements: [{ ...button, accessibility_label: "x".repeat(76) }] }]
  ];
  for (const blocks of invalidBlocks) {
    await assert.rejects(() => postMessage({
      channel: "D123",
      text: "fallback",
      blocks,
      messagePurpose: "dm-preview"
    }, { slackCall }), /exceeds/u);
  }
  assert.equal(calls, 0);

  await postMessage({
    channel: "D123",
    text: "fallback",
    blocks: [{
      type: "actions",
      block_id: "b".repeat(255),
      elements: [{
        ...button,
        action_id: "a".repeat(255),
        text: { type: "plain_text", text: "x".repeat(75) },
        accessibility_label: "y".repeat(75)
      }]
    }],
    messagePurpose: "dm-preview"
  }, {
    slackCall: async (method, payload) => {
      await slackCall(method, payload);
      return { ok: true, channel: payload.channel, ts: "1.2" };
    }
  });
  assert.equal(calls, 1);
});

test("postMessage rejects a mismatched or malformed Slack receipt", async () => {
  const input = { channel: "D123", text: "preview", messagePurpose: "dm-preview" };
  await assert.rejects(
    () => postMessage(input, { slackCall: async () => ({ ok: true, channel: "DWRONG", ts: "1.2" }) }),
    /wrong Slack channel/u
  );
  await assert.rejects(
    () => postMessage(input, { slackCall: async () => ({ ok: true, channel: "D123", ts: "bad" }) }),
    /invalid Slack timestamp/u
  );
});

test("slackApi retries transient failures but not deterministic Slack errors", async () => {
  let calls = 0;
  const delays = [];
  const recovered = await slackApi("chat.postMessage", {}, "xoxb-test", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "retry-after": "1" }
      });
      return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), { status: 200 });
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); }
  });
  assert.equal(recovered.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);

  calls = 0;
  await assert.rejects(() => slackApi("chat.postMessage", {}, "xoxb-test", {
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 });
    },
    sleep: async () => {}
  }), /not_in_channel/u);
  assert.equal(calls, 1);
});
