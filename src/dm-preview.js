import { config, assertRecommendationMode } from "./config.js";
import { buildMealResponse } from "./meal-service.js";
import { postMessage } from "./slack.js";

export function assertDmPreviewDestination(
  channel,
  {
    protectedMealChannel = config.lunchChannelId,
    operatorDmChannel = config.operationsAlertChannelId
  } = {}
) {
  if (channel === protectedMealChannel) {
    throw new Error("DM preview destination must differ from the protected meal channel");
  }
  if (!/^D[A-Z0-9]+$/u.test(String(channel || ""))) {
    throw new Error("DM preview destination must be a Slack direct-message conversation ID");
  }
  if (!/^D[A-Z0-9]+$/u.test(String(operatorDmChannel || "")) || channel !== operatorDmChannel) {
    throw new Error("DM preview destination must be the configured operator DM");
  }
  return channel;
}

export async function sendDinnerDmPreview({
  channel = config.operationsAlertChannelId,
  mode = "cache",
  dryRun = false,
  protectedMealChannel = config.lunchChannelId,
  operatorDmChannel = config.operationsAlertChannelId,
  buildMealResponseFn = buildMealResponse,
  postMessageFn = postMessage
} = {}) {
  assertRecommendationMode(mode);
  if (mode !== "cache") {
    throw new Error("DM preview mode must be cache");
  }
  assertDmPreviewDestination(channel, { protectedMealChannel, operatorDmChannel });

  const response = await buildMealResponseFn({ mealType: "저녁", mode, source: "manual-private-test" });
  if (dryRun) {
    return { ...response, delivery: { sent: false, channel } };
  }

  const result = await postMessageFn({
    channel,
    text: response.text,
    blocks: response.blocks,
    messagePurpose: "dm-preview"
  });
  return {
    ...response,
    delivery: {
      sent: true,
      channel: result.channel,
      ts: result.ts
    }
  };
}
