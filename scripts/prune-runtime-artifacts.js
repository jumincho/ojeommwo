import { pruneRuntimeArtifacts } from "../src/runtime-maintenance.js";

const result = pruneRuntimeArtifacts({ dryRun: process.argv.includes("--dry-run") });
console.log(`[maintenance] ${result.dryRun ? "would remove" : "removed"} ${result.totalRemoved} files (${result.totalBytes} bytes)`);
