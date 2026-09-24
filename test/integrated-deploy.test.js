import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(ROOT, "scripts", "deploy-integrated-pororo.ps1");
const script = fs.readFileSync(SCRIPT_PATH, "utf8");

test("integrated archive packages bot source only and rejects generated observatory state", () => {
  const localPreparation = script.slice(0, script.indexOf("$ContainerScript = @'"));
  const syntaxCheck = fs.readFileSync(path.join(ROOT, "scripts", "check-syntax.js"), "utf8");
  assert.ok(script.includes('"config", "prompts", "scripts", "src", "test"'));
  assert.doesNotMatch(localPreparation, /\$ObservatorySourceEntries|Copy-SourceEntry\s+-SourceRoot\s+\$ObservatoryRoot/u,
    "the integrated bot transaction must not stage any nested observatory source");
  assert.match(localPreparation, /\$ArchiveEntries\s*=\s*@\(\$BotSourceEntries\)/u);
  assert.doesNotMatch(localPreparation, /\$ArchiveEntries[^\r\n]*observatory/u);

  assert.match(script, /Assert-SourceOnlyTree/u);
  assert.match(script, /\.env.*logs.*node_modules.*\.next.*out.*runtime.*\.git/u);
  assert.match(script, /\^\(data\).*observatory\/data/u);
  assert.match(script, /observatory\/public\/data\/snapshot\.json/u);
  assert.match(script, /Integrated bot source archive contains nested observatory source/u);
  assert.match(script, /integrated bot archive contains nested observatory source/u);
  assert.doesNotMatch(syntaxCheck, /observatory\/public\/data\/snapshot\.json/u,
    "the DB-derived snapshot is generated and validated by observatory verify, not tracked bot syntax input");
  assert.match(script, /Assert-NoReparsePoint/u);
  assert.doesNotMatch(script, /Test-Path[^\r\n]*-Force/u,
    "Test-Path has no -Force parameter; hidden entries are handled by literal existence checks");
  assert.doesNotMatch(script, /\[System\.IO\.Path\]::GetRelativePath/u,
    "Windows PowerShell 5.1 does not expose Path.GetRelativePath");
  assert.doesNotMatch(localPreparation, /Get-Command\s+"?(?:node|npm|pnpm)|&\s+\$?(?:Node|Npm|Pnpm)\b/iu,
    "the local phase must not install dependencies or build source");
});

test("integrated deploy uses the exact pororo to ojeommwo root contract", () => {
  assert.match(script, /\$SshTarget\s*=\s*"ojeommwo@203\.0\.113\.10"/u);
  assert.match(script, /\$ExpectedRemoteRoot\s*=\s*"\/root\/ojeommwo-v2"/u);
  assert.match(script, /RemoteRoot -cne \$ExpectedRemoteRoot/u);
  assert.match(script, /docker cp "\$archive" "\$container:\$container_archive"/u);
  assert.match(script, /docker exec -i "\$container" sh -s --/u);
  assert.match(script, /container='ojeommwo'/u);
  assert.match(script, /HostConfig\.RestartPolicy\.Name/u);
  assert.match(script, /crontab -l/u);
  assert.match(script, /grep -Fxc/u);
  assert.match(fs.readFileSync(path.join(ROOT, "scripts", "pororo-crontab.txt"), "utf8"),
    /pgrep -x sshd[\s\S]*\/usr\/sbin\/sshd/u,
    "container restarts must not silently disable the local emergency sync management path");
  assert.match(script, /CRON_TZ=Asia\/Seoul/u);
  assert.match(script, /path traversal/u);
  assert.match(script, /stat -c %d "\$root"[\s\S]*stat -c %d "\$stage"/u);
  assert.match(script, /staged source is missing \$required/u);
  assert.match(script, /\[switch\]\$BotOnly/u);
  assert.match(script, /\[switch\]\$ApplyTaxonomyMigration/u);
  assert.match(script, /\[switch\]\$RepairCandidateReadiness/u);
  assert.match(script, /PreviousRecommendationsSha256[\s\S]*\^\[A-Fa-f0-9\]\{64\}\$/u);
  for (const fixture of [
    "holiday-skip-dates.json",
    "recommendations.json",
    "recommendations.sample.json"
  ]) assert.match(script, new RegExp(fixture.replaceAll(".", "\\."), "u"));
  assert.match(script, /Get-FileHash[\s\S]*FixtureManifestBase64/u);
  assert.match(script, /verify_static_fixtures[\s\S]*sha256sum/u);
  assert.match(script, /immutable fixture hash differs from the audited local release/u);
  assert.match(script, /case "\$root_mode" in[\s\S]*700\|750/u);
  assert.match(script, /find "\$stage" ! -type d ! -type f -print -quit/u);
  assert.match(script, /find "\$stage" -type d -exec chmod 0750 \{\} \+/u);
  assert.match(script, /find "\$stage" -type f -exec chmod 0640 \{\} \+/u);
  assert.match(script, /find "\$stage\/scripts" -type f -name '\*\.sh' -exec chmod 0750 \{\} \+/u);
  assert.doesNotMatch(script, /chmod 0755 "\$stage\/scripts/u);
  assert.match(script, /Invoke-NativeChecked[\s\S]*\[string\]\$StandardInput/u);
  assert.match(script, /ProcessStartInfo[\s\S]*RedirectStandardInput\s*=\s*\$true/u);
  assert.match(script, /UTF8Encoding\]::new\(\$false\)[\s\S]*StandardInput\.BaseStream\.Write/u,
    "the remote script payload must be written as explicit UTF-8 bytes");
  assert.doesNotMatch(script, /\$StandardInput \| & \$FilePath/u);
  assert.ok(script.includes("$BomSafeRemoteShell = \"LC_ALL=C sed '1s/^\\xEF\\xBB\\xBF//' | sh -s\""),
    "Windows PowerShell's optional redirected-stdin BOM must be stripped before set -eu");
  assert.match(script, /\$BomSafeRemoteShell[\s\S]*-StandardInput \$HostScript/u,
    "the remote transaction must stream its script over stdin instead of exceeding Windows argv limits");
  assert.doesNotMatch(script, /\$HostScriptBase64/u);
});

test("integrated bot promotion fences live work and rolls back the whole root", () => {
  assert.match(script, /\.operating-maintenance/u);
  for (const contract of [
    /\.candidate-refresh\.lock/u,
    /\.scheduled-lunch\.lock/u,
    /\.scheduled-dinner\.lock/u,
    /\.interaction-listener\.lock/u,
    /flock -n 5/u,
    /flock -n 6/u,
    /flock -n 7/u,
    /flock -n 8/u
  ]) assert.match(script, contract);
  assert.match(script, /\/proc\/\[0-9\]\*[\s\S]*cmdline=.*cmdline.*2>\/dev\/null\) \|\| continue[\s\S]*cmd0=.*"\$cmdline"[\s\S]*cmd1=.*"\$cmdline"/u);
  assert.match(script, /cmd1" = 'scripts\/run-interaction-listener\.js'/u);
  assert.match(script, /readlink -f "\$proc\/cwd"[\s\S]*= "\$root"/u);
  assert.doesNotMatch(script, /pkill|pgrep/u, "listener detection must compare exact argv and cwd");
  assert.match(script, /moved_states='\.env data logs observatory'[\s\S]*for name in \$moved_states; do[\s\S]*mv -- "\$root\/\$name" "\$stage\/\$name"/u);
  assert.match(script, /mv -- "\$root" "\$backup"[\s\S]*mv -- "\$stage" "\$root"/u);
  assert.match(script, /restore_previous/u);
  assert.match(script, /backup_operating_stores\(\)[\s\S]*recommendations\.json[\s\S]*verified-candidates\.json/u);
  assert.match(script, /restore_operating_stores\(\)[\s\S]*\.deploy-rollback-\$operation_id/u);
  assert.match(script, /restore_previous[\s\S]*restore_operating_stores[\s\S]*previous interaction listener could not be restored/u,
    "a failed taxonomy deployment must restore source and data before restarting the listener");
  assert.match(script, /if ! mv -- "\$backup" "\$root"; then[\s\S]*mv -- "\$failed" "\$root"/u,
    "a failed previous-root rename must retain a complete promoted fallback");
  assert.match(script, /recovery_complete=0[\s\S]*recovery paths were retained/u,
    "incomplete rollback must retain every recovery tree instead of deleting live state");
  assert.match(script, /reconcile_swap_state\(\)[\s\S]*! -e "\$root"[\s\S]*-d "\$backup"[\s\S]*-d "\$stage"[\s\S]*root_moved=1/u);
  assert.match(script, /reconcile_swap_state\(\)[\s\S]*-d "\$root"[\s\S]*-d "\$backup"[\s\S]*! -e "\$stage"[\s\S]*promoted=1/u);
  assert.match(script, /reconcile_swap_state[\s\S]*restore_previous/u,
    "cleanup must recover swap flags before selecting rollback logic");
  assert.match(script, /previous interaction listener could not be restored exactly once/u);
  assert.match(script, /run_bot_tests\(\)[\s\S]*test\/\*\.test\.js[\s\S]*awk/u,
    "failed server tests must emit bounded per-failure diagnostics");
  assert.match(script, /rm -f -- "\$archive" "\$listing" "\$test_log"/u,
    "deployment cleanup must remove the bounded test log");
  assert.match(script, /listener_count\)" -eq 1/u);
  assert.match(script, /start_listener\(\)[\s\S]*exec 4>&- 5>&- 6>&- 7>&- 8>&-[\s\S]*nohup \.\/scripts\/run-interaction-listener\.sh/u,
    "the listener must not inherit source, candidate, meal, or listener deployment locks");
  assert.doesNotMatch(script, /start_listener[^\n]*\nlistener_stopped=0/u,
    "rollback must still restore one listener if the final count check fails");
  const startIndex = script.indexOf("start_listener || { echo 'new interaction listener");
  const finalCountIndex = script.indexOf('[ "$(listener_count)" -eq 1 ]', startIndex);
  const commitIndex = script.indexOf("committed=1", finalCountIndex);
  assert.ok(startIndex >= 0 && finalCountIndex > startIndex && commitIndex > finalCountIndex,
    "deployment must remain rollback-capable through listener start and final exact-count validation");
  for (const store of [
    "recommendation-history.json", "sent-messages.json", "meal-events.json",
    "verified-candidates.json", "candidate-preferences.json",
    "coffee-participation.json", "delivery-outbox.json"
  ]) assert.ok(script.includes(store), `pre-promotion validation is missing ${store}`);
  assert.match(script, /chmod 0600 "\$stage\/data\/"\*\.json/u);
});

test("server validation precedes promotion and nested observatory deploy follows bot success", () => {
  const firstCheck = script.indexOf('(cd "$stage" && node scripts/check-syntax.js)');
  const sourceSwap = script.indexOf('mv -- "$root" "$backup"');
  const postCheck = script.indexOf('(cd "$root" && node scripts/check-syntax.js)');
  const botPassed = script.indexOf("$BotSourcePassed = $true");
  const nestedInvoke = script.indexOf("& $ObservatoryDeploy -SshTarget $SshTarget");
  assert.ok(firstCheck >= 0 && sourceSwap > firstCheck, "full checks must run before promotion");
  assert.ok(postCheck > sourceSwap, "checks must run again after promotion");
  assert.ok(botPassed > postCheck && nestedInvoke > botPassed,
    "nested observatory deployment must begin only after bot source success");
  assert.match(script, /NODE_ENV=test node --import \.\/scripts\/setup-node-environment\.js --test test\/\*\.test\.js/u);
  assert.match(script, /node src\/index\.js --validate/u);
  assert.match(script, /normalize-meal-events\.js --reject-invalid --apply/u);
  assert.match(script, /migrate-food-taxonomy\.js --apply --externally-fenced/u);
  assert.match(script, /OJEOMMWO_MAINTENANCE_TOKEN="\$operation_id"/u);
  assert.match(script, /verify_static_fixtures pre[\s\S]*verify_static_fixtures post/u);
  assert.match(script, /integrated-source-deployment/u);
  assert.match(script, /validate-operating-snapshot\.js --data-dir data/u);
  assert.match(script, /audit-recommendations\.js --strict/u);
  assert.match(script, /health-check\.js --require-pass/u);
  assert.match(script, /node src\/index\.js --slack-capability-test/u);
  const rejectInvalidIndex = script.indexOf("normalize-meal-events.js --reject-invalid --apply");
  const releaseHealthIndex = script.indexOf("health-check.js --require-pass");
  assert.ok(rejectInvalidIndex > sourceSwap && releaseHealthIndex > rejectInvalidIndex,
    "post-promotion invalid-input migration must precede release health");
  assert.match(script, /server-side[\s\S]*pnpm install\/build/u);
  assert.doesNotMatch(script, /slack-auth-test|send-scheduled-meal\.js/u,
    "deployment verification must not send Slack messages");
  assert.match(script, /no message was sent|never send a test message/u);
  assert.match(script, /if \(-not \$BotOnly\)[\s\S]*& \$ObservatoryDeploy/u);
  assert.match(script, /never send a test message[\s\S]*personal DM/u);
});

test("candidate-readiness repair is explicit, fenced, rollback-capable, and delivery-free", () => {
  const refreshCommand = /node scripts\/refresh-verified-candidates\.js\s+\\\s*\n\s*--force --required-ready-sets 2/gu;
  assert.equal([...script.matchAll(refreshCommand)].length, 1,
    "the repair path must contain exactly one forced two-set refresh");

  const repairBlock = script.match(
    /if \[ "\$repair_candidate_readiness" -eq 1 \]; then[\s\S]*?node scripts\/refresh-verified-candidates\.js[\s\S]*?\nfi/u,
  )?.[0] || "";
  assert.ok(repairBlock, "candidate refresh must be gated by the explicit repair switch");
  assert.doesNotMatch(repairBlock, /send-scheduled-meal|slack-auth-test|run-candidate-refresh\.sh/u,
    "repair must invoke only the non-delivery CLI while the deployment owns the lock");

  assert.match(script, /repair_candidate_readiness=\$6/u);
  assert.match(script,
    /case "\$repair_candidate_readiness" in\s*0\|1\) ;;\s*\*\) echo 'invalid candidate-readiness repair mode'/u,
    "the container must reject any interpolated mode other than literal 0 or 1");
  assert.match(script,
    /\$RepairCandidateReadinessValue = if \(\$RepairCandidateReadiness\) \{ "1" \} else \{ "0" \}/u);
  assert.match(script,
    /'__APPLY_TAXONOMY__' '__PREVIOUS_RECOMMENDATIONS_SHA__' \\\s*\n\s*'__REPAIR_CANDIDATE_READINESS__'/u);
  assert.match(script,
    /\.Replace\("__REPAIR_CANDIDATE_READINESS__", \$RepairCandidateReadinessValue\)/u,
    "the host must pass a validated numeric mode as its own quoted positional argument");

  const backupFunction = script.slice(
    script.indexOf("backup_operating_stores()"),
    script.indexOf("restore_operating_stores()"),
  );
  assert.doesNotMatch(backupFunction, /return 0/u,
    "every deployment must preserve rollback state, including model-only changes");
  assert.match(backupFunction, /cp -- "\$root\/\.env" "\$operating_backup\/\.env"/u);
  assert.match(script, /mv -f -- "\$root\/\.env\.rollback-\$operation_id" "\$root\/\.env"/u,
    "rollback must atomically restore the operating model settings");
  assert.match(backupFunction, /meal-events\.json[\s\S]*verified-candidates\.json/u,
    "repair rollback must snapshot both normalization and candidate stores");

  const backupIndex = script.indexOf("backup_operating_stores ||");
  const promotionIndex = script.indexOf('mv -- "$stage" "$root"');
  const normalizationIndex = script.indexOf("normalize-meal-events.js --reject-invalid --apply");
  const refreshIndex = script.indexOf("node scripts/refresh-verified-candidates.js");
  const validateIndex = script.indexOf("node src/index.js --validate", refreshIndex);
  const healthIndex = script.indexOf("health-check.js --require-pass", refreshIndex);
  const slackReadOnlyIndex = script.indexOf("node src/index.js --slack-capability-test", refreshIndex);
  const commitIndex = script.indexOf("committed=1", refreshIndex);
  assert.ok(
    backupIndex >= 0 && promotionIndex > backupIndex && normalizationIndex > promotionIndex
      && refreshIndex > normalizationIndex && validateIndex > refreshIndex
      && healthIndex > validateIndex && slackReadOnlyIndex > healthIndex && commitIndex > slackReadOnlyIndex,
    "repair must run once after migration/normalization and before validation, health, read-only Slack, and commit",
  );

  const cleanup = script.slice(script.indexOf("cleanup() {"), script.indexOf("trap cleanup EXIT"));
  assert.match(cleanup,
    /status" -ne 0[\s\S]*restore_previous[\s\S]*restore_operating_stores[\s\S]*start_listener/u,
    "a refresh or later gate failure must restore source and operating stores before the old listener restarts");
  assert.ok(refreshIndex < commitIndex,
    "refresh failure must remain inside the transaction's uncommitted rollback window");
});

test("bot-only promotion preserves the verified observatory subtree by exact rename", () => {
  assert.match(script, /observatory_runtime_link=\.\.\/\.\.\/\.ojeommwo-v2-state\/observatory/u);
  assert.match(script, /verify_observatory_tree\(\)[\s\S]*out\/index\.html[\s\S]*readlink "\$observatory\/runtime"/u);

  const validationLink = script.indexOf('ln -s "$root/observatory" "$stage/observatory"');
  const validationLinkRemoval = script.indexOf('rm -- "$stage/observatory"', validationLink);
  const moveSet = script.indexOf("moved_states='.env data logs observatory'");
  const exactMove = script.indexOf('mv -- "$root/$name" "$stage/$name"', moveSet);
  const sourceSwap = script.indexOf('mv -- "$root" "$backup"');
  const promotedIdentityCheck = script.indexOf("promoted observatory subtree is not the verified live subtree");
  const botOnlyGate = script.indexOf("if (-not $BotOnly)");
  assert.ok(
    validationLink >= 0 && validationLinkRemoval > validationLink && moveSet > validationLinkRemoval
      && exactMove > moveSet && sourceSwap > exactMove && promotedIdentityCheck > sourceSwap
      && botOnlyGate > promotedIdentityCheck,
    "read-only validation must end before the exact live subtree rename, root swap, and optional nested deploy",
  );
  assert.match(script, /observatory_identity=\$\(stat -c '%d:%i' "\$root\/observatory"\)/u);
  assert.match(script, /restore_moved_states_from[\s\S]*for name in \$moved_states/u);
  assert.doesNotMatch(script, /ln -s "\$observatory_runtime_link" "\$stage\/observatory\/runtime"/u,
    "the integrated transaction must never reconstruct part of the live observatory tree");
});

test("integrated and standalone observatory promotions share one source lock", () => {
  const standalonePath = path.join(ROOT, "observatory", "scripts", "deploy-pororo.ps1");
  const standalone = fs.readFileSync(standalonePath, "utf8");
  assert.match(script, /exec 4>"\$observatory_state\/\.source-deploy\.lock"[\s\S]*flock -n 4/u);
  assert.match(standalone, /exec 8>"\$HOST_STATE\/\.source-deploy\.lock"[\s\S]*flock -n 8/u);

  const lock = script.indexOf('exec 4>"$observatory_state/.source-deploy.lock"');
  const cleanupUnlock = script.indexOf("flock -u 4");
  const cleanupTrap = script.indexOf("trap cleanup EXIT");
  const exactMove = script.indexOf('mv -- "$root/$name" "$stage/$name"');
  assert.ok(lock >= 0 && cleanupUnlock > lock && cleanupTrap > cleanupUnlock && exactMove > cleanupTrap,
    "EXIT cleanup must own the shared lock release while the rename runs under that lock");
});

test("integrated deployment PowerShell parses", { skip: process.platform !== "win32" }, () => {
  const escaped = SCRIPT_PATH.replaceAll("'", "''");
  const command = [
    "$tokens=$null;$errors=$null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors)|Out-Null`,
    "if($errors.Count){$errors|ForEach-Object{Write-Error $_.Message};exit 1}"
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
