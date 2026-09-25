import fs from "node:fs";
import path from "node:path";

// A JWT expiry is not proof that its refresh session is still accepted.
// Read only bounded, atomically written metadata from the daily live probe.
export function liveCodexAuthHealth({ directory, now = new Date(), maxAgeMs = 36 * 60 * 60_000,
  model = "gpt-6-luna", reasoningEffort = "xhigh" } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("Invalid live authentication health window");
  }
  const names = fs.existsSync(directory) ? fs.readdirSync(directory)
    .filter((name) => /^auth-check-\d{4}-\d{2}-\d{2}T[\dZ-]+(?:-[\w-]+)?-telemetry\.log$/u.test(name)).sort().reverse() : [];
  if (!names.length) throw new Error("No live authentication probe is recorded; run scripts/check-codex-auth.js");
  const file = path.join(directory, names[0]);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Unsafe authentication probe metadata");
  let probe;
  try { probe = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("Malformed authentication probe metadata"); }
  const recordedAt = Date.parse(probe?.recordedAt);
  if (probe?.version !== 1 || probe?.job !== "auth-check" || !Number.isFinite(recordedAt)
      || probe.model !== model || probe.reasoningEffort !== reasoningEffort || probe.useSearch !== false) {
    throw new Error("Authentication probe does not match the configured model contract");
  }
  const ageMs = now.getTime() - recordedAt;
  if (ageMs < -5 * 60_000 || ageMs > maxAgeMs) throw new Error("The live authentication probe is stale or future-dated");
  if (probe.success !== true) throw new Error("The latest live authentication probe failed; restore authentication and rerun the probe");
  return { status: "pass", detail: `${model} / ${reasoningEffort} live authentication succeeded at ${probe.recordedAt}` };
}
