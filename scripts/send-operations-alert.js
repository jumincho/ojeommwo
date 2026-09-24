import { assertRuntimeConfig } from "../src/config.js";
import { sendOperationsAlert } from "../src/operations-alert.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

assertRuntimeConfig({ requireBotToken: true });

const result = await sendOperationsAlert({
  job: argValue("--job", "scheduled job"),
  detail: argValue("--detail", "non-zero exit")
});
if (!result.sent) console.log(`[operations-alert] skipped: ${result.reason}`);
else console.log(`[operations-alert] sent to ${result.channel}:${result.ts}`);
