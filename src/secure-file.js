import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedWindowsPowerShellEnvironment } from "./windows-powershell-environment.js";

function windowsPowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || "").trim();
  if (!systemRoot) throw new Error("SystemRoot is unavailable; cannot preserve the sensitive-file ACL");
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(executable)) throw new Error("Windows PowerShell is unavailable; cannot preserve the sensitive-file ACL");
  return executable;
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runAclScript(script, environment) {
  const result = spawnSync(windowsPowerShellPath(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedPowerShell(script)
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: isolatedWindowsPowerShellEnvironment(environment)
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown ACL error").trim();
    throw new Error(`Could not preserve the sensitive-file ACL: ${detail}`);
  }
  return String(result.stdout || "").trim();
}

function copyAndVerifyWindowsAcl(sourcePath, destinationPath) {
  return runAclScript(String.raw`
$ErrorActionPreference = 'Stop'
$source = [Environment]::GetEnvironmentVariable('OJEOMMWO_ACL_SOURCE', 'Process')
$destination = [Environment]::GetEnvironmentVariable('OJEOMMWO_ACL_DESTINATION', 'Process')
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor
  [System.Security.AccessControl.AccessControlSections]::Group -bor
  [System.Security.AccessControl.AccessControlSections]::Access
$sourceAcl = Get-Acl -LiteralPath $source
$expected = $sourceAcl.GetSecurityDescriptorSddlForm($sections)
Set-Acl -LiteralPath $destination -AclObject $sourceAcl
$actual = (Get-Acl -LiteralPath $destination).GetSecurityDescriptorSddlForm($sections)
if ($actual -cne $expected) { throw 'ACL verification failed before replacement' }
[Console]::Out.Write($expected)
`, {
    OJEOMMWO_ACL_SOURCE: sourcePath,
    OJEOMMWO_ACL_DESTINATION: destinationPath
  });
}

function verifyWindowsAcl(filePath, expectedSddl) {
  runAclScript(String.raw`
$ErrorActionPreference = 'Stop'
$file = [Environment]::GetEnvironmentVariable('OJEOMMWO_ACL_FILE', 'Process')
$expected = [Environment]::GetEnvironmentVariable('OJEOMMWO_EXPECTED_SDDL', 'Process')
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor
  [System.Security.AccessControl.AccessControlSections]::Group -bor
  [System.Security.AccessControl.AccessControlSections]::Access
$actual = (Get-Acl -LiteralPath $file).GetSecurityDescriptorSddlForm($sections)
if ($actual -cne $expected) { throw 'ACL verification failed after replacement' }
`, {
    OJEOMMWO_ACL_FILE: filePath,
    OJEOMMWO_EXPECTED_SDDL: expectedSddl
  });
}

export function replaceSensitiveTextFile(targetPath, text) {
  const resolvedTarget = path.resolve(targetPath);
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new Error(`Sensitive target file is missing: ${resolvedTarget}`);
  }
  const tempPath = `${resolvedTarget}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  let expectedWindowsAcl = "";
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.closeSync(descriptor);
    descriptor = undefined;

    // A Windows mode bit does not protect secrets. Copy the already-hardened
    // DACL while the temporary file is still empty, then verify it both before
    // and after the atomic rename.
    if (process.platform === "win32") {
      expectedWindowsAcl = copyAndVerifyWindowsAcl(resolvedTarget, tempPath);
    }

    descriptor = fs.openSync(tempPath, "r+");
    fs.writeFileSync(descriptor, String(text), "utf8");
    fs.ftruncateSync(descriptor, Buffer.byteLength(String(text), "utf8"));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (process.platform !== "win32") fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, resolvedTarget);
    if (process.platform === "win32") verifyWindowsAcl(resolvedTarget, expectedWindowsAcl);
    else fs.chmodSync(resolvedTarget, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
  }
}
