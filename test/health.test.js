import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateReadinessWindow,
  cooldownEnforcementHealth,
  defaultLeaseStandbyReadiness,
  filesystemCapacityHealth,
  formatHealthReport,
  healthExitCode,
  immediateStandbyReadiness,
  mealNormalizationStateHealth,
  productionDeliveryContract,
  summarizeHealth,
  unverifiedMealNormalizationHealth,
  unixPermissionContract,
  unixSourcePermissionContract
} from "../src/health.js";

test("filesystem capacity health preserves an operating reserve", () => {
  const gib = 1024 ** 3;
  assert.equal(filesystemCapacityHealth({ availableBytes: 33 * gib, totalBytes: 437 * gib }).status, "pass");
  assert.equal(filesystemCapacityHealth({ availableBytes: 12 * gib, totalBytes: 437 * gib }).status, "warn");
  assert.equal(filesystemCapacityHealth({ availableBytes: 4 * gib, totalBytes: 437 * gib }).status, "fail");
  assert.throws(() => filesystemCapacityHealth({ availableBytes: -1, totalBytes: 1 }), /invalid/u);
});

test("immediate standby probes both meals independently of an empty weekend schedule", () => {
  const calls = [];
  const now = new Date("2026-08-01T12:00:00.000Z"); // Saturday 21:00 KST.
  const report = immediateStandbyReadiness({
    now,
    assess: (options) => {
      calls.push(options);
      return {
        ready: options.currentMeal === "lunch",
        eligibleCandidateCount: options.currentMeal === "lunch" ? 3 : 2
      };
    }
  });
  assert.deepEqual(calls.map((call) => call.currentMeal), ["lunch", "dinner"]);
  assert.ok(calls.every((call) => call.expiresAt.getTime() - now.getTime() === 1));
  assert.ok(calls.every((call) => Array.isArray(call.holidayDates) && call.holidayDates.length === 0));
  assert.equal(report.ready, false);
  assert.equal(report.detail, "lunch=ready(3), dinner=blocked(2)");
});

test("default standby readiness audits the full 24-hour lease horizon", () => {
  const now = new Date("2026-08-30T10:00:00.000Z");
  let captured;
  const report = defaultLeaseStandbyReadiness({
    now,
    holidayDates: ["2026-01-01"],
    assess: (options) => {
      captured = options;
      return { ready: true, scheduledSendCount: 2, detail: "covered" };
    }
  });
  assert.equal(captured.expiresAt.toISOString(), "2026-08-31T10:00:00.000Z");
  assert.deepEqual(captured.holidayDates, ["2026-01-01"]);
  assert.equal(captured.currentMeal, undefined);
  assert.equal(report.ready, true);
});

test("candidate readiness requires the last scheduled refresh before a send", () => {
  const weekendGap = candidateReadinessWindow({
    now: new Date("2026-07-16T09:45:00.000Z"),
    nextSendAt: new Date("2026-07-20T02:25:00.000Z")
  });
  assert.equal(weekendGap.refreshAt.toISOString(), "2026-07-19T23:50:00.000Z");
  assert.equal(weekendGap.refreshPending, true);

  const afterMorningGate = candidateReadinessWindow({
    now: new Date("2026-07-20T01:00:00.000Z"),
    nextSendAt: new Date("2026-07-20T02:25:00.000Z")
  });
  assert.equal(afterMorningGate.refreshPending, false);

  const beforeDinnerGate = candidateReadinessWindow({
    now: new Date("2026-07-20T05:00:00.000Z"),
    nextSendAt: new Date("2026-07-20T08:25:00.000Z")
  });
  assert.equal(beforeDinnerGate.refreshAt.toISOString(), "2026-07-20T06:00:00.000Z");
  assert.equal(beforeDinnerGate.refreshPending, true);
});

test("health summary makes failures dominant over warnings", () => {
  assert.equal(summarizeHealth([{ status: "pass" }, { status: "warn" }]).status, "warn");
  assert.equal(summarizeHealth([{ status: "pass" }, { status: "warn" }, { status: "fail" }]).status, "fail");
  assert.deepEqual(summarizeHealth([{ status: "pass" }]).counts, { pass: 1, warn: 0, fail: 0 });
});

test("release health requires a clean pass while strict keeps fail-only compatibility", () => {
  for (const status of ["pass", "warn", "fail"]) {
    const report = { status };
    assert.equal(healthExitCode(report, ["--require-pass"]), status === "pass" ? 0 : 1);
    assert.equal(healthExitCode(report, ["--strict"]), status === "fail" ? 1 : 0);
  }
  assert.equal(healthExitCode({ status: "warn" }, []), 0);
});

test("cooldown health evaluates every policy-enforced violation, not only the recent window", () => {
  const result = cooldownEnforcementHealth({
    cooldowns: {
      allViolationEvents: 1,
      recentViolations: [],
      enforcedViolations: [{ recommendedAt: "2026-01-01T00:00:00.000Z" }]
    }
  });
  assert.equal(result.status, "fail");
  assert.match(result.detail, /^1 violations since enforcement/u);
});

test("unverified meal normalizations warn separately and remain non-learning review items", () => {
  const mealEvents = {
    events: [
      { normalizationStatus: "verified", normalizationAttemptCount: 1 },
      { normalizationStatus: "unverified", normalizationAttemptCount: 3 }
    ]
  };
  const state = mealNormalizationStateHealth(mealEvents, { maxAttempts: 3 });
  const review = unverifiedMealNormalizationHealth(mealEvents);

  assert.equal(state.status, "pass");
  assert.equal(review.status, "warn");
  assert.match(review.detail, /1 terminal unverified/u);
  assert.match(review.detail, /manual review/u);
  assert.match(review.detail, /excluded from preference learning/u);
});

test("exhausted failed or unresolved normalizations remain a hard health failure", () => {
  for (const normalizationStatus of ["failed", "unresolved"]) {
    const result = mealNormalizationStateHealth({
      events: [{ normalizationStatus, normalizationAttemptCount: 3 }]
    }, { maxAttempts: 3 });
    assert.equal(result.status, "fail");
    assert.match(result.detail, /exhausted retry limits/u);
  }
  assert.equal(unverifiedMealNormalizationHealth({ events: [] }).status, "pass");
});

test("health report exposes the service release version", () => {
  const text = formatHealthReport({
    releaseVersion: "2",
    releaseLabel: "2 · 2026-08-30T20:03:46+09:00 · Daybreak Blue(GPT-5.6 Sol) Ultra",
    status: "pass",
    counts: { pass: 1, warn: 0, fail: 0 },
    checks: [{ name: "test", status: "pass", detail: "ok" }]
  });
  assert.match(text, /ojeommwo-v2 2 · 2026-08-30T20:03:46\+09:00 · Daybreak Blue\(GPT-5\.6 Sol\) Ultra health/u);
});

test("production health fails closed on delivery mode, scheduler, or channel drift", () => {
  const valid = {
    recommendationMode: "cache",
    enableSchedule: false,
    codexCliSandbox: "read-only",
    codexCliIsolateLinux: true,
    codexCliIsolationUid: 65534,
    codexCliIsolationGid: 65534,
    timezone: "Asia/Seoul",
    lunchChannelId: "C0123456789",
    operationsAlertChannelId: "D0123456789"
  };
  assert.equal(productionDeliveryContract(valid).valid, true);
  for (const drift of [
    { recommendationMode: "codex-cli" },
    { enableSchedule: true },
    { codexCliSandbox: "danger-full-access" },
    { timezone: "UTC" },
    { lunchChannelId: "CWRONG" },
    { operationsAlertChannelId: "DWRONG" }
  ]) {
    assert.equal(productionDeliveryContract({ ...valid, ...drift }).valid, false);
  }
  assert.equal(productionDeliveryContract(valid, {
    platform: "linux", uid: 0, identitySwitchSupported: true
  }).valid, true);
  for (const drift of [
    { codexCliIsolateLinux: false },
    { codexCliIsolationUid: 0 }
  ]) {
    assert.equal(productionDeliveryContract({ ...valid, ...drift }, {
      platform: "linux", uid: 0, identitySwitchSupported: true
    }).valid, false);
  }
  assert.equal(productionDeliveryContract(valid, {
    platform: "linux", uid: 0, identitySwitchSupported: false
  }).valid, false);
});

test("Linux permission health allows integrated source traversal but keeps every state file private", () => {
  for (const rootMode of [0o700, 0o750]) {
    assert.equal(unixPermissionContract({
      rootMode,
      envMode: 0o600,
      dataMode: 0o700,
      storeModes: Array(7).fill(0o600)
    }).valid, true);
  }
  for (const drift of [
    { rootMode: 0o770, envMode: 0o600, dataMode: 0o700, storeModes: Array(7).fill(0o600) },
    { rootMode: 0o750, envMode: 0o640, dataMode: 0o700, storeModes: Array(7).fill(0o600) },
    { rootMode: 0o750, envMode: 0o600, dataMode: 0o750, storeModes: Array(7).fill(0o600) },
    { rootMode: 0o750, envMode: 0o600, dataMode: 0o700, storeModes: [0o600, 0o640] }
  ]) assert.equal(unixPermissionContract(drift).valid, false);
});

test("Linux source permission health rejects any recursively writable source entry", () => {
  const valid = {
    directories: [
      { path: "src", mode: 0o750 },
      { path: "scripts", mode: 0o750 },
      { path: "test/fixtures", mode: 0o750 }
    ],
    files: [
      { path: "package.json", mode: 0o640 },
      { path: "src/index.js", mode: 0o640 }
    ],
    shellFiles: [{ path: "scripts/run-interaction-listener.sh", mode: 0o750 }]
  };
  assert.equal(unixSourcePermissionContract(valid).valid, true);
  for (const drift of [
    { directories: [{ path: "src", mode: 0o770 }], files: [], shellFiles: [] },
    { directories: [], files: [{ path: "src/index.js", mode: 0o660 }], shellFiles: [] },
    { directories: [], files: [], shellFiles: [{ path: "scripts/run.sh", mode: 0o755 }] }
  ]) {
    const result = unixSourcePermissionContract(drift);
    assert.equal(result.valid, false);
    assert.match(result.detail, /src|scripts/u);
  }
});
