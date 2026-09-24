import { config, assertRuntimeConfig } from "./config.js";
import { validateStaticFallback } from "./recommender.js";
import { assertCodexCliAvailable } from "./codex-cli.js";
import { slackApi } from "./slack.js";
import { executeMeal } from "./meal-service.js";
import { logError, logInfo } from "./logger.js";
import { RELEASE_LABEL } from "./version.js";
import { verifySlackCapability } from "./slack-capability.js";

const dryRun = process.argv.includes("--dry-run");
const validateOnly = process.argv.includes("--validate");
const slackAuthTest = process.argv.includes("--slack-auth-test");
const slackCapabilityTest = process.argv.includes("--slack-capability-test");
const showVersion = process.argv.includes("--version");

async function sendMeal({ channel, mealType, source }) {
  return executeMeal({
    channel,
    mealType,
    source,
    mode: config.recommendationMode,
    dryRun
  });
}

async function main() {
  if (showVersion) {
    console.log(RELEASE_LABEL);
    return;
  }
  assertRuntimeConfig({ dryRun });
  const fallback = validateStaticFallback();
  if (!fallback.ok) {
    throw new Error(fallback.message);
  }
  if (config.recommendationMode === "codex-cli") {
    const codexCli = assertCodexCliAvailable();
    if (!codexCli.ok) throw new Error(codexCli.message);
    logInfo(`[validate] Codex CLI available at ${codexCli.path}`);
  }

  if (validateOnly) {
    logInfo("[validate] configuration and static fallback passed.");
    return;
  }

  if (slackAuthTest) {
    const auth = await slackApi("auth.test", {});
    logInfo(`[validate] Slack bot auth passed for team ${auth.team || auth.team_id || "unknown"}.`);
    return;
  }

  if (slackCapabilityTest) {
    const capability = await verifySlackCapability();
    logInfo(
      `[validate] Slack bot auth, lunch membership, and Socket Mode passed for team ${capability.team}; no message was sent.`
    );
    return;
  }

  if (dryRun) {
    const result = await sendMeal({ channel: config.lunchChannelId, mealType: "식사", source: "dry-run" });
    console.log(result.text);
    return;
  }

  throw new Error("Direct live scheduling is disabled; use the fenced server cron or local-emergency task wrappers");
}

main().catch((error) => {
  logError("[fatal]", error);
  process.exitCode = 1;
});
