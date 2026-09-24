import assert from "node:assert/strict";
import test from "node:test";
import { verifySlackCapability, verifySlackDeliveryTarget } from "../src/slack-capability.js";

function fixtureApi({ member = true, archived = false } = {}) {
  const calls = [];
  const slackApiImpl = async (method, body, token, options) => {
    calls.push({ method, body, token, options });
    if (method === "auth.test") return { ok: true, team: "fixture-team" };
    if (method === "conversations.info") {
      return { channel: { id: "C0123456789", is_member: member, is_archived: archived } };
    }
    if (method === "apps.connections.open") return { url: "wss://wss-primary.slack.com/link/?ticket=secret" };
    throw new Error(`unexpected method: ${method}`);
  };
  return { calls, slackApiImpl };
}

test("Slack capability proves bot auth, lunch membership, and Socket Mode without posting", async () => {
  const fixture = fixtureApi();
  const result = await verifySlackCapability({
    slackApiImpl: fixture.slackApiImpl,
    botToken: "xoxb-fixture",
    appToken: "xapp-fixture",
    lunchChannelId: "C0123456789"
  });
  assert.deepEqual(result, {
    team: "fixture-team",
    channel: "C0123456789",
    member: true,
    socketMode: true
  });
  assert.deepEqual(fixture.calls.map((call) => call.method), [
    "auth.test",
    "conversations.info",
    "apps.connections.open"
  ]);
  assert.equal(fixture.calls.some((call) => call.method === "chat.postMessage"), false);
  const membershipCall = fixture.calls.find((call) => call.method === "conversations.info");
  assert.deepEqual(membershipCall.body, { channel: "C0123456789" });
  assert.deepEqual(membershipCall.options, { requestMethod: "GET" });
});

test("Slack delivery-target preflight is read-only and does not open Socket Mode", async () => {
  const fixture = fixtureApi();
  const result = await verifySlackDeliveryTarget({
    slackApiImpl: fixture.slackApiImpl,
    botToken: "xoxb-fixture",
    lunchChannelId: "C0123456789"
  });
  assert.deepEqual(result, {
    team: "fixture-team",
    channel: "C0123456789",
    member: true
  });
  assert.deepEqual(fixture.calls.map((call) => call.method), ["auth.test", "conversations.info"]);
  assert.equal(fixture.calls.some((call) => call.method === "chat.postMessage"), false);
  assert.equal(fixture.calls.some((call) => call.method === "apps.connections.open"), false);
});

test("Slack capability fails closed when the bot is absent or the channel is archived", async () => {
  await assert.rejects(
    verifySlackCapability({
      slackApiImpl: fixtureApi({ member: false }).slackApiImpl,
      botToken: "xoxb-fixture",
      appToken: "xapp-fixture",
      lunchChannelId: "C0123456789"
    }),
    /not a member/u
  );
  await assert.rejects(
    verifySlackCapability({
      slackApiImpl: fixtureApi({ archived: true }).slackApiImpl,
      botToken: "xoxb-fixture",
      appToken: "xapp-fixture",
      lunchChannelId: "C0123456789"
    }),
    /archived/u
  );
});
