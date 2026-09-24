import { config, REQUIRED_OPERATOR_DM_CHANNEL_ID } from "./config.js";
import { assertSlackPostResult, postMessage } from "./slack.js";

function safeLine(value, maxLength = 300) {
  return String(value ?? "")
    .replace(/[\r\n]+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .trim()
    .slice(0, maxLength);
}

export function formatOperationsAlert({ job, detail, now = new Date() }) {
  return [
    "🚨 *ojeommwo-v2 운영 작업 실패*",
    `• 작업: ${safeLine(job, 100) || "unknown"}`,
    `• 원인: ${safeLine(detail) || "unknown error"}`,
    `• 시각: ${now.toISOString()}`
  ].join("\n");
}

export async function sendOperationsAlert({
  job,
  detail,
  channel = config.operationsAlertChannelId,
  protectedMealChannel = config.lunchChannelId,
  now = new Date(),
  postMessageFn = postMessage
} = {}) {
  if (!channel) return { sent: false, reason: "not-configured" };
  if (channel !== REQUIRED_OPERATOR_DM_CHANNEL_ID) {
    throw new Error(`operations alerts must use the protected operator DM ${REQUIRED_OPERATOR_DM_CHANNEL_ID}`);
  }
  if (channel === protectedMealChannel) {
    return { sent: false, reason: "protected-meal-channel" };
  }
  const result = assertSlackPostResult(await postMessageFn({
    channel,
    text: formatOperationsAlert({ job, detail, now }),
    messagePurpose: "operations-alert"
  }), channel);
  return { sent: true, channel: result.channel, ts: result.ts };
}
