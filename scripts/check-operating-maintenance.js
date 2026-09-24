import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import {
  inspectOperatingMaintenanceMarker,
  OPERATING_MAINTENANCE_MARKER
} from "../src/maintenance-marker.js";

const args = process.argv.slice(2);
let markerPath = path.join(DATA_DIR, OPERATING_MAINTENANCE_MARKER);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "--path") throw new Error(`Unknown argument: ${args[index]}`);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--path requires a value");
  markerPath = path.resolve(value);
  index += 1;
}

const result = inspectOperatingMaintenanceMarker({ markerPath });
if (result.state === "active") {
  console.log(`[maintenance] ${result.detail}`);
} else if (result.state === "absent") {
  console.log(`[maintenance] ${result.detail}`);
} else {
  console.error(`[maintenance] ${result.detail}`);
  process.exitCode = 1;
}

