export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function currentTimeMs(now = new Date(), label = "validation") {
  const value = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(value)) throw new Error(`${label} requires a valid current time`);
  return value;
}

export function parseTimestampMs(value, label = "timestamp") {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(`${label} has an invalid timestamp`);
  return parsed;
}

export function assertNotFuture(parsed, {
  label = "timestamp",
  now = new Date(),
  maxFutureSkewMs = MAX_FUTURE_CLOCK_SKEW_MS
} = {}) {
  const nowMs = currentTimeMs(now, label);
  if (!Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    throw new Error(`${label} has an invalid future-skew policy`);
  }
  if (parsed > nowMs + maxFutureSkewMs) {
    throw new Error(`${label} is more than five minutes in the future`);
  }
  return parsed;
}

export function timestampMs(value, {
  label = "timestamp",
  now = new Date(),
  maxFutureSkewMs = MAX_FUTURE_CLOCK_SKEW_MS
} = {}) {
  return assertNotFuture(parseTimestampMs(value, label), { label, now, maxFutureSkewMs });
}

export function assertTimestampOrder(earlierMs, laterMs, label) {
  if (laterMs < earlierMs) throw new Error(`${label} has an invalid timestamp order`);
}
