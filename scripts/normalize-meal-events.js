import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, assertRuntimeConfig } from "../src/config.js";
import {
  normalizeMealEventById,
  pendingMealEventIds
} from "../src/meal-event-normalizer.js";
import {
  invalidCustomMealInputReason,
  prepareMealEventForNormalization
} from "../src/meal-normalization.js";
import { getMealEvents, updateMealEventsByIdAtomically } from "../src/storage.js";

function parseArguments(argv) {
  const valueFlags = new Set(["--event-id"]);
  const booleanFlags = new Set([
    "--apply", "--with-codex", "--prepare", "--latest", "--force-reset-verified", "--reject-invalid"
  ]);
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valueFlags.has(argument)) {
      if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (booleanFlags.has(argument)) {
      if (flags.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      flags.add(argument);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return {
    has: (name) => flags.has(name) || values.has(name),
    value: (name) => values.get(name) || ""
  };
}

function isCustomEvent(event) {
  return Boolean(event.inputText || event.inputNormalization || event.rawMenu);
}

function isVerifiedNormalization(event) {
  return event.normalizationStatus === "verified" || event.normalizationStatus === "verified-source";
}

export function prepareMealEventsAtomically(eventIds, {
  enabled = config.mealNormalizationEnabled,
  forceResetVerified = false,
  updateEvents = updateMealEventsByIdAtomically,
  prepareEvent = prepareMealEventForNormalization
} = {}) {
  if (!Array.isArray(eventIds) || !eventIds.length || eventIds.length > 2000
      || eventIds.some((eventId) => !String(eventId || "").trim())
      || new Set(eventIds).size !== eventIds.length
      || typeof updateEvents !== "function"
      || typeof prepareEvent !== "function") {
    throw new Error("Atomic meal preparation requires unique event IDs and a batch update function");
  }
  return updateEvents(eventIds, (current, eventId) => {
    if (!isCustomEvent(current)) throw new Error(`Meal event is no longer a custom event: ${eventId}`);
    if (isVerifiedNormalization(current) && !forceResetVerified) {
      throw new Error(
        `Refusing to reset verified custom meal events (${eventId}); add --force-reset-verified after review`
      );
    }
    return prepareEvent(current, { enabled });
  });
}

function invalidReasonForEvent(event) {
  if (!isCustomEvent(event)) return "";
  return invalidCustomMealInputReason({
    restaurantInput: event.rawRestaurant ?? event.restaurant,
    menuInput: event.rawMenu ?? event.menu
  });
}

export function rejectInvalidMealEventsAtomically({
  getStore = getMealEvents,
  updateEvents = updateMealEventsByIdAtomically,
  prepareEvent = prepareMealEventForNormalization
} = {}) {
  if (typeof getStore !== "function" || typeof updateEvents !== "function" || typeof prepareEvent !== "function") {
    throw new Error("Invalid meal rejection requires store, batch update, and preparation functions");
  }
  const store = getStore();
  const eventIds = store?.events
    ?.filter((event) => invalidReasonForEvent(event))
    .map((event) => event.eventId) || [];
  if (!eventIds.length) return [];
  return updateEvents(eventIds, (current) => {
    // Recheck under the storage lock so a concurrently corrected submission is
    // never reset from its newer meaningful value.
    if (!invalidReasonForEvent(current)) return current;
    return prepareEvent(current, { enabled: config.mealNormalizationEnabled });
  });
}

export async function normalizeMealEventsIndependently(eventIds, {
  normalizeEvent = normalizeMealEventById
} = {}) {
  if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 2000
      || eventIds.some((eventId) => !String(eventId || "").trim())
      || new Set(eventIds).size !== eventIds.length
      || typeof normalizeEvent !== "function") {
    throw new Error("Independent meal normalization requires 1-2000 unique event IDs and a normalization function");
  }
  const results = [];
  for (const eventId of eventIds) {
    try {
      const result = await normalizeEvent(eventId);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Normalization returned an invalid result contract");
      }
      results.push({ eventId, ok: true, result });
    } catch (error) {
      results.push({
        eventId,
        ok: false,
        error: String(error?.message || error || "normalization failed").slice(0, 240)
      });
    }
  }
  return {
    results,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length
  };
}

export async function main() {
  const args = parseArguments(process.argv.slice(2));
  const apply = args.has("--apply");
  const withCodex = args.has("--with-codex");
  const prepare = args.has("--prepare");
  const latest = args.has("--latest");
  const forceResetVerified = args.has("--force-reset-verified");
  const rejectInvalid = args.has("--reject-invalid");
  const requestedId = args.value("--event-id");
  if (withCodex && !apply) throw new Error("--with-codex requires --apply");
  if (forceResetVerified && (!prepare || !apply)) {
    throw new Error("--force-reset-verified requires --prepare --apply");
  }
  if (requestedId && latest) throw new Error("--event-id and --latest cannot be combined");
  if (rejectInvalid && (requestedId || latest || prepare || withCodex || forceResetVerified)) {
    throw new Error("--reject-invalid can be combined only with --apply");
  }
  if (withCodex) assertRuntimeConfig({ requireBotToken: false });

  const store = getMealEvents();
  let targets = store.events.filter(isCustomEvent);
  if (rejectInvalid) targets = targets.filter((event) => invalidReasonForEvent(event));
  else if (requestedId) targets = targets.filter((event) => event.eventId === requestedId);
  else if (latest) targets = targets.slice(-1);
  else if (!prepare) {
    const pending = new Set(pendingMealEventIds({ maxEvents: 2000 }));
    targets = targets.filter((event) => pending.has(event.eventId));
  }
  if (!targets.length) {
    if (rejectInvalid) {
      console.log(`[meal-normalization] selected=0 apply=${apply} rejectInvalid=true`);
      return;
    }
    throw new Error("No matching custom meal events were found");
  }
  if (rejectInvalid) {
    if (apply) rejectInvalidMealEventsAtomically();
  } else if (prepare) {
    if (apply) {
      prepareMealEventsAtomically(targets.map((event) => event.eventId), { forceResetVerified });
    } else {
      targets.map((event) => prepareMealEventForNormalization(event, {
        enabled: config.mealNormalizationEnabled
      }));
    }
  }

  console.log(
    `[meal-normalization] selected=${targets.length} apply=${apply} withCodex=${withCodex} rejectInvalid=${rejectInvalid}`
  );
  if (!apply) {
    for (const event of targets) {
      console.log(`[meal-normalization] would process ${event.eventId}: ${event.restaurant || "(상호 미입력)"} / ${event.menu}`);
    }
    return;
  }
  if (!withCodex) return;

  const batch = await normalizeMealEventsIndependently(targets.map((event) => event.eventId));
  for (const item of batch.results) {
    console.log(item.ok
      ? `[meal-normalization] ${item.eventId}: ${item.result.event?.normalizationStatus || item.result.reason}`
      : `[meal-normalization] ${item.eventId}: failed (${item.error})`);
  }
  if (batch.failed) {
    throw new Error(
      `${batch.failed}/${batch.results.length} independent meal normalizations failed; successful items remain committed and reruns are idempotent`
    );
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error("[meal-normalization] failed:", error.message);
    process.exitCode = 1;
  });
}
