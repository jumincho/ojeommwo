import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config, DATA_DIR } from "./config.js";
import { logWarn } from "./logger.js";
import {
  validateRecommendationBatchForDelivery,
  validateMealEventStore,
  validateRecommendationHistoryStore,
  validateSchedulerStateStore,
  validateSentMessageStore
} from "./operating-data-integrity.js";
import {
  validateCandidatePreferenceStore,
  validateCoffeeParticipationStore
} from "./interaction-data-integrity.js";
import { recommendationCommentForDisplay } from "./recommendation-comment.js";
import { validateMessageBlocks } from "./slack.js";
import { currentTimeMs, timestampMs } from "./time-integrity.js";
import { hasValidCategoryAdjudication } from "./category-arbitration.js";

const RECOMMENDATIONS_PER_MESSAGE = 3;
const MAX_DELIVERY_OUTBOX_ENTRIES = 20;
const DELIVERY_OUTBOX_RETENTION_DAYS = 14;
const CLIENT_MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u;
const STORE_LOCK_WAIT_MS = 5000;
const STORE_LOCK_POLL_MS = 25;
const STORE_LOCK_MALFORMED_STALE_MS = 60000;
const STORE_LOCK_LIVE_STALE_MS = 5 * 60 * 1000;
export const MAX_JSON_STORE_BYTES = 16 * 1024 * 1024;
const LOCK_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function ensureDataDir(dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dataDir, 0o700);
}

function dataFilePath(dataDir, fileName) {
  if (path.basename(fileName) !== fileName || !fileName.endsWith(".json")) {
    throw new Error(`Invalid data file name: ${fileName}`);
  }
  return path.join(dataDir, fileName);
}

export function readJsonAt(dataDir, fileName, fallback) {
  ensureDataDir(dataDir);
  const filePath = dataFilePath(dataDir, fileName);
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(filePath)) {
    if (!fs.existsSync(backupPath)) return structuredClone(fallback);
    try {
      const recovered = readBoundedJsonFile(backupPath, `${fileName} backup`);
      logWarn(`[storage] ${fileName} is missing; recovered the last valid backup.`);
      return recovered;
    } catch (error) {
      throw new Error(`Failed to read ${fileName}: primary is missing and backup is invalid (${error.message})`);
    }
  }

  try {
    return readBoundedJsonFile(filePath, fileName);
  } catch (error) {
    if (fs.existsSync(backupPath)) {
      try {
        const recovered = readBoundedJsonFile(backupPath, `${fileName} backup`);
        logWarn(`[storage] Invalid JSON in ${fileName}; recovered the last valid backup:`, error.message);
        return recovered;
      } catch (backupError) {
        throw new Error(`Failed to read ${fileName}: primary and backup are invalid (${error.message}; ${backupError.message})`);
      }
    }
    throw new Error(`Failed to read ${fileName}: invalid JSON and no backup is available (${error.message})`);
  }
}

function readBoundedJsonFile(filePath, label) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (stat.size > MAX_JSON_STORE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_JSON_STORE_BYTES}-byte safety limit`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sleepSync(milliseconds) {
  Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, Math.max(1, milliseconds));
}

function isLockContention(error) {
  if (error?.code === "EEXIST") return true;
  if (process.platform !== "win32") return false;
  // Windows can report EPERM/EACCES instead of EEXIST when another process has
  // just created or removed a lock file. The bounded lock deadline prevents a
  // genuine permission problem from spinning indefinitely.
  return ["EACCES", "EPERM"].includes(error?.code);
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sameLockSnapshot(lockPath, snapshot, raw) {
  try {
    const currentStat = fs.statSync(lockPath);
    return currentStat.size === snapshot.size
      && currentStat.mtimeMs === snapshot.mtimeMs
      && fs.readFileSync(lockPath, "utf8") === raw;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function acquireLockMetadataGuard(lockPath, { deadline, pollMs, staleMs }) {
  const guardPath = `${lockPath}.reap`;
  const token = crypto.randomUUID();
  let attempted = false;
  for (;;) {
    if (attempted && Date.now() >= deadline) return null;
    attempted = true;
    let descriptor;
    let created = false;
    try {
      descriptor = fs.openSync(guardPath, "wx", 0o600);
      created = true;
      fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, pid: process.pid, token })}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return { path: guardPath, token };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (!isLockContention(error)) {
        if (created) fs.rmSync(guardPath, { force: true });
        throw error;
      }
      try {
        const ageMs = Math.max(0, Date.now() - fs.statSync(guardPath).mtimeMs);
        if (ageMs >= staleMs) {
          fs.rmSync(guardPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          if (Date.now() >= deadline) return null;
          sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
          continue;
        }
        throw statError;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseLockMetadataGuard(guard) {
  if (!guard) return;
  try {
    const current = JSON.parse(fs.readFileSync(guard.path, "utf8"));
    if (current?.token === guard.token) fs.rmSync(guard.path, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function reapUnchangedLock(lockPath, snapshot, raw) {
  if (!sameLockSnapshot(lockPath, snapshot, raw)) return false;
  const stalePath = `${lockPath}.${crypto.randomUUID()}.stale`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  try {
    if (!sameLockSnapshot(stalePath, snapshot, raw)) {
      if (!fs.existsSync(lockPath)) fs.renameSync(stalePath, lockPath);
      return false;
    }
    fs.rmSync(stalePath, { force: true });
    return true;
  } finally {
    fs.rmSync(stalePath, { force: true });
  }
}

function tryReapAbandonedLock(lockPath, malformedStaleMs, liveStaleMs) {

  try {
    let stat;
    let owner;
    let raw = "";
    try {
      stat = fs.statSync(lockPath);
      raw = fs.readFileSync(lockPath, "utf8");
      owner = JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      try {
        stat ||= fs.statSync(lockPath);
      } catch (statError) {
        if (statError?.code === "ENOENT") return true;
        throw statError;
      }
      owner = null;
    }

    const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
    if (owner && Number.isInteger(Number(owner.pid)) && Number(owner.pid) > 0) {
      if (processIsRunning(Number(owner.pid)) && ageMs < liveStaleMs) return false;
      return reapUnchangedLock(lockPath, stat, raw);
    }
    if (ageMs < malformedStaleMs) return false;
    return reapUnchangedLock(lockPath, stat, raw);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

export function withJsonStoreLockAt(dataDir, fileName, operation, {
  waitMs = STORE_LOCK_WAIT_MS,
  pollMs = STORE_LOCK_POLL_MS,
  malformedStaleMs = STORE_LOCK_MALFORMED_STALE_MS,
  liveStaleMs = STORE_LOCK_LIVE_STALE_MS
} = {}) {
  if (typeof operation !== "function") throw new Error("JSON store lock requires an operation");
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000
      || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000
      || !Number.isInteger(malformedStaleMs) || malformedStaleMs < 30000 || malformedStaleMs > 600000
      || !Number.isInteger(liveStaleMs) || liveStaleMs < 30000 || liveStaleMs > 3600000) {
    throw new Error("JSON store lock timing is invalid");
  }
  ensureDataDir(dataDir);
  const filePath = dataFilePath(dataDir, fileName);
  const lockPath = `${filePath}.lock`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;

  for (;;) {
    const guard = acquireLockMetadataGuard(lockPath, {
      deadline,
      pollMs,
      staleMs: malformedStaleMs
    });
    if (!guard) throw new Error(`Timed out waiting for JSON store lock: ${fileName}`);
    let status = "blocked";
    try {
      let descriptor;
      let created = false;
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        created = true;
        fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        status = "acquired";
      } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (!isLockContention(error)) {
          if (created) fs.rmSync(lockPath, { force: true });
          throw error;
        }
        if (tryReapAbandonedLock(lockPath, malformedStaleMs, liveStaleMs)) status = "retry";
      }
    } finally {
      releaseLockMetadataGuard(guard);
    }
    if (status === "acquired") break;
    if (status === "retry") continue;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for JSON store lock: ${fileName}`);
    sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  try {
    return operation();
  } finally {
    const releaseDeadline = Date.now() + STORE_LOCK_WAIT_MS;
    const guard = acquireLockMetadataGuard(lockPath, {
      deadline: releaseDeadline,
      pollMs,
      staleMs: malformedStaleMs
    });
    if (!guard) throw new Error(`Timed out releasing JSON store lock: ${fileName}`);
    try {
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (current?.token === token) fs.rmSync(lockPath, { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } finally {
      releaseLockMetadataGuard(guard);
    }
  }
}

function writeJsonAtUnlocked(dataDir, fileName, data, { synchronizeBackup = false } = {}) {
  ensureDataDir(dataDir);
  const filePath = dataFilePath(dataDir, fileName);
  const backupPath = `${filePath}.bak`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = JSON.stringify(data, null, 2);
  if (serialized === undefined) throw new Error("JSON store requires a serializable JSON value");
  const payload = serialized + "\n";
  if (Buffer.byteLength(payload, "utf8") > MAX_JSON_STORE_BYTES) {
    throw new Error(fileName + " exceeds the " + MAX_JSON_STORE_BYTES + "-byte safety limit");
  }
  let descriptor;
  try {
    if (fs.existsSync(filePath)) {
      try {
        JSON.parse(fs.readFileSync(filePath, "utf8"));
        fs.copyFileSync(filePath, backupPath);
        fs.chmodSync(backupPath, 0o600);
      } catch {
        // Preserve an earlier valid backup instead of replacing it with corrupt data.
      }
    }
    descriptor = fs.openSync(tmpPath, "wx", 0o600);
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o600);
    if (synchronizeBackup) {
      // Hard-negative candidate removal must also replace the recovery copy;
      // otherwise a later primary-file recovery could resurrect a known-closed
      // candidate from the normally desirable last-known-good backup.
      fs.copyFileSync(filePath, backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tmpPath, { force: true });
  }
}

export function writeJsonAt(dataDir, fileName, data, { synchronizeBackup = false } = {}) {
  if (typeof synchronizeBackup !== "boolean") {
    throw new Error("JSON backup synchronization option must be boolean");
  }
  return withJsonStoreLockAt(
    dataDir,
    fileName,
    () => writeJsonAtUnlocked(dataDir, fileName, data, { synchronizeBackup })
  );
}

export function readJson(fileName, fallback) {
  return readJsonAt(DATA_DIR, fileName, fallback);
}

export function writeJson(fileName, data) {
  return writeJsonAt(DATA_DIR, fileName, data);
}

export function appendSentMessage(message, {
  retentionDays = config.historyRetentionDays,
  now = new Date()
} = {}) {
  return withJsonStoreLockAt(DATA_DIR, "sent-messages.json", () => {
    const store = readJsonAt(DATA_DIR, "sent-messages.json", { version: 1, messages: [] });
    validateSentMessageStore(store, { now });
    const effectiveRetentionDays = Number(retentionDays);
    if (!Number.isFinite(effectiveRetentionDays) || effectiveRetentionDays < 1 || effectiveRetentionDays > 3650) {
      throw new Error("Sent message retention must be between 1 and 3650 days");
    }
    const nowMs = currentTimeMs(now, "Sent message append");
    const cutoff = nowMs - effectiveRetentionDays * 24 * 60 * 60 * 1000;
    const previousCount = store.messages.length;
    store.messages = store.messages.filter((item) => {
      const time = Date.parse(item.sentAt || "");
      return Number.isFinite(time) && time >= cutoff;
    });
    const key = `${message.channel}:${message.ts}`;
    const previous = store.messages.find((item) => `${item.channel}:${item.ts}` === key);
    if (previous) {
      for (const field of ["mealType", "source", "requestedMode", "generationMode"]) {
        if (String(previous[field] || "") !== String(message[field] || "")) {
          throw new Error(`Refusing to replace sent message ${key} with conflicting ${field}`);
        }
      }
      if (previous.clientMsgId && message.clientMsgId && previous.clientMsgId !== message.clientMsgId) {
        throw new Error(`Refusing to replace sent message ${key} with a conflicting client message ID`);
      }
      const upgradedClientId = !previous.clientMsgId && Boolean(message.clientMsgId);
      if (upgradedClientId) previous.clientMsgId = message.clientMsgId;
      if (store.messages.length !== previousCount || upgradedClientId) {
        validateSentMessageStore(store, { now });
        writeJsonAtUnlocked(DATA_DIR, "sent-messages.json", store);
      }
      return { inserted: false, message: structuredClone(previous) };
    }
    if (message.clientMsgId) {
      const clientIdOwner = store.messages.find((item) => item.clientMsgId === message.clientMsgId);
      if (clientIdOwner) {
        throw new Error(`Client message ID ${message.clientMsgId} is already committed to ${clientIdOwner.channel}:${clientIdOwner.ts}`);
      }
    }
    store.messages.push(message);
    validateSentMessageStore(store, { now });
    writeJsonAtUnlocked(DATA_DIR, "sent-messages.json", store);
    return { inserted: true, message: structuredClone(message) };
  });
}

export function getSentMessages() {
  const store = readJson("sent-messages.json", { version: 1, messages: [] });
  validateSentMessageStore(store);
  return store;
}

export function getSentMessageByClientMsgId(clientMsgId) {
  if (!CLIENT_MESSAGE_ID_PATTERN.test(String(clientMsgId || ""))) {
    throw new Error("sent message lookup requires a valid client message ID");
  }
  return getSentMessages().messages.find((item) => item.clientMsgId === clientMsgId) || null;
}

export function saveSentMessages(store, { now = new Date() } = {}) {
  validateSentMessageStore(store, { now });
  writeJson("sent-messages.json", store);
}

export function prepareSentMessageCleanup(channel, {
  keepRecentMessages = config.keepRecentMessages,
  now = new Date(),
  dataDir = DATA_DIR
} = {}) {
  if (!/^[CGD][A-Z0-9]+$/u.test(String(channel || ""))) {
    throw new Error("Message cleanup requires a valid Slack channel");
  }
  if (!Number.isInteger(keepRecentMessages) || keepRecentMessages < 0 || keepRecentMessages > 1000) {
    throw new Error("Message cleanup keep count must be an integer between 0 and 1000");
  }
  const requestedAt = new Date(currentTimeMs(now, "Message cleanup preparation")).toISOString();
  return withJsonStoreLockAt(dataDir, "sent-messages.json", () => {
    const store = readJsonAt(dataDir, "sent-messages.json", { version: 1, messages: [] });
    validateSentMessageStore(store, { now });
    const pending = store.messages.filter((message) => message.channel === channel
      && message.deletionRequestedAt && !message.deletedAt);
    const active = store.messages
      .filter((message) => message.channel === channel
        && !message.deletionRequestedAt && !message.deletedAt)
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const selected = active.slice(keepRecentMessages);
    if (selected.length > 0) {
      const keys = new Set(selected.map((message) => `${message.channel}:${message.ts}`));
      store.messages = store.messages.map((message) => keys.has(`${message.channel}:${message.ts}`)
        ? {
          ...message,
          deletionRequestedAt: requestedAt,
          deletionReason: "retention-cleanup"
        }
        : message);
      validateSentMessageStore(store, { now });
      writeJsonAtUnlocked(dataDir, "sent-messages.json", store);
    }
    const intendedKeys = new Set([
      ...pending.map((message) => `${message.channel}:${message.ts}`),
      ...selected.map((message) => `${message.channel}:${message.ts}`)
    ]);
    return store.messages
      .filter((message) => intendedKeys.has(`${message.channel}:${message.ts}`))
      .map((message) => structuredClone(message));
  });
}

export function finalizeSentMessageCleanup({ channel, ts }, {
  now = new Date(),
  dataDir = DATA_DIR
} = {}) {
  const deletedAt = new Date(currentTimeMs(now, "Message cleanup finalization")).toISOString();
  return withJsonStoreLockAt(dataDir, "sent-messages.json", () => {
    const store = readJsonAt(dataDir, "sent-messages.json", { version: 1, messages: [] });
    validateSentMessageStore(store, { now });
    const message = store.messages.find((item) => item.channel === channel && item.ts === ts);
    if (!message) throw new Error(`Cleanup intent not found for ${channel}:${ts}`);
    if (message.deletedAt) return { finalized: false, message: structuredClone(message) };
    if (!message.deletionRequestedAt || message.deletionReason !== "retention-cleanup") {
      throw new Error(`Cleanup was not durably prepared for ${channel}:${ts}`);
    }
    message.deletedAt = deletedAt;
    validateSentMessageStore(store, { now });
    writeJsonAtUnlocked(dataDir, "sent-messages.json", store);
    return { finalized: true, message: structuredClone(message) };
  });
}

export function getSchedulerState() {
  const store = readJson("scheduler-state.json", { version: 1, sentKeys: [] });
  validateSchedulerStateStore(store);
  return store;
}

export function saveSchedulerState(state) {
  validateSchedulerStateStore(state);
  writeJson("scheduler-state.json", state);
}

export function getRecommendationHistory() {
  const store = readJson("recommendation-history.json", { version: 1, items: [] });
  validateRecommendationHistoryStore(store);
  return store;
}

export function saveRecommendationHistory(history, { now = new Date() } = {}) {
  validateRecommendationHistoryStore(history, { now });
  writeJson("recommendation-history.json", history);
}

export function getMealEvents() {
  const store = readJson("meal-events.json", { version: 1, events: [] });
  validateMealEventStore(store);
  return store;
}

export function mergeMealEvent(store, event, {
  retentionDays = 730,
  now = new Date()
} = {}) {
  validateMealEventStore(store, { now });
  const previous = store.events.find((item) =>
    item.eventId === event.eventId
    || (event.respondentId && item.respondentId === event.respondentId
      && item.date === event.date && item.mealType === event.mealType));
  if (previous) return { store, event: previous, inserted: false };

  const nowMs = currentTimeMs(now, "Meal event merge");
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const nextStore = {
    ...store,
    events: [
      ...store.events.filter((item) => {
        const time = Date.parse(item.createdAt || item.eatenAt || "");
        return Number.isFinite(time) && time >= cutoff;
      }),
      event
    ].slice(-2000)
  };
  validateMealEventStore(nextStore, { now });
  return { store: nextStore, event, inserted: true };
}

export function appendMealEvent(event, { retentionDays = 730, now = new Date() } = {}) {
  return withJsonStoreLockAt(DATA_DIR, "meal-events.json", () => {
    const store = readJsonAt(DATA_DIR, "meal-events.json", { version: 1, events: [] });
    const result = mergeMealEvent(store, event, { retentionDays, now });
    if (result.inserted) writeJsonAtUnlocked(DATA_DIR, "meal-events.json", result.store);
    return result;
  });
}

export function saveMealEvents(store, { now = new Date() } = {}) {
  validateMealEventStore(store, { now });
  writeJson("meal-events.json", store);
  return store;
}

export function updateMealEventById(eventId, mutate, { dataDir = DATA_DIR, now = new Date() } = {}) {
  if (!String(eventId || "").trim() || typeof mutate !== "function") {
    throw new Error("Atomic meal event update requires an event ID and mutation function");
  }
  return withJsonStoreLockAt(dataDir, "meal-events.json", () => {
    const store = readJsonAt(dataDir, "meal-events.json", { version: 1, events: [] });
    validateMealEventStore(store, { now });
    const index = store.events.findIndex((event) => event.eventId === eventId);
    if (index < 0) throw new Error(`Meal event not found: ${eventId}`);
    const updated = mutate(structuredClone(store.events[index]));
    if (!updated || updated.eventId !== eventId) {
      throw new Error(`Atomic meal event update cannot change event identity: ${eventId}`);
    }
    store.events[index] = updated;
    validateMealEventStore(store, { now });
    writeJsonAtUnlocked(dataDir, "meal-events.json", store);
    return structuredClone(updated);
  });
}

export function updateMealEventsByIdAtomically(eventIds, mutate, {
  dataDir = DATA_DIR,
  now = new Date()
} = {}) {
  if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 2000
      || eventIds.some((eventId) => !String(eventId || "").trim())
      || new Set(eventIds).size !== eventIds.length
      || typeof mutate !== "function") {
    throw new Error("Atomic meal event batch update requires 1-2000 unique event IDs and a mutation function");
  }
  return withJsonStoreLockAt(dataDir, "meal-events.json", () => {
    const store = readJsonAt(dataDir, "meal-events.json", { version: 1, events: [] });
    validateMealEventStore(store, { now });
    const indices = eventIds.map((eventId) => {
      const index = store.events.findIndex((event) => event.eventId === eventId);
      if (index < 0) throw new Error(`Meal event not found: ${eventId}`);
      return index;
    });
    const updatedEvents = eventIds.map((eventId, position) => {
      const updated = mutate(structuredClone(store.events[indices[position]]), eventId, position);
      if (!updated || updated.eventId !== eventId || typeof updated.then === "function") {
        throw new Error(`Atomic meal event batch update cannot change event identity or run asynchronously: ${eventId}`);
      }
      return updated;
    });
    for (let position = 0; position < indices.length; position += 1) {
      store.events[indices[position]] = updatedEvents[position];
    }
    validateMealEventStore(store, { now });
    writeJsonAtUnlocked(dataDir, "meal-events.json", store);
    return structuredClone(updatedEvents);
  });
}

export function updateVerifiedCandidateStore(mutate, {
  dataDir = DATA_DIR,
  validate,
  synchronizeBackup = false
} = {}) {
  if (typeof mutate !== "function" || typeof validate !== "function"
      || typeof synchronizeBackup !== "boolean") {
    throw new Error("Atomic verified candidate update requires mutation and validation functions");
  }
  return withJsonStoreLockAt(dataDir, "verified-candidates.json", () => {
    const current = readJsonAt(dataDir, "verified-candidates.json", {
      version: 1,
      candidates: [],
      catalog: []
    });
    validate(structuredClone(current));
    const next = mutate(structuredClone(current));
    if (!next || typeof next !== "object" || Array.isArray(next) || typeof next.then === "function") {
      throw new Error("Atomic verified candidate mutation must return a store object synchronously");
    }
    validate(structuredClone(next));
    writeJsonAtUnlocked(dataDir, "verified-candidates.json", next, { synchronizeBackup });
    return structuredClone(next);
  });
}

export function getCandidatePreferences() {
  const store = readJson("candidate-preferences.json", { version: 1, responses: [] });
  validateCandidatePreferenceStore(store);
  return store;
}

export function mergeCandidatePreferenceResponse(store, response, {
  retentionDays = 730,
  now = new Date()
} = {}) {
  validateCandidatePreferenceStore(store, { now });
  const previous = store.responses.find((item) => item.responseId === response.responseId);
  if (previous) return { store, response: previous, inserted: false };

  const nowMs = currentTimeMs(now, "Candidate preference merge");
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const normalized = {
    ...response,
    createdAt: response.submittedAt,
    updatedAt: response.submittedAt
  };
  const nextStore = {
    ...store,
    responses: [
      ...store.responses.filter((item) => {
        const time = Date.parse(item.updatedAt || item.createdAt || "");
        return Number.isFinite(time) && time >= cutoff;
      }),
      normalized
    ].slice(-5000)
  };
  validateCandidatePreferenceStore(nextStore, { now });
  return { store: nextStore, response: normalized, inserted: true };
}

export function appendCandidatePreference(response, { retentionDays = 730, now = new Date() } = {}) {
  return withJsonStoreLockAt(DATA_DIR, "candidate-preferences.json", () => {
    const store = readJsonAt(DATA_DIR, "candidate-preferences.json", { version: 1, responses: [] });
    const result = mergeCandidatePreferenceResponse(store, response, { retentionDays, now });
    if (result.inserted) writeJsonAtUnlocked(DATA_DIR, "candidate-preferences.json", result.store);
    return result;
  });
}

export function getCoffeeParticipation() {
  const store = readJson("coffee-participation.json", { version: 1, messages: [] });
  validateCoffeeParticipationStore(store);
  return store;
}

export function mutateCoffeeParticipation(mutate, { dataDir = DATA_DIR, now = new Date() } = {}) {
  if (typeof mutate !== "function") {
    throw new Error("Atomic coffee participation update requires a mutation function");
  }
  return withJsonStoreLockAt(dataDir, "coffee-participation.json", () => {
    const store = readJsonAt(dataDir, "coffee-participation.json", { version: 1, messages: [] });
    validateCoffeeParticipationStore(store, { now });
    const before = JSON.stringify(store);
    const result = mutate(store);
    validateCoffeeParticipationStore(store, { now });
    if (JSON.stringify(store) !== before) {
      writeJsonAtUnlocked(dataDir, "coffee-participation.json", store);
    }
    return structuredClone(result);
  });
}

export function saveCoffeeParticipation(store, { now = new Date() } = {}) {
  validateCoffeeParticipationStore(store, { now });
  writeJson("coffee-participation.json", store);
}

function validateDeliveryResponse(response, delivery) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("delivery outbox response must be an object");
  }
  if (!String(response.text || "").trim() || String(response.text).length > 12000) {
    throw new Error("delivery outbox response has invalid text");
  }
  if (!Array.isArray(response.blocks)
      || response.blocks.some((block) => !block || typeof block !== "object" || Array.isArray(block))) {
    throw new Error("delivery outbox response has malformed or oversized blocks");
  }
  validateMessageBlocks(response.blocks);
  if (!Array.isArray(response.recommendations) || response.recommendations.length !== RECOMMENDATIONS_PER_MESSAGE) {
    throw new Error("delivery outbox response must contain exactly three recommendations");
  }
  if (response.recommendations.some((item) => !item || typeof item !== "object" || Array.isArray(item)
      || !String(item.category || "").trim() || !String(item.restaurant || "").trim()
      || !String(item.menu || "").trim())) {
    throw new Error("delivery outbox response has an invalid recommendation");
  }
  if (!new Set(["cache", "static", "codex-cli"]).has(response.generationMode)) {
    throw new Error("delivery outbox response has an invalid generation mode");
  }
  if (typeof response.fallbackUsed !== "boolean") {
    throw new Error("delivery outbox response has an invalid fallback marker");
  }
  if (response.fallbackUsed && (!String(response.fallbackReason || "").trim()
      || String(response.fallbackReason).length > 500)) {
    throw new Error("delivery outbox fallback must preserve a bounded failure reason");
  }
  validateRecommendationBatchForDelivery(response.recommendations, {
    mealType: delivery.mealType,
    source: delivery.source,
    now: delivery.preparedAt
  });
}

export function validateDeliveryOutboxStore(store, { now = new Date() } = {}) {
  if (!store || store.version !== 1 || !Array.isArray(store.deliveries)) {
    throw new Error("delivery outbox must use version 1 and contain a deliveries array");
  }
  if (store.deliveries.length > MAX_DELIVERY_OUTBOX_ENTRIES) {
    throw new Error(`delivery outbox cannot exceed ${MAX_DELIVERY_OUTBOX_ENTRIES} entries`);
  }
  const ids = new Set();
  for (const delivery of store.deliveries) {
    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
      throw new Error("delivery outbox entries must be objects");
    }
    if (!CLIENT_MESSAGE_ID_PATTERN.test(String(delivery.clientMsgId || "")) || ids.has(delivery.clientMsgId)) {
      throw new Error("delivery outbox client message IDs must be valid and unique");
    }
    ids.add(delivery.clientMsgId);
    if (!/^[CGD][A-Z0-9]+$/u.test(String(delivery.channel || ""))) {
      throw new Error("delivery outbox entry has an invalid channel");
    }
    if (!new Set(["점심", "저녁"]).has(delivery.mealType)
        || !String(delivery.source || "").startsWith("scheduled-")
        || String(delivery.source).length > 80
        || !new Set(["cache", "static", "codex-cli"]).has(delivery.requestedMode)) {
      throw new Error("delivery outbox entry has invalid scheduled provenance");
    }
    timestampMs(delivery.preparedAt, { label: "delivery outbox entry preparation", now });
    validateDeliveryResponse(delivery.response, delivery);
  }
  return { deliveryCount: store.deliveries.length };
}

export function getDeliveryOutbox() {
  const store = readJson("delivery-outbox.json", { version: 1, deliveries: [] });
  validateDeliveryOutboxStore(store);
  return store;
}

export function getPreparedDelivery(clientMsgId) {
  if (!CLIENT_MESSAGE_ID_PATTERN.test(String(clientMsgId || ""))) {
    throw new Error("prepared delivery requires a valid client message ID");
  }
  return getDeliveryOutbox().deliveries.find((item) => item.clientMsgId === clientMsgId) || null;
}

export function savePreparedDelivery(delivery, { now = new Date() } = {}) {
  return withJsonStoreLockAt(DATA_DIR, "delivery-outbox.json", () => {
    const store = readJsonAt(DATA_DIR, "delivery-outbox.json", { version: 1, deliveries: [] });
    validateDeliveryOutboxStore(store, { now });
    const previous = store.deliveries.find((item) => item.clientMsgId === delivery.clientMsgId);
    if (previous) return structuredClone(previous);
    const nowMs = currentTimeMs(now, "prepared delivery save");
    const cutoff = nowMs - DELIVERY_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const next = {
      version: 1,
      deliveries: [
        ...store.deliveries.filter((item) => Date.parse(item.preparedAt || "") >= cutoff),
        structuredClone(delivery)
      ].slice(-MAX_DELIVERY_OUTBOX_ENTRIES)
    };
    validateDeliveryOutboxStore(next, { now });
    writeJsonAtUnlocked(DATA_DIR, "delivery-outbox.json", next);
    return structuredClone(delivery);
  });
}

export function removePreparedDelivery(clientMsgId) {
  return withJsonStoreLockAt(DATA_DIR, "delivery-outbox.json", () => {
    const store = readJsonAt(DATA_DIR, "delivery-outbox.json", { version: 1, deliveries: [] });
    validateDeliveryOutboxStore(store);
    const deliveries = store.deliveries.filter((item) => item.clientMsgId !== clientMsgId);
    if (deliveries.length === store.deliveries.length) return false;
    const next = { version: 1, deliveries };
    validateDeliveryOutboxStore(next);
    writeJsonAtUnlocked(DATA_DIR, "delivery-outbox.json", next);
    return true;
  });
}

export function appendRecommendationHistory({
  recommendations,
  channel,
  messageTs,
  mealType,
  source,
  requestedMode,
  generationMode,
  fallbackUsed,
  fallbackReason,
  retentionDays
}) {
  return withJsonStoreLockAt(DATA_DIR, "recommendation-history.json", () => {
    const history = readJsonAt(DATA_DIR, "recommendation-history.json", { version: 1, items: [] });
    validateRecommendationHistoryStore(history);
    const effectiveRetentionDays = Number(retentionDays ?? config.historyRetentionDays);
    if (!Number.isFinite(effectiveRetentionDays) || effectiveRetentionDays < 1 || effectiveRetentionDays > 3650) {
      throw new Error("Recommendation history retention must be between 1 and 3650 days");
    }
    const groupKey = `${channel}:${messageTs}`;
    const existing = history.items.filter((item) => `${item.channel}:${item.messageTs}` === groupKey);
    if (existing.length > 0) {
      const identity = (item) => [item.category, item.restaurant, item.menu, item.priceText]
        .map((value) => String(value || "").trim())
        .join("\u0000");
      const previousIdentities = existing.map(identity).sort();
      const nextIdentities = recommendations.map(identity).sort();
      if (existing.length === recommendations.length
        && previousIdentities.every((value, index) => value === nextIdentities[index])) {
        return { inserted: false, items: structuredClone(existing) };
      }
      throw new Error(`Refusing to replace recommendation history group ${groupKey} with conflicting content`);
    }
    const now = new Date();
    const cutoff = now.getTime() - effectiveRetentionDays * 24 * 60 * 60 * 1000;
    const retained = history.items.filter((item) => {
      const time = Date.parse(item.recommendedAt || "");
      return Number.isFinite(time) && time >= cutoff;
    });

    for (const recommendation of recommendations) {
      retained.push({
        category: recommendation.category,
        restaurant: recommendation.restaurant,
        menu: recommendation.menu,
        priceText: recommendation.priceText,
        comment: recommendationCommentForDisplay(recommendation),
        evidence: recommendation.evidence,
        candidateId: recommendation.candidateId,
        branch: recommendation.branch,
        address: recommendation.address,
        latitude: recommendation.latitude,
        longitude: recommendation.longitude,
        distanceKm: recommendation.distanceKm,
        priceChannel: recommendation.priceChannel,
        priceCheckedAt: recommendation.priceCheckedAt,
        deliveryStatus: recommendation.deliveryStatus,
        deliveryCheckedAt: recommendation.deliveryCheckedAt,
        priceEvidenceUrl: recommendation.priceEvidenceUrl,
        deliveryEvidenceUrl: recommendation.deliveryEvidenceUrl,
        evidenceVerifiedAt: recommendation.evidenceVerifiedAt,
        evidenceVerification: recommendation.evidenceVerification,
        ingredientFamilies: recommendation.ingredientFamilies,
        ...(hasValidCategoryAdjudication(recommendation) ? {
          categoryAuthority: recommendation.categoryAuthority,
          categoryAdjudicatedAt: recommendation.categoryAdjudicatedAt,
          categoryAdjudicationKey: recommendation.categoryAdjudicationKey,
        } : {}),
        channel,
        messageTs,
        mealType,
        source,
        requestedMode,
        generationMode,
        fallbackUsed,
        ...(fallbackReason ? { fallbackReason } : {}),
        recommendedAt: now.toISOString()
      });
    }

    const next = { version: 1, items: retained };
    validateRecommendationHistoryStore(next);
    writeJsonAtUnlocked(DATA_DIR, "recommendation-history.json", next);
    return { inserted: true };
  });
}
