import path from "node:path";
import { validateOperatingSnapshotDirectory } from "../src/operating-snapshot.js";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}

const input = valueAfter("--data-dir");
if (!input) throw new Error("--data-dir is required");
const result = validateOperatingSnapshotDirectory(path.resolve(input));
console.log(JSON.stringify({
  ok: true,
  dataDir: result.dataDir,
  counts: result.counts,
  historyGroups: result.audit.totals.historyMessageGroups
}, null, 2));
