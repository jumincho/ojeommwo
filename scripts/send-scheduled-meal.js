import { config, assertRecommendationMode, assertRuntimeConfig } from "../src/config.js";
import { slackApi } from "../src/slack.js";
import { executeMeal } from "../src/meal-service.js";
import { normalizeMealType } from "../src/meal-types.js";
import { validateStaticFallback } from "../src/recommender.js";
import { sendOperationsAlert } from "../src/operations-alert.js";
import { verifySlackDeliveryTarget } from "../src/slack-capability.js";

const failureContext = {
  meal: "unknown",
  channel: "unknown",
  mode: "unknown",
  dryRun: false,
  alertOnFailure: false
};

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set(["--meal", "--channel", "--mode"]);
  const flagOptions = new Set(["--dry-run", "--auth-test"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valueOptions.has(argument)) {
      if (values.has(argument)) throw new Error(`${argument} may be specified only once`);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (flagOptions.has(argument)) {
      if (flags.has(argument)) throw new Error(`${argument} may be specified only once`);
      flags.add(argument);
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return {
    has: (name) => values.has(name) || flags.has(name),
    value: (name, fallback = "") => values.get(name) ?? fallback
  };
}

function sourceForMode(mode) {
  if (mode === "codex-cli") return "scheduled-codex-cli";
  return `scheduled-${mode}`;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const authTest = args.has("--auth-test");
  const mode = args.value("--mode", "cache").trim();

  if (dryRun && authTest) throw new Error("--dry-run and --auth-test cannot be used together");

  let mealType = "auth-test";
  let channel = "auth-test";
  if (!authTest) {
    if (!args.has("--meal")) {
      throw new Error("--meal is required; use lunch or dinner for live delivery");
    }

    const meal = args.value("--meal").trim().toLowerCase();
    mealType = normalizeMealType(meal);
    if (!dryRun && !["lunch", "dinner"].includes(meal)) {
      throw new Error("live scheduled delivery requires --meal lunch or --meal dinner");
    }
    if (!dryRun && (!args.has("--channel") || !args.value("--channel").trim())) {
      throw new Error("live scheduled delivery requires an explicit --channel");
    }
    if (!dryRun && mode !== "cache") {
      throw new Error("live scheduled delivery requires --mode cache; model and static modes are dry-run diagnostics only");
    }

    channel = args.has("--channel") ? args.value("--channel").trim() : "";
    if (channel && !/^[CGD][A-Z0-9]+$/u.test(channel)) {
      throw new Error("--channel must be a Slack channel or conversation ID");
    }
    if (!dryRun && channel !== config.lunchChannelId) {
      throw new Error("live scheduled delivery requires --channel to exactly match LUNCH_CHANNEL_ID; use the dedicated DM preview for live DM tests");
    }
  }

  Object.assign(failureContext, {
    meal: mealType,
    channel,
    mode,
    dryRun,
    alertOnFailure: !dryRun && !authTest
  });
  assertRecommendationMode(mode);
  assertRuntimeConfig({ dryRun, requireBotToken: authTest || !dryRun });
  const fallback = validateStaticFallback();
  if (!fallback.ok) throw new Error(fallback.message);

  if (authTest) {
    const auth = await slackApi("auth.test", {});
    console.log(`[scheduled] Slack auth passed for ${auth.team || auth.team_id || "unknown"}.`);
    return;
  }

  const startedAt = new Date().toISOString();
  console.log(`[scheduled] starting ${mealType} recommendation for ${channel} using ${mode} at ${startedAt}`);

  if (!dryRun) {
    const capability = await verifySlackDeliveryTarget({ lunchChannelId: channel });
    console.log(
      `[scheduled] Slack delivery target passed for ${capability.team}:${capability.channel}; preflight sent no message.`
    );
  }

  const result = await executeMeal({
    channel,
    mealType,
    mode,
    source: sourceForMode(mode),
    dryRun
  });

  if (!dryRun && result.weather === null) {
    try {
      await sendOperationsAlert({
        job: `${mealType} 날씨 정보`,
        detail: "기상청 필수 현재·단기예보를 가져오지 못해 추천은 발송했지만 날씨 줄은 안전하게 생략됨"
      });
    } catch (alertError) {
      console.error("[scheduled] weather omission alert failed:", alertError);
    }
  }

  if (dryRun) console.log(result.text);
  else console.log(`[scheduled] sent ${mealType} recommendation to ${result.delivery.channel}:${result.delivery.ts}`);
  if (result.fallbackReason) console.log(`[scheduled] fallbackReason=${result.fallbackReason}`);
  if (result.researchStats) console.log(`[scheduled] searchStats=${JSON.stringify(result.researchStats)}`);
}

main().catch(async (error) => {
  console.error("[scheduled] failed:", error);
  if (failureContext.alertOnFailure) {
    try {
      await sendOperationsAlert({
        job: `${failureContext.meal} scheduled delivery to ${failureContext.channel} (${failureContext.mode})`,
        detail: error?.message || error
      });
    } catch (alertError) {
      console.error("[scheduled] failure alert failed:", alertError);
    }
  }
  process.exitCode = 1;
});
