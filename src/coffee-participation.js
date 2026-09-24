import { config } from "./config.js";
import { mutateCoffeeParticipation } from "./storage.js";

export const COFFEE_STATUS_BLOCK_ID = "coffee_participation_status";

function assertMessageTarget({ channel, messageTs }) {
  if (!/^[CGD][A-Z0-9]+$/u.test(String(channel || ""))) throw new Error("Coffee participation requires a valid channel");
  if (!/^\d+\.\d+$/u.test(String(messageTs || ""))) throw new Error("Coffee participation requires a valid timestamp");
}

function assertTarget({ channel, messageTs, userId }) {
  assertMessageTarget({ channel, messageTs });
  if (!/^[UW][A-Z0-9]+$/u.test(String(userId || ""))) throw new Error("Coffee participation requires a valid Slack user ID");
}

export function coffeeTargetForBlockAction(payload) {
  const target = {
    channel: payload?.channel?.id || payload?.container?.channel_id,
    messageTs: payload?.message?.ts || payload?.container?.message_ts,
    userId: payload?.user?.id
  };
  assertTarget(target);
  return target;
}

function retainedMessages(store, now, retentionDays) {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return (store.messages || []).filter((item) => {
    const updated = Date.parse(item.updatedAt || "");
    return Number.isFinite(updated) && updated >= cutoff;
  });
}

function revisionTimestamp(now, previousUpdatedAt) {
  const requested = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(requested)) throw new Error("Coffee participation requires a valid current time");
  const previous = Date.parse(previousUpdatedAt || "");
  return new Date(Number.isFinite(previous) ? Math.max(requested, previous + 1) : requested).toISOString();
}

function sameUsers(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((userId, index) => userId === right[index]);
}

function mutateStoreAtomically(mutateStore, mutate) {
  if (typeof mutateStore !== "function") {
    throw new Error("Coffee participation requires an atomic storage strategy");
  }
  return mutateStore(mutate);
}

export function toggleCoffeeParticipation({
  channel,
  messageTs,
  userId,
  now = new Date(),
  retentionDays = config.coffeeParticipationRetentionDays,
  mutateStore = mutateCoffeeParticipation
}) {
  assertTarget({ channel, messageTs, userId });
  return mutateStoreAtomically(mutateStore, (store) => {
    const messages = retainedMessages(store, now, retentionDays);
    const key = `${channel}:${messageTs}`;
    const existing = messages.find((item) => `${item.channel}:${item.messageTs}` === key);
    const previousUserIds = [...new Set(existing?.userIds || [])].filter((id) => /^[UW][A-Z0-9]+$/u.test(id));
    const next = new Set(previousUserIds);
    const joined = !next.has(userId);
    if (joined && next.size >= 100) {
      throw new Error("Coffee participation queue is full (100 users)");
    }
    if (joined) next.add(userId);
    else next.delete(userId);
    const userIds = [...next];
    const updatedAt = revisionTimestamp(now, existing?.updatedAt);
    const withoutCurrent = messages.filter((item) => `${item.channel}:${item.messageTs}` !== key);
    withoutCurrent.push({ channel, messageTs, userIds, updatedAt });
    store.version = 1;
    store.messages = withoutCurrent.slice(-500);
    return {
      channel,
      messageTs,
      userIds,
      count: userIds.length,
      joined,
      previousUserIds,
      revision: updatedAt
    };
  });
}

export function restoreCoffeeParticipation(state, {
  now = new Date(),
  mutateStore = mutateCoffeeParticipation
} = {}) {
  assertMessageTarget({ channel: state?.channel, messageTs: state?.messageTs });
  if (!Array.isArray(state.previousUserIds) || !Array.isArray(state.userIds)
      || !Number.isFinite(Date.parse(state.revision || ""))) {
    throw new Error("Coffee participation rollback requires a complete revision state");
  }
  return mutateStoreAtomically(mutateStore, (store) => {
    const key = `${state.channel}:${state.messageTs}`;
    const current = (store.messages || []).find((item) => `${item.channel}:${item.messageTs}` === key);
    if (!current || current.updatedAt !== state.revision || !sameUsers(current.userIds, state.userIds)) {
      return { restored: false };
    }
    const messages = store.messages.filter((item) => `${item.channel}:${item.messageTs}` !== key);
    messages.push({
      channel: state.channel,
      messageTs: state.messageTs,
      userIds: [...state.previousUserIds],
      updatedAt: revisionTimestamp(now, current.updatedAt)
    });
    store.version = 1;
    store.messages = messages.slice(-500);
    return { restored: true };
  });
}

export function buildCoffeeMessageUpdate(payload, state) {
  const text = String(payload?.message?.text || "").trim();
  if (!text) throw new Error("Coffee participation cannot update a message without fallback text");
  const sourceBlocks = Array.isArray(payload?.message?.blocks) ? payload.message.blocks : [];
  const blocks = structuredClone(sourceBlocks).filter((block) => block?.block_id !== COFFEE_STATUS_BLOCK_ID);
  if (state.count > 0) {
    blocks.push({
      type: "context",
      block_id: COFFEE_STATUS_BLOCK_ID,
      elements: [{
        type: "mrkdwn",
        text: `☕ *커피 대기열 ${state.count}명* · ${state.userIds.map((id) => `<@${id}>`).join(" ")}`
      }]
    });
  }
  return { channel: state.channel, ts: state.messageTs, text, blocks };
}
