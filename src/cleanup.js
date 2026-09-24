import { config } from "./config.js";
import { deleteMessage } from "./slack.js";
import { finalizeSentMessageCleanup, prepareSentMessageCleanup } from "./storage.js";

function isMessageNotFound(error) {
  return error?.data?.error === "message_not_found"
    || /(?:^|\b)message_not_found(?:\b|$)/u.test(String(error?.message || ""));
}

export async function cleanupOldMessages(channel, {
  enabled = config.enableCleanup,
  keepRecentMessages = config.keepRecentMessages,
  prepareMessages = prepareSentMessageCleanup,
  finalizeMessage = finalizeSentMessageCleanup,
  deleteMessageFn = deleteMessage,
  logDeleted = console.log,
  logFailure = console.error,
  now = new Date()
} = {}) {
  if (!enabled) return { deleted: 0, failed: 0 };

  const toDelete = prepareMessages(channel, { keepRecentMessages, now });
  if (toDelete.length === 0) return { deleted: 0, failed: 0 };

  let deleted = 0;
  let failed = 0;

  for (const message of toDelete) {
    let absent = false;
    try {
      await deleteMessageFn({ channel: message.channel, ts: message.ts });
    } catch (error) {
      if (isMessageNotFound(error)) {
        absent = true;
      } else {
        failed += 1;
        logFailure(`[cleanup] failed to delete ${message.channel}:${message.ts}:`, error.message);
        continue;
      }
    }
    finalizeMessage({ channel: message.channel, ts: message.ts }, { now });
    deleted += 1;
    logDeleted(`[cleanup] ${absent ? "confirmed absent" : "deleted old message"} ${message.channel}:${message.ts}`);
  }

  return { deleted, failed };
}
