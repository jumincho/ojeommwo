import path from "node:path";
import { mergeOperatingSnapshots } from "../src/operating-snapshot-merge.js";

const VALUE_FLAGS = new Set(["--server-dir", "--local-dir", "--output-dir"]);

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a directory path`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of VALUE_FLAGS) {
    if (!values.has(flag)) throw new Error(`${flag} is required`);
  }
  return Object.fromEntries([...values].map(([flag, value]) => [flag.slice(2), path.resolve(value)]));
}

const args = parseArgs(process.argv.slice(2));
const result = mergeOperatingSnapshots({
  serverDir: args["server-dir"],
  localDir: args["local-dir"],
  outputDir: args["output-dir"]
});
console.log(JSON.stringify({ ok: true, ...result }, null, 2));
