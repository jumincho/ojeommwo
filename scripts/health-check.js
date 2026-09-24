import { formatHealthReport, healthExitCode, runHealthCheck } from "../src/health.js";

const report = runHealthCheck();
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else console.log(formatHealthReport(report));
process.exitCode = healthExitCode(report, process.argv.slice(2));
