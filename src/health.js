import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedWindowsPowerShellEnvironment } from "./windows-powershell-environment.js";
import {
  config,
  DATA_DIR,
  PRODUCTION_TIMEZONE,
  REQUIRED_CODEX_MODEL,
  REQUIRED_CODEX_REASONING_EFFORT,
  REQUIRED_LUNCH_CHANNEL_ID,
  REQUIRED_OPERATOR_DM_CHANNEL_ID,
  ROOT_DIR,
  validateRuntimeConfig
} from "./config.js";
import { validateStaticFallback, getCachedRecommendations } from "./recommender.js";
import { getKstParts, loadHolidayDates } from "./scheduler.js";
import { auditHasStructuralFailure, auditRecommendationData } from "./recommendation-audit.js";
import {
  getCandidatePreferences,
  getCoffeeParticipation,
  getDeliveryOutbox,
  getRecommendationHistory,
  getMealEvents,
  getSentMessages,
  readJson
} from "./storage.js";
import {
  filterEligibleVerifiedCandidates,
  hasCurrentDeterministicEvidence
} from "./verified-candidates.js";
import {
  filterResearchCooldownEligible,
  hasViableRecommendationSet,
  nextScheduledSendAt
} from "./candidate-research.js";
import { codexExecutionIsolationStatus, codexResearchCapabilityStatus } from "./codex-cli.js";
import { liveCodexAuthHealth } from "./codex-auth-health.js";
import { RELEASE } from "./version.js";
import { normalizeMealType } from "./meal-types.js";
import { loadMealNormalizationCatalog } from "./meal-normalization.js";
import { assessLocalEmergencyReadiness } from "./local-emergency-readiness.js";
import {
  validateCandidatePreferenceStore,
  validateCoffeeParticipationStore
} from "./interaction-data-integrity.js";
import {
  validateMealEventStore,
  validateRecommendationHistoryStore,
  validateSentMessageStore
} from "./operating-data-integrity.js";
import { migrateTaxonomyStores } from "./taxonomy-migration.js";
import { inspectOperatingMaintenanceMarker } from "./maintenance-marker.js";
import { auditCategoryArbitrationStores } from "./category-arbitration.js";

const CANDIDATE_REFRESH_GRACE_MS = 20 * 60 * 1000;
const FILESYSTEM_FAIL_FREE_BYTES = 5 * 1024 ** 3;
const FILESYSTEM_WARN_FREE_BYTES = 15 * 1024 ** 3;
const FILESYSTEM_FAIL_FREE_RATIO = 0.02;
const FILESYSTEM_WARN_FREE_RATIO = 0.05;
const PROTECTED_SOURCE_DIRECTORIES = Object.freeze(["prompts", "scripts", "src", "test"]);
const PROTECTED_SOURCE_FILES = Object.freeze([
  ".env.example",
  ".gitignore",
  "ARCHITECTURE.md",
  "HANDOFF.md",
  "package.json",
  "AGENTS.md",
  "MODEL_EVALUATION.md",
  "QUALITY_REPORT.md",
  "README.md",
  "RELEASES.md"
]);

function wallClockMinute(parts) {
  const [year, month, day] = parts.dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, parts.hour, parts.minute) / 60000;
}

export function candidateReadinessWindow({
  now = new Date(),
  nextSendAt,
  refreshGraceMs = CANDIDATE_REFRESH_GRACE_MS
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Candidate readiness requires a valid current time");
  }
  if (!(nextSendAt instanceof Date) || !Number.isFinite(nextSendAt.getTime())) {
    throw new Error("Candidate readiness requires a valid next send time");
  }
  if (!Number.isInteger(refreshGraceMs) || refreshGraceMs < 0 || refreshGraceMs > 60 * 60 * 1000) {
    throw new Error("Candidate refresh grace must be between zero and one hour");
  }

  const current = getKstParts(now);
  const send = getKstParts(nextSendAt);
  const refresh = {
    ...send,
    ...(send.hour < 15 ? { hour: 8, minute: 50 } : { hour: 15, minute: 0 })
  };
  const minuteStartMs = now.getTime() - now.getSeconds() * 1000 - now.getMilliseconds();
  const refreshAt = new Date(
    minuteStartMs + (wallClockMinute(refresh) - wallClockMinute(current)) * 60 * 1000
  );
  const refreshDeadline = new Date(refreshAt.getTime() + refreshGraceMs);
  return {
    nextSendAt,
    refreshAt,
    refreshDeadline,
    refreshPending: refreshAt < nextSendAt && now < refreshDeadline
  };
}

export function immediateStandbyReadiness({
  now = new Date(),
  verifiedCandidates = [],
  history = { version: 1, items: [] },
  mealEvents = { version: 1, events: [] },
  assess = assessLocalEmergencyReadiness
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Immediate standby readiness requires a valid current time");
  }
  if (typeof assess !== "function") {
    throw new Error("Immediate standby readiness requires a readiness assessor");
  }
  // A one-millisecond lease contains only the explicit catch-up meal. This
  // deliberately avoids the normal weekday/weekend schedule so health cannot
  // turn a currently exhausted standby into a vacuous weekend PASS.
  const expiresAt = new Date(now.getTime() + 1);
  const reports = ["lunch", "dinner"].map((currentMeal) => assess({
    now,
    expiresAt,
    holidayDates: [],
    currentMeal,
    verifiedCandidates,
    history,
    mealEvents
  }));
  return {
    ready: reports.every((report) => report.ready),
    reports,
    detail: reports.map((report, index) => {
      const meal = index === 0 ? "lunch" : "dinner";
      return `${meal}=${report.ready ? "ready" : "blocked"}(${report.eligibleCandidateCount})`;
    }).join(", ")
  };
}

export function defaultLeaseStandbyReadiness({
  now = new Date(),
  holidayDates = [],
  verifiedCandidates = [],
  history = { version: 1, items: [] },
  mealEvents = { version: 1, events: [] },
  assess = assessLocalEmergencyReadiness
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Default-lease standby readiness requires a valid current time");
  }
  if (typeof assess !== "function") {
    throw new Error("Default-lease standby readiness requires a readiness assessor");
  }
  return assess({
    now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    holidayDates,
    verifiedCandidates,
    history,
    mealEvents
  });
}

function check(name, status, detail) {
  return { name, status, detail };
}

export function filesystemCapacityHealth({ availableBytes, totalBytes } = {}) {
  if (!Number.isFinite(availableBytes) || !Number.isFinite(totalBytes)
    || availableBytes < 0 || totalBytes <= 0 || availableBytes > totalBytes) {
    throw new Error("filesystem capacity is invalid");
  }
  const freeRatio = availableBytes / totalBytes;
  const freeGiB = availableBytes / 1024 ** 3;
  const detail = `${freeGiB.toFixed(1)} GiB free (${(freeRatio * 100).toFixed(1)}%)`;
  if (availableBytes < FILESYSTEM_FAIL_FREE_BYTES || freeRatio < FILESYSTEM_FAIL_FREE_RATIO) {
    return check("filesystem-capacity", "fail", `${detail}; operating writes are at immediate risk`);
  }
  if (availableBytes < FILESYSTEM_WARN_FREE_BYTES || freeRatio < FILESYSTEM_WARN_FREE_RATIO) {
    return check("filesystem-capacity", "warn", `${detail}; reclaim unrelated host storage before the reserve is exhausted`);
  }
  return check("filesystem-capacity", "pass", detail);
}

function attempt(name, task) {
  try {
    return task();
  } catch (error) {
    return check(name, "fail", error.message);
  }
}

export function summarizeHealth(checks) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const item of checks) counts[item.status] = (counts[item.status] || 0) + 1;
  return {
    status: counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass",
    counts
  };
}

export function productionDeliveryContract(runtimeConfig = config, {
  platform = process.platform,
  uid = process.getuid?.(),
  identitySwitchSupported = typeof process.setuid === "function" && typeof process.setgid === "function"
} = {}) {
  const problems = [];
  if (runtimeConfig.recommendationMode !== "cache") problems.push("RECOMMENDATION_MODE must be cache");
  if (runtimeConfig.enableSchedule !== false) problems.push("ENABLE_SCHEDULE must be false under pororo cron");
  if (runtimeConfig.codexCliSandbox !== "read-only") problems.push("CODEX_CLI_SANDBOX must be read-only");
  if (runtimeConfig.timezone !== PRODUCTION_TIMEZONE) problems.push(`TIMEZONE must be ${PRODUCTION_TIMEZONE}`);
  const isolation = codexExecutionIsolationStatus({
    platform,
    uid,
    sandbox: runtimeConfig.codexCliSandbox,
    isolateLinux: runtimeConfig.codexCliIsolateLinux,
    isolationUid: runtimeConfig.codexCliIsolationUid,
    isolationGid: runtimeConfig.codexCliIsolationGid,
    identitySwitchSupported
  });
  if (platform === "linux" && uid === 0 && (!isolation.safe || !isolation.isolated)) {
    problems.push(isolation.detail);
  }
  if (runtimeConfig.lunchChannelId !== REQUIRED_LUNCH_CHANNEL_ID) {
    problems.push(`LUNCH_CHANNEL_ID must be ${REQUIRED_LUNCH_CHANNEL_ID}`);
  }
  if (runtimeConfig.operationsAlertChannelId !== REQUIRED_OPERATOR_DM_CHANNEL_ID) {
    problems.push(`OPERATIONS_ALERT_CHANNEL_ID must be ${REQUIRED_OPERATOR_DM_CHANNEL_ID}`);
  }
  return {
    valid: problems.length === 0,
    detail: problems.length === 0
      ? `cache delivery / external cron / read-only Codex / ${PRODUCTION_TIMEZONE} / protected channel ${REQUIRED_LUNCH_CHANNEL_ID}`
      : problems.join("; ")
  };
}

export function healthExitCode(report, args = []) {
  if (args.includes("--require-pass")) return report.status === "pass" ? 0 : 1;
  if (args.includes("--strict")) return report.status === "fail" ? 1 : 0;
  return 0;
}

export function cooldownEnforcementHealth(report) {
  const violations = report?.cooldowns?.enforcedViolations;
  if (!Array.isArray(violations)) throw new Error("Recommendation audit is missing enforced cooldown violations");
  return check(
    "cooldown-enforcement",
    violations.length > 0 ? "fail" : "pass",
    `${violations.length} violations since enforcement (${report.cooldowns.allViolationEvents} retained historical audit events)`
  );
}

function mealNormalizationCounts(mealEvents) {
  if (!Array.isArray(mealEvents?.events)) {
    throw new Error("Meal normalization health requires an events array");
  }
  const counts = new Map();
  for (const event of mealEvents.events) {
    const status = event.normalizationStatus || "legacy-or-not-applicable";
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return counts;
}

export function mealNormalizationStateHealth(mealEvents, {
  maxAttempts = config.mealNormalizationMaxAttempts
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Meal normalization health requires a positive retry limit");
  }
  const counts = mealNormalizationCounts(mealEvents);
  const exhausted = mealEvents.events.filter((event) =>
    ["failed", "unresolved"].includes(event.normalizationStatus)
    && (event.normalizationAttemptCount || 0) >= maxAttempts
  );
  const active = (counts.get("pending") || 0) + (counts.get("normalizing") || 0);
  const detail = [...counts].map(([status, count]) => `${status}=${count}`).join(", ")
    || "no meal events";
  if (exhausted.length) {
    return check(
      "meal-normalization-state",
      "fail",
      `${exhausted.length} custom meal normalizations exhausted retry limits; ${detail}`
    );
  }
  return check("meal-normalization-state", active ? "warn" : "pass", detail);
}

export function unverifiedMealNormalizationHealth(mealEvents) {
  const counts = mealNormalizationCounts(mealEvents);
  const unverified = counts.get("unverified") || 0;
  return check(
    "meal-normalization-unverified",
    unverified ? "warn" : "pass",
    unverified
      ? `${unverified} terminal unverified meal entries require manual review and remain excluded from preference learning`
      : "no terminal unverified meal entries require manual review"
  );
}

function windowsPermissionCheck() {
  const envPath = path.join(ROOT_DIR, ".env");
  const dataPath = path.join(ROOT_DIR, "data");
  const protectorPath = path.join(ROOT_DIR, "scripts", "protect-local-data-acl.ps1");
  const escapedPath = envPath.replaceAll("'", "''");
  const escapedDataPath = dataPath.replaceAll("'", "''");
  const escapedRootPath = ROOT_DIR.replaceAll("'", "''");
  const escapedProtectorPath = protectorPath.replaceAll("'", "''");
  const command = `
$ErrorActionPreference = "Stop"
$acl = Get-Acl -LiteralPath '${escapedPath}'
if (-not $acl.AreAccessRulesProtected) { throw ".env inherits filesystem permissions" }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($currentSid, "S-1-5-18", "S-1-5-32-544")
$readMask = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
$sandboxDeny = $false
foreach ($rule in $acl.Access) {
  $identity = [string]$rule.IdentityReference
  if ($identity -like "*\\CodexSandboxUsers" -and
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny -and
      (([int]$rule.FileSystemRights -band $readMask) -eq $readMask)) {
    $sandboxDeny = $true
  }
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      (([int]$rule.FileSystemRights -band $readMask) -ne 0)) {
    try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { throw ".env has an unresolvable read principal: $identity" }
    if ($sid -notin $allowedSids) { throw ".env grants read access to an unexpected principal: $identity" }
  }
}
if (-not $sandboxDeny) { throw ".env does not explicitly deny Codex sandbox reads" }
if (-not (Test-Path -LiteralPath '${escapedProtectorPath}' -PathType Leaf)) {
  throw "data ACL verifier is missing"
}
& '${escapedProtectorPath}' -ProjectRoot '${escapedRootPath}' -DataDir '${escapedDataPath}' -VerifyOnly | Out-Null
Write-Output "private Windows ACL; env inheritance disabled and sandbox read denied; data owner and exact FullControl principals verified"
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    encoding: "utf8",
    windowsHide: true,
    // Full regression runs can start several PowerShell processes at once on
    // Windows. Preserve the ACL gate while avoiding a false failure caused
    // solely by cold-start contention.
    timeout: 30000,
    env: isolatedWindowsPowerShellEnvironment()
  });
  if (result.status !== 0) {
    const processFailure = result.error?.message
      || (result.signal ? `PowerShell ACL check terminated by ${result.signal}` : "");
    const detail = String(
      result.stderr || result.stdout || processFailure || "PowerShell ACL check failed"
    ).trim();
    throw new Error(detail.slice(0, 500));
  }
  return check("secret-permissions", "pass", String(result.stdout).trim());
}

export function unixPermissionContract({ rootMode, envMode, dataMode, storeModes = [] }) {
  const projectModeValid = rootMode === 0o700 || rootMode === 0o750;
  const storesValid = storeModes.every((mode) => mode === 0o600);
  return {
    valid: projectModeValid && envMode === 0o600 && dataMode === 0o700 && storesValid,
    detail: `project=${rootMode.toString(8)}, env=${envMode.toString(8)}, data=${dataMode.toString(8)}, stores=${storesValid ? "600" : "invalid"}`
  };
}

export function unixSourcePermissionContract({ directories = [], files = [], shellFiles = [] } = {}) {
  const invalid = [];
  for (const entry of directories) {
    if (entry.mode !== 0o750) invalid.push(`${entry.path}=${entry.mode.toString(8)} (directory)`);
  }
  for (const entry of files) {
    if (entry.mode !== 0o640) invalid.push(`${entry.path}=${entry.mode.toString(8)} (file)`);
  }
  for (const entry of shellFiles) {
    if (entry.mode !== 0o750) invalid.push(`${entry.path}=${entry.mode.toString(8)} (shell)`);
  }
  return {
    valid: invalid.length === 0,
    detail: invalid.length > 0
      ? invalid.slice(0, 8).join(", ") + (invalid.length > 8 ? `, and ${invalid.length - 8} more` : "")
      : `${directories.length} directories=750, ${files.length} files=640, ${shellFiles.length} shell files=750`
  };
}

function sourcePermissionCheck() {
  if (process.platform === "win32") {
    return check(
      "source-permissions",
      "pass",
      "Unix mode bits are not applicable to the Windows standby; the server deployment gate enforces them"
    );
  }

  const directories = [];
  const files = [];
  const shellFiles = [];
  const inspect = (absolutePath, relativePath) => {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`${relativePath} is a symbolic link`);
    if (stat.isDirectory()) {
      directories.push({ path: relativePath, mode: stat.mode & 0o777 });
      const entries = fs.readdirSync(absolutePath).sort((left, right) => left.localeCompare(right, "en"));
      for (const entry of entries) inspect(path.join(absolutePath, entry), `${relativePath}/${entry}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`${relativePath} is not a regular file or directory`);
    const target = relativePath.startsWith("scripts/") && relativePath.endsWith(".sh")
      ? shellFiles
      : files;
    target.push({ path: relativePath, mode: stat.mode & 0o777 });
  };

  for (const relativePath of PROTECTED_SOURCE_FILES) {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${relativePath} is not a safe regular source file`);
    }
    files.push({ path: relativePath, mode: stat.mode & 0o777 });
  }
  for (const relativePath of PROTECTED_SOURCE_DIRECTORIES) {
    inspect(path.join(ROOT_DIR, relativePath), relativePath);
  }
  const contract = unixSourcePermissionContract({ directories, files, shellFiles });
  return check(
    "source-permissions",
    contract.valid ? "pass" : "fail",
    contract.valid
      ? contract.detail
      : `expected recursive directories 750, files 640, and shell files 750; got ${contract.detail}`
  );
}

function secretPermissionCheck() {
  if (process.platform === "win32") {
    return windowsPermissionCheck();
  }
  const rootMode = fs.statSync(ROOT_DIR).mode & 0o777;
  const envMode = fs.statSync(path.join(ROOT_DIR, ".env")).mode & 0o777;
  const dataDir = path.join(ROOT_DIR, "data");
  const dataMode = fs.statSync(dataDir).mode & 0o777;
  const protectedStores = [
    "recommendation-history.json",
    "sent-messages.json",
    "meal-events.json",
    "verified-candidates.json",
    "candidate-preferences.json",
    "coffee-participation.json",
    "delivery-outbox.json"
  ];
  const storeModes = protectedStores.map((name) => fs.statSync(path.join(dataDir, name)).mode & 0o777);
  const contract = unixPermissionContract({ rootMode, envMode, dataMode, storeModes });
  if (!contract.valid) {
    return check("secret-permissions", "fail", `expected project 700/750, .env 600, data 700, and operating stores 600; got ${contract.detail}`);
  }
  return check("secret-permissions", "pass", contract.detail);
}

function assertNormalizedMealTypes(items, field) {
  for (const item of items) {
    if (normalizeMealType(item.mealType || "meal") !== item.mealType) {
      throw new Error(`${field} contains a non-normalized meal type`);
    }
  }
}

export function runHealthCheck({ now = new Date() } = {}) {
  const checks = [];
  let candidateSchedule;
  try {
    const holidayCache = new Map();
    const holidayCheck = (dateKey) => {
      const year = dateKey.slice(0, 4);
      if (!holidayCache.has(year)) {
        holidayCache.set(year, loadHolidayDates(
          path.join(DATA_DIR, "holiday-skip-dates.json"),
          { requiredYear: year }
        ));
      }
      return holidayCache.get(year).includes(dateKey);
    };
    const nextSendAt = nextScheduledSendAt({ now, holidayCheck });
    candidateSchedule = candidateReadinessWindow({ now, nextSendAt });
  } catch {
    candidateSchedule = null;
  }
  const localEmergencyActive = fs.existsSync(path.join(DATA_DIR, "local-emergency-lease.json"));
  checks.push(attempt("configuration", () => {
    validateRuntimeConfig(config, { requireBotToken: true });
    return check("configuration", "pass", "runtime configuration valid");
  }));
  checks.push(attempt("operating-maintenance", () => {
    const result = inspectOperatingMaintenanceMarker({ now });
    if (result.state === "absent") return check("operating-maintenance", "pass", result.detail);
    if (result.state === "active" && result.owned) {
      return check("operating-maintenance", "pass", result.detail);
    }
    if (result.state === "active") {
      return check("operating-maintenance", "warn", result.detail);
    }
    return check("operating-maintenance", "fail", result.detail);
  }));
  checks.push(check(
    "codex-model-contract",
    config.codexCliModel === REQUIRED_CODEX_MODEL
      && config.codexCliReasoningEffort === REQUIRED_CODEX_REASONING_EFFORT
      && config.codexCliUseSearch
      ? "pass"
      : "fail",
    `${config.codexCliModel} / reasoning ${config.codexCliReasoningEffort} / web search ${config.codexCliUseSearch}`
  ));
  const deliveryContract = productionDeliveryContract(config);
  checks.push(check(
    "production-delivery-contract",
    deliveryContract.valid ? "pass" : "fail",
    deliveryContract.detail
  ));
  checks.push(attempt("meal-normalization-catalog", () => {
    const catalog = loadMealNormalizationCatalog();
    if (!catalog.length) throw new Error("meal normalization catalog is empty");
    return check("meal-normalization-catalog", "pass", `${catalog.length} canonical restaurant/menu entries`);
  }));
  checks.push(attempt("static-fallback", () => {
    const result = validateStaticFallback();
    if (!result.ok) throw new Error(result.message);
    return check("static-fallback", "pass", result.message);
  }));
  checks.push(attempt("holiday-coverage", () => {
    const year = new Intl.DateTimeFormat("en", { timeZone: config.timezone, year: "numeric" }).format(now);
    const dates = loadHolidayDates(path.join(DATA_DIR, "holiday-skip-dates.json"), { requiredYear: year });
    return check("holiday-coverage", "pass", `${year}: ${dates.filter((date) => date.startsWith(`${year}-`)).length} skip dates`);
  }));
  checks.push(attempt("filesystem-capacity", () => {
    const capacity = fs.statfsSync(ROOT_DIR, { bigint: true });
    return filesystemCapacityHealth({
      availableBytes: Number(capacity.bavail * capacity.bsize),
      totalBytes: Number(capacity.blocks * capacity.bsize)
    });
  }));

  let history;
  let sentMessages;
  let mealEvents;
  let candidatePreferences;
  let coffeeParticipation;
  let deliveryOutbox;
  checks.push(attempt("operating-data", () => {
    history = getRecommendationHistory();
    sentMessages = getSentMessages();
    mealEvents = getMealEvents();
    candidatePreferences = getCandidatePreferences();
    coffeeParticipation = getCoffeeParticipation();
    deliveryOutbox = getDeliveryOutbox();
    if (!Array.isArray(sentMessages.messages)) throw new Error("sent-messages.json must contain a messages array");
    return check(
      "operating-data",
      "pass",
      `${history.items.length} recommendations, ${sentMessages.messages.length} messages, ${mealEvents.events.length} meal events, ${candidatePreferences.responses.length} preference responses, ${coffeeParticipation.messages.length} coffee messages, ${deliveryOutbox.deliveries.length} pending deliveries`
    );
  }));
  if (deliveryOutbox) {
    checks.push(attempt("delivery-outbox", () => {
      if (deliveryOutbox.deliveries.length === 0) {
        return check("delivery-outbox", "pass", "no uncertain scheduled deliveries");
      }
      const ages = deliveryOutbox.deliveries.map((item) => (now.getTime() - Date.parse(item.preparedAt)) / 3600000);
      if (ages.some((age) => !Number.isFinite(age) || age < -5 / 60 || age > 1)) {
        throw new Error(`${deliveryOutbox.deliveries.length} stale or future-dated scheduled deliveries require operator review`);
      }
      return check("delivery-outbox", "warn", `${deliveryOutbox.deliveries.length} recent uncertain deliveries are awaiting idempotent retry`);
    }));
  }

  if (history && sentMessages && mealEvents && candidatePreferences && coffeeParticipation) {
    checks.push(attempt("meal-event-integrity", () => {
      const counts = validateMealEventStore(mealEvents);
      return check("meal-event-integrity", "pass", `${counts.eventCount} valid, unique meal events`);
    }));
    checks.push(attempt(
      "meal-normalization-state",
      () => mealNormalizationStateHealth(mealEvents)
    ));
    checks.push(attempt(
      "meal-normalization-unverified",
      () => unverifiedMealNormalizationHealth(mealEvents)
    ));
    checks.push(attempt("recommendation-history-structure", () => {
      const counts = validateRecommendationHistoryStore(history);
      return check("recommendation-history-structure", "pass", `${counts.itemCount} items in ${counts.groupCount} complete diverse groups`);
    }));
    checks.push(attempt("sent-message-structure", () => {
      const counts = validateSentMessageStore(sentMessages);
      return check("sent-message-structure", "pass", `${counts.messageCount} unique normalized messages`);
    }));
    checks.push(attempt("message-cleanup-state", () => {
      const pending = sentMessages.messages.filter((message) => message.deletionRequestedAt && !message.deletedAt);
      if (pending.length === 0) return check("message-cleanup-state", "pass", "no pending Slack deletion intents");
      const stale = pending.filter((message) => now.getTime() - Date.parse(message.deletionRequestedAt) > 60 * 60 * 1000);
      if (stale.length > 0) throw new Error(`${stale.length} Slack deletion intents have remained pending for over one hour`);
      return check("message-cleanup-state", "warn", `${pending.length} recent Slack deletion intents are awaiting retry`);
    }));
    checks.push(attempt("candidate-preference-integrity", () => {
      const counts = validateCandidatePreferenceStore(candidatePreferences);
      return check(
        "candidate-preference-integrity",
        "pass",
        `${counts.responseCount} unique responses, ${counts.ratingCount} valid ratings, no raw user IDs`
      );
    }));
    checks.push(attempt("coffee-participation-integrity", () => {
      const counts = validateCoffeeParticipationStore(coffeeParticipation);
      return check(
        "coffee-participation-integrity",
        "pass",
        `${counts.messageCount} message states, ${counts.participantCount} unique participant entries`
      );
    }));
    checks.push(attempt("meal-type-normalization", () => {
      assertNormalizedMealTypes(history.items, "recommendation history");
      assertNormalizedMealTypes(sentMessages.messages, "sent messages");
      assertNormalizedMealTypes(mealEvents.events, "meal events");
      assertNormalizedMealTypes(candidatePreferences.responses, "candidate preferences");
      return check("meal-type-normalization", "pass", "all operating meal labels are Korean-normalized");
    }));
    checks.push(attempt("food-taxonomy-integrity", () => {
      const recommendations = readJson("recommendations.json", []);
      const verifiedCandidates = readJson("verified-candidates.json", {
        version: 1,
        candidates: [],
        catalog: []
      });
      const migration = migrateTaxonomyStores({
        recommendations,
        recommendationHistory: history,
        sentMessages,
        mealEvents,
        candidatePreferences,
        verifiedCandidates
      });
      const mutationCount = (value) => value && typeof value === "object"
        ? Object.values(value).reduce((sum, count) => sum + Number(count || 0), 0)
        : Number(value || 0);
      const mutations = Object.entries(migration.report)
        .map(([name, value]) => [name, mutationCount(value)])
        .filter(([, count]) => count > 0)
        .map(([name, count]) => `${name}=${count}`);
      if (migration.droppedMessageKeys.length > 0 || mutations.length > 0) {
        throw new Error(`food taxonomy migration is not clean: ${mutations.join(", ") || `${migration.droppedMessageKeys.length} dropped groups`}`);
      }
      const candidateCount = (verifiedCandidates.candidates?.length || 0)
        + (verifiedCandidates.catalog?.length || 0);
      return check(
        "food-taxonomy-integrity",
        "pass",
        `19-category taxonomy is canonical across ${recommendations.length + history.items.length} recommendations, ${candidateCount} candidates, ${mealEvents.events.length} meal events, and ${candidatePreferences.responses.length} preference responses`
      );
    }));
    checks.push(attempt("category-arbitration-integrity", () => {
      const verifiedCandidates = readJson("verified-candidates.json", {
        version: 1,
        candidates: [],
        catalog: []
      });
      const report = auditCategoryArbitrationStores({
        verifiedCandidates,
        recommendationHistory: history,
        candidatePreferences,
      });
      const unresolved = Object.entries(report)
        .filter(([, group]) => group.unresolved.length > 0)
        .map(([name, group]) => `${name}=${group.unresolved.length}`);
      if (unresolved.length) {
        throw new Error(`unresolved category arbitration rows: ${unresolved.join(", ")}`);
      }
      const total = Object.values(report).reduce((sum, group) => sum + group.total, 0);
      return check(
        "category-arbitration-integrity",
        "pass",
        `${total} learned rows have structural, model-agreement, or identity-bound adjudication authority`
      );
    }));
  }

  if (history && sentMessages) {
    const report = auditRecommendationData({
      history,
      sentMessages,
      candidatePreferences,
      now,
      policyEnforcementSince: config.policyEnforcementSince,
      choiceDiversityEnforcementSince: config.choiceDiversityEnforcementSince
    });
    checks.push(check(
      "history-integrity",
      auditHasStructuralFailure(report) ? "fail" : "pass",
      auditHasStructuralFailure(report) ? "sent/history groups are inconsistent" : `${report.totals.historyMessageGroups} complete groups`
    ));
    checks.push(cooldownEnforcementHealth(report));
    checks.push(check(
      "choice-diversity-enforcement",
      report.choiceDiversity.enforcedViolationEvents > 0 ? "fail" : "pass",
      `${report.choiceDiversity.enforcedViolationEvents} violations since enforcement (${report.choiceDiversity.allViolationEvents} retained historical audit events)`
    ));
  }

  checks.push(attempt("cache-readiness", () => {
    try {
      const recommendations = getCachedRecommendations({
        history,
        mealEvents,
        candidatePreferences,
        mealType: "점심",
        now
      });
      return check("cache-readiness", "pass", `${recommendations.length} immediately selectable recommendations`);
    } catch (error) {
      if (candidateSchedule?.refreshPending && !localEmergencyActive) {
        return check(
          "cache-readiness",
          "pass",
          `no immediate send is due; the ${candidateSchedule.refreshAt.toISOString()} candidate refresh gate precedes ${candidateSchedule.nextSendAt.toISOString()}`
        );
      }
      throw error;
    }
  }));

  checks.push(attempt("standby-immediate-readiness", () => {
    if (!history || !mealEvents) throw new Error("operating data is unavailable");
    const store = readJson("verified-candidates.json", { version: 1, candidates: [] });
    const readiness = immediateStandbyReadiness({
      now,
      verifiedCandidates: store.candidates,
      history,
      mealEvents
    });
    if (!readiness.ready) {
      throw new Error(`fresh local standby cannot send an immediate meal: ${readiness.detail}`);
    }
    return check(
      "standby-immediate-readiness",
      "pass",
      `fresh local standby can immediately cover both meal entry points: ${readiness.detail}`
    );
  }));

  checks.push(attempt("standby-24h-readiness", () => {
    if (!history || !mealEvents) throw new Error("operating data is unavailable");
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const years = new Set([
      getKstParts(now).dateKey.slice(0, 4),
      getKstParts(new Date(expiresAt.getTime() - 1)).dateKey.slice(0, 4)
    ]);
    const holidayDates = [...years].flatMap((year) => loadHolidayDates(
      path.join(DATA_DIR, "holiday-skip-dates.json"),
      { requiredYear: year }
    ));
    const store = readJson("verified-candidates.json", { version: 1, candidates: [] });
    const readiness = defaultLeaseStandbyReadiness({
      now,
      holidayDates,
      verifiedCandidates: store.candidates,
      history,
      mealEvents
    });
    if (!readiness.ready) {
      throw new Error(`default 24-hour local standby lease is not covered: ${readiness.detail}`);
    }
    return check(
      "standby-24h-readiness",
      "pass",
      readiness.scheduledSendCount
        ? `default local standby lease covers every scheduled meal: ${readiness.detail}`
        : readiness.detail
    );
  }));

  checks.push(attempt("verified-candidates", () => {
    const filePath = path.join(DATA_DIR, "verified-candidates.json");
    if (!fs.existsSync(filePath) && !fs.existsSync(`${filePath}.bak`)) {
      return check(
        "verified-candidates",
        config.allowUnverifiedFallback ? "warn" : "fail",
        "no pre-verified candidate pool is present"
      );
    }
    const store = readJson("verified-candidates.json", { version: 1, candidates: [] });
    const allCurrentlyEligible = filterEligibleVerifiedCandidates(store.candidates, { now });
    const unverifiedActive = allCurrentlyEligible.filter((candidate) =>
      !hasCurrentDeterministicEvidence(candidate, { now })
    );
    checks.push(check(
      "candidate-evidence-verification",
      unverifiedActive.length ? "fail" : "pass",
      unverifiedActive.length
        ? `${unverifiedActive.length} currently eligible active candidates lack current deterministic HTML verification`
        : "all currently eligible active candidates have current deterministic HTML verification"
    ));
    const currentlyEligible = allCurrentlyEligible.filter((candidate) =>
      hasCurrentDeterministicEvidence(candidate, { now })
    );
    if (!candidateSchedule) throw new Error("could not resolve the next candidate refresh and send window");
    const { nextSendAt } = candidateSchedule;
    const eligible = filterEligibleVerifiedCandidates(currentlyEligible, { now: nextSendAt })
      .filter((candidate) => hasCurrentDeterministicEvidence(candidate, { now: nextSendAt }));
    const selectable = filterResearchCooldownEligible(eligible, { history, mealEvents, now: nextSendAt });
    const freshViable = hasViableRecommendationSet(selectable, config.recommendationCount);
    const direct = selectable.filter((candidate) => candidate.deliveryStatus === "verified");
    const directViable = hasViableRecommendationSet(direct, config.recommendationCount);
    const scheduledRecovery = !freshViable && candidateSchedule.refreshPending && !localEmergencyActive;
    const readinessStatus = freshViable || scheduledRecovery
      ? "pass"
      : config.allowUnverifiedFallback ? "warn" : "fail";
    checks.push(check(
      "delivery-confidence",
      readinessStatus,
      directViable
        ? `${direct.length} candidates carry fresh direct-delivery evidence labels; checkout is not independently verified`
        : freshViable
          ? `${selectable.length}/${eligible.length} candidates remain cooldown-selectable and deterministically evidence-valid through ${nextSendAt.toISOString()}; checkout remains a user confirmation`
          : scheduledRecovery
            ? `the ${candidateSchedule.refreshAt.toISOString()} evidence refresh gate precedes ${nextSendAt.toISOString()}; current cache is not treated as next-send evidence`
          : `${selectable.length}/${eligible.length} deterministically verified candidates remain cooldown-selectable through ${nextSendAt.toISOString()} and cannot form a diverse set`
    ));
    return check(
      "verified-candidates",
      readinessStatus,
      freshViable
        ? `${eligible.length}/${currentlyEligible.length} trusted candidates remain valid through the actual next send; ${selectable.length} are cooldown-eligible now`
        : scheduledRecovery
          ? `next-send candidates are intentionally gated by the ${candidateSchedule.refreshAt.toISOString()} refresh before ${nextSendAt.toISOString()}`
        : `${eligible.length}/${currentlyEligible.length} trusted candidates remain valid through the actual next send and cannot form a diverse set; ${selectable.length} are cooldown-eligible now`
    );
  }));

  checks.push(attempt("secret-permissions", secretPermissionCheck));
  checks.push(attempt("source-permissions", sourcePermissionCheck));
  const isolation = codexExecutionIsolationStatus();
  checks.push(check("codex-least-privilege", isolation.safe ? "pass" : "fail", isolation.detail));
  const codexCapability = codexResearchCapabilityStatus();
  checks.push(check(
    "codex-research-capability",
    codexCapability.ok ? "pass" : "fail",
    codexCapability.detail
  ));
  checks.push(attempt("codex-live-authentication", () => {
    if (process.platform === "win32") {
      return check("codex-live-authentication", "pass", "Windows emergency mode uses verified cached candidates without a model session");
    }
    const result = liveCodexAuthHealth({ directory: path.join(DATA_DIR, "codex-cli-runs"), now,
      model: config.codexCliModel, reasoningEffort: config.codexCliReasoningEffort });
    return check("codex-live-authentication", result.status, result.detail);
  }));
  checks.push(check(
    "loose-fallback",
    config.allowUnverifiedFallback ? "warn" : "pass",
    config.allowUnverifiedFallback ? "unverified emergency candidates are allowed" : "unverified emergency candidates are disabled"
  ));
  checks.push(check(
    "operations-alert",
    config.operationsAlertChannelId === REQUIRED_OPERATOR_DM_CHANNEL_ID ? "pass" : "fail",
    config.operationsAlertChannelId === REQUIRED_OPERATOR_DM_CHANNEL_ID
      ? `failure alerts are pinned to protected operator DM ${REQUIRED_OPERATOR_DM_CHANNEL_ID}`
      : `failure alerts must use protected operator DM ${REQUIRED_OPERATOR_DM_CHANNEL_ID}`
  ));

  return {
    version: 1,
    releaseVersion: RELEASE.version,
    releaseDate: RELEASE.date,
    releaseImplementationModel: RELEASE.implementationModel,
    releaseLabel: RELEASE.label,
    generatedAt: now.toISOString(),
    ...summarizeHealth(checks),
    checks
  };
}

export function formatHealthReport(report) {
  const releaseLabel = report.releaseLabel || report.releaseVersion;
  const lines = [
    `ojeommwo-v2 ${releaseLabel} health: ${report.status.toUpperCase()} (pass=${report.counts.pass}, warn=${report.counts.warn}, fail=${report.counts.fail})`
  ];
  for (const item of report.checks) lines.push(`- [${item.status.toUpperCase()}] ${item.name}: ${item.detail}`);
  return lines.join("\n");
}
