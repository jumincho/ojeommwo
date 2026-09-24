import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { RECOMMENDATION_LIMITS } from "./recommendation-limits.js";
import { readBoundedResponseBytes } from "./bounded-response.js";

const SLACK_BLOCK_IDENTIFIER_LIMIT = 255;
const SLACK_BUTTON_TEXT_LIMIT = 75;
const SLACK_API_RESPONSE_LIMIT_BYTES = 1_000_000;

function blockStringLimit(key, parent, grandparent) {
  if (key === "value") return RECOMMENDATION_LIMITS.slackBlockValue;
  if (key === "block_id" || key === "action_id") return SLACK_BLOCK_IDENTIFIER_LIMIT;
  if (key === "accessibility_label") return SLACK_BUTTON_TEXT_LIMIT;
  if (key === "text" && parent?.type === "plain_text" && grandparent?.type === "button") {
    return SLACK_BUTTON_TEXT_LIMIT;
  }
  return RECOMMENDATION_LIMITS.slackBlockText;
}

export function validateMessageBlocks(blocks) {
  if (blocks === undefined) return;
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > RECOMMENDATION_LIMITS.slackBlocks) {
    throw new Error(`chat.postMessage blocks must contain 1-${RECOMMENDATION_LIMITS.slackBlocks} items`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(blocks);
  } catch {
    throw new Error("chat.postMessage blocks must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > RECOMMENDATION_LIMITS.slackBlocksBytes) {
    throw new Error("chat.postMessage blocks exceed the bounded payload size");
  }
  const visit = (value, key = "", parent = null, grandparent = null) => {
    if (typeof value === "string") {
      const limit = blockStringLimit(key, parent, grandparent);
      if (value.length > limit) throw new Error(`chat.postMessage block ${key || "string"} exceeds ${limit} characters`);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, parent, grandparent);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey, value, parent);
      }
    }
  };
  visit(blocks);
}

export async function slackApi(method, body, token = config.slackBotToken, {
  fetchImpl = globalThis.fetch,
  timeoutMs = config.slackApiTimeoutMs,
  maxAttempts = 3,
  retryBaseMs = 250,
  requestMethod = "POST",
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  if (!/^[a-z][a-z0-9_.]+$/i.test(String(method || ""))) {
    throw new Error("Slack API method is invalid");
  }
  if (process.env.NODE_ENV === "test" && fetchImpl === globalThis.fetch) {
    throw new Error("Slack API network access is disabled in NODE_ENV=test; inject fetchImpl for a mock request");
  }
  if (!token) throw new Error(`${method} failed: missing Slack bot token`);
  if (!['GET', 'POST'].includes(requestMethod)) {
    throw new Error("Slack API request method must be GET or POST");
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("Slack API maxAttempts must be between 1 and 5");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      const requestUrl = new URL(`https://slack.com/api/${method}`);
      const requestHeaders = { "Authorization": `Bearer ${token}` };
      const requestOptions = {
        method: requestMethod,
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeoutMs)
      };
      if (requestMethod === "GET") {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Slack API GET parameters must be an object");
        }
        for (const [key, value] of Object.entries(body)) {
          if (!/^[a-z][a-z0-9_]*$/iu.test(key)
              || !["string", "number", "boolean"].includes(typeof value)
              || (typeof value === "number" && !Number.isFinite(value))) {
            throw new Error("Slack API GET parameters must contain only bounded scalar values");
          }
          const serialized = String(value);
          if (serialized.length > 1024) throw new Error("Slack API GET parameter exceeds 1024 characters");
          requestUrl.searchParams.set(key, serialized);
        }
      } else {
        requestHeaders["Content-Type"] = "application/json; charset=utf-8";
        requestOptions.body = JSON.stringify(body || {});
      }
      response = await fetchImpl(requestUrl.toString(), requestOptions);
    } catch (error) {
      if (attempt < maxAttempts) {
        await sleep(retryBaseMs * 2 ** (attempt - 1));
        continue;
      }
      const reason = error?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (error?.message || "network error");
      throw new Error(`${method} failed: ${reason}`);
    }

    let rawBody;
    try {
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: SLACK_API_RESPONSE_LIMIT_BYTES,
        label: "Slack API response"
      });
      rawBody = new TextDecoder().decode(bytes);
    } catch (error) {
      throw new Error(`${method} failed: ${error?.message || "invalid response body"}`);
    }
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      if (response.status >= 500 && attempt < maxAttempts) {
        await sleep(retryBaseMs * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`${method} failed: HTTP ${response.status} returned a non-JSON response`);
    }

    const retryableSlackError = ["ratelimited", "internal_error", "fatal_error", "service_unavailable"].includes(data.error);
    const retryable = response.status === 429 || response.status >= 500 || retryableSlackError;
    if (retryable && attempt < maxAttempts) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(retryAfterSeconds * 1000, 30000)
        : retryBaseMs * 2 ** (attempt - 1);
      await sleep(delayMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(`${method} failed: HTTP ${response.status} ${data.error || "unknown_error"}`);
    }

    if (!data.ok) {
      const metadata = Array.isArray(data?.response_metadata?.messages)
        ? data.response_metadata.messages
          .filter((message) => typeof message === "string")
          .slice(0, 2)
          .map((message) => message.replace(/[\r\n\t]+/gu, " ").slice(0, 160))
          .filter(Boolean)
          .join("; ")
        : "";
      throw new Error(`${method} failed: ${data.error || "unknown_error"}${metadata ? ` (${metadata})` : ""}`);
    }

    return data;
  }

  throw new Error(`${method} failed after ${maxAttempts} attempts`);
}

export async function postMessage(
  { channel, text, blocks, threadTs, clientMsgId, messagePurpose },
  { slackCall = slackApi, randomUUIDFn = randomUUID } = {}
) {
  if (!/^[CGD][A-Z0-9]+$/.test(String(channel || ""))) {
    throw new Error("chat.postMessage requires a valid channel or conversation ID");
  }
  if (!String(text || "").trim()) throw new Error("chat.postMessage requires non-empty text");
  if (typeof text !== "string" || text.length > RECOMMENDATION_LIMITS.slackFallbackText) {
    throw new Error(`chat.postMessage text cannot exceed ${RECOMMENDATION_LIMITS.slackFallbackText} characters`);
  }
  if (!String(messagePurpose || "").trim()) {
    throw new Error("chat.postMessage requires an explicit message purpose");
  }
  if (typeof messagePurpose !== "string" || messagePurpose.length > 80) {
    throw new Error("chat.postMessage purpose cannot exceed 80 characters");
  }
  if (channel === config.lunchChannelId && messagePurpose !== "meal-recommendation") {
    throw new Error("chat.postMessage permits only meal recommendations in the protected meal channel");
  }
  if (typeof slackCall !== "function" || typeof randomUUIDFn !== "function") {
    throw new Error("chat.postMessage requires valid delivery dependencies");
  }
  if (threadTs !== undefined && !/^\d+\.\d+$/u.test(String(threadTs))) {
    throw new Error("chat.postMessage thread timestamp is invalid");
  }
  validateMessageBlocks(blocks);
  const effectiveClientMsgId = clientMsgId || randomUUIDFn();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(effectiveClientMsgId)) {
    throw new Error("chat.postMessage client message ID must be a UUID");
  }

  const payload = {
    channel,
    text,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false
  };

  if (blocks !== undefined) payload.blocks = blocks;

  if (threadTs) payload.thread_ts = threadTs;
  payload.client_msg_id = effectiveClientMsgId;
  const result = await slackCall("chat.postMessage", payload);
  return assertSlackPostResult(result, channel);
}

export function assertSlackPostResult(result, expectedChannel) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("chat.postMessage returned an invalid Slack receipt");
  }
  if (result.channel !== expectedChannel) {
    throw new Error("chat.postMessage returned a receipt for the wrong Slack channel");
  }
  if (typeof result.ts !== "string" || !/^\d+\.\d+$/u.test(result.ts)) {
    throw new Error("chat.postMessage returned an invalid Slack timestamp");
  }
  return result;
}

export async function deleteMessage({ channel, ts }) {
  if (!channel || !ts) throw new Error("chat.delete requires channel and ts");
  return slackApi("chat.delete", { channel, ts });
}
