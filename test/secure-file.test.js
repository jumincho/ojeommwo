import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { replaceSensitiveTextFile } from "../src/secure-file.js";

function windowsSddl(filePath) {
  const executable = path.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sections=[System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group -bor [System.Security.AccessControl.AccessControlSections]::Access",
    "$acl=Get-Acl -LiteralPath ([Environment]::GetEnvironmentVariable('OJEOMMWO_TEST_FILE','Process'))",
    "[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))"
  ].join(";");
  const result = spawnSync(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, OJEOMMWO_TEST_FILE: filePath }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("sensitive atomic replacement preserves protection and exact content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-secure-file-"));
  const target = path.join(directory, ".env");
  try {
    fs.writeFileSync(target, "SECRET=old\n", { mode: 0o600 });
    const previousAcl = process.platform === "win32" ? windowsSddl(target) : "";

    replaceSensitiveTextFile(target, "SECRET=new-value\nSECOND=ok\n");

    assert.equal(fs.readFileSync(target, "utf8"), "SECRET=new-value\nSECOND=ok\n");
    assert.deepEqual(
      fs.readdirSync(directory).sort(),
      [".env"],
      "temporary secret files must not remain"
    );
    if (process.platform === "win32") assert.equal(windowsSddl(target), previousAcl);
    else assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sensitive replacement refuses to invent an unprotected target", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-secure-file-missing-"));
  try {
    const target = path.join(directory, ".env");
    assert.throws(() => replaceSensitiveTextFile(target, "SECRET=value\n"), /missing/u);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
