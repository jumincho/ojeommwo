import path from "node:path";
import process from "node:process";

function removeModulePath(environment) {
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  return environment;
}

export function clearInheritedPowerShellModulePath(environment = process.env) {
  return removeModulePath(environment);
}

export function isolatedWindowsPowerShellEnvironment(overrides = {}) {
  const environment = removeModulePath({ ...process.env, ...overrides });
  const systemRoot = String(environment.SystemRoot || environment.SYSTEMROOT || "").trim();
  if (!systemRoot) {
    throw new Error("SystemRoot is unavailable; cannot isolate Windows PowerShell modules");
  }
  environment.PSModulePath = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules"
  );
  return environment;
}
