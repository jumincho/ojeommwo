import { config } from "./config.js";
import { slackApi } from "./slack.js";

export async function verifySlackDeliveryTarget({
  slackApiImpl = slackApi,
  botToken = config.slackBotToken,
  lunchChannelId = config.lunchChannelId
} = {}) {
  const auth = await slackApiImpl("auth.test", {}, botToken);
  // Slack's conversations.info endpoint is specified as GET. In practice its
  // edge currently ignores a JSON POST body and reports `channel` as missing,
  // so keep this read-only probe on the documented query form.
  const membership = await slackApiImpl(
    "conversations.info",
    { channel: lunchChannelId },
    botToken,
    { requestMethod: "GET" }
  );
  if (membership?.channel?.id !== lunchChannelId) {
    throw new Error("Slack lunch membership preflight returned the wrong channel");
  }
  if (membership.channel.is_archived === true) {
    throw new Error("Slack lunch channel is archived");
  }
  if (membership.channel.is_member !== true) {
    throw new Error("Slack bot is not a member of the protected lunch channel");
  }

  return {
    team: auth.team || auth.team_id || "unknown",
    channel: lunchChannelId,
    member: true
  };
}

export async function verifySlackCapability({
  slackApiImpl = slackApi,
  botToken = config.slackBotToken,
  appToken = config.slackAppToken,
  lunchChannelId = config.lunchChannelId
} = {}) {
  const deliveryTarget = await verifySlackDeliveryTarget({
    slackApiImpl,
    botToken,
    lunchChannelId
  });

  const socket = await slackApiImpl("apps.connections.open", {}, appToken);
  let socketUrl;
  try {
    socketUrl = new URL(socket.url);
  } catch {
    throw new Error("Slack Socket Mode capability returned an invalid URL");
  }
  if (socketUrl.protocol !== "wss:") {
    throw new Error("Slack Socket Mode capability did not return a WSS URL");
  }
  return {
    ...deliveryTarget,
    socketMode: true
  };
}
