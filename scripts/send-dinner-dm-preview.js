import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_LUNCH_CHANNEL_ID,
  REQUIRED_OPERATOR_DM_CHANNEL_ID,
  assertRuntimeConfig
} from "../src/config.js";
import { sendDinnerDmPreview } from "../src/dm-preview.js";
import { validateStaticFallback } from "../src/recommender.js";

const VALUE_OPTIONS = new Set(["--channel", "--mode"]);
const FLAG_OPTIONS = new Set(["--send", "--dry-run"]);

export function parseDinnerDmPreviewArguments(argv = []) {
  if (!Array.isArray(argv)) throw new Error("DM preview arguments must be an array");
  const values = new Map();
  const flags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (VALUE_OPTIONS.has(argument)) {
      if (values.has(argument)) throw new Error(`${argument} may be specified only once`);
      const value = argv[index + 1];
      if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      values.set(argument, value.trim());
      index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(argument)) {
      if (flags.has(argument)) throw new Error(`${argument} may be specified only once`);
      flags.add(argument);
      continue;
    }
    throw new Error(`unknown argument: ${String(argument)}`);
  }

  if (flags.has("--send") && flags.has("--dry-run")) {
    throw new Error("--send and --dry-run cannot be used together");
  }

  const send = flags.has("--send");
  const channel = values.get("--channel") || REQUIRED_OPERATOR_DM_CHANNEL_ID;
  const mode = values.get("--mode") || "cache";
  if (channel !== REQUIRED_OPERATOR_DM_CHANNEL_ID) {
    throw new Error(`DM preview destination must exactly match the protected operator DM ${REQUIRED_OPERATOR_DM_CHANNEL_ID}`);
  }
  if (mode !== "cache") throw new Error("DM preview mode must be cache");

  return {
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    mode,
    send,
    dryRun: !send
  };
}

export async function runDinnerDmPreviewCli({
  argv = process.argv.slice(2),
  assertRuntimeConfigFn = assertRuntimeConfig,
  validateStaticFallbackFn = validateStaticFallback,
  sendDinnerDmPreviewFn = sendDinnerDmPreview,
  log = console.log
} = {}) {
  const { channel, mode, send, dryRun } = parseDinnerDmPreviewArguments(argv);
  assertRuntimeConfigFn({ dryRun, requireBotToken: send });
  const fallback = validateStaticFallbackFn();
  if (!fallback.ok) throw new Error(fallback.message);

  const result = await sendDinnerDmPreviewFn({
    channel,
    mode,
    dryRun,
    protectedMealChannel: REQUIRED_LUNCH_CHANNEL_ID,
    operatorDmChannel: REQUIRED_OPERATOR_DM_CHANNEL_ID
  });
  if (dryRun) {
    log(result.text);
    log(`[dm-preview] dry-run only; destination=${channel}`);
    return result;
  }
  log(`[dm-preview] sent current dinner recommendation to ${result.delivery.channel}:${result.delivery.ts}`);
  return result;
}

const directInvocation = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directInvocation) {
  runDinnerDmPreviewCli().catch((error) => {
    console.error("[dm-preview] failed:", error);
    process.exitCode = 1;
  });
}
