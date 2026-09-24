import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

export const SOURCE_SEAL_LIMITS = Object.freeze({
  maxFiles: 2_048,
  maxEntries: 4_096,
  maxDepth: 16,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxRelativePathBytes: 512
});

const SOURCE_DIRECTORIES = Object.freeze(["src", "scripts", "prompts", "config"]);
const SOURCE_FILES = Object.freeze([
  "package.json",
  "data/holiday-skip-dates.json",
  "data/recommendations.json",
  "data/recommendations.sample.json"
]);
// Include the integrated observatory source in the emergency-copy identity.
// Generated snapshots, build caches, dependencies and credentials remain separate.
const OBSERVATORY_SOURCE_DIRECTORIES = Object.freeze([
  "app", "build", "scripts", "worker", "patches", ".openai",
]);
const OBSERVATORY_SOURCE_FILES = Object.freeze([
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "VERSION",
  "next.config.ts", "vite.config.ts", "tsconfig.json", "eslint.config.mjs",
  "run-pororo.sh",
]);

const RELEASE_KEYS = Object.freeze(["version", "date", "implementationModel", "label"]);
let releaseImportSequence = 0;

function fail(message) {
  throw new Error(`Source seal rejected: ${message}`);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertRelativePath(relativePath, limits) {
  if (typeof relativePath !== "string" || relativePath.length === 0 ||
      path.posix.isAbsolute(relativePath) || relativePath.includes("\\") ||
      relativePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /[\u0000-\u001f\u007f]/u.test(relativePath)) {
    fail(`unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
  if (Buffer.byteLength(relativePath, "utf8") > limits.maxRelativePathBytes) {
    fail(`relative path exceeds ${limits.maxRelativePathBytes} UTF-8 bytes: ${relativePath}`);
  }
  if (relativePath !== relativePath.normalize("NFC")) {
    fail(`relative path is not NFC-normalized: ${relativePath}`);
  }
}

function assertLimits(limits) {
  const merged = { ...SOURCE_SEAL_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`invalid ${name} bound`);
  }
  return Object.freeze(merged);
}

function sameFileStat(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
    before.mode === after.mode;
}

async function assertRegularDirectory(directoryPath, displayName) {
  const stat = await fs.lstat(directoryPath, { bigint: true }).catch((error) => {
    fail(`cannot inspect ${displayName}: ${error.message}`);
  });
  if (stat.isSymbolicLink()) fail(`${displayName} is a symbolic link or junction`);
  if (!stat.isDirectory()) fail(`${displayName} is not a directory`);
  return stat;
}

async function collectSourceFiles(root, limits) {
  const files = [];
  let entryCount = 0;
  let totalBytes = 0;

  const addFile = async (relativePath) => {
    assertRelativePath(relativePath, limits);
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    if (!isWithinRoot(root, absolutePath)) fail(`path escapes the project root: ${relativePath}`);

    const before = await fs.lstat(absolutePath, { bigint: true }).catch((error) => {
      fail(`cannot inspect ${relativePath}: ${error.message}`);
    });
    if (before.isSymbolicLink()) fail(`${relativePath} is a symbolic link or junction`);
    if (!before.isFile()) fail(`${relativePath} is not a regular file`);
    if (before.size > BigInt(limits.maxFileBytes)) {
      fail(`${relativePath} exceeds the ${limits.maxFileBytes}-byte per-file bound`);
    }
    if (files.length + 1 > limits.maxFiles) fail(`source tree exceeds the ${limits.maxFiles}-file bound`);
    totalBytes += Number(before.size);
    if (totalBytes > limits.maxTotalBytes) fail(`source tree exceeds the ${limits.maxTotalBytes}-byte total bound`);

    const realPath = await fs.realpath(absolutePath).catch((error) => {
      fail(`cannot resolve ${relativePath}: ${error.message}`);
    });
    if (!isWithinRoot(root, realPath)) fail(`resolved path escapes the project root: ${relativePath}`);
    files.push({ relativePath, absolutePath, before });
  };

  const walkDirectory = async (relativeDirectory, depth) => {
    if (depth > limits.maxDepth) fail(`${relativeDirectory} exceeds the ${limits.maxDepth}-level depth bound`);
    assertRelativePath(relativeDirectory, limits);
    const absoluteDirectory = path.resolve(root, ...relativeDirectory.split("/"));
    if (!isWithinRoot(root, absoluteDirectory)) fail(`directory escapes the project root: ${relativeDirectory}`);
    await assertRegularDirectory(absoluteDirectory, relativeDirectory);
    const realDirectory = await fs.realpath(absoluteDirectory);
    if (!isWithinRoot(root, realDirectory)) fail(`resolved directory escapes the project root: ${relativeDirectory}`);

    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) fail(`source tree exceeds the ${limits.maxEntries}-entry bound`);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      assertRelativePath(relativePath, limits);
      if (entry.isSymbolicLink()) fail(`${relativePath} is a symbolic link or junction`);
      if (entry.isDirectory()) {
        await walkDirectory(relativePath, depth + 1);
      } else if (entry.isFile()) {
        await addFile(relativePath);
      } else {
        fail(`${relativePath} is not a regular file or directory`);
      }
    }
  };

  for (const relativePath of SOURCE_FILES) await addFile(relativePath);
  for (const relativeDirectory of SOURCE_DIRECTORIES) await walkDirectory(relativeDirectory, 1);
  const observatoryRoot = path.join(root, "observatory");
  const observatoryStat = await fs.lstat(observatoryRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (observatoryStat) {
    await assertRegularDirectory(observatoryRoot, "observatory");
    for (const name of OBSERVATORY_SOURCE_FILES) await addFile(`observatory/${name}`);
    for (const name of OBSERVATORY_SOURCE_DIRECTORIES) await walkDirectory(`observatory/${name}`, 1);
    for (const name of ["icon.svg", "og.png"]) await addFile(`observatory/public/${name}`);
  }


  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  const portableNames = new Set();
  for (const file of files) {
    const portableName = file.relativePath.normalize("NFC").toLowerCase();
    if (portableNames.has(portableName)) fail(`source tree has a cross-platform path collision: ${file.relativePath}`);
    portableNames.add(portableName);
  }
  return files;
}

function frameLength(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

async function readRelease(root) {
  const versionPath = path.join(root, "src", "version.js");
  const versionUrl = pathToFileURL(versionPath);
  versionUrl.searchParams.set("sourceSealRead", String(++releaseImportSequence));
  let imported;
  try {
    imported = await import(versionUrl.href);
  } catch (error) {
    fail(`src/version.js could not be loaded: ${error.message}`);
  }
  const release = imported.RELEASE;
  if (!release || typeof release !== "object" || Array.isArray(release) ||
      Object.keys(release).length !== RELEASE_KEYS.length ||
      RELEASE_KEYS.some((key) => typeof release[key] !== "string" || release[key].length === 0) ||
      RELEASE_KEYS.some((key) => !Object.hasOwn(release, key))) {
    fail("src/version.js RELEASE must contain exactly version, date, implementationModel, and label strings");
  }
  return Object.fromEntries(RELEASE_KEYS.map((key) => [key, release[key]]));
}

export async function buildSourceSeal({ root = DEFAULT_ROOT, limits = {} } = {}) {
  const effectiveLimits = assertLimits(limits);
  const requestedRoot = path.resolve(root);
  await assertRegularDirectory(requestedRoot, "project root");
  const realRoot = await fs.realpath(requestedRoot);
  const files = await collectSourceFiles(realRoot, effectiveLimits);
  const release = await readRelease(realRoot);
  const hash = crypto.createHash("sha256");
  hash.update("ojeommwo-source-seal-v1\0", "utf8");
  let packageContent = null;

  for (const file of files) {
    const content = await fs.readFile(file.absolutePath);
    const after = await fs.lstat(file.absolutePath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || !sameFileStat(file.before, after) ||
        BigInt(content.length) !== after.size) {
      fail(`${file.relativePath} changed while the seal was being generated`);
    }
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    hash.update(frameLength(pathBytes.length));
    hash.update(pathBytes);
    hash.update(frameLength(content.length));
    hash.update(content);
    if (file.relativePath === "package.json") packageContent = content;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageContent.toString("utf8"));
  } catch (error) {
    fail(`package.json is invalid JSON: ${error.message}`);
  }
  const packageReleaseVersion = /^\d+\.\d+$/u.test(release.version) ? `${release.version}.0` : release.version;
  if (packageJson.version !== packageReleaseVersion) {
    fail(`package.json version ${JSON.stringify(packageJson.version)} does not match src/version.js ${JSON.stringify(release.version)}`);
  }
  for (const file of files) {
    const finalStat = await fs.lstat(file.absolutePath, { bigint: true }).catch((error) => {
      fail(`cannot recheck ${file.relativePath}: ${error.message}`);
    });
    if (!finalStat.isFile() || finalStat.isSymbolicLink() || !sameFileStat(file.before, finalStat)) {
      fail(`${file.relativePath} changed before the seal was finalized`);
    }
  }

  return Object.freeze({
    version: 1,
    release: Object.freeze(release),
    sourceSeal: Object.freeze({
      algorithm: "sha256",
      sha256: hash.digest("hex"),
      fileCount: files.length
    })
  });
}

export function serializeSourceSeal(seal) {
  return `${JSON.stringify(seal, null, 2)}\n`;
}

function parseArguments(argv) {
  const options = { root: DEFAULT_ROOT, output: "" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--root" && argument !== "--output") fail(`unsupported argument: ${argument}`);
    if (seen.has(argument)) fail(`duplicate argument: ${argument}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) fail(`${argument} requires a value`);
    seen.add(argument);
    options[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const serialized = serializeSourceSeal(await buildSourceSeal({ root: options.root }));
  if (!options.output) {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = path.resolve(options.output);
  const outputParent = path.dirname(outputPath);
  await assertRegularDirectory(outputParent, "source-seal output directory");
  await fs.writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
