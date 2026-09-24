import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const protector = path.resolve("scripts/protect-local-data-acl.ps1");

function powershell(args) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

function powershellCore(args) {
  return spawnSync("pwsh.exe", [
    "-NoProfile", "-NonInteractive", ...args
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

test("Windows data ACL protector supports PowerShell 7 FileSystemAclExtensions", {
  skip: process.platform !== "win32"
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-acl-pwsh-test-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "state.json"), "{}\n");
  try {
    const protectedResult = powershellCore(["-File", protector,
      "-ProjectRoot", root, "-DataDir", dataDir
    ]);
    assert.equal(protectedResult.status, 0, protectedResult.stderr || protectedResult.stdout);
    const verifiedResult = powershellCore(["-File", protector,
      "-ProjectRoot", root, "-DataDir", dataDir, "-VerifyOnly"
    ]);
    assert.equal(verifiedResult.status, 0, verifiedResult.stderr || verifiedResult.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows data ACL protector enforces and verifies the exact private ACL", {
  skip: process.platform !== "win32"
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-acl-test-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "state.json"), "{}\n");
  fs.writeFileSync(path.join(dataDir, "nested", "artifact.txt"), "test\n");
  try {
    const result = powershell(["-File", protector,
      "-ProjectRoot", root, "-DataDir", dataDir
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /exact owner\/System\/Administrators FullControl only/u);

    const escaped = dataDir.replaceAll("'", "''");
    const probe = powershell(["-File", protector, "-ProjectRoot", root,
      "-DataDir", dataDir, "-VerifyOnly"]);
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);

    // Runtime temp/backup files inherit from the protected data root. They
    // remain safe when all three inherited rules are still exact.
    const freshPath = path.join(dataDir, "fresh-runtime-file.json").replaceAll("'", "''");
    const createFresh = powershell(["-Command",
      `[System.IO.File]::WriteAllText('${freshPath}','{}')`]);
    assert.equal(createFresh.status, 0, createFresh.stderr || createFresh.stdout);
    const inherited = powershell(["-File", protector, "-ProjectRoot", root,
      "-DataDir", dataDir, "-VerifyOnly"]);
    assert.equal(inherited.status, 0, inherited.stderr || inherited.stdout);

    const tamper = spawnSync("icacls.exe", [path.join(dataDir, "state.json"),
      "/grant", "*S-1-5-32-545:(R)"], {
      encoding: "utf8", windowsHide: true, timeout: 30_000
    });
    assert.equal(tamper.status, 0, tamper.stderr || tamper.stdout);
    const rejected = powershell(["-File", protector, "-ProjectRoot", root,
      "-DataDir", dataDir, "-VerifyOnly"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr || rejected.stdout, /exactly owner\/System\/Administrators|Unexpected or duplicate ACL principal/u);

    const repaired = powershell(["-File", protector,
      "-ProjectRoot", root, "-DataDir", dataDir
    ]);
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    const repairedProbe = powershell(["-File", protector, "-ProjectRoot", root,
      "-DataDir", dataDir, "-VerifyOnly"]);
    assert.equal(repairedProbe.status, 0, repairedProbe.stderr || repairedProbe.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows ACL protection is least-privilege and idempotent on the managed data tree", {
  skip: process.platform !== "win32"
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-acl-idempotence-test-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "candidate-preferences.json"), '{"version":1,"responses":[]}\n');
  fs.writeFileSync(path.join(dataDir, "candidate-preferences.json.bak"), '{"version":1,"responses":[]}\n');
  fs.writeFileSync(path.join(dataDir, "nested", "artifact.txt"), "test\n");
  try {
    const escapedRoot = root.replaceAll("'", "''");
    const escapedData = dataDir.replaceAll("'", "''");
    const escapedProtector = protector.replaceAll("'", "''");
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$projectRoot = '${escapedRoot}'
$dataDir = '${escapedData}'
$protector = '${escapedProtector}'
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor
  [System.Security.AccessControl.AccessControlSections]::Group -bor
  [System.Security.AccessControl.AccessControlSections]::Access

function Get-ManagedEntries {
  @(
    Get-Item -Force -LiteralPath $dataDir
    Get-ChildItem -Force -LiteralPath $dataDir -Recurse
  )
}

function Get-OwnerDaclSddl {
  param([System.IO.FileSystemInfo]$Entry)
  $security = if ($Entry.PSIsContainer) {
    ([System.IO.DirectoryInfo]$Entry).GetAccessControl($sections)
  } else {
    ([System.IO.FileInfo]$Entry).GetAccessControl($sections)
  }
  $security.GetSecurityDescriptorSddlForm($sections)
}

# Establish the exact private contract on an isolated representative tree.
# Tests must never mutate or snapshot the live operating data tree because a
# legitimate atomic store replacement may run concurrently with the suite.
& $protector -ProjectRoot $projectRoot -DataDir $dataDir | Out-Null
& $protector -ProjectRoot $projectRoot -DataDir $dataDir -VerifyOnly | Out-Null
$before = @{}
foreach ($entry in (Get-ManagedEntries)) {
  $relative = $entry.FullName.Substring($dataDir.Length)
  $before[$relative] = [pscustomobject]@{
    IsDirectory = [bool]$entry.PSIsContainer
    OwnerDacl = Get-OwnerDaclSddl -Entry $entry
    Sha256 = if ($entry.PSIsContainer) { '' } else {
      (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash
    }
  }
}

# This call failed on PowerShell 5.1 when Set-Acl needlessly requested
# SeSecurityPrivilege for the SACL. It must succeed as the ordinary operator.
& $protector -ProjectRoot $projectRoot -DataDir $dataDir | Out-Null
& $protector -ProjectRoot $projectRoot -DataDir $dataDir -VerifyOnly | Out-Null

$after = @(Get-ManagedEntries)
if ($after.Count -ne $before.Count) { throw 'managed data entry count changed' }
foreach ($entry in $after) {
  $relative = $entry.FullName.Substring($dataDir.Length)
  if (-not $before.ContainsKey($relative)) { throw "unexpected managed entry: $relative" }
  $expected = $before[$relative]
  if ([bool]$entry.PSIsContainer -ne $expected.IsDirectory) {
    throw "managed entry type changed: $relative"
  }
  $actualSddl = Get-OwnerDaclSddl -Entry $entry
  if ($actualSddl -cne $expected.OwnerDacl) {
    throw "owner/DACL changed during idempotent protection: $relative"
  }
  if (-not $entry.PSIsContainer) {
    $actualHash = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash
    if ($actualHash -cne $expected.Sha256) {
      throw "file content changed during ACL protection: $relative"
    }
  }
}
`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const result = powershell(["-EncodedCommand", encoded]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const source = fs.readFileSync(protector, "utf8");
  assert.match(source, /"System\.IO\.FileSystemAclExtensions" -as \[type\]/u);
  assert.match(source, /FileSystemAclExtensions\]::SetAccessControl/u);
  assert.match(source, /\)\.SetAccessControl\(\$acl\)/u);
  assert.doesNotMatch(source, /^\s*Set-Acl\b/mu);
  assert.doesNotMatch(source, /AccessControlSections\]::(?:Audit|All)/u);
});

test("Windows data ACL protector refuses paths outside ProjectRoot data without changing them", {
  skip: process.platform !== "win32"
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-acl-boundary-test-"));
  const dataDir = path.join(root, "data");
  const outside = path.join(root, "outside");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "do-not-touch.txt"), "test\n");
  try {
    const escaped = outside.replaceAll("'", "''");
    const before = powershell(["-Command",
      `(Get-Acl -LiteralPath '${escaped}').GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)`]);
    assert.equal(before.status, 0, before.stderr || before.stdout);
    const result = powershell(["-File", protector,
      "-ProjectRoot", root, "-DataDir", outside
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /exactly ProjectRoot\\data/u);
    const after = powershell(["-Command",
      `(Get-Acl -LiteralPath '${escaped}').GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)`]);
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.equal(after.stdout.trim(), before.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows health delegates data ACL checks to the non-mutating exact verifier", () => {
  const health = fs.readFileSync(path.resolve("src/health.js"), "utf8");
  assert.match(health, /protect-local-data-acl\.ps1/u);
  assert.match(health, /-VerifyOnly/u);
  assert.match(health, /"-ExecutionPolicy",\s*"Bypass"/u);
  assert.doesNotMatch(health, /\$modifyMask/u);
});
