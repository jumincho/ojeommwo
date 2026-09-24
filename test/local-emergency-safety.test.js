import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedWindowsPowerShellEnvironment } from "../src/windows-powershell-environment.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(ROOT, "scripts", name), "utf8");
const windowsPowerShellEnvironment = (overrides = {}) =>
  isolatedWindowsPowerShellEnvironment(overrides);
const powerShellFiles = [
  "enable-local-emergency.ps1",
  "run-local-emergency-meal.ps1",
  "run-local-interaction-listener.ps1",
  "disable-local-emergency.ps1",
  "local-failover-common.ps1",
  "powershell-hash-compat.ps1",
  "sync-operating-data-from-server.ps1",
  "reconcile-local-emergency-data.ps1"
];

test("local emergency JSON parsing preserves ISO release dates as strings on PowerShell 7", {
  skip: process.platform !== "win32"
}, () => {
  const commonPath = path.join(ROOT, "scripts", "local-failover-common.ps1");
  const escapedCommonPath = commonPath.replaceAll("'", "''");
  const command = `
. '${escapedCommonPath}'
$parsed = ConvertFrom-OjeommwoJson -Json '{"date":"2026-08-24T17:48:32+09:00"}'
if ($parsed.date -isnot [string]) { throw "ISO date was coerced to $($parsed.date.GetType().FullName)" }
`;
  const result = spawnSync("pwsh.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("local emergency activation requires a fresh exact server snapshot and a bounded lease", () => {
  const script = read("enable-local-emergency.ps1");
  const common = read("local-failover-common.ps1");
  assert.match(script, /\$LunchChannel\s*=\s*""/u);
  assert.match(script, /\[ValidateRange\(1, 24\)\][\s\S]*\$MaxSnapshotAgeHours\s*=\s*24/u);
  assert.match(script, /\$RequiredLunchChannel\s*=\s*"C0123456789"/u);
  assert.match(script, /\$LunchChannel -cne \$RequiredLunchChannel/u);
  assert.match(script, /pororo-docker is running[\s\S]*cannot be enabled/u);
  assert.match(script, /-RequireExactHashes/u);
  assert.match(script, /\[ValidateRange\(1, 24\)\][\s\S]*\$LeaseHours/u);
  assert.match(script, /Assert-LocalEmergencyReadiness/u);
  assert.match(script, /-CurrentMeal \$CurrentMeal/u);
  assert.match(script, /MaxCatchUpDelayMinutes\s*=\s*45/u);
  assert.match(script, /\$ExpiresAt\s*=\s*\$NextSameMeal/u);
  assert.match(script, /Local Windows emergency mode never runs Codex or changes candidate evidence/u);
  assert.doesNotMatch(script, /Invoke-LocalEmergencyCandidatePreparation/u);
  assert.match(common, /check-local-emergency-readiness\.js/u);
  assert.match(common, /Assert-LocalEmergencyCandidateSnapshot/u);
  assert.match(common, /same-revision recovery copy/u);
  assert.doesNotMatch(common, /local-emergency-candidate-provenance\.json/u);
  assert.match(script, /unreachable-confirmed/u);
  assert.match(script, /local-emergency-lease\.json|Get-LocalEmergencyLeasePath/u);
  assert.match(script, /Enter-OjeommwoStateTransitionLock[\s\S]*try\s*\{[\s\S]*Get-PororoDockerState/u);
  assert.match(script, /Assert-OjeommwoKstLocalTimezone/u);
  assert.match(script, /finally\s*\{\s*Exit-OjeommwoStateTransitionLock/u);
  const standbyValidation = script.indexOf("Assert-LocalStandbySnapshot");
  const leaseCreation = script.indexOf("$LeasePath = Get-LocalEmergencyLeasePath");
  const taskRegistration = script.indexOf("Register-LocalEmergencyTask -TaskName");
  assert.ok(standbyValidation >= 0 && leaseCreation > standbyValidation && taskRegistration > leaseCreation,
    "source/manifest validation must finish before lease or task mutation");
  assert.match(script, /try\s*\{[\s\S]*WriteAllText[\s\S]*Move-Item[\s\S]*finally\s*\{[\s\S]*Remove-Item -LiteralPath \$LeaseTempPath/u);
});

test("local live runners fail closed on lease mismatch and primary recovery", () => {
  const meal = read("run-local-emergency-meal.ps1");
  const listener = read("run-local-interaction-listener.ps1");
  assert.match(meal, /ValidateSet\("lunch", "dinner"\)/u);
  assert.doesNotMatch(meal, /ValidateSet\([^\n]*"meal"/u);
  assert.match(meal, /Get-LocalEmergencyLease/u);
  assert.match(meal, /Invoke-OjeommwoFailClosedAuthorityValidation[\s\S]*Get-LocalEmergencyLease[\s\S]*Assert-LocalStandbySnapshot/u);
  assert.match(read("local-failover-common.ps1"), /function Invoke-OjeommwoFailClosedAuthorityValidation[\s\S]*catch\s*\{[\s\S]*Disable-OjeommwoLocalEmergency[\s\S]*all local tasks and the lease were removed/u);
  assert.match(meal, /Assert-LocalStandbySnapshot/u);
  assert.match(meal, /Test-PororoStatePermitsLease/u);
  assert.match(meal, /Disable-OjeommwoLocalEmergency/u);
  assert.match(meal, /Assert-LocalEmergencyReadiness/u);
  assert.match(meal, /readiness failed closed and all local tasks were removed/u);
  assert.match(meal, /ENABLE_OBSERVATORY_LINK\s*=\s*"false"/u);
  assert.match(meal, /PreviousObservatoryLink/u);
  assert.match(meal, /Assert-OjeommwoKstLocalTimezone/u);
  assert.match(meal, /check-holiday-date\.js/u);
  assert.doesNotMatch(meal, /ConvertFrom-Json[\s\S]*HolidaySkipData/u);
  assert.match(listener, /Get-LocalEmergencyLease/u);
  assert.match(listener, /Test-PororoStatePermitsLease/u);
  assert.match(listener, /Disable-OjeommwoLocalEmergency/u);
  assert.match(listener, /catch\s*\{[\s\S]*failed closed[\s\S]*Disable-OjeommwoLocalEmergency/u);
  assert.match(listener, /ENABLE_OBSERVATORY_LINK\s*=\s*"false"/u);
  assert.match(listener, /PreviousObservatoryLink/u);
});

test("local emergency disable treats an already-clean task scheduler as success", () => {
  const common = read("local-failover-common.ps1");
  assert.match(common, /Get-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue/u);
  assert.match(common, /Unregister-ScheduledTask -Confirm:\$false -ErrorAction Stop/u);
  assert.doesNotMatch(common, /schtasks\.exe \/Delete/u);
});

test("server recovery has a maintenance-fenced, rollback-capable data reconciliation path", () => {
  const reconcile = read("reconcile-local-emergency-data.ps1");
  for (const name of [
    "recommendation-history.json",
    "sent-messages.json",
    "meal-events.json",
    "verified-candidates.json",
    "candidate-preferences.json",
    "coffee-participation.json",
    "delivery-outbox.json"
  ]) assert.match(reconcile, new RegExp(name.replace(".", "\\."), "u"));
  assert.match(reconcile, /\.operating-maintenance/u);
  assert.match(reconcile, /flock -n [5-8]/u);
  assert.match(reconcile, /rollback/u);
  assert.match(reconcile, /merge-operating-snapshots\.js/u);
  assert.match(reconcile, /sync-operating-data-from-server\.ps1/u);
  assert.match(reconcile, /function Ensure-RemoteInteractionListener/u);
  assert.match(reconcile, /Assert-LocalEmergencyCandidateSnapshot/u);
  assert.doesNotMatch(reconcile, /local (?:Luna|model)|(?:Luna|model) candidate divergence/iu);
  assert.doesNotMatch(reconcile, /\b(?:pgrep|pkill)\b/u);
  assert.match(reconcile, /\/proc\/\[0-9\]\*[\s\S]*cmdline=.*cmdline.*2>\/dev\/null\) \|\| continue[\s\S]*cmd0=.*"\$cmdline"[\s\S]*cmd1=.*"\$cmdline"/u);
  assert.match(reconcile, /readlink -f "\$proc\/cwd"[\s\S]*= "\$root"/u);
  assert.match(reconcile, /\$name\.primary[\s\S]*\$name\.bak[\s\S]*\$name\.bak\.absent/u);
  assert.match(reconcile, /promoted primary\/recovery mismatch/u);
  assert.match(reconcile, /cmp -s -- "\$backup\/\$name\.primary" "\$data\/\$name"/u);
  assert.match(reconcile, /finally\s*\{[\s\S]*Ensure-RemoteInteractionListener/u);
  const restoreIndex = reconcile.indexOf("Ensure-RemoteInteractionListener -SshExecutable");
  const refreshIndex = reconcile.indexOf('$SyncScript = Join-Path');
  assert.ok(restoreIndex >= 0 && refreshIndex > restoreIndex,
    "remote listener must be healthy before the local post-reconcile refresh");
  for (const wrapper of ["run-scheduled-meal.sh", "run-candidate-refresh.sh", "run-interaction-listener.sh"]) {
    assert.match(read(wrapper), /\.operating-maintenance/u);
  }
});

test("local candidate evidence must remain the exact server-synced revision", {
  skip: process.platform !== "win32"
}, () => {
  const commonPath = path.join(ROOT, "scripts", "local-failover-common.ps1").replaceAll("'", "''");
  const command = String.raw`
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("ojeommwo-candidate-provenance-test-" + [guid]::NewGuid().ToString("N"))
$data = Join-Path $root "data"
New-Item -ItemType Directory -Path $data -Force | Out-Null
try {
  . '${commonPath}'
  $candidate = Join-Path $data "verified-candidates.json"
  [System.IO.File]::WriteAllText($candidate, '{"version":1,"candidates":[]}', [System.Text.UTF8Encoding]::new($false))
  $baseHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [pscustomobject]@{
    version = 1
    syncedAt = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString("o")
    stores = @([pscustomobject]@{ name = "verified-candidates.json"; sha256 = $baseHash })
  }
  $acceptedHash = Assert-LocalEmergencyCandidateSnapshot -ProjectRoot $root -Manifest $manifest
  if ($acceptedHash -cne $baseHash) { throw "exact server candidate snapshot was not accepted" }

  [System.IO.File]::WriteAllText($candidate, '{"version":1,"candidates":[],"local":true}', [System.Text.UTF8Encoding]::new($false))
  $tamperRejected = $false
  try { Assert-LocalEmergencyCandidateSnapshot -ProjectRoot $root -Manifest $manifest | Out-Null }
  catch { $tamperRejected = $_.Exception.Message -like "*differ from the server-synced*" }
  if (-not $tamperRejected) { throw "local candidate mutation was accepted" }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    cwd: ROOT,
    env: windowsPowerShellEnvironment(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("server-to-local promotion refuses to overwrite an emergency lease", () => {
  const common = read("local-failover-common.ps1");
  const sync = read("sync-operating-data-from-server.ps1");
  const reconcile = read("reconcile-local-emergency-data.ps1");
  assert.match(sync, /Assert-LocalPromotionAllowed[\s\S]*local-emergency-lease\.json/u);
  assert.match(sync, /disable and reconcile emergency mode before server data promotion/u);
  assert.match(sync, /Enter-OjeommwoStateTransitionLock[\s\S]*Invoke-TransactionalPromotion[\s\S]*finally\s*\{[\s\S]*Exit-OjeommwoStateTransitionLock/u);
  assert.match(reconcile, /Enter-OjeommwoStateTransitionLock[\s\S]*Assert-NoLocalEmergencyRuntime[\s\S]*-ExistingStateTransitionLock \$StateTransitionLock[\s\S]*Exit-OjeommwoStateTransitionLock/u);
  assert.match(sync, /ExistingStateTransitionLock[\s\S]*OwnsStateTransitionLock/u);
  assert.match(common, /function Test-OjeommwoLocalRuntimeProcess/u);
  assert.match(common, /\$ProcessName -eq 'node\.exe'/u);
  assert.match(common, /\$Arguments\[1\][\s\S]*scripts\\run-interaction-listener\.js/u);
  assert.match(common, /\$Argument -notin @\('-file', '-f'\)/u);
  assert.match(sync, /Test-OjeommwoLocalRuntimeProcess -Process \$_/u);
  assert.match(reconcile, /Test-OjeommwoLocalRuntimeProcess -Process \$_ -IncludeMealRunner/u);
  assert.doesNotMatch(sync, /CommandLine -match ['"][^'"\n]*interaction-listener/u);
  assert.doesNotMatch(reconcile, /CommandLine -match ['"][^'"\n]*interaction-listener/u);
});

test("sync, failover, and reconciliation seal the exact deployed release and runtime source", () => {
  const common = read("local-failover-common.ps1");
  const sync = read("sync-operating-data-from-server.ps1");
  const reconcile = read("reconcile-local-emergency-data.ps1");

  assert.match(sync, /generate-source-seal\.js/u);
  assert.match(sync, /SOURCE-SEAL\.before\.json[\s\S]*SOURCE-SEAL\.after\.json[\s\S]*cmp -s/u);
  assert.match(sync, /SOURCE-SEAL\.json[\s\S]*SHA256SUMS/u);
  assert.match(sync, /RemoteSourceSealHash[\s\S]*LocalSourceSealHash[\s\S]*-cne/u);
  assert.match(sync, /version\s*=\s*2[\s\S]*release\s*=\s*\[ordered\]@\{[\s\S]*sourceSeal\s*=\s*\[ordered\]@\{/u);
  assert.match(common, /function Assert-OjeommwoManifestReleaseSourceSeal/u);
  assert.match(common, /snapshotMaxAgeHours -gt 24/u);
  assert.match(common, /Manifest\.version -ne 2/u);
  assert.match(common, /Assert-OjeommwoManifestReleaseSourceSeal -ProjectRoot \$ProjectRoot -Manifest \$Manifest/u);
  assert.match(reconcile, /Manifest\.version -ne 2/u);
  assert.match(reconcile, /Assert-OjeommwoManifestReleaseSourceSeal/u);
  assert.match(reconcile, /SOURCE-SEAL\.json[\s\S]*server-source-seal\.before\.json[\s\S]*cmp -s/u);
  assert.match(reconcile, /server-source-seal\.after\.json[\s\S]*deployed application source was not stable/u);
  const syncSealFence = sync.indexOf("if ($RemoteSourceSealHash -cne $LocalSourceSealHash)");
  const snapshotValidation = sync.indexOf('"--data-dir", $StageRoot');
  const standbyReadiness = sync.indexOf('"--lease-expires-at", $ReadinessExpiresAt.ToString("o")');
  const manifestWrite = sync.lastIndexOf("Write-StandbyManifest `");
  const localPromotion = sync.lastIndexOf("Invoke-TransactionalPromotion `");
  assert.ok(syncSealFence >= 0 && manifestWrite > syncSealFence && localPromotion > manifestWrite,
    "a source-seal mismatch must fail before manifest creation or any local promotion");
  assert.ok(snapshotValidation > syncSealFence && standbyReadiness > snapshotValidation
      && manifestWrite > standbyReadiness,
    "a staged snapshot must cover a fresh 24-hour lease before manifest creation or local promotion");
  const prePromoteSeal = reconcile.indexOf("server-source-seal.pre-promote.json");
  const firstPromotion = reconcile.indexOf('promoted="$name $promoted"');
  assert.ok(prePromoteSeal >= 0 && firstPromotion > prePromoteSeal,
    "the deployed source seal must be regenerated immediately before operating-data promotion");
  assert.match(reconcile, /server-source-seal\.pre-promote\.json[\s\S]*local\/SOURCE-SEAL\.json[\s\S]*deployed application source changed before operating-data promotion/u);
});

test("PowerShell manifest identity validation accepts only v2 with an exact release and source seal", {
  skip: process.platform !== "win32"
}, () => {
  const commonPath = path.join(ROOT, "scripts", "local-failover-common.ps1").replaceAll("'", "''");
  const command = String.raw`
. '${commonPath}'
$seal = [pscustomobject][ordered]@{
  version = 1
  release = [pscustomobject][ordered]@{
    version = "2"
    date = "2026-08-30T20:03:46+09:00"
    implementationModel = "Daybreak Blue(GPT-5.6 Sol) Ultra"
    label = "2 exact"
  }
  sourceSeal = [pscustomobject][ordered]@{
    algorithm = "sha256"
    sha256 = ("a" * 64)
    fileCount = 42
  }
}
function New-Manifest {
  param([int]$Version = 2)
  return [pscustomobject][ordered]@{
    version = $Version
    source = "pororo-docker:/root/ojeommwo-v2/data"
    syncedAt = [DateTimeOffset]::UtcNow.ToString("o")
    release = [pscustomobject][ordered]@{
      version = $seal.release.version
      date = $seal.release.date
      implementationModel = $seal.release.implementationModel
      label = $seal.release.label
    }
    sourceSeal = [pscustomobject][ordered]@{
      algorithm = $seal.sourceSeal.algorithm
      sha256 = $seal.sourceSeal.sha256
      fileCount = $seal.sourceSeal.fileCount
    }
    stores = @(
      "recommendation-history.json",
      "sent-messages.json",
      "meal-events.json",
      "verified-candidates.json",
      "candidate-preferences.json",
      "coffee-participation.json",
      "delivery-outbox.json"
    ) | ForEach-Object {
      [pscustomobject][ordered]@{ name = $_; sha256 = ("c" * 64) }
    }
  }
}
$accepted = Assert-OjeommwoManifestReleaseSourceSeal -ProjectRoot $PWD -Manifest (New-Manifest) -CurrentSeal $seal
if ($accepted.sourceSeal.sha256 -cne $seal.sourceSeal.sha256) { throw "exact manifest was not accepted" }

$legacyRejected = $false
try { Assert-OjeommwoManifestReleaseSourceSeal -ProjectRoot $PWD -Manifest (New-Manifest -Version 1) -CurrentSeal $seal | Out-Null }
catch { $legacyRejected = $_.Exception.Message -like "*version 2*" }
if (-not $legacyRejected) { throw "legacy manifest was accepted" }

$releaseMismatch = New-Manifest
$releaseMismatch.release.version = "2.9"
$releaseRejected = $false
try { Assert-OjeommwoManifestReleaseSourceSeal -ProjectRoot $PWD -Manifest $releaseMismatch -CurrentSeal $seal | Out-Null }
catch { $releaseRejected = $_.Exception.Message -like "*release does not match*" }
if (-not $releaseRejected) { throw "release mismatch was accepted" }

$sourceMismatch = New-Manifest
$sourceMismatch.sourceSeal.sha256 = ("b" * 64)
$sourceRejected = $false
try { Assert-OjeommwoManifestReleaseSourceSeal -ProjectRoot $PWD -Manifest $sourceMismatch -CurrentSeal $seal | Out-Null }
catch { $sourceRejected = $_.Exception.Message -like "*source seal does not match*" }
if (-not $sourceRejected) { throw "source mismatch was accepted" }

function Assert-ManifestRejected {
  param($Manifest, [string]$Label)
  $Rejected = $false
  try { Assert-OjeommwoManifestReleaseSourceSeal -ProjectRoot $PWD -Manifest $Manifest -CurrentSeal $seal | Out-Null }
  catch { $Rejected = $true }
  if (-not $Rejected) { throw "$Label was accepted" }
}
$extraTop = New-Manifest
$extraTop | Add-Member -NotePropertyName unexpected -NotePropertyValue $true
Assert-ManifestRejected -Manifest $extraTop -Label "extra top-level property"
$missingTop = New-Manifest
$missingTop.PSObject.Properties.Remove("source")
Assert-ManifestRejected -Manifest $missingTop -Label "missing provenance property"
$extraRelease = New-Manifest
$extraRelease.release | Add-Member -NotePropertyName commit -NotePropertyValue "untrusted"
Assert-ManifestRejected -Manifest $extraRelease -Label "extra release property"
$shortStores = New-Manifest
$shortStores.stores = @($shortStores.stores | Select-Object -First 6)
Assert-ManifestRejected -Manifest $shortStores -Label "six-store manifest"
$duplicateStore = New-Manifest
$duplicateStore.stores[6].name = $duplicateStore.stores[0].name
Assert-ManifestRejected -Manifest $duplicateStore -Label "duplicate-store manifest"
$extraStoreField = New-Manifest
$extraStoreField.stores[0] | Add-Member -NotePropertyName size -NotePropertyValue 1
Assert-ManifestRejected -Manifest $extraStoreField -Label "extra store property"
$uppercaseHash = New-Manifest
$uppercaseHash.stores[0].sha256 = ("A" * 64)
Assert-ManifestRejected -Manifest $uppercaseHash -Label "non-canonical store digest"

$script:DisableCalls = 0
function global:Disable-OjeommwoLocalEmergency {
  param([string]$ProjectRoot)
  $script:DisableCalls += 1
}
$authorityRejected = $false
try {
  Invoke-OjeommwoFailClosedAuthorityValidation -ProjectRoot $PWD -Validation { throw "tampered standby source" } | Out-Null
} catch {
  $authorityRejected = $_.Exception.Message -like "*all local tasks and the lease were removed*tampered standby source*"
}
if (-not $authorityRejected -or $script:DisableCalls -ne 1) {
  throw "authority validation failure did not invoke exactly one automatic disable"
}
`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    cwd: ROOT,
    env: windowsPowerShellEnvironment(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("server sync and local emergency activation share one exclusive state-transition lock", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = fs.mkdtempSync(path.join(process.env.TEMP, "ojeommwo-transition-lock-test-"));
  const lockTemp = path.join(fixture, "locks");
  const readyPath = path.join(fixture, "ready");
  const releasePath = path.join(fixture, "release");
  fs.mkdirSync(lockTemp);
  const commonPath = path.join(ROOT, "scripts", "local-failover-common.ps1").replaceAll("'", "''");
  const escapedFixture = fixture.replaceAll("'", "''");
  const escapedReady = readyPath.replaceAll("'", "''");
  const escapedRelease = releasePath.replaceAll("'", "''");
  const env = windowsPowerShellEnvironment({ TEMP: lockTemp, TMP: lockTemp });
  const holderCommand = [
    `. '${commonPath}'`,
    `$handle=Enter-OjeommwoStateTransitionLock -ProjectRoot '${escapedFixture}'`,
    `try{[System.IO.File]::WriteAllText('${escapedReady}','ready');$deadline=[DateTime]::UtcNow.AddSeconds(30);while(-not (Test-Path -LiteralPath '${escapedRelease}')){if([DateTime]::UtcNow -ge $deadline){throw 'test release signal timed out'};Start-Sleep -Milliseconds 25}}finally{Exit-OjeommwoStateTransitionLock -Handle $handle}`
  ].join(";");
  const contenderCommand = [
    `. '${commonPath}'`,
    `$handle=Enter-OjeommwoStateTransitionLock -ProjectRoot '${escapedFixture}'`,
    "try{}finally{Exit-OjeommwoStateTransitionLock -Handle $handle}"
  ].join(";");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
  const holder = spawn("powershell.exe", [...args, holderCommand], {
    cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  const holderDone = new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.once("close", resolve);
  });
  let holderStderr = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk) => { holderStderr += chunk; });
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(readyPath), true, holderStderr || "lock holder did not become ready");
    const blocked = spawnSync("powershell.exe", [...args, contenderCommand], {
      cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr || blocked.stdout, /state transition is active/u);
    fs.writeFileSync(releasePath, "release", "utf8");
    const holderStatus = await holderDone;
    assert.equal(holderStatus, 0, holderStderr);
    const acquired = spawnSync("powershell.exe", [...args, contenderCommand], {
      cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    assert.equal(acquired.status, 0, acquired.stderr || acquired.stdout);
  } finally {
    if (holder.exitCode === null) holder.kill();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("PowerShell emergency scripts and runtime classification are valid on Windows", {
  skip: process.platform !== "win32"
}, () => {
  const quotedFiles = powerShellFiles
    .map((name) => `'${path.join(ROOT, "scripts", name).replaceAll("'", "''")}'`)
    .join(",");
  const command = [
    `$files=@(${quotedFiles})`,
    "$failed=$false",
    "foreach($file in $files){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$failed=$true;$errors|ForEach-Object{Write-Error $_.Message}}}",
    "if($failed){exit 1}"
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    cwd: ROOT,
    env: windowsPowerShellEnvironment(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const commonPath = path.join(ROOT, "scripts", "local-failover-common.ps1").replaceAll("'", "''");
  const classifierCommand = [
    `. '${commonPath}'`,
    "$cases=@(",
    "  @{ Expected=$true; Meal=$false; Process=[pscustomobject]@{ Name='node.exe'; CommandLine='\"C:\\Program Files\\nodejs\\node.exe\" scripts\\run-interaction-listener.js' } },",
    "  @{ Expected=$false; Meal=$false; Process=[pscustomobject]@{ Name='node.exe'; CommandLine='node.exe -e \"console.log(''''scripts/run-interaction-listener.js'''')\"' } },",
    "  @{ Expected=$false; Meal=$false; Process=[pscustomobject]@{ Name='node.exe'; CommandLine='node.exe ..\\scripts\\run-interaction-listener.js' } },",
    "  @{ Expected=$false; Meal=$false; Process=[pscustomobject]@{ Name='powershell.exe'; CommandLine='powershell.exe -NoProfile -Command \"ssh pororo-docker pgrep -f ''''node scripts/run-interaction-listener.js''''\"' } },",
    "  @{ Expected=$false; Meal=$false; Process=[pscustomobject]@{ Name='pwsh.exe'; CommandLine='pwsh.exe -CommandWithArgs ssh diagnostic -File C:\\ojeommwo-v2\\scripts\\run-local-interaction-listener.ps1' } },",
    "  @{ Expected=$true; Meal=$false; Process=[pscustomobject]@{ Name='pwsh.exe'; CommandLine='pwsh.exe -NoProfile -File \"C:\\ojeommwo-v2\\scripts\\run-local-interaction-listener.ps1\"' } },",
    "  @{ Expected=$false; Meal=$false; Process=[pscustomobject]@{ Name='powershell.exe'; CommandLine='powershell.exe -NoProfile -Command \"& ''''C:\\ojeommwo-v2\\scripts\\run-local-interaction-listener.ps1''''\"' } },",
    "  @{ Expected=$false; Meal=$false; Process=[pscustomobject]@{ Name='powershell.exe'; CommandLine='powershell.exe -NoProfile -File \"C:\\ojeommwo-v2\\scripts\\run-local-emergency-meal.ps1\" -Meal lunch' } },",
    "  @{ Expected=$true; Meal=$true; Process=[pscustomobject]@{ Name='powershell.exe'; CommandLine='powershell.exe -NoProfile -File \"C:\\ojeommwo-v2\\scripts\\run-local-emergency-meal.ps1\" -Meal lunch' } },",
    "  @{ Expected=$false; Meal=$true; Process=[pscustomobject]@{ Name='ssh.exe'; CommandLine='ssh.exe pororo-docker node scripts/run-interaction-listener.js' } }",
    ")",
    "$failed=$false",
    "foreach($case in $cases){$actual=Test-OjeommwoLocalRuntimeProcess -Process $case.Process -IncludeMealRunner:([bool]$case.Meal);if($actual -ne $case.Expected){$failed=$true;Write-Error (\"classification mismatch: {0}\" -f $case.Process.CommandLine)}}",
    "if($failed){exit 1}"
  ].join("\n");
  const classifierResult = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", classifierCommand], {
    cwd: ROOT,
    env: windowsPowerShellEnvironment(),
    encoding: "utf8"
  });
  assert.equal(classifierResult.status, 0, classifierResult.stderr || classifierResult.stdout);

  const syncPath = path.join(ROOT, "scripts", "sync-operating-data-from-server.ps1")
    .replaceAll("'", "''");
  const aclProtectorPath = path.join(ROOT, "scripts", "protect-local-data-acl.ps1")
    .replaceAll("'", "''");
  const transactionCommand = String.raw`
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ojeommwo-sync-transaction-test-" + [guid]::NewGuid().ToString("N"))
$lockTemp = Join-Path $fixtureRoot "locks"
$previousTemp = $env:TEMP

function Write-Utf8NoBom {
  param([string]$Path, [string]$Value)
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Assert-Text {
  param([string]$Path, [string]$Expected)
  $Actual = [System.IO.File]::ReadAllText($Path)
  if ($Actual -cne $Expected) {
    throw "unexpected file content at $Path"
  }
}

function Assert-NoTransactionArtifacts {
  param([string]$DataDirectory)
  $Artifacts = @(
    Get-ChildItem -LiteralPath $DataDirectory -Force |
      Where-Object { $_.Name -like ".ojeommwo-*" }
  )
  if ($Artifacts.Count -ne 0) {
    throw ("transaction artifacts remain: " + (($Artifacts | ForEach-Object { $_.Name }) -join ", "))
  }
}

New-Item -ItemType Directory -Path $lockTemp -Force | Out-Null
try {
  $env:TEMP = $lockTemp
  . '${syncPath}'

  $Definitions = @(
    @{ Name = "one.json"; Property = "items"; Required = $true },
    @{ Name = "two.json"; Property = "items"; Required = $true }
  )

  $SuccessRoot = Join-Path $fixtureRoot "success-root"
  $SuccessData = Join-Path $SuccessRoot "data"
  $SuccessStage = Join-Path $fixtureRoot "success-stage"
  $SuccessBackup = Join-Path $fixtureRoot "success-backup"
  New-Item -ItemType Directory -Path $SuccessData, $SuccessStage -Force | Out-Null
  Write-Utf8NoBom -Path (Join-Path $SuccessData "one.json") -Value "old-one"
  Write-Utf8NoBom -Path (Join-Path $SuccessData "two.json") -Value "old-two"
  Write-Utf8NoBom -Path (Join-Path $SuccessStage "one.json") -Value "new-one"
  Write-Utf8NoBom -Path (Join-Path $SuccessStage "two.json") -Value "new-two"
  $SuccessManifest = Join-Path $SuccessStage "local-standby-manifest.json"
  Write-Utf8NoBom -Path $SuccessManifest -Value "new-manifest"

  function global:Assert-LocalPromotionAllowed {
    param([string]$Root, [switch]$SkipLockCheck)
  }
  $SuccessPromotion = @{
    Root = $SuccessRoot
    StageDirectory = $SuccessStage
    BackupDirectory = $SuccessBackup
    StoreDefinitions = $Definitions
    ManifestStagePath = $SuccessManifest
    AclProtectorPath = '${aclProtectorPath}'
  }
  Invoke-TransactionalPromotion @SuccessPromotion

  Assert-Text -Path (Join-Path $SuccessData "one.json") -Expected "new-one"
  Assert-Text -Path (Join-Path $SuccessData "one.json.bak") -Expected "new-one"
  Assert-Text -Path (Join-Path $SuccessData "two.json") -Expected "new-two"
  Assert-Text -Path (Join-Path $SuccessData "two.json.bak") -Expected "new-two"
  Assert-Text -Path (Join-Path $SuccessData "local-standby-manifest.json") -Expected "new-manifest"
  Assert-Text -Path (Join-Path $SuccessBackup "one.json") -Expected "old-one"
  Assert-Text -Path (Join-Path $SuccessBackup "two.json") -Expected "old-two"
  Assert-NoTransactionArtifacts -DataDirectory $SuccessData

  $RollbackRoot = Join-Path $fixtureRoot "rollback-root"
  $RollbackData = Join-Path $RollbackRoot "data"
  $RollbackStage = Join-Path $fixtureRoot "rollback-stage"
  $RollbackBackup = Join-Path $fixtureRoot "rollback-backup"
  New-Item -ItemType Directory -Path $RollbackData, $RollbackStage -Force | Out-Null
  Write-Utf8NoBom -Path (Join-Path $RollbackData "one.json") -Value "rollback-old-one"
  Write-Utf8NoBom -Path (Join-Path $RollbackData "two.json") -Value "rollback-old-two"
  Write-Utf8NoBom -Path (Join-Path $RollbackStage "one.json") -Value "rollback-new-one"
  Write-Utf8NoBom -Path (Join-Path $RollbackStage "two.json") -Value "rollback-new-two"
  $RollbackManifest = Join-Path $RollbackStage "local-standby-manifest.json"
  Write-Utf8NoBom -Path $RollbackManifest -Value "rollback-new-manifest"

  $script:PromotionGuardCalls = 0
  function global:Assert-LocalPromotionAllowed {
    param([string]$Root, [switch]$SkipLockCheck)
    $script:PromotionGuardCalls += 1
    if ($script:PromotionGuardCalls -eq 4) {
      $Victim = Get-ChildItem -LiteralPath (Join-Path $Root "data") -Force |
        Where-Object { $_.Name -like ".ojeommwo-sync-*-two.json.tmp" } |
        Select-Object -First 1
      if ($null -eq $Victim) {
        throw "test could not locate the second staged promotion"
      }
      Remove-Item -LiteralPath $Victim.FullName -Force
    }
  }

  $RollbackObserved = $false
  try {
    $RollbackPromotion = @{
      Root = $RollbackRoot
      StageDirectory = $RollbackStage
      BackupDirectory = $RollbackBackup
      StoreDefinitions = $Definitions
      ManifestStagePath = $RollbackManifest
      AclProtectorPath = '${aclProtectorPath}'
    }
    Invoke-TransactionalPromotion @RollbackPromotion
  } catch {
    $RollbackObserved = $true
    if ($_.Exception.Message -notlike "Operating data promotion failed and was fully rolled back:*") {
      throw
    }
  }
  if (-not $RollbackObserved) {
    throw "forced mid-transaction failure did not fail"
  }

  Assert-Text -Path (Join-Path $RollbackData "one.json") -Expected "rollback-old-one"
  Assert-Text -Path (Join-Path $RollbackData "two.json") -Expected "rollback-old-two"
  if (Test-Path -LiteralPath (Join-Path $RollbackData "one.json.bak")) {
    throw "a newly-created recovery copy survived rollback"
  }
  if (Test-Path -LiteralPath (Join-Path $RollbackData "two.json.bak")) {
    throw "a newly-created recovery copy survived rollback"
  }
  Assert-Text -Path (Join-Path $RollbackBackup "one.json") -Expected "rollback-old-one"
  Assert-Text -Path (Join-Path $RollbackBackup "two.json") -Expected "rollback-old-two"
  if (Test-Path -LiteralPath (Join-Path $RollbackData "local-standby-manifest.json")) {
    throw "an unattempted manifest was left behind after rollback"
  }
  Assert-NoTransactionArtifacts -DataDirectory $RollbackData

  $AclFailureRoot = Join-Path $fixtureRoot "acl-failure-root"
  $AclFailureData = Join-Path $AclFailureRoot "data"
  $AclFailureStage = Join-Path $fixtureRoot "acl-failure-stage"
  $AclFailureBackup = Join-Path $fixtureRoot "acl-failure-backup"
  New-Item -ItemType Directory -Path $AclFailureData, $AclFailureStage -Force | Out-Null
  Write-Utf8NoBom -Path (Join-Path $AclFailureData "one.json") -Value "acl-old-one"
  Write-Utf8NoBom -Path (Join-Path $AclFailureData "one.json.bak") -Value "acl-backup-one"
  Write-Utf8NoBom -Path (Join-Path $AclFailureData "two.json") -Value "acl-old-two"
  Write-Utf8NoBom -Path (Join-Path $AclFailureData "two.json.bak") -Value "acl-backup-two"
  Write-Utf8NoBom -Path (Join-Path $AclFailureData "local-standby-manifest.json") -Value "acl-old-manifest"
  Write-Utf8NoBom -Path (Join-Path $AclFailureStage "one.json") -Value "acl-new-one"
  Write-Utf8NoBom -Path (Join-Path $AclFailureStage "two.json") -Value "acl-new-two"
  $AclFailureManifest = Join-Path $AclFailureStage "local-standby-manifest.json"
  Write-Utf8NoBom -Path $AclFailureManifest -Value "acl-new-manifest"
  $AclMarker = Join-Path $fixtureRoot "acl-first-call.marker"
  $AclWrapper = Join-Path $fixtureRoot "acl-wrapper.ps1"
  $AclWrapperText = @'
param([string]$ProjectRoot,[string]$DataDir,[switch]$VerifyOnly)
$marker = "__MARKER__"
if (-not (Test-Path -LiteralPath $marker)) {
  [System.IO.File]::WriteAllText($marker, "first")
  throw "forced ACL verification failure"
}
& "__PROTECTOR__" -ProjectRoot $ProjectRoot -DataDir $DataDir
'@
  $AclWrapperText = $AclWrapperText.Replace("__MARKER__", $AclMarker).Replace("__PROTECTOR__", '${aclProtectorPath}')
  Write-Utf8NoBom -Path $AclWrapper -Value $AclWrapperText
  function global:Assert-LocalPromotionAllowed {
    param([string]$Root, [switch]$SkipLockCheck)
  }
  $AclRollbackObserved = $false
  try {
    $AclFailurePromotion = @{
      Root = $AclFailureRoot
      StageDirectory = $AclFailureStage
      BackupDirectory = $AclFailureBackup
      StoreDefinitions = $Definitions
      ManifestStagePath = $AclFailureManifest
      AclProtectorPath = $AclWrapper
    }
    Invoke-TransactionalPromotion @AclFailurePromotion
  } catch {
    $AclRollbackObserved = $_.Exception.Message -like "Operating data promotion failed and was fully rolled back:*forced ACL verification failure*"
  }
  if (-not $AclRollbackObserved) { throw "forced ACL failure did not produce a complete rollback" }
  Assert-Text -Path (Join-Path $AclFailureData "one.json") -Expected "acl-old-one"
  Assert-Text -Path (Join-Path $AclFailureData "one.json.bak") -Expected "acl-backup-one"
  Assert-Text -Path (Join-Path $AclFailureData "two.json") -Expected "acl-old-two"
  Assert-Text -Path (Join-Path $AclFailureData "two.json.bak") -Expected "acl-backup-two"
  Assert-Text -Path (Join-Path $AclFailureData "local-standby-manifest.json") -Expected "acl-old-manifest"
  Assert-NoTransactionArtifacts -DataDirectory $AclFailureData

  if (@(Get-ChildItem -LiteralPath $lockTemp -Force).Count -ne 0) {
    throw "runner lock artifacts remain after transaction tests"
  }
} finally {
  $env:TEMP = $previousTemp
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
`;
  const encodedTransactionCommand = Buffer.from(transactionCommand, "utf16le").toString("base64");
  const transactionResult = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedTransactionCommand
  ], {
    cwd: ROOT,
    env: windowsPowerShellEnvironment(),
    encoding: "utf8"
  });
  assert.equal(transactionResult.status, 0,
    transactionResult.stderr || transactionResult.stdout);
});
