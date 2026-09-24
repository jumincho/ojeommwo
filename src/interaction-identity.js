import crypto from "node:crypto";

export const PSEUDONYMOUS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u;

export function slackUserIdForPayload(payload) {
  const userId = String(payload?.user?.id || "");
  if (!/^[UW][A-Z0-9]+$/u.test(userId)) {
    throw new Error("Interaction requires a valid Slack user");
  }
  return userId;
}

export function stablePseudonymousId(namespace, values) {
  const label = String(namespace || "").trim();
  const parts = (Array.isArray(values) ? values : []).map((value) => String(value || "").trim());
  if (!label || !parts.length || parts.some((value) => !value || value.length > 256)) {
    throw new Error("Pseudonymous interaction identity is incomplete");
  }
  const hex = crypto.createHash("sha256").update(`${label}:${parts.join(":")}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function respondentIdForPayload(payload) {
  return stablePseudonymousId("ojeommwo-v2-respondent", [slackUserIdForPayload(payload)]);
}
