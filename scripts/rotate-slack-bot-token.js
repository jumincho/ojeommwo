import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeEnvText } from "../src/env-file.js";
import { replaceSensitiveTextFile } from "../src/secure-file.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = path.resolve(process.argv[2] ?? "");
const envPath = path.resolve(process.argv[3] ?? path.join(ROOT_DIR, ".env"));

if (!process.argv[2]) {
  throw new Error("Usage: node scripts/rotate-slack-bot-token.js <token-file> [env-file]");
}

function normalizedPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function regularFileStat(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular, non-symbolic-link file: ${filePath}`);
  }
  return stat;
}

function hasStableIdentity(stat) {
  return typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint"
    && (stat.dev !== 0n || stat.ino !== 0n);
}

function sameIdentity(left, right) {
  return hasStableIdentity(left) && hasStableIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

function readTokenFile(filePath, expectedStat) {
  let descriptor;
  try {
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(descriptor, { bigint: true });
    if (!openedStat.isFile() || (hasStableIdentity(expectedStat) && !sameIdentity(expectedStat, openedStat))) {
      throw new Error("Token file changed while it was being validated");
    }
    return fs.readFileSync(descriptor, "utf8").trim();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function removeValidatedTokenFile(filePath, expectedStat) {
  const currentStat = regularFileStat(filePath, "Token file");
  if (!sameIdentity(expectedStat, currentStat)) {
    throw new Error("Slack bot token was rotated, but the token file changed and was not deleted");
  }
  fs.rmSync(filePath);
}

if (normalizedPath(tokenFile) === normalizedPath(envPath)) {
  throw new Error("Token input must not be the environment file");
}

const envStat = regularFileStat(envPath, "Environment file");
const tokenStat = regularFileStat(tokenFile, "Token file");
if (sameIdentity(tokenStat, envStat)) {
  throw new Error("Token input must not alias the environment file");
}

const token = readTokenFile(tokenFile, tokenStat);
if (!/^xoxb-[A-Za-z0-9-]+$/.test(token)) {
  throw new Error("Token file does not contain one valid Slack bot token");
}

const currentEnvStat = regularFileStat(envPath, "Environment file");
if (hasStableIdentity(envStat) && !sameIdentity(envStat, currentEnvStat)) {
  throw new Error("Environment file changed while the token input was being validated");
}
const current = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
const updates = new Map([["SLACK_BOT_TOKEN", token]]);
replaceSensitiveTextFile(envPath, mergeEnvText(current, updates));
removeValidatedTokenFile(tokenFile, tokenStat);
console.log("[env] Slack bot token rotated and the validated input file was deleted");
