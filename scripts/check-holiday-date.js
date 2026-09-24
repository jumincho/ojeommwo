import { loadHolidayDates } from "../src/scheduler.js";

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set(["--file", "--date"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowed.has(option) || values.has(option)) throw new Error(`invalid argument: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    values.set(option, value);
    index += 1;
  }
  if (!values.has("--file") || !values.has("--date")) {
    throw new Error("--file and --date are required");
  }
  const date = values.get("--date");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("--date must be a real calendar date in YYYY-MM-DD format");
  }
  return { filePath: values.get("--file"), date };
}

try {
  const { filePath, date } = parseArguments(process.argv.slice(2));
  const dates = loadHolidayDates(filePath, { requiredYear: date.slice(0, 4) });
  console.log(dates.includes(date) ? "skip" : "send");
} catch (error) {
  console.error(`[holiday-check] FAIL: ${error?.message || error}`);
  process.exitCode = 1;
}
