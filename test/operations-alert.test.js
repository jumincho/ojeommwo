import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_LUNCH_CHANNEL_ID, REQUIRED_OPERATOR_DM_CHANNEL_ID } from "../src/config.js";
import { formatOperationsAlert, sendOperationsAlert } from "../src/operations-alert.js";
import { postMessage } from "../src/slack.js";

test("operations alert is optional and escapes untrusted error text", async () => {
  assert.deepEqual(await sendOperationsAlert({ channel: "" }), { sent: false, reason: "not-configured" });
  const text = formatOperationsAlert({
    job: "lunch",
    detail: "not_in_channel\n<!channel>",
    now: new Date("2026-07-13T03:00:00.000Z")
  });
  assert.doesNotMatch(text, /<!channel>/u);
  assert.match(text, /not_in_channel &lt;!channel&gt;/u);
});

test("operations alert posts only to the protected operator DM", async () => {
  let postInput;
  let slackPayload;
  const result = await sendOperationsAlert({
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    job: "research",
    detail: "exit code 1",
    postMessageFn: async (value) => {
      postInput = value;
      return postMessage(value, {
        slackCall: async (_method, payload) => {
          slackPayload = payload;
          return { channel: payload.channel, ts: "1.2" };
        }
      });
    }
  });
  assert.equal(result.sent, true);
  assert.equal(postInput.channel, REQUIRED_OPERATOR_DM_CHANNEL_ID);
  assert.equal(postInput.messagePurpose, "operations-alert");
  assert.match(slackPayload.client_msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  await assert.rejects(
    () => sendOperationsAlert({ channel: "D123ABC" }),
    /protected operator DM D0123456789/u
  );
});

test("operations alert fails closed when configured for the protected meal channel", async () => {
  let postCalls = 0;
  await assert.rejects(() => sendOperationsAlert({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    protectedMealChannel: REQUIRED_LUNCH_CHANNEL_ID,
    postMessageFn: async () => { postCalls += 1; }
  }), /protected operator DM/u);
  assert.equal(postCalls, 0);
});

test("operations alert rejects a mismatched or malformed Slack receipt", async () => {
  await assert.rejects(() => sendOperationsAlert({
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    postMessageFn: async () => ({ channel: "DWRONG", ts: "1.2" })
  }), /wrong Slack channel/u);
  await assert.rejects(() => sendOperationsAlert({
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    postMessageFn: async () => ({ channel: REQUIRED_OPERATOR_DM_CHANNEL_ID, ts: "not-a-ts" })
  }), /invalid Slack timestamp/u);
});
