import { config, assertRuntimeConfig } from "../src/config.js";
import { readBoundedResponseBytes } from "../src/bounded-response.js";

assertRuntimeConfig({ requireBotToken: true });

const response = await fetch("https://slack.com/api/auth.test", {
  method: "POST",
  headers: {
    authorization: `Bearer ${config.slackBotToken}`,
    "content-type": "application/x-www-form-urlencoded"
  },
  signal: AbortSignal.timeout(config.slackApiTimeoutMs)
});
const responseBytes = await readBoundedResponseBytes(response, {
  maxBytes: 64 * 1024,
  label: "Slack auth.test response"
});
const result = JSON.parse(new TextDecoder().decode(responseBytes));
if (!response.ok || !result.ok) {
  throw new Error(`Slack auth.test failed: ${result.error ?? response.status}`);
}

const scopes = (response.headers.get("x-oauth-scopes") ?? "")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean)
  .sort();
const requiredScopes = ["channels:read", "chat:write"].sort();
const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
const extraScopes = scopes.filter((scope) => !requiredScopes.includes(scope));
const legacyCommandsScopePresent = extraScopes.includes("commands");
const unsupportedExtraScopes = extraScopes.filter((scope) => scope !== "commands");
const operationalScopeMatch = missingScopes.length === 0 && unsupportedExtraScopes.length === 0;
const leastPrivilege = operationalScopeMatch && extraScopes.length === 0;

console.log(JSON.stringify({
  ok: true,
  team: result.team,
  user: result.user,
  botId: result.bot_id,
  scopes,
  requiredScopes,
  missingScopes,
  extraScopes,
  legacyCommandsScopePresent,
  operationalScopeMatch,
  leastPrivilege
}, null, 2));

if (!leastPrivilege) process.exitCode = 1;
