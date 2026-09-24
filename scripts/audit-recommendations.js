import { auditHasIntegrityFailure, auditRecommendationData, formatAuditReport } from "../src/recommendation-audit.js";
import { getCandidatePreferences, getRecommendationHistory, getSentMessages } from "../src/storage.js";
import { config } from "../src/config.js";

function valueAfter(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const windowDays = Number.parseInt(valueAfter("--window-days", "30"), 10);
if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 3650) {
  throw new Error("--window-days must be an integer between 1 and 3650");
}

const report = auditRecommendationData({
  history: getRecommendationHistory(),
  sentMessages: getSentMessages(),
  candidatePreferences: getCandidatePreferences(),
  windowDays,
  policyEnforcementSince: config.policyEnforcementSince,
  choiceDiversityEnforcementSince: config.choiceDiversityEnforcementSince
});

if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else console.log(formatAuditReport(report));

if (process.argv.includes("--strict") && auditHasIntegrityFailure(report)) process.exitCode = 1;
