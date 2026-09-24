import test from "node:test";
import assert from "node:assert/strict";
import { assertDmPreviewDestination, sendDinnerDmPreview } from "../src/dm-preview.js";
import { postMessage } from "../src/slack.js";

const response = {
  text: "오늘 저녁 추천",
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "저녁" } }],
  recommendations: []
};

test("DM preview rejects the protected meal channel and all non-DM destinations", async () => {
  assert.throws(
    () => assertDmPreviewDestination("C0123456789", { protectedMealChannel: "C0123456789" }),
    /protected meal channel/u
  );
  assert.throws(
    () => assertDmPreviewDestination("C123ABC", { protectedMealChannel: "C0123456789", operatorDmChannel: "D123ABC" }),
    /direct-message/u
  );
  assert.throws(
    () => assertDmPreviewDestination("D999XYZ", { protectedMealChannel: "C0123456789", operatorDmChannel: "D123ABC" }),
    /configured operator DM/u
  );

  await assert.rejects(
    () => sendDinnerDmPreview({
      channel: "C0123456789",
      protectedMealChannel: "C0123456789",
      operatorDmChannel: "D123ABC",
      buildMealResponseFn: async () => { throw new Error("must not build"); },
      postMessageFn: async () => { throw new Error("must not send"); }
    }),
    /protected meal channel/u
  );
});

test("DM preview rejects every non-cache mode before building data or posting to Slack", async () => {
  for (const mode of ["codex-cli", "static"]) {
    let builds = 0;
    let posts = 0;
    await assert.rejects(() => sendDinnerDmPreview({
      channel: "D123ABC",
      mode,
      protectedMealChannel: "C0123456789",
      operatorDmChannel: "D123ABC",
      buildMealResponseFn: async () => { builds += 1; return response; },
      postMessageFn: async () => { posts += 1; return { channel: "D123ABC", ts: "1.2" }; }
    }), /mode must be cache/u);
    assert.equal(builds, 0);
    assert.equal(posts, 0);
  }
});

test("DM preview builds a Korean dinner message and sends exactly once without storage hooks", async () => {
  const calls = [];
  let postInput;
  let slackPayload;
  const result = await sendDinnerDmPreview({
    channel: "D123ABC",
    protectedMealChannel: "C0123456789",
    operatorDmChannel: "D123ABC",
    buildMealResponseFn: async (input) => {
      calls.push(["build", input]);
      return response;
    },
    postMessageFn: async (input) => {
      calls.push(["post", input]);
      postInput = input;
      return postMessage(input, {
        slackCall: async (_method, payload) => {
          slackPayload = payload;
          return { channel: payload.channel, ts: "123.456" };
        }
      });
    }
  });

  assert.deepEqual(calls.map(([name]) => name), ["build", "post"]);
  assert.equal(calls[0][1].mealType, "저녁");
  assert.equal(calls[0][1].mode, "cache");
  assert.equal(postInput.channel, "D123ABC");
  assert.equal(postInput.messagePurpose, "dm-preview");
  assert.match(slackPayload.client_msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(result.delivery.sent, true);
});

test("DM preview dry-run renders content without calling Slack", async () => {
  const result = await sendDinnerDmPreview({
    channel: "D123ABC",
    dryRun: true,
    protectedMealChannel: "C0123456789",
    operatorDmChannel: "D123ABC",
    buildMealResponseFn: async () => response,
    postMessageFn: async () => { throw new Error("Slack must not be called"); }
  });
  assert.deepEqual(result.delivery, { sent: false, channel: "D123ABC" });
});
