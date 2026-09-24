import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import {
  clearInheritedPowerShellModulePath,
  isolatedWindowsPowerShellEnvironment
} from "../src/windows-powershell-environment.js";

test("test bootstrap removes a foreign PowerShell module path case-insensitively", () => {
  const environment = { Path: "safe", pSmOdUlEpAtH: "foreign" };
  assert.equal(clearInheritedPowerShellModulePath(environment), environment);
  assert.deepEqual(environment, { Path: "safe" });
});

test("Windows PowerShell children use only the operating-system module directory", () => {
  if (process.platform !== "win32") return;
  const environment = isolatedWindowsPowerShellEnvironment({
    PSModulePath: "foreign-core-modules",
    OJEOMMWO_TEST_VALUE: "kept"
  });
  assert.equal(environment.OJEOMMWO_TEST_VALUE, "kept");
  assert.equal(
    environment.PSModulePath,
    path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules")
  );
  assert.doesNotMatch(environment.PSModulePath, /codex-runtimes|PowerShell\\Modules$/iu);
});
