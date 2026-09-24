import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  CODEX_RETRY_AFTER_MAX_MS,
  CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES,
  assertBoundedCodexOutputFile,
  buildCodexInvocationTelemetry,
  buildCodexArgs,
  buildSanitizedCodexEnv,
  calculateCodexRetryDelayMs,
  codexAuthCheckFailureKind,
  codexAuthSourceSnapshot,
  codexAuthReadiness,
  withCodexAuthPersistence,
  codexExecutionIsolationStatus,
  codexResearchCapabilityStatus,
  codexIsolationTempPrefix,
  createBoundedByteCapture,
  createCodexDiagnosticMetadataCapture,
  createCodexRetryCoordinator,
  isRetryableCodexExecutionError,
  monitorCodexChild,
  parseCodexRetryAfterMs,
  parseCodexCliOutput,
  promoteIsolatedCodexAuth,
  validateCodexRecommendations,
  writeCodexInvocationTelemetry
} from "../src/codex-cli.js";

const recommendations = [
  { category: "한식", restaurant: "한식집", menu: "제육덮밥", priceText: "9,000원", comment: "매콤한 제육 양념이 부드러운 고기에 고르게 배어, 따뜻한 밥과 함께 먹을수록 감칠맛이 살아납니다.", evidence: ["https://example.com/e1"] },
  { category: "중식", restaurant: "중식집", menu: "짬뽕", priceText: "10,000원", comment: "칼칼한 국물에 해물 향과 아삭한 채소 식감이 어우러져, 마지막 국물까지 시원하게 당기는 짬뽕입니다.", evidence: ["https://example.com/e2"] },
  { category: "돈까스", restaurant: "일식집", menu: "돈카츠", priceText: "가격 확인 필요", comment: "바삭한 튀김옷 안에 두툼한 고기 육즙이 살아 있어, 고소한 소스와 곁들이면 식감이 더욱 또렷합니다.", evidence: ["https://example.com/e3"] }
];

function chatgptAuthFixture({
  marker = "source",
  accountId = "account-fixture",
  refreshedAt = "2026-07-21T00:00:00.000Z"
} = {}) {
  const credential = (name) => `${name}-${marker}-${"x".repeat(32)}`;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: credential("id"),
      access_token: credential("access"),
      refresh_token: credential("refresh"),
      account_id: accountId
    },
    last_refresh: refreshedAt
  };
}

function writePrivateAuth(filePath, auth) {
  fs.writeFileSync(filePath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function isolatedAuthExecution(sourcePath, candidatePath, sourceSnapshot = codexAuthSourceSnapshot(sourcePath)) {
  const candidateStat = fs.statSync(candidatePath);
  return {
    authSourcePath: sourcePath,
    isolatedAuthPath: candidatePath,
    authSourceSnapshot: sourceSnapshot,
    authCandidateUid: candidateStat.uid,
    authCandidateGid: candidateStat.gid
  };
}

test("parseCodexCliOutput accepts fenced and embedded JSON", () => {
  assert.deepEqual(parseCodexCliOutput('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(parseCodexCliOutput('result: {"ok":true} done'), { ok: true });
  assert.throws(() => parseCodexCliOutput("no json"), /not valid JSON/u);
});

test("Codex diagnostic metadata captures only bounded exact usage and Retry-After fields", () => {
  const nowMs = Date.parse("2026-08-30T00:00:00.000Z");
  const capture = createCodexDiagnosticMetadataCapture({ now: () => nowMs });
  capture.push(Buffer.from("untrusted tokens used soon\ntokens ", "utf8"));
  capture.push(Buffer.from("used\n26,844\nRetry-After: 7\n", "utf8"));
  assert.deepEqual(capture.finish(), {
    tokenUsage: { totalTokens: 26844, source: "codex-cli-footer" },
    retryAfterMs: 7000
  });
  assert.deepEqual(capture.finish(), {
    tokenUsage: { totalTokens: 26844, source: "codex-cli-footer" },
    retryAfterMs: 7000
  });

  const malformed = createCodexDiagnosticMetadataCapture();
  malformed.push(`tokens used\n26,844 tokens\n${"x".repeat(600)}\nRetry-After: never\n`);
  assert.deepEqual(malformed.finish(), { tokenUsage: null, retryAfterMs: null });
});

test("Codex Retry-After parsing and exponential jitter are strictly bounded", () => {
  const nowMs = Date.parse("2026-08-30T00:00:00.000Z");
  assert.equal(parseCodexRetryAfterMs("7", { nowMs }), 7000);
  assert.equal(
    parseCodexRetryAfterMs("Sun, 30 Aug 2026 00:00:09 GMT", { nowMs }),
    9000
  );
  assert.equal(parseCodexRetryAfterMs("999999999", { nowMs }), CODEX_RETRY_AFTER_MAX_MS);
  assert.equal(parseCodexRetryAfterMs("not-a-header", { nowMs }), null);
  assert.equal(calculateCodexRetryDelayMs({ attempt: 1, random: () => 0 }), 500);
  assert.equal(calculateCodexRetryDelayMs({ attempt: 2, random: () => 0 }), 1000);
  assert.equal(calculateCodexRetryDelayMs({ attempt: 20, random: () => 1 }), 30000);
  assert.equal(calculateCodexRetryDelayMs({
    attempt: 1,
    retryAfterMs: CODEX_RETRY_AFTER_MAX_MS,
    random: () => 0
  }), CODEX_RETRY_AFTER_MAX_MS);
  assert.throws(
    () => calculateCodexRetryDelayMs({ attempt: 1, random: () => 2 }),
    /jitter source/u
  );
});

test("Codex retry coordinator waits only when the caller starts the next attempt", async () => {
  let nowMs = 1000;
  const waits = [];
  const coordinator = createCodexRetryCoordinator({
    now: () => nowMs,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      nowMs += milliseconds;
    }
  });
  assert.deepEqual(await coordinator.before("candidate-refresh"), { attempt: 1, waitMs: 0 });
  coordinator.failed("candidate-refresh", 1, 7000);
  assert.deepEqual(waits, []);
  nowMs += 2000;
  assert.deepEqual(await coordinator.before("candidate-refresh"), {
    attempt: 2,
    waitMs: 5000
  });
  assert.deepEqual(waits, [5000]);
  coordinator.clear("candidate-refresh");
  assert.deepEqual(await coordinator.before("candidate-refresh"), { attempt: 1, waitMs: 0 });
  assert.throws(
    () => coordinator.failed("candidate-refresh", 1, CODEX_RETRY_AFTER_MAX_MS + 1),
    /failure is invalid/u
  );
});

test("Codex retry classification preserves explicit fail-fast errors", () => {
  assert.equal(isRetryableCodexExecutionError(Object.assign(new Error("network timeout"), {
    retryable: false
  })), false);
  assert.equal(isRetryableCodexExecutionError(new Error("Codex CLI exited with code 1")), true);
  assert.equal(isRetryableCodexExecutionError(Object.assign(new Error("fixture"), {
    code: "ECONNRESET"
  })), true);
  assert.equal(isRetryableCodexExecutionError(new Error("invalid output schema")), false);
});

test("scheduled Codex auth alerts trust only internal error codes", () => {
  for (const [code, expected] of [
    ["CODEX_AUTH_REQUIRED", "authentication-required"],
    ["CODEX_AUTH_PERSISTENCE_FAILED", "authentication-persistence-failed"],
    ["CODEX_MODEL_CONFIGURATION_REQUIRED", "model-configuration-required"],
  ]) {
    assert.equal(codexAuthCheckFailureKind(Object.assign(new Error("fixture"), { code })), expected);
  }
  assert.equal(
    codexAuthCheckFailureKind(new Error("CODEX_AUTH_REQUIRED token_revoked 401 Unauthorized")),
    "provider-or-runtime-failure"
  );
  assert.equal(codexAuthCheckFailureKind(null), "provider-or-runtime-failure");
});

test("Codex invocation telemetry is atomic, private, and excludes prompts and secrets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-telemetry-"));
  const filePath = path.join(directory, "candidate-refresh-telemetry.json");
  const secret = "DO_NOT_RECORD_THIS_SECRET_OR_PROMPT";
  try {
    const telemetry = buildCodexInvocationTelemetry({
      job: "candidate-refresh",
      attempt: 2,
      startedAt: "2026-08-30T00:00:00.000Z",
      recordedAt: "2026-08-30T00:00:03.000Z",
      durationMs: 2500,
      success: false,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      useSearch: true,
      tokenUsage: { totalTokens: 26844, source: "codex-cli-footer" },
      retryable: true,
      retryDelayMs: 7000,
      providerRetryAfterMs: 7000,
      prompt: secret,
      error: new Error(secret)
    });
    writeCodexInvocationTelemetry(filePath, telemetry);
    const raw = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(raw, new RegExp(secret, "u"));
    assert.deepEqual(JSON.parse(raw), {
      version: 1,
      recordedAt: "2026-08-30T00:00:03.000Z",
      startedAt: "2026-08-30T00:00:00.000Z",
      job: "candidate-refresh",
      attempt: 2,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      useSearch: true,
      durationMs: 2500,
      success: false,
      tokenUsage: { totalTokens: 26844, source: "codex-cli-footer" },
      retry: { eligible: true, delayMs: 7000, providerRetryAfterMs: 7000 }
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o077, 0);
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("isolated Codex environment excludes application secrets", () => {
  const env = buildSanitizedCodexEnv({
    PATH: "/usr/bin",
    LANG: "ko_KR.UTF-8",
    SLACK_BOT_TOKEN: "xoxb-secret",
    NAVER_SEARCH_CLIENT_SECRET: "secret",
    PUBLIC_DATA_SERVICE_KEY: "secret",
    CODEX_HOME: "/root/.codex"
  }, { home: "/tmp/isolated" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/isolated");
  assert.equal(env.CODEX_HOME, path.join("/tmp/isolated", ".codex"));
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.NAVER_SEARCH_CLIENT_SECRET, undefined);
  assert.equal(env.PUBLIC_DATA_SERVICE_KEY, undefined);
  assert.equal(buildSanitizedCodexEnv({ CODEX_HOME: "/root/.codex" }).CODEX_HOME, undefined);
});

test("official Codex execution rejects every non-read-only sandbox", () => {
  for (const sandbox of ["workspace-write", "danger-full-access"]) {
    assert.equal(codexExecutionIsolationStatus({
      platform: "linux", uid: 0, sandbox, isolateLinux: true
    }).safe, false);
  }
  const isolated = codexExecutionIsolationStatus({
    platform: "linux", uid: 0, sandbox: "read-only", isolateLinux: true,
    isolationUid: 65534, isolationGid: 65534, identitySwitchSupported: true
  });
  assert.equal(isolated.safe, true);
  assert.equal(isolated.isolated, true);
  for (const drift of [
    { isolateLinux: false, identitySwitchSupported: true },
    { isolateLinux: true, identitySwitchSupported: false },
    { isolateLinux: true, identitySwitchSupported: true, isolationUid: 0 }
  ]) {
    const status = codexExecutionIsolationStatus({
      platform: "linux",
      uid: 0,
      sandbox: "read-only",
      isolationUid: 65534,
      isolationGid: 65534,
      ...drift
    });
    assert.equal(status.safe, false);
    assert.equal(status.isolated, false);
  }
});

test("Windows Codex execution is disabled because same-user read isolation cannot protect bot secrets", () => {
  const status = codexExecutionIsolationStatus({ platform: "win32", sandbox: "read-only" });
  assert.equal(status.safe, true);
  assert.equal(status.executionAllowed, false);
  assert.match(status.detail, /synchronized deterministic cache/u);
});

test("server Codex capability requires private auth, an executable regular file, and a version probe", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-capability-"));
  const executable = path.join(directory, "codex");
  const auth = path.join(directory, "auth.json");
  const callerHome = path.join(directory, "caller-home");
  const probePrefix = path.join(directory, "probe-");
  const probeRoots = () => fs.readdirSync(directory).filter((entry) => entry.startsWith("probe-"));
  try {
    fs.writeFileSync(executable, "fixture", { mode: 0o700 });
    const capabilityAuth = chatgptAuthFixture();
    capabilityAuth.tokens.access_token = `header.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.signature`;
    writePrivateAuth(auth, capabilityAuth);
    fs.mkdirSync(callerHome, { mode: 0o700 });
    let capturedProbeOptions;
    const options = {
      platform: "linux",
      uid: process.getuid?.(),
      codexPath: executable,
      authPath: auth,
      executablePermissionCheck: () => true,
      authPermissionCheck: () => true,
      authDirectoryCheck: () => ({ ok: true }),
      probeIsolationOptions: {
        tempPrefix: probePrefix,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: callerHome,
          CODEX_HOME: path.join(callerHome, ".codex"),
          SLACK_BOT_TOKEN: "must-not-leak"
        }
      },
      probeVersion: (_executable, spawnOptions) => {
        capturedProbeOptions = spawnOptions;
        const arg0 = path.join(spawnOptions.env.CODEX_HOME, "tmp", "arg0");
        fs.mkdirSync(arg0, { recursive: true });
        fs.writeFileSync(path.join(arg0, "marker"), "fixture");
        return { status: 0, stdout: "codex-cli 1.2.3\n", stderr: "" };
      }
    };
    assert.equal(codexResearchCapabilityStatus(options).ok, true);
    assert.notEqual(capturedProbeOptions.env.HOME, callerHome);
    assert.equal(capturedProbeOptions.env.CODEX_HOME, path.join(capturedProbeOptions.env.HOME, ".codex"));
    assert.equal(capturedProbeOptions.cwd, path.join(path.dirname(capturedProbeOptions.env.HOME), "work"));
    assert.equal(capturedProbeOptions.env.SLACK_BOT_TOKEN, undefined);
    if (process.platform === "linux" && process.getuid?.() === 0) {
      assert.equal(capturedProbeOptions.uid, 65534);
      assert.equal(capturedProbeOptions.gid, 65534);
    }
    assert.equal(fs.existsSync(path.join(callerHome, ".codex")), false);
    assert.deepEqual(probeRoots(), []);
    assert.match(codexResearchCapabilityStatus({
      ...options,
      authPermissionCheck: () => false
    }).detail, /group or other/u);
    assert.match(codexResearchCapabilityStatus({
      ...options,
      executablePermissionCheck: () => false
    }).detail, /not executable/u);
    assert.match(codexResearchCapabilityStatus({
      ...options,
      authDirectoryCheck: () => ({ ok: false, detail: "Codex auth source directory is shared" })
    }).detail, /directory is shared/u);
    assert.match(codexResearchCapabilityStatus({
      ...options,
      probeVersion: () => ({ status: 1, stdout: "", stderr: "broken" })
    }).detail, /version probe failed/u);
    assert.deepEqual(probeRoots(), []);
    assert.match(codexResearchCapabilityStatus({
      ...options,
      probeVersion: () => { throw new Error("probe threw"); }
    }).detail, /probe threw/u);
    assert.deepEqual(probeRoots(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("service auth never falls back to the interactive Codex home", () => {
  const source = fs.readFileSync(path.resolve("src/codex-cli.js"), "utf8");
  assert.doesNotMatch(
    source,
    /path\.join\(os\.homedir\(\), "\.codex", "auth\.json"\)/u
  );
  assert.equal(source.match(/config\.codexCliAuthPath/gu)?.length, 2);
});

test("Linux UID isolation ignores a forwarded root-only TMPDIR", () => {
  assert.equal(codexIsolationTempPrefix({
    platform: "linux",
    systemTempDir: "/tmp/codex-vscode-0"
  }), "/tmp/ojeommwo-codex-");
  assert.equal(codexIsolationTempPrefix({
    platform: "win32",
    systemTempDir: "portable-temp"
  }), path.join("portable-temp", "ojeommwo-codex-"));
});

test("successful isolated Codex refresh is atomically promoted with source metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-auth-promote-"));
  const sourcePath = path.join(directory, "auth.json");
  const candidatePath = path.join(directory, "isolated-auth.json");
  try {
    writePrivateAuth(sourcePath, chatgptAuthFixture());
    writePrivateAuth(candidatePath, chatgptAuthFixture({
      marker: "refreshed",
      refreshedAt: "2026-08-01T12:00:00.000Z"
    }));
    const sourceBefore = fs.statSync(sourcePath);
    const result = promoteIsolatedCodexAuth(isolatedAuthExecution(sourcePath, candidatePath));
    const sourceAfter = fs.statSync(sourcePath);

    assert.deepEqual(result, { promoted: true, reason: "refreshed" });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(sourcePath, "utf8")),
      JSON.parse(fs.readFileSync(candidatePath, "utf8"))
    );
    assert.equal(sourceAfter.mode & 0o777, sourceBefore.mode & 0o777);
    assert.equal(sourceAfter.uid, sourceBefore.uid);
    assert.equal(sourceAfter.gid, sourceBefore.gid);
    assert.equal(
      fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
      false
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unchanged isolated Codex auth is not rewritten", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-auth-unchanged-"));
  const sourcePath = path.join(directory, "auth.json");
  const candidatePath = path.join(directory, "isolated-auth.json");
  try {
    writePrivateAuth(sourcePath, chatgptAuthFixture());
    fs.copyFileSync(sourcePath, candidatePath);
    fs.chmodSync(candidatePath, 0o600);
    const sourceBefore = fs.statSync(sourcePath);
    const result = promoteIsolatedCodexAuth(isolatedAuthExecution(sourcePath, candidatePath));
    const sourceAfter = fs.statSync(sourcePath);

    assert.deepEqual(result, { promoted: false, reason: "unchanged" });
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("isolated Codex auth promotion uses a source-hash CAS guard", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-auth-cas-"));
  const sourcePath = path.join(directory, "auth.json");
  const candidatePath = path.join(directory, "isolated-auth.json");
  try {
    writePrivateAuth(sourcePath, chatgptAuthFixture());
    writePrivateAuth(candidatePath, chatgptAuthFixture({
      marker: "candidate",
      refreshedAt: "2026-08-01T12:00:00.000Z"
    }));
    const originalSnapshot = codexAuthSourceSnapshot(sourcePath);
    const externallyRefreshed = chatgptAuthFixture({
      marker: "external",
      refreshedAt: "2026-08-01T11:00:00.000Z"
    });
    writePrivateAuth(sourcePath, externallyRefreshed);

    assert.throws(
      () => promoteIsolatedCodexAuth(
        isolatedAuthExecution(sourcePath, candidatePath, originalSnapshot)
      ),
      /source changed/u
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(sourcePath, "utf8")), externallyRefreshed);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("isolated Codex auth promotion rejects invalid refreshes without exposing tokens", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-auth-invalid-"));
  const sourcePath = path.join(directory, "auth.json");
  const candidatePath = path.join(directory, "isolated-auth.json");
  const tokenSentinel = "DO_NOT_LOG_THIS_REFRESH_TOKEN";
  try {
    writePrivateAuth(sourcePath, chatgptAuthFixture());
    fs.writeFileSync(candidatePath, `{${tokenSentinel}`, { mode: 0o600 });
    fs.chmodSync(candidatePath, 0o600);
    assert.throws(
      () => promoteIsolatedCodexAuth(isolatedAuthExecution(sourcePath, candidatePath)),
      (error) => {
        assert.match(error.message, /not valid JSON/u);
        assert.doesNotMatch(error.message, new RegExp(tokenSentinel, "u"));
        return true;
      }
    );

    writePrivateAuth(candidatePath, chatgptAuthFixture({
      marker: tokenSentinel,
      accountId: "different-account",
      refreshedAt: "2026-08-01T12:00:00.000Z"
    }));
    assert.throws(
      () => promoteIsolatedCodexAuth(isolatedAuthExecution(sourcePath, candidatePath)),
      (error) => {
        assert.match(error.message, /different account/u);
        assert.doesNotMatch(error.message, new RegExp(tokenSentinel, "u"));
        return true;
      }
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(sourcePath, "utf8")),
      chatgptAuthFixture()
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rotated credentials survive a failed provider operation without losing the original failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-failed-refresh-"));
  const sourcePath = path.join(directory, "auth.json");
  const candidatePath = path.join(directory, "isolated-auth.json");
  try {
    writePrivateAuth(sourcePath, chatgptAuthFixture());
    writePrivateAuth(candidatePath, chatgptAuthFixture({ marker: "refreshed", refreshedAt: "2026-08-01T12:00:00.000Z" }));
    const execution = isolatedAuthExecution(sourcePath, candidatePath);
    const failure = new Error("provider timed out after refreshing auth");
    await assert.rejects(withCodexAuthPersistence(execution, async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(JSON.parse(fs.readFileSync(sourcePath)), JSON.parse(fs.readFileSync(candidatePath)));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("auth readiness rejects empty, malformed and expired credentials without disclosing tokens", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-expiry-"));
  const authPath = path.join(directory, "auth.json");
  const nowMs = Date.parse("2026-09-12T00:00:00Z");
  try {
    for (const auth of [{}, chatgptAuthFixture()]) {
      writePrivateAuth(authPath, auth);
      assert.equal(codexAuthReadiness(authPath, { nowMs }).ok, false);
    }
    for (const delta of [-1, 0, 60]) {
      const auth = chatgptAuthFixture();
      auth.tokens.access_token = `header.${Buffer.from(JSON.stringify({ exp: nowMs / 1000 + delta })).toString("base64url")}.signature`;
      writePrivateAuth(authPath, auth);
      const result = codexAuthReadiness(authPath, { nowMs });
      assert.equal(result.ok, delta > 0);
      assert.ok(!JSON.stringify(result).includes(auth.tokens.access_token));
      if (delta <= 0) assert.match(result.detail, /expired/u);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("provider auth errors stop retries while tool text cannot forge auth metadata", async () => {
  const capture = createCodexDiagnosticMetadataCapture();
  capture.push(JSON.stringify({ type: "item.completed", item: { text: "Your access token could not be refreshed" } }) + "\n");
  assert.equal(capture.finish().authRequired, undefined);
  for (const event of [
    { type: "error", message: "Your access token could not be refreshed because your refresh token has expired." },
    { type: "turn.failed", error: { message: "401 Unauthorized" } },
    { type: "error", message: "auth error code: token_revoked" },
    { type: "turn.failed", error: { message: "refresh_token_invalidated" } }
  ]) {
    const child = fakeCodexChild();
    const monitored = monitorCodexChild({ child, logStream: new PassThrough(), prompt: "fixture", timeoutMs: 1000, logPath: "fixture.log" });
    child.stdout.write(JSON.stringify(event) + "\n");
    child.emit("close", 1, null);
    await assert.rejects(monitored, (error) => error.code === "CODEX_AUTH_REQUIRED" && !isRetryableCodexExecutionError(error));
  }
});

test("Codex diagnostic capture enforces one shared UTF-8 byte budget", () => {
  const written = [];
  let overflowCount = 0;
  const capture = createBoundedByteCapture({
    maxBytes: 5,
    write: (chunk) => written.push(Buffer.from(chunk)),
    onExceeded: () => { overflowCount += 1; }
  });
  capture.push("가");
  capture.push("abc");
  capture.push("ignored");
  assert.equal(Buffer.concat(written).toString("utf8"), "가ab");
  assert.equal(capture.byteLength, 5);
  assert.equal(capture.exceeded, true);
  assert.equal(overflowCount, 1);
});

function fakeCodexChild(stdin = new PassThrough()) {
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

test("Codex child monitoring captures stdin and diagnostic-log failures", async () => {
  const brokenStdin = new Writable({
    write(chunk, encoding, callback) { callback(new Error("fixture stdin failure")); }
  });
  await assert.rejects(
    monitorCodexChild({
      child: fakeCodexChild(brokenStdin),
      logStream: new PassThrough(),
      prompt: "fixture",
      timeoutMs: 1000,
      logPath: "fixture.log"
    }),
    /stdin failed/u
  );

  const child = fakeCodexChild();
  const brokenLog = new Writable({
    write(chunk, encoding, callback) { callback(new Error("fixture log failure")); }
  });
  const monitored = monitorCodexChild({
    child,
    logStream: brokenLog,
    prompt: "fixture",
    timeoutMs: 1000,
    logPath: "fixture.log"
  });
  child.stdout.write("diagnostic");
  await assert.rejects(monitored, /diagnostic log failed/u);
});

test("Codex child monitoring returns usage and attaches Retry-After to failures", async () => {
  const successfulChild = fakeCodexChild();
  const successful = monitorCodexChild({
    child: successfulChild,
    logStream: new PassThrough(),
    prompt: "fixture",
    timeoutMs: 1000,
    logPath: "fixture.log"
  });
  successfulChild.stderr.write("tokens used\n26,");
  successfulChild.stderr.write("844\n");
  successfulChild.exitCode = 0;
  successfulChild.emit("close", 0, null);
  assert.deepEqual(await successful, {
    tokenUsage: { totalTokens: 26844, source: "codex-cli-footer" },
    retryAfterMs: null
  });

  const failedChild = fakeCodexChild();
  const failed = monitorCodexChild({
    child: failedChild,
    logStream: new PassThrough(),
    prompt: "fixture",
    timeoutMs: 1000,
    logPath: "fixture.log"
  });
  failedChild.stderr.write("Retry-After: 9\n");
  failedChild.exitCode = 1;
  failedChild.emit("close", 1, null);
  await assert.rejects(failed, (error) => {
    assert.match(error.message, /exited with code 1/u);
    assert.deepEqual(error.codexDiagnosticMetadata, {
      tokenUsage: null,
      retryAfterMs: 9000
    });
    assert.equal(Object.keys(error).includes("codexDiagnosticMetadata"), false);
    return true;
  });
});

test("oversized Codex structured output is deleted before it can be copied", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-codex-output-"));
  const outputPath = path.join(directory, "output.json");
  try {
    fs.writeFileSync(outputPath, Buffer.alloc(CODEX_STRUCTURED_OUTPUT_LIMIT_BYTES + 1));
    assert.throws(() => assertBoundedCodexOutputFile(outputPath), /1 MB structured-output limit/u);
    assert.equal(fs.existsSync(outputPath), false);
    fs.writeFileSync(outputPath, "{}", "utf8");
    assert.equal(assertBoundedCodexOutputFile(outputPath), 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("buildCodexArgs keeps the non-interactive structured-output contract", () => {
  const args = buildCodexArgs({ outputPath: "/tmp/out.json", schemaPath: "/tmp/schema.json" });
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--strict-config"));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.deepEqual(args.slice(-3), ["--output-last-message", "/tmp/out.json", "-"]);
  assert.equal(args.at(-1), "-");
});

test("validateCodexRecommendations accepts one unknown price but not two", () => {
  assert.equal(validateCodexRecommendations(recommendations, { items: [] }).length, 3);
  const twoUnknown = recommendations.map((item, index) => index < 2 ? { ...item, priceText: "가격 확인 필요" } : item);
  assert.throws(() => validateCodexRecommendations(twoUnknown, { items: [] }), /more than one/u);
  const malformed = recommendations.map((item, index) => index === 0 ? { ...item, priceText: "약 9천원" } : item);
  assert.throws(() => validateCodexRecommendations(malformed, { items: [] }), /Invalid price/u);
  const schema = JSON.parse(fs.readFileSync(path.resolve("prompts/codex-cli-recommendation.schema.json"), "utf8"));
  const pricePattern = new RegExp(schema.properties.recommendations.items.properties.priceText.pattern, "u");
  assert.equal(pricePattern.test("9,000원"), true);
  assert.equal(pricePattern.test("가격 확인 필요"), true);
  assert.equal(pricePattern.test("약 9천원"), false);
});

test("validateCodexRecommendations rejects cooldown conflicts", () => {
  assert.throws(() => validateCodexRecommendations(recommendations, {
    items: [{
      restaurant: "한식집",
      menu: "다른 메뉴",
      recommendedAt: new Date().toISOString()
    }]
  }), /recent restaurant duplicate/u);
});

test("validateCodexRecommendations applies actual meals to live model cooldowns", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  assert.throws(() => validateCodexRecommendations(recommendations, { items: [] }, {
    now,
    mealEvents: {
      events: [{
        restaurant: "한식집",
        menu: "다른 메뉴",
        mealType: "점심",
        source: "scheduled-lunch",
        respondentId: "a".repeat(64),
        normalizationStatus: "verified-source",
        createdAt: "2026-07-13T00:00:00.000Z"
      }]
    }
  }), /recent restaurant duplicate/u);
});

test("validateCodexRecommendations rejects unsafe or non-URL evidence", () => {
  const unsafe = recommendations.map((item, index) => index === 0 ? { ...item, evidence: ["search result"] } : item);
  assert.throws(() => validateCodexRecommendations(unsafe, { items: [] }), /safe HTTPS URLs/u);
});


test("JSONL usage records input/cache/output without double-counting cache or reasoning", () => {
  const capture = createCodexDiagnosticMetadataCapture();
  const usage = { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 300, reasoning_output_tokens: 200 };
  const event = JSON.stringify({ type: "turn.completed", usage }) + "\n";
  capture.push(event.slice(0, 31));
  capture.push(event.slice(31));
  capture.push("tokens used\n999\n");
  assert.deepEqual(capture.finish().tokenUsage, {
    totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 900,
    outputTokens: 300, reasoningOutputTokens: 200, source: "codex-cli-json",
  });
  const oldCli = createCodexDiagnosticMetadataCapture();
  oldCli.push(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 3 } }));
  assert.deepEqual(oldCli.finish().tokenUsage, {
    totalTokens: 23, inputTokens: 20, cachedInputTokens: 0, outputTokens: 3, source: "codex-cli-json",
  });
  for (const invalid of [
    { input_tokens: 10, cached_input_tokens: 11, output_tokens: 2 },
    { input_tokens: -1, cached_input_tokens: 0, output_tokens: 2 },
    { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 3 },
    { input_tokens: "10", cached_input_tokens: 0, output_tokens: 2 },
    { input_tokens: 10000000000, cached_input_tokens: 0, output_tokens: 1 },
  ]) {
    const rejected = createCodexDiagnosticMetadataCapture();
    rejected.push(JSON.stringify({ type: "turn.completed", usage: invalid }));
    assert.equal(rejected.finish().tokenUsage, null);
  }
  const embedded = createCodexDiagnosticMetadataCapture();
  embedded.push(JSON.stringify({ type: "item.completed", item: { text: event } }));
  assert.equal(embedded.finish().tokenUsage, null);
});

test("structured token telemetry strips extra data and validates subset accounting", () => {
  const base = { job: "candidate-refresh", attempt: 1, startedAt: "2026-09-09T00:00:00Z", durationMs: 10, success: true };
  const tokenUsage = { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 900,
    outputTokens: 300, reasoningOutputTokens: 200, source: "codex-cli-json" };
  const built = buildCodexInvocationTelemetry({ ...base, tokenUsage: { ...tokenUsage, prompt: "private" } });
  assert.deepEqual(built.tokenUsage, tokenUsage);
  assert.throws(() => buildCodexInvocationTelemetry({ ...base, tokenUsage: { ...tokenUsage, totalTokens: 2400 } }), /token usage is invalid/u);
  assert.throws(() => buildCodexInvocationTelemetry({ ...base, tokenUsage: { ...tokenUsage, cachedInputTokens: 1201 } }), /token usage is invalid/u);
  assert.ok(buildCodexArgs({ outputPath: "output.json", schemaPath: "schema.json" }).includes("--json"));
});

test("interleaved stdout and stderr chunks preserve JSONL usage and retry timing", async () => {
  const child = fakeCodexChild();
  const log = new PassThrough();
  const result = monitorCodexChild({ child, logStream: log, prompt: "fixture", timeoutMs: 1000, logPath: "fixture.log" });
  const event = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 300 } }) + "\n";
  child.stdout.write(event.slice(0, 40));
  child.stderr.write("Retry-After: 7\n");
  child.stdout.write(event.slice(40));
  child.exitCode = 0;
  child.emit("close", 0, null);
  assert.deepEqual(await result, {
    tokenUsage: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 900, outputTokens: 300, source: "codex-cli-json" },
    retryAfterMs: 7000,
  });
});

 test("I/O failure waits for child termination before returning its temporary auth home", async () => {
  const child = fakeCodexChild();
  let killed = false;
  child.kill = () => { killed = true; return true; };
  const brokenLog = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("fixture log failure")); } });
  let completed = false;
  const monitored = monitorCodexChild({ child, logStream: brokenLog, prompt: "fixture", timeoutMs: 1000, logPath: "fixture.log" });
  const observed = monitored.catch((error) => { completed = true; return error; });
  child.stdout.write("fixture");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killed, true);
  assert.equal(completed, false);
  child.emit("close", null, "SIGTERM");
  assert.match((await observed).message, /diagnostic log failed/u);
});


test("incompatible CLI/model errors stop retries without trusting model item text", async () => {
  const capture = createCodexDiagnosticMetadataCapture();
  capture.push(JSON.stringify({ type: "item.completed", item: { text: "The model requires a newer version" } }) + "\n");
  assert.equal(capture.finish().modelConfigurationRequired, undefined);
  const child = fakeCodexChild();
  const monitored = monitorCodexChild({ child, logStream: new PassThrough(), prompt: "fixture", timeoutMs: 1000, logPath: "fixture.log" });
  child.stdout.write(JSON.stringify({ type: "error", message: "The 'gpt-6-astra' model requires a newer version of Codex." }) + "\n");
  child.emit("close", 1, null);
  await assert.rejects(monitored, (error) => error.code === "CODEX_MODEL_CONFIGURATION_REQUIRED" && !isRetryableCodexExecutionError(error));
});
