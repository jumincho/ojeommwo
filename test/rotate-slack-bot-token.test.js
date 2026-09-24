import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "rotate-slack-bot-token.js");

function run(tokenFile, envFile) {
  return spawnSync(process.execPath, [SCRIPT, tokenFile, envFile], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-token-rotation-"));
  const envFile = path.join(directory, ".env");
  const tokenFile = path.join(directory, "new-token.txt");
  fs.writeFileSync(envFile, "NODE_ENV=production\nSLACK_BOT_TOKEN=xoxb-old-token\n", { mode: 0o600 });
  fs.writeFileSync(tokenFile, "xoxb-new-token-123\n", { mode: 0o600 });
  return { directory, envFile, tokenFile };
}

test("token rotation deletes only a validated input after a successful replacement", () => {
  const value = fixture();
  try {
    const result = run(value.tokenFile, value.envFile);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(fs.readFileSync(value.envFile, "utf8"), /SLACK_BOT_TOKEN=xoxb-new-token-123/u);
    assert.equal(fs.existsSync(value.tokenFile), false);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("failed token validation preserves the input file", () => {
  const value = fixture();
  try {
    fs.writeFileSync(value.tokenFile, "not-a-token\n", { mode: 0o600 });
    const result = run(value.tokenFile, value.envFile);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(value.tokenFile, "utf8"), "not-a-token\n");
    assert.match(fs.readFileSync(value.envFile, "utf8"), /SLACK_BOT_TOKEN=xoxb-old-token/u);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("token rotation rejects the environment file itself without deleting it", () => {
  const value = fixture();
  try {
    const before = fs.readFileSync(value.envFile, "utf8");
    const aliasedPath = path.join(value.directory, ".", ".env");
    const result = run(aliasedPath, value.envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not be the environment file/u);
    assert.equal(fs.readFileSync(value.envFile, "utf8"), before);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("token rotation rejects a hard-link alias of the environment file", () => {
  const value = fixture();
  try {
    fs.rmSync(value.tokenFile);
    fs.linkSync(value.envFile, value.tokenFile);
    const before = fs.readFileSync(value.envFile, "utf8");
    const result = run(value.tokenFile, value.envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not alias the environment file/u);
    assert.equal(fs.readFileSync(value.envFile, "utf8"), before);
    assert.equal(fs.existsSync(value.tokenFile), true);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("token rotation rejects non-regular input without removing it", () => {
  const value = fixture();
  try {
    fs.rmSync(value.tokenFile);
    fs.mkdirSync(value.tokenFile);
    const result = run(value.tokenFile, value.envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular, non-symbolic-link file/u);
    assert.equal(fs.statSync(value.tokenFile).isDirectory(), true);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("token rotation rejects symbolic-link input without touching its target", { skip: process.platform === "win32" }, () => {
  const value = fixture();
  const target = path.join(value.directory, "token-target.txt");
  try {
    fs.renameSync(value.tokenFile, target);
    fs.symlinkSync(target, value.tokenFile);
    const result = run(value.tokenFile, value.envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular, non-symbolic-link file/u);
    assert.equal(fs.readFileSync(target, "utf8"), "xoxb-new-token-123\n");
    assert.equal(fs.lstatSync(value.tokenFile).isSymbolicLink(), true);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
