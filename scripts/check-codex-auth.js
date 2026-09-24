import path from "node:path";
import { config, ROOT_DIR } from "../src/config.js";
import {
  codexAuthCheckFailureKind,
  codexAuthReadiness,
  runStructuredCodex
} from "../src/codex-cli.js";

// Real provider authentication/model probe. Never touches learning stores or Slack.
// Use the normal isolated execution path so refresh tokens are safely persisted.
async function main() {
  if (process.argv.length > 2) throw new Error("The auth check accepts no arguments");
  if (process.platform !== "linux") throw new Error("Codex auth checks run only on the primary Linux server");
  config.codexCliUseSearch = false;
  const result = await runStructuredCodex({
    prompt: 'Authentication and structured-output check. Return exactly {"ok":true}. Do not use tools.',
    schemaPath: path.join(ROOT_DIR, "prompts", "codex-auth-check.schema.json"),
    runKind: "auth-check",
    timeoutMs: 90_000
  });
  if (result.parsed?.ok !== true) throw new Error("Codex auth check returned an invalid response");
  const readiness = codexAuthReadiness(config.codexCliAuthPath);
  if (!readiness.ok) throw new Error(readiness.detail);
  console.log(JSON.stringify({ ok: true, model: config.codexCliModel, reasoningEffort: config.codexCliReasoningEffort,
    checkedAt: new Date().toISOString(), expiresAt: readiness.expiresAt, invocation: result.invocation }, null, 2));
}

main().catch((error) => {
  const failureKind = codexAuthCheckFailureKind(error);
  // This exact, bounded marker is consumed by the shell wrapper. Do not print
  // provider text here: the private invocation log retains the full diagnostic.
  process.stderr.write(`OJEOMMWO_CODEX_AUTH_CHECK_FAILURE=${failureKind}\n`);
  process.stderr.write("Codex live authentication check failed; inspect the private invocation log.\n");
  process.exitCode = 1;
});
