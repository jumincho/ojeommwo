import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS_DIRS = ["src", "scripts", "test", "observatory/scripts", "observatory/tests"];
const JSON_FILES = [
  "package.json",
  "observatory/package.json",
  "data/holiday-skip-dates.json",
  "data/recommendations.json",
  "data/recommendations.sample.json",
  "config/meal-normalization-aliases.json",
  "prompts/codex-cli-recommendation.schema.json",
  "prompts/meal-event-normalization.schema.json",
  "prompts/verified-candidates.schema.json"
];

function walk(dir, extensions, files = []) {
  if (!fs.existsSync(dir)) return files;
  const allowed = Array.isArray(extensions) ? extensions : [extensions];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, allowed, files);
    } else if (entry.isFile() && allowed.some((extension) => entry.name.endsWith(extension))) {
      files.push(fullPath);
    }
  }
  return files;
}

let failed = false;

for (const dir of JS_DIRS) {
  for (const filePath of walk(path.join(ROOT_DIR, dir), [".js", ".mjs"])) {
    const result = spawnSync(process.execPath, ["--check", filePath], { stdio: "inherit" });
    if (result.status !== 0) failed = true;
  }
}

for (const fileName of JSON_FILES) {
  const filePath = path.join(ROOT_DIR, fileName);
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    failed = true;
    console.error(`[check] invalid JSON ${fileName}: ${error.message}`);
  }
}

if (process.platform === "win32") {
  for (const filePath of walk(path.join(ROOT_DIR, "scripts"), ".ps1")) {
    const escapedPath = filePath.replace(/'/g, "''");
    const command = [
      "$errors=$null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$null, [ref]$errors) | Out-Null`,
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" });
    if (result.status !== 0) failed = true;
  }
} else {
  const observatoryRunner = path.join(ROOT_DIR, "observatory", "run-pororo.sh");
  const shellFiles = [
    ...walk(path.join(ROOT_DIR, "scripts"), ".sh"),
    ...walk(path.join(ROOT_DIR, "observatory", "scripts"), ".sh")
  ];
  if (fs.existsSync(observatoryRunner)) shellFiles.push(observatoryRunner);
  for (const filePath of shellFiles) {
    const result = spawnSync("bash", ["-n", filePath], { stdio: "inherit" });
    if (result.status !== 0) failed = true;
  }
}

if (failed) process.exit(1);
console.log("[check] JavaScript, platform scripts, and tracked JSON files passed.");
