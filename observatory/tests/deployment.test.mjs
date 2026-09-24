import { EXPECTED_RELEASE } from "../worker/snapshot-edge.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSnapshot } from "../scripts/lib/snapshot-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("release, static fallback, and Sites contracts stay aligned", () => {
  const pkg = JSON.parse(read("package.json"));
  const hosting = JSON.parse(read(".openai/hosting.json"));
  const workspace = read("pnpm-workspace.yaml");
  assert.equal(`${read("VERSION").trim()}.0`, pkg.version);
  assert.match(read("next.config.ts"), /output:\s*["']export["']/u);
  assert.equal(hosting.project_id, "appgprj_6a5dac95abb88191ae8971c41ad2372c");
  assert.equal(hosting.d1, null);
  assert.equal(hosting.r2, "SNAPSHOTS");
  assert.match(pkg.scripts["build:sites"], /build-sites\.mjs/u);
  assert.match(pkg.scripts["verify:sites"], /build-sites\.mjs/u);
  assert.equal(pkg.packageManager, "pnpm@11.16.0");
  const sitesBuild = read("scripts/build-sites.mjs");
  assert.match(sitesBuild, /vinext[\s\S]*dist[\s\S]*cli\.js/u);
  assert.match(sitesBuild, /Build complete\./u);
  assert.match(sitesBuild, /UV_HANDLE_CLOSING/u);
  assert.match(sitesBuild, /validateFreshBuild/u);
  assert.equal(fs.existsSync(path.join(root, "package-lock.json")), false);
  assert.equal(fs.existsSync(path.join(root, "scripts", "setup-test-environment.mjs")), true);
  assert.equal(fs.existsSync(path.join(root, "tests", "setup-node-environment.mjs")), false);
  assert.equal(fs.existsSync(path.join(root, "tests", "test-environment.mjs")), false);
  assert.match(pkg.scripts.test, /--import \.\/scripts\/setup-test-environment\.mjs --test/u);
  assert.match(pkg.scripts.verify, /--import \.\/scripts\/setup-test-environment\.mjs --test/u);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /\.\/tests\/(?:test-environment|setup-node-environment)\.mjs/u);
  assert.equal(pkg.dependencies.next, "16.3.3");
  assert.equal(pkg.dependencies.react, "19.2.8");
  assert.equal(pkg.dependencies["react-dom"], "19.2.8");
  assert.equal(pkg.devDependencies.eslint, "10.7.0");
  assert.equal(pkg.devDependencies["eslint-config-next"], undefined);
  assert.equal(pkg.devDependencies["eslint-plugin-react-hooks"], "7.1.1");
  assert.equal(pkg.devDependencies["typescript-eslint"], "8.65.0");
  assert.equal(pkg.devDependencies["react-server-dom-webpack"], "19.2.8");
  assert.equal(pkg.devDependencies.vite, "8.0.16");
  assert.equal(pkg.devDependencies.vinext, "0.0.50");
  assert.equal(pkg.dependencies.vinext, undefined);
  assert.match(workspace, /minimatch@10\.2\.5>brace-expansion["']?:\s*5\.0\.9/u);
  assert.match(workspace, /esbuild:\s*0\.28\.1/u);
  assert.match(workspace, /fast-uri:\s*3\.1\.7/u);
  assert.match(workspace, /nanoid:\s*3\.3\.18/u);
  assert.match(workspace, /postcss:\s*8\.5\.23/u);
  assert.match(workspace, /sharp:\s*0\.35\.4/u);
  assert.match(workspace, /undici:\s*7\.29\.0/u);
  assert.match(workspace, /ws:\s*8\.21\.0/u);
  assert.match(workspace, /sharp:\s*true/u);
  assert.match(workspace, /unrs-resolver:\s*true/u);
  for (const ghsa of ["GHSA-5p2g-fcmc-qvqq", "GHSA-w3rx-r6r6-pgpr"]) {
    assert.equal(workspace.match(new RegExp(ghsa, "gu"))?.length, 1);
  }
  assert.match(workspace, /audit:\s*\n\s*level:\s*low\s*\n\s*ignore:/u);

  const unsafeBuildAssets = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (/\.(?:heic|heif|icns|jxl)$/iu.test(entry.name)) unsafeBuildAssets.push(fullPath);
    }
  };
  for (const directory of ["app", "public", "worker"]) walk(path.join(root, directory));
  assert.deepEqual(unsafeBuildAssets, []);
  assert.doesNotMatch(workspace, /set this to true or false/u);
});

test("snapshot refresh validates protected DB state and atomically promotes only a fresh candidate", () => {
  const refresh = read("scripts/refresh-snapshot-host.sh");
  const cron = read("scripts/install-snapshot-cron.sh");
  assert.match(cron, /\*\/10 \* \* \* \*/u);
  assert.match(cron, /HEALTH_MINUTES='2,7,12,17,22,27,32,37,42,47,52,57'/u);
  assert.match(cron, /HEALTH_LINE="\$HEALTH_MINUTES \* \* \* \* .*--health --max-age-seconds 1200/u);
  assert.doesNotMatch(cron, /HEALTH_LINE="\*\/5/u);
  assert.match(refresh, /CONTAINER_ROOT=\/root\/ojeommwo-v2\/observatory/u);
  assert.match(refresh, /CONTAINER_STATE=\/root\/\.ojeommwo-v2-state\/observatory/u);
  assert.match(refresh, /SOURCE_DATA=\/root\/ojeommwo-v2\/data/u);
  assert.match(refresh, /OPERATING_VALIDATOR=\/root\/ojeommwo-v2\/scripts\/validate-operating-snapshot\.js/u);
  assert.match(refresh, /export-snapshot\.mjs/u);
  assert.match(refresh, /validate-snapshot\.mjs/u);
  assert.match(refresh, /--health/u);
  assert.match(refresh, /--max-age-seconds/u);
  assert.match(refresh, /runtime snapshot is stale/u);
  const operatingValidation = refresh.indexOf('node "$operating_validator" --data-dir "$data"');
  const exportCandidate = refresh.indexOf('node "$project/scripts/export-snapshot.mjs"');
  const validateCandidate = refresh.indexOf('node "$project/scripts/validate-snapshot.mjs" "$candidate"');
  const atomicPromotion = refresh.indexOf('mv -f -- "$candidate" "$snapshot"');
  assert.ok(
    operatingValidation >= 0 && exportCandidate > operatingValidation
      && validateCandidate > exportCandidate && atomicPromotion > validateCandidate,
    "invalid operating data or candidate output must never replace the last known-good snapshot"
  );
  assert.doesNotMatch(refresh, /codex|luna|openai|slack|wget|search/iu);

  const markerValidation = cron.indexOf("BEGIN_COUNT=$(grep -Fxc");
  const cronPromotion = cron.indexOf('crontab "$TEMP"');
  assert.ok(markerValidation >= 0 && cronPromotion > markerValidation,
    "managed cron markers must be validated before replacing the crontab");
  assert.match(cron, /BEGIN_COUNT[\s\S]*END_COUNT[\s\S]*markers are malformed/u);
  assert.match(cron, /BEGIN_LINE[\s\S]*END_LINE[\s\S]*marker order is malformed/u);
});

test("Sites publish is authenticated, byte-verified, and retires only the legacy edge", () => {
  const deploy = read("run-pororo.sh");
  const refresh = read("scripts/refresh-snapshot-host.sh");
  const push = read("scripts/push-snapshot-sites.mjs");
  const cron = read("scripts/install-snapshot-cron.sh");
  const edge = read("worker/snapshot-edge.mjs");
  assert.match(refresh, /push-snapshot-sites\.mjs/u);
  assert.match(refresh, /sha256sum "\$HOST_STATE\/snapshot\.json"/u);
  assert.match(refresh, /Sites snapshot hash does not match/u);
  assert.match(refresh, /public-url\.txt/u);
  assert.doesNotMatch(refresh, /FALLBACK_URL|203\.0\.113\.10/u);
  assert.match(read("scripts/lib/sites-http.mjs"), /method: "GET"/u);
  assert.match(refresh, /flock -w 60 9/u);
  assert.match(push, /AbortSignal\.timeout\(120_000\)/u);
  assert.match(push, /Authorization: authorization/u);
  assert.match(push, /api\/snapshot\/chunk/u);
  assert.match(push, /api\/snapshot\/commit/u);
  assert.match(push, /api\/snapshot\/abort/u);
  assert.match(push, /createHash\("sha256"\)/u);
  assert.doesNotMatch(push, /SLACK_|lunch|recommendation-history/u);
  assert.match(edge, /MAX_SNAPSHOT_BYTES = 512 \* 1024/u);
  assert.match(edge, /MAX_CHUNK_BYTES = 2 \* 1024/u);
  assert.match(edge, /MAX_SNAPSHOT_CHUNKS = 256/u);
  assert.equal(EXPECTED_RELEASE, JSON.parse(read("package.json")).version);
  assert.match(deploy, /SERVICE_VERSION.*src\/version\.js/u);
  assert.match(deploy, /"\$RELEASE_VERSION" = "\$EXPECTED_RELEASE"/u);
  assert.doesNotMatch(deploy, /"\$RELEASE_VERSION" = [0-9]/u);
  assert.match(edge, /tokenMatches/u);
  assert.match(edge, /SNAPSHOTS\.put/u);
  assert.match(cron, /\*\/10 \* \* \* \* .*refresh-snapshot-host\.sh/u);
  assert.doesNotMatch(cron, /refresh-public-url-host|trycloudflare/u);
  const publish = deploy.indexOf('"$ROOT/scripts/refresh-snapshot-host.sh"');
  const health = deploy.indexOf('"$ROOT/scripts/refresh-snapshot-host.sh" --health', publish);
  const retire = deploy.indexOf('docker rm -f "$container"', health);
  assert.ok(publish >= 0 && health > publish && retire > health,
    "the legacy edge must remain available until Sites accepts and serves the fresh snapshot");
  assert.match(deploy, /LEGACY_TUNNEL_CONTAINER=ojeommwo-observatory-tunnel/u);
  assert.match(deploy, /LEGACY_APP_CONTAINER=ojeommwo-observatory/u);
  assert.doesNotMatch(deploy, /ojeommwo-v2-app|pororo-docker|lunch/u);
});

test("deployment uploads source only and builds transactionally inside ojeommwo", () => {
  const deploy = read("scripts/deploy-pororo.ps1");
  const localPhase = deploy.slice(0, deploy.indexOf("$RemoteScript = @'"));
  const sourceList = deploy.slice(deploy.indexOf("$RequiredSource = @("), deploy.indexOf("foreach ($Entry"));

  assert.match(deploy, /ExpectedRemoteRoot = "\/home\/ojeommwo\/docker1\/root\/ojeommwo-v2\/observatory"/u);
  assert.match(deploy, /HOST_STATE=\/home\/ojeommwo\/docker1\/root\/\.ojeommwo-v2-state\/observatory/u);
  assert.match(deploy, /CONTAINER_ROOT=\/root\/ojeommwo-v2\/observatory/u);
  assert.match(deploy, /DATA_DIR=\/root\/ojeommwo-v2\/data/u);
  assert.doesNotMatch(localPhase, /&\s*\$(?:Pnpm|Node)\b|\bpnpm(?:\.cmd)?\s+(?:install|verify|build)|\bnode(?:\.exe)?\s+/iu);
  assert.doesNotMatch(sourceList, /["'](?:out|runtime|node_modules|\.next)["']/u);
  for (const source of [
    ".gitattributes", ".openai", "ARCHITECTURE.md", "build", "DESIGN.md", "HANDOFF.md",
    "README.md", "SECURITY.md", "public", "vite.config.ts", "worker"
  ]) {
    assert.ok(sourceList.includes(`"${source}"`), `integrated source archive is missing ${source}`);
  }
  assert.match(localPhase, /--exclude=public\/data\/snapshot\.json/u);
  assert.match(localPhase, /\$ArchiveListing\s*=\s*@\(& \$Tar -tzf \$Archive\)/u);
  assert.match(deploy, /public\/data\/snapshot\\\.json/u,
    "both local and remote archive validation must reject the DB-derived snapshot");
  assert.match(deploy, /Source archive contains the DB-derived public snapshot/u);
  assert.match(deploy, /deployment archive contains the DB-derived public snapshot/u);
  assert.match(deploy, /docker exec[\s\S]*corepack pnpm install --frozen-lockfile/u);
  assert.match(deploy, /corepack pnpm audit --prod --audit-level low/u);
  assert.match(deploy, /corepack pnpm audit --audit-level low/u);
  assert.match(deploy, /corepack pnpm verify/u);
  assert.match(deploy, /CONTAINER_STAGE="\$CONTAINER_PARENT\/\.observatory-stage-\$OPERATION_ID"/u);
  assert.match(deploy, /ln -s "\$RUNTIME_LINK" "\$STAGE\/runtime"/u);
  assert.match(deploy, /rm -rf -- "\$stage\/node_modules" "\$stage\/\.next"/u);
  assert.match(deploy, /rm -f -- "\$stage\/tsconfig\.tsbuildinfo"/u,
    "the server build must not promote TypeScript incremental metadata");
  assert.match(deploy, /\[ ! -e "\$STAGE\/tsconfig\.tsbuildinfo" \]/u,
    "the host promotion gate must verify TypeScript incremental metadata is absent");
  assert.match(deploy, /mv -- "\$ROOT" "\$BACKUP"[\s\S]*mv -- "\$STAGE" "\$ROOT"/u);
  assert.match(deploy, /new observatory failed health checks; restoring previous source/u);
  assert.match(deploy, /restore_source/u);
  assert.match(deploy, /FAILED="\$HOST_PARENT\/\.observatory-failed-\$OPERATION_ID"/u);
  assert.match(deploy, /mv -- "\$ROOT" "\$FAILED"[\s\S]*mv -- "\$BACKUP" "\$ROOT"/u);
  assert.match(deploy, /reconcile_source_state[\s\S]*PROMOTION_STARTED[\s\S]*PROMOTED=1/u);
  assert.match(deploy, /reconcile_source_state[\s\S]*restore_source/u,
    "signal cleanup must reconstruct a completed rename before restoring the old source");
  assert.match(deploy, /flock -n 8/u);
  assert.match(deploy, /LEGACY_RUNTIME=\/home\/ojeommwo\/docker1\/root\/ojeommwo-observatory\/runtime/u);
  assert.match(deploy, /\.legacy-snapshot-\$OPERATION_ID\.candidate/u);
  assert.match(deploy, /validate-snapshot\.mjs"[\s\S]*\.legacy-snapshot-\$OPERATION_ID\.candidate/u);
  assert.match(deploy, /CANONICAL_PUBLIC_URL=https:\/\/ojeommwo-observatory\.jumincho\.chatgpt\.site\//u);
  assert.match(deploy, /PUBLIC_URL_BACKUP="\$HOST_STATE\/\.public-url-\$OPERATION_ID\.previous"/u);
  assert.match(deploy, /cmp -s -- "\$PUBLIC_URL_FILE" "\$PUBLIC_URL_BACKUP"/u);
  assert.match(deploy, /PUBLIC_URL_PROMOTED=1[\s\S]*if sh "\$ROOT\/run-pororo\.sh"/u);
  assert.match(deploy, /new observatory failed health checks[\s\S]*restore_public_url[\s\S]*restore_source/u,
    "a failed Sites handoff must restore both the legacy public URL and source");
  assert.doesNotMatch(deploy, /trycloudflare/u);
  assert.match(deploy, /if docker exec "\$DATA_CONTAINER" node[\s\S]*validate-snapshot\.mjs/u);
  assert.match(deploy, /legacy snapshot was incompatible and will be regenerated/u);
  assert.match(deploy, /rm -f -- "\$LEGACY_SNAPSHOT_CANDIDATE"/u);
  const legacyV1 = Object.fromEntries([
    "algorithm", "cooccurrenceEdges", "displayOnly", "generatedAt", "menus",
    "recommendationEvents", "restaurants", "schemaVersion", "source", "stats", "taxonomy"
  ].map((key) => [key, null]));
  legacyV1.schemaVersion = 1;
  assert.throws(() => validateSnapshot(legacyV1), /schemaVersion must be 2/u);
  assert.doesNotMatch(deploy, /rm -rf --? "?\$LEGACY_(?:ROOT|RUNTIME)/u);
  assert.match(deploy, /docker exec "\$DATA_CONTAINER" chown "root:\$HOST_GID" "\$CONTAINER_PARENT"/u);
  assert.match(deploy, /docker exec "\$DATA_CONTAINER" chmod 0770 "\$CONTAINER_PARENT"/u);
  assert.match(deploy, /restore_parent_permissions[\s\S]*chmod 0750 "\$CONTAINER_PARENT"/u);
  assert.match(deploy, /if ! restore_parent_permissions; then/u);
  assert.match(
    deploy,
    /CONTAINER_BACKUP="\$CONTAINER_PARENT\/\.observatory-previous-\$OPERATION_ID"[\s\S]*docker exec "\$DATA_CONTAINER" rm -rf -- "\$CONTAINER_BACKUP"[\s\S]*COMPLETE=1/u,
    "root-owned previous build artifacts must be removed before deployment is declared complete",
  );
  assert.doesNotMatch(deploy, /chmod\s+(?:-R\s+)?0?7[0-7]{2}\s+[^\n]*(?:\.env|DATA_DIR|\/data)/u);
});

test("standalone deploy streams a BOM-safe shell program outside Windows argv", () => {
  const deployPath = path.join(root, "scripts", "deploy-pororo.ps1");
  const deployBytes = fs.readFileSync(deployPath);
  const deploy = deployBytes.toString("utf8");

  assert.notDeepEqual([...deployBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf],
    "the PowerShell source itself must not carry a UTF-8 BOM");
  assert.match(deploy, /Invoke-NativeChecked[\s\S]*\[string\]\$StandardInput/u);
  assert.match(deploy, /ProcessStartInfo[\s\S]*RedirectStandardInput\s*=\s*\$true/u);
  assert.match(deploy, /UTF8Encoding\]::new\(\$false\)\.GetBytes\(\$StandardInput\)[\s\S]*StandardInput\.BaseStream\.Write/u,
    "Windows PowerShell must write explicit BOM-free UTF-8 bytes to native stdin");
  assert.match(deploy, /LC_ALL=C sed '1s\/\^\\xEF\\xBB\\xBF\/\/' \| sh -s -- '\$RemoteRoot' '\$RemoteArchive' '\$OperationId'/u,
    "the remote shell must defensively strip one optional BOM and receive only short validated arguments");
  assert.match(deploy, /-StandardInput \(\$RemoteScript \+ "`n"\)/u);
  assert.doesNotMatch(deploy, /\$RemoteScript\s*\|\s*&\s*\$Ssh/u,
    "the PowerShell pipeline can re-encode native stdin and must not be used");
  assert.doesNotMatch(deploy, /RemoteDriver|RemoteScriptBase64|RemoteCommand\s*=\s*[^\r\n]*\$RemoteScript/u,
    "the large remote program must not be copied through a second file or embedded in argv/base64 argv");
});

test("native stdin plus the optional BOM guard preserves a large Unicode payload byte-for-byte", { skip: process.platform !== "win32" }, () => {
  const deploy = read("scripts/deploy-pororo.ps1");
  const helperStart = deploy.indexOf("function ConvertTo-NativeArgument");
  const helperEnd = deploy.indexOf("if ($SshTarget", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = deploy.slice(helperStart, helperEnd);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-observatory-stdin-"));
  const receiver = path.join(temporary, "receiver.cjs");
  const rawReceived = path.join(temporary, "raw-received.bin");
  const received = path.join(temporary, "received.bin");
  const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
  try {
    fs.writeFileSync(
      receiver,
      "const fs=require('node:fs');const raw=fs.readFileSync(0);fs.writeFileSync(process.argv[2],raw);const bom=raw.length>=3&&raw[0]===0xef&&raw[1]===0xbb&&raw[2]===0xbf;fs.writeFileSync(process.argv[3],bom?raw.subarray(3):raw);\n",
      "utf8",
    );
    const command = [
      helper,
      "$payload=('한글🙂' * 6000)",
      `Invoke-NativeChecked -FilePath ${psQuote(process.execPath)} -Arguments @(${psQuote(receiver)},${psQuote(rawReceived)},${psQuote(received)}) -StandardInput $payload -FailureMessage 'stdin receiver failed'`,
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const raw = fs.readFileSync(rawReceived);
    const actual = fs.readFileSync(received);
    const expected = Buffer.from("한글🙂".repeat(6000), "utf8");
    assert.ok(expected.length > 32 * 1024, "fixture must exceed common Windows argv limits");
    const hasBom = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    assert.deepEqual(hasBom ? raw.subarray(3) : raw, expected,
      "native stdin may add only the one optional BOM removed by the remote guard");
    assert.deepEqual(actual, expected);
    assert.notDeepEqual([...actual.subarray(0, 3)], [0xef, 0xbb, 0xbf],
      "the shell payload after the guard must be BOM-free");
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
});

test("standalone deployment PowerShell parses", { skip: process.platform !== "win32" }, () => {
  const deployPath = path.join(root, "scripts", "deploy-pororo.ps1");
  const escaped = deployPath.replaceAll("'", "''");
  const command = [
    "$tokens=$null;$errors=$null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors)|Out-Null`,
    "if($errors.Count){$errors|ForEach-Object{Write-Error $_.Message};exit 1}",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("failed Sites handoff restores the previous verified source before retiring the old edge", () => {
  const deploy = read("scripts/deploy-pororo.ps1");
  const runtime = read("run-pororo.sh");
  const rootSwap = deploy.indexOf('mv -- "$ROOT" "$BACKUP"');
  const stagePromotion = deploy.indexOf('mv -- "$STAGE" "$ROOT"', rootSwap);
  const appPromotion = deploy.indexOf('if sh "$ROOT/run-pororo.sh"', stagePromotion);
  const failureStatus = deploy.indexOf("else\n    status=$?", appPromotion);
  const failureRestore = deploy.indexOf('if ! restore_source; then', appPromotion);
  const failureExit = deploy.indexOf('exit "$status"', failureRestore);
  assert.ok(
    rootSwap >= 0 && stagePromotion > rootSwap && appPromotion > stagePromotion
      && failureStatus > appPromotion && failureRestore > failureStatus && failureExit > failureRestore,
    "a failed app must retain its nonzero status while the previous source/export is restored",
  );
  assert.match(deploy, /for required in[\s\S]*out\/index\.html/u);
  const snapshotPublish = runtime.indexOf('"$ROOT/scripts/refresh-snapshot-host.sh"');
  const snapshotHealth = runtime.indexOf('"$ROOT/scripts/refresh-snapshot-host.sh" --health', snapshotPublish);
  const cronInstall = runtime.indexOf('"$ROOT/scripts/install-snapshot-cron.sh"', snapshotHealth);
  const siteHealth = runtime.indexOf('"${PUBLIC_URL}healthz"', cronInstall);
  const previousRemoval = runtime.indexOf('docker rm -f "$container"', siteHealth);
  assert.ok(snapshotPublish >= 0 && snapshotHealth > snapshotPublish && cronInstall > snapshotHealth
      && siteHealth > cronInstall && previousRemoval > siteHealth,
    "the Quick Tunnel fallback must remain intact through every fallible Sites handoff check");
});

test("server verification does not require a globally installed pnpm shim", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts.build, "node scripts/build-sites.mjs");
  assert.doesNotMatch(packageJson.scripts.verify, /(^|\s|&&)\s*pnpm\s/u);
  assert.match(packageJson.scripts.verify, /node scripts\/export-snapshot\.mjs/u);
  assert.match(packageJson.scripts.verify, /node scripts\/validate-snapshot\.mjs public\/data\/snapshot\.json/u);
  assert.ok(
    packageJson.scripts.verify.indexOf("node scripts/validate-snapshot.mjs")
      > packageJson.scripts.verify.indexOf("node scripts/export-snapshot.mjs"),
    "observatory verify must validate the server-generated snapshot before build",
  );
  assert.match(packageJson.scripts.verify, /node --import \.\/scripts\/setup-test-environment\.mjs --test/u);
  assert.match(packageJson.scripts.verify, /eslint/u);
  assert.match(packageJson.scripts.verify, /tsc --noEmit/u);
  assert.match(packageJson.scripts.verify, /next build/u);
  assert.match(packageJson.scripts.start, /run-local-emergency-viewer\.mjs/u);
});

test("embedded server shell programs do not terminate their own quote boundary", () => {
  const deploy = read("scripts/deploy-pororo.ps1");
  const refresh = read("scripts/refresh-snapshot-host.sh");
  const deployProgram = deploy.match(/sh -eu -c '(?<program>[\s\S]*?)' sh "\$CONTAINER_STAGE"/u)?.groups?.program;
  const refreshPrograms = [...refresh.matchAll(/sh -eu -c '(?<program>[\s\S]*?)' sh /gu)].map((match) => match.groups.program);
  assert.ok(deployProgram);
  assert.equal(refreshPrograms.length, 2);
  for (const program of [deployProgram, ...refreshPrograms]) {
    assert.doesNotMatch(program, /'/u, "single quotes would close the host shell's embedded program literal");
  }
});

test("short viewports cannot place the fixed reroll shop over the control grid", () => {
  const css = read("app/globals.css");
  assert.match(css, /height:\s*calc\(100dvh - 72px - 212px\);\s*min-height:\s*0;/u);
  assert.doesNotMatch(css, /\.observatory-grid[^}]*min-height:\s*430px/su);
});

test("display-only easter eggs stay isolated from operations while appearing in both visualizations", () => {
  const observatory = read("app/components/Observatory.tsx");
  const tasteMap = read("app/components/TasteMap.tsx");
  const cosmos = read("app/components/MenuCosmos.tsx");
  const reroll = read("app/components/RerollShop.tsx");
  assert.match(observatory, /<TasteMap[^>]+easterEggs=/u);
  assert.match(observatory, /<MenuCosmos[\s\S]+easterEggs=/u);
  assert.match(tasteMap, /taste-map__star--easter/u);
  assert.match(cosmos, /kind:\s*"anomaly"/u);
  assert.doesNotMatch(reroll, /easterEgg/iu);
});
