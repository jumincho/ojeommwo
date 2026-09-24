import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
const entrypoint = path.join(root, "dist", "server", "index.js");
const hostingPath = path.join(root, "dist", ".openai", "hosting.json");
const startedAt = Date.now();

if (!fs.existsSync(cli)) {
  throw new Error("vinext is not installed; run the frozen pnpm install first");
}

const result = spawnSync(process.execPath, [cli, "build"], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_WRITE_LOGS: "false",
  },
  maxBuffer: 16 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;

function validateFreshBuild() {
  for (const required of [entrypoint, hostingPath]) {
    const stat = fs.statSync(required);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Sites build output is missing or empty: ${required}`);
    }
  }
  if (fs.statSync(entrypoint).mtimeMs < startedAt - 5_000) {
    throw new Error(`Sites worker entrypoint is stale: ${entrypoint}`);
  }
  const hosting = JSON.parse(fs.readFileSync(hostingPath, "utf8"));
  if (hosting.project_id !== "appgprj_6a5dac95abb88191ae8971c41ad2372c"
      || hosting.d1 !== null || hosting.r2 !== "SNAPSHOTS") {
    throw new Error("Sites build hosting manifest drifted");
  }

  const entrypointSource = fs.readFileSync(entrypoint, "utf8");
  const buildRootVariants = new Set([
    root,
    root.replaceAll("\\", "/"),
    root.replaceAll("/", "\\"),
  ]);
  for (const buildRoot of buildRootVariants) {
    if (entrypointSource.includes(buildRoot)) {
      throw new Error("Sites worker contains an absolute local build path");
    }
  }
  if (/(?:url\(|["'])\s*[A-Za-z]:[\\/]/u.test(entrypointSource)) {
    throw new Error("Sites worker contains a Windows absolute asset path");
  }
}

if (result.status === 0) {
  validateFreshBuild();
  process.exit(0);
}

const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const windowsUvShutdown = process.platform === "win32"
  && (result.status === 3221226505 || result.status === -1073740791)
  && combined.includes("Build complete.")
  && combined.includes("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)");

if (windowsUvShutdown) {
  validateFreshBuild();
  process.stderr.write(
    "[sites-build] vinext completed and produced fresh validated output; ignored its known Windows-only libuv shutdown assertion.\n",
  );
  process.exit(0);
}

process.exit(result.status ?? 1);
