import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { MAX_JSON_STORE_BYTES } from "./storage.js";
import { validateOperatingSnapshotDirectory } from "./operating-snapshot.js";

const STORE_FILES = Object.freeze({
  history: "recommendation-history.json",
  sentMessages: "sent-messages.json",
  mealEvents: "meal-events.json",
  verifiedCandidates: "verified-candidates.json",
  candidatePreferences: "candidate-preferences.json",
  coffeeParticipation: "coffee-participation.json",
  deliveryOutbox: "delivery-outbox.json"
});

const SENT_PROVENANCE_FIELDS = Object.freeze([
  "mealType",
  "source",
  "requestedMode",
  "generationMode",
  "fallbackUsed",
  "fallbackReason"
]);

const EVENT_SUBMISSION_FIELDS = Object.freeze([
  "eventId",
  "respondentId",
  "date",
  "mealType",
  "source",
  "rating",
  "tags",
  "channel",
  "messageTs",
  "createdAt",
  "eatenAt",
  "inputText",
  "inputNormalization"
]);

const NORMALIZATION_STATUS_RANK = Object.freeze({
  "": 0,
  "local-only": 1,
  pending: 2,
  normalizing: 3,
  failed: 4,
  unresolved: 5,
  unverified: 6,
  "rejected-input": 7,
  "verified-source": 8,
  verified: 9
});

function clone(value) {
  return structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function timestamp(value, label) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(`${label} has an invalid timestamp`);
  return parsed;
}

function keyForTarget(channel, timestampValue) {
  return `${channel}:${timestampValue}`;
}

function requiredDirectory(input, label) {
  if (!String(input || "").trim()) throw new Error(`${label} is required`);
  const resolved = path.resolve(input || "");
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  return fs.realpathSync(resolved);
}

function readRequiredJson(directory, fileName) {
  const filePath = path.join(directory, fileName);
  if (path.dirname(filePath) !== directory) throw new Error(`Unsafe snapshot file path: ${fileName}`);
  if (!fs.existsSync(filePath)) throw new Error(`Snapshot is missing required ${fileName}`);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("must be a regular non-link file");
    }
    if (stat.size > MAX_JSON_STORE_BYTES) {
      throw new Error("exceeds the " + MAX_JSON_STORE_BYTES + "-byte safety limit");
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Snapshot contains invalid JSON in ${fileName}: ${error.message}`);
  }
}

function readSnapshotStores(directory) {
  return Object.fromEntries(
    Object.entries(STORE_FILES).map(([key, fileName]) => [key, readRequiredJson(directory, fileName)])
  );
}

function sortedKeys(values) {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function historyGroups(store, label) {
  const groups = new Map();
  for (const item of store.items) {
    const key = keyForTarget(item.channel, item.messageTs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, group] of groups) {
    if (group.length !== 3) throw new Error(`${label} history group ${key} is incomplete`);
  }
  return groups;
}

function canonicalHistoryGroup(group) {
  return group.map((item) => {
    const copy = clone(item);
    delete copy.recommendedAt;
    return canonicalJson(copy);
  }).sort();
}

function mergeHistory(serverStore, localStore) {
  const serverGroups = historyGroups(serverStore, "server");
  const localGroups = historyGroups(localStore, "local");
  const items = [];
  const keys = sortedKeys(new Set([...serverGroups.keys(), ...localGroups.keys()]));
  for (const key of keys) {
    const serverGroup = serverGroups.get(key);
    const localGroup = localGroups.get(key);
    if (serverGroup && localGroup
      && !sameValue(canonicalHistoryGroup(serverGroup), canonicalHistoryGroup(localGroup))) {
      throw new Error(`Recommendation history conflict at ${key}`);
    }
    const selected = (serverGroup || localGroup).map(clone);
    if (serverGroup && localGroup) {
      const earliest = [...serverGroup, ...localGroup]
        .map((item) => item.recommendedAt)
        .sort((left, right) => timestamp(left, `recommendation history ${key}`)
          - timestamp(right, `recommendation history ${key}`))[0];
      for (const item of selected) item.recommendedAt = earliest;
    }
    items.push(...selected.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), "en")));
  }
  return { version: 1, items };
}

function withoutSentState(message) {
  const copy = clone(message);
  delete copy.sentAt;
  delete copy.clientMsgId;
  delete copy.deletionRequestedAt;
  delete copy.deletedAt;
  delete copy.deletionReason;
  return copy;
}

function sentDeletionRank(message) {
  if (Object.hasOwn(message, "deletedAt")) return 2;
  if (Object.hasOwn(message, "deletionRequestedAt")) return 1;
  return 0;
}

function laterState(left, right, field, key) {
  return timestamp(right[field], `sent message ${key} ${field}`)
    > timestamp(left[field], `sent message ${key} ${field}`)
    ? right
    : left;
}

function applySentDeletionState(merged, serverMessage, localMessage, key) {
  const candidates = [serverMessage, localMessage];
  const highestRank = Math.max(...candidates.map(sentDeletionRank));
  if (highestRank === 0) return;
  const atHighestRank = candidates.filter((message) => sentDeletionRank(message) === highestRank);
  const chosen = atHighestRank.length === 1
    ? atHighestRank[0]
    : laterState(
      atHighestRank[0],
      atHighestRank[1],
      highestRank === 2 ? "deletedAt" : "deletionRequestedAt",
      key
    );
  merged.deletionReason = chosen.deletionReason;
  if (highestRank === 1) {
    merged.deletionRequestedAt = chosen.deletionRequestedAt;
    return;
  }
  merged.deletedAt = chosen.deletedAt;
  if (chosen.deletionRequestedAt) {
    merged.deletionRequestedAt = chosen.deletionRequestedAt;
    return;
  }
  const compatibleRequest = candidates
    .map((message) => message.deletionRequestedAt)
    .filter(Boolean)
    .filter((value) => timestamp(value, `sent message ${key} deletionRequestedAt`)
      <= timestamp(chosen.deletedAt, `sent message ${key} deletedAt`))
    .sort((left, right) => timestamp(left, `sent message ${key} deletionRequestedAt`)
      - timestamp(right, `sent message ${key} deletionRequestedAt`))[0];
  if (compatibleRequest) merged.deletionRequestedAt = compatibleRequest;
}

function mergeSentRecord(serverMessage, localMessage, key) {
  for (const field of SENT_PROVENANCE_FIELDS) {
    if (!sameValue(serverMessage[field], localMessage[field])) {
      throw new Error(`Sent message core provenance conflict at ${key}: ${field}`);
    }
  }

  if (serverMessage.clientMsgId && localMessage.clientMsgId
    && serverMessage.clientMsgId !== localMessage.clientMsgId) {
    throw new Error(`Sent message core provenance conflict at ${key}: clientMsgId`);
  }
  const serverBase = withoutSentState(serverMessage);
  const localBase = withoutSentState(localMessage);
  for (const field of new Set([...Object.keys(serverBase), ...Object.keys(localBase)])) {
    if (Object.hasOwn(serverBase, field) && Object.hasOwn(localBase, field)
      && !sameValue(serverBase[field], localBase[field])) {
      throw new Error(`Sent message metadata conflict at ${key}: ${field}`);
    }
  }
  const merged = { ...serverBase, ...localBase };
  merged.sentAt = timestamp(serverMessage.sentAt, `sent message ${key}`)
    <= timestamp(localMessage.sentAt, `sent message ${key}`)
    ? serverMessage.sentAt
    : localMessage.sentAt;
  const clientMsgId = serverMessage.clientMsgId || localMessage.clientMsgId;
  if (clientMsgId) merged.clientMsgId = clientMsgId;
  applySentDeletionState(merged, serverMessage, localMessage, key);
  return merged;
}

function indexBy(records, keyFor, label) {
  const indexed = new Map();
  for (const record of records) {
    const key = keyFor(record);
    if (indexed.has(key)) throw new Error(`${label} contains duplicate key ${key}`);
    indexed.set(key, record);
  }
  return indexed;
}

function mergeSentMessages(serverStore, localStore) {
  const keyFor = (message) => keyForTarget(message.channel, message.ts);
  const server = indexBy(serverStore.messages, keyFor, "server sent messages");
  const local = indexBy(localStore.messages, keyFor, "local sent messages");
  const messages = sortedKeys(new Set([...server.keys(), ...local.keys()])).map((key) => {
    if (server.has(key) && local.has(key)) return mergeSentRecord(server.get(key), local.get(key), key);
    return clone(server.get(key) || local.get(key));
  });
  const clientTargets = new Map();
  for (const message of messages) {
    if (!message.clientMsgId) continue;
    const target = keyFor(message);
    if (clientTargets.has(message.clientMsgId) && clientTargets.get(message.clientMsgId) !== target) {
      throw new Error(`Sent message clientMsgId conflict at ${message.clientMsgId}`);
    }
    clientTargets.set(message.clientMsgId, target);
  }
  return { version: 1, messages };
}

function strictRecordUnion(serverRecords, localRecords, {
  keyFor,
  label,
  secondaryKeyFor
}) {
  const merged = new Map();
  for (const [source, records] of [["server", serverRecords], ["local", localRecords]]) {
    for (const record of records) {
      const key = keyFor(record);
      if (!merged.has(key)) {
        merged.set(key, clone(record));
      } else if (!sameValue(merged.get(key), record)) {
        throw new Error(`${label} conflict at ${key} (${source})`);
      }
    }
  }

  if (secondaryKeyFor) {
    const secondary = new Map();
    for (const [primaryKey, record] of merged) {
      const secondaryKey = secondaryKeyFor(record);
      if (!secondaryKey) continue;
      if (secondary.has(secondaryKey) && secondary.get(secondaryKey) !== primaryKey) {
        throw new Error(`${label} secondary slot conflict at ${secondaryKey}`);
      }
      secondary.set(secondaryKey, primaryKey);
    }
  }

  return sortedKeys(merged.keys()).map((key) => merged.get(key));
}

function eventSubmission(event) {
  return Object.fromEntries(
    EVENT_SUBMISSION_FIELDS
      .filter((field) => Object.hasOwn(event, field))
      .map((field) => [field, event[field]])
  );
}

function eventProgress(event) {
  const status = String(event.normalizationStatus || "");
  // A completed verification is a monotonic fact: a divergent branch that
  // merely attempted (and failed) a later retry must not erase it. Once both
  // branches are either verified or unverified, attempt/time/status order can
  // select the genuinely newer revision.
  const verified = status === "verified" || status === "verified-source" ? 1 : 0;
  const terminalRejectedInput = status === "rejected-input" ? 1 : 0;
  const attempts = Number(event.normalizationAttemptCount || 0);
  const times = [
    event.normalizationCompletedAt,
    event.normalizationStartedAt,
    event.normalization?.verifiedAt,
    event.createdAt,
    event.eatenAt
  ].map((value) => Date.parse(value || "")).filter(Number.isFinite);
  const latestTime = times.length > 0 ? Math.max(...times) : Number.NEGATIVE_INFINITY;
  const statusRank = NORMALIZATION_STATUS_RANK[status] ?? 0;
  return [verified, terminalRejectedInput, attempts, latestTime, statusRank];
}

function compareProgress(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function mergeEventRevision(serverEvent, localEvent, eventId) {
  if (sameValue(serverEvent, localEvent)) return clone(serverEvent);
  if (!sameValue(eventSubmission(serverEvent), eventSubmission(localEvent))) {
    throw new Error(`Meal event immutable submission conflict at ${eventId}`);
  }
  const progress = compareProgress(eventProgress(serverEvent), eventProgress(localEvent));
  if (progress === 0) throw new Error(`Meal event normalization revision conflict at ${eventId}`);
  return clone(progress > 0 ? serverEvent : localEvent);
}

function eventCreatedTime(event, label) {
  return timestamp(event.createdAt || event.eatenAt, label);
}

function mergeMealEvents(serverStore, localStore) {
  const eventsById = new Map();
  for (const [source, events] of [["server", serverStore.events], ["local", localStore.events]]) {
    for (const event of events) {
      const eventId = String(event.eventId);
      if (!eventsById.has(eventId)) {
        eventsById.set(eventId, clone(event));
      } else {
        eventsById.set(eventId, mergeEventRevision(eventsById.get(eventId), event, eventId, source));
      }
    }
  }

  const slots = new Map();
  for (const [eventId, event] of eventsById) {
    if (!event.respondentId || !event.date) continue;
    const slot = `${event.respondentId}:${event.date}:${event.mealType}`;
    if (!slots.has(slot)) slots.set(slot, []);
    slots.get(slot).push({ eventId, event });
  }
  for (const [slot, records] of slots) {
    if (records.length < 2) continue;
    records.sort((left, right) => {
      const difference = eventCreatedTime(left.event, `meal event ${left.eventId}`)
        - eventCreatedTime(right.event, `meal event ${right.eventId}`);
      return difference || left.eventId.localeCompare(right.eventId, "en");
    });
    const earliestTime = eventCreatedTime(records[0].event, `meal event ${records[0].eventId}`);
    const sameTime = records.filter((record) =>
      eventCreatedTime(record.event, `meal event ${record.eventId}`) === earliestTime);
    if (sameTime.length > 1) throw new Error(`Meal event secondary slot conflict at ${slot}`);
    for (const record of records.slice(1)) eventsById.delete(record.eventId);
  }

  const events = sortedKeys(eventsById.keys()).map((eventId) => eventsById.get(eventId));
  return { version: 1, events };
}

function mergeCandidatePreferences(serverStore, localStore) {
  const responses = strictRecordUnion(serverStore.responses, localStore.responses, {
    keyFor: (response) => String(response.responseId),
    label: "Candidate preference",
    secondaryKeyFor: (response) => response.respondentId
      ? `${response.respondentId}:${response.channel}:${response.messageTs}`
      : ""
  });
  return { version: 1, responses };
}

function mergeCoffeeParticipation(serverStore, localStore) {
  const keyFor = (message) => keyForTarget(message.channel, message.messageTs);
  const server = indexBy(serverStore.messages, keyFor, "server coffee participation");
  const local = indexBy(localStore.messages, keyFor, "local coffee participation");
  const messages = sortedKeys(new Set([...server.keys(), ...local.keys()])).map((key) => {
    const serverMessage = server.get(key);
    const localMessage = local.get(key);
    if (!serverMessage || !localMessage) return clone(serverMessage || localMessage);
    const serverTime = timestamp(serverMessage.updatedAt, `coffee participation ${key}`);
    const localTime = timestamp(localMessage.updatedAt, `coffee participation ${key}`);
    if (serverTime === localTime && !sameValue(serverMessage, localMessage)) {
      throw new Error(`Coffee participation has conflicting states at the same timestamp for ${key}`);
    }
    return clone(localTime > serverTime ? localMessage : serverMessage);
  });
  return { version: 1, messages };
}

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function sentReceiptExists(delivery, sentMessages) {
  return sentMessages.some((message) => {
    if (message.channel !== delivery.channel || message.mealType !== delivery.mealType) return false;
    if (message.clientMsgId) return message.clientMsgId === delivery.clientMsgId;
    if (message.source !== delivery.source) return false;
    if (message.requestedMode !== undefined && message.requestedMode !== delivery.requestedMode) return false;
    return localDateKey(message.sentAt) === localDateKey(delivery.preparedAt);
  });
}

function mergeDeliveryOutbox(serverStore, localStore, sentMessages) {
  const deliveries = strictRecordUnion(serverStore.deliveries, localStore.deliveries, {
    keyFor: (delivery) => String(delivery.clientMsgId),
    label: "Delivery outbox"
  }).filter((delivery) => !sentReceiptExists(delivery, sentMessages));
  return { version: 1, deliveries };
}

function mergeStores(server, local) {
  const history = mergeHistory(server.history, local.history);
  const sentMessages = mergeSentMessages(server.sentMessages, local.sentMessages);
  return {
    history,
    sentMessages,
    mealEvents: mergeMealEvents(server.mealEvents, local.mealEvents),
    verifiedCandidates: clone(server.verifiedCandidates),
    candidatePreferences: mergeCandidatePreferences(
      server.candidatePreferences,
      local.candidatePreferences
    ),
    coffeeParticipation: mergeCoffeeParticipation(
      server.coffeeParticipation,
      local.coffeeParticipation
    ),
    deliveryOutbox: mergeDeliveryOutbox(
      server.deliveryOutbox,
      local.deliveryOutbox,
      sentMessages.messages
    )
  };
}

function writeSnapshotStores(directory, stores) {
  for (const [key, fileName] of Object.entries(STORE_FILES)) {
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(stores[key], null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  }
}

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(candidate, ancestor) {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function prepareOutputPath(outputDirectory, sourceDirectories) {
  if (!String(outputDirectory || "").trim()) throw new Error("output snapshot directory is required");
  const requested = path.resolve(outputDirectory || "");
  const parent = path.dirname(requested);
  const baseName = path.basename(requested);
  if (!baseName || baseName === "." || baseName === "..") {
    throw new Error("Output snapshot must name a new directory");
  }
  const parentReal = requiredDirectory(parent, "output snapshot parent");
  const physical = path.join(parentReal, baseName);
  if (pathEntryExists(physical)) throw new Error("Output snapshot directory already exists");
  if (sourceDirectories.some((source) => isWithin(physical, source))) {
    throw new Error("Output snapshot directory cannot be inside an input snapshot");
  }
  return { requested, physical, parentReal, baseName };
}

function validNow(value) {
  const now = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(now.getTime())) throw new Error("Snapshot merge requires a valid current time");
  return now;
}

export function mergeOperatingSnapshots({ serverDir, localDir, outputDir, now = new Date() } = {}) {
  const effectiveNow = validNow(now);
  const serverDirectory = requiredDirectory(serverDir, "server snapshot");
  const localDirectory = requiredDirectory(localDir, "local snapshot");
  const output = prepareOutputPath(outputDir, [serverDirectory, localDirectory]);

  const server = readSnapshotStores(serverDirectory);
  const local = readSnapshotStores(localDirectory);
  validateOperatingSnapshotDirectory(serverDirectory, { now: effectiveNow });
  validateOperatingSnapshotDirectory(localDirectory, { now: effectiveNow });
  const merged = mergeStores(server, local);

  const prefix = `.${output.baseName}.merge-`;
  const stagingDirectory = fs.mkdtempSync(path.join(output.parentReal, prefix));
  if (process.platform !== "win32") fs.chmodSync(stagingDirectory, 0o700);
  let promoted = false;
  try {
    writeSnapshotStores(stagingDirectory, merged);
    const validation = validateOperatingSnapshotDirectory(stagingDirectory, { now: effectiveNow });
    if (pathEntryExists(output.physical)) throw new Error("Output snapshot directory appeared during merge");
    fs.renameSync(stagingDirectory, output.physical);
    promoted = true;
    return {
      version: 1,
      outputDir: output.requested,
      counts: validation.counts,
      historyGroups: validation.audit.totals.historyMessageGroups
    };
  } finally {
    if (!promoted && path.dirname(stagingDirectory) === output.parentReal
      && path.basename(stagingDirectory).startsWith(prefix)) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }
}
