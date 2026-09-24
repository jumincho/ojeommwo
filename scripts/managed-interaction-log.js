import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  "..",
  "logs",
  "interaction-listener.log"
);
const SECRET_PATTERNS = Object.freeze([
  /xoxb-[A-Za-z0-9-]+/gu,
  /xapp-[A-Za-z0-9-]+/gu,
  /sk-[A-Za-z0-9_-]+/gu
]);
const CONSOLE_METHODS = Object.freeze(["log", "info", "warn", "error", "debug"]);
const TRUNCATION_MARKER = Buffer.from("\n[log entry truncated]\n", "utf8");
const MANAGED_ARCHIVE_PATTERN = /^interaction-listener-\d{8}-\d{6}(?:-\d+(?:-\d+)?)?\.log$/u;

export const INTERACTION_LISTENER_LOG_LIMIT_BYTES = 5 * 1024 * 1024;
export const INTERACTION_LISTENER_ARCHIVE_LIMIT = 4;

let activeInstallation = null;

export function redactManagedLogText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

function compactUtcTimestamp(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Managed interaction log rotation requires a valid date");
  }
  return now.toISOString()
    .replace(/[-:]/gu, "")
    .replace("T", "-")
    .replace(/\.\d{3}Z$/u, "");
}

function validateLogPath(logPath) {
  if (!path.isAbsolute(logPath) || path.basename(logPath) !== "interaction-listener.log") {
    throw new Error("Managed interaction log path must be an absolute interaction-listener.log path");
  }
  const directory = path.dirname(logPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("Managed interaction log directory is not a safe regular directory");
  }
}

function openActiveLog(logPath, { exclusive = false } = {}) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const baseFlags = fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow;
  let expected = null;
  let flags = baseFlags;
  if (exclusive) {
    flags |= fs.constants.O_CREAT | fs.constants.O_EXCL;
  } else if (fs.existsSync(logPath)) {
    expected = fs.lstatSync(logPath);
    if (expected.isSymbolicLink() || !expected.isFile()) {
      throw new Error("Managed interaction log is not a safe regular file");
    }
  } else {
    flags |= fs.constants.O_CREAT | fs.constants.O_EXCL;
  }

  const fd = fs.openSync(logPath, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino))) {
      throw new Error("Managed interaction log changed while it was being opened");
    }
    fs.fchmodSync(fd, 0o600);
    return { fd, size: opened.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function selectArchivePath(logPath, now) {
  const directory = path.dirname(logPath);
  const timestamp = compactUtcTimestamp(now);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const archivePath = path.join(
      directory,
      `interaction-listener-${timestamp}-${process.pid}${suffix}.log`
    );
    if (!fs.existsSync(archivePath)) return archivePath;
  }
  throw new Error("Could not allocate a unique managed interaction log archive");
}

function collectManagedArchives(logPath) {
  const directory = path.dirname(logPath);
  const archives = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!MANAGED_ARCHIVE_PATTERN.test(entry.name) || !entry.isFile()) continue;
    const archivePath = path.join(directory, entry.name);
    const stat = fs.lstatSync(archivePath);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    archives.push({
      path: archivePath,
      name: entry.name,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  return archives;
}

export function pruneManagedInteractionLogArchives({
  logPath = DEFAULT_LOG_PATH,
  maxArchives = INTERACTION_LISTENER_ARCHIVE_LIMIT,
  preservePath = null
} = {}) {
  if (!Number.isSafeInteger(maxArchives) || maxArchives < 1 || maxArchives > 100) {
    throw new Error("Managed interaction log archive limit must be between 1 and 100");
  }
  validateLogPath(logPath);
  const preserve = preservePath ? path.resolve(preservePath) : null;
  const archives = collectManagedArchives(logPath);
  archives.sort((left, right) =>
    (right.path === preserve ? 1 : 0) - (left.path === preserve ? 1 : 0)
    || right.mtimeMs - left.mtimeMs
    || right.name.localeCompare(left.name, "en")
  );

  for (const archive of archives.slice(maxArchives)) {
    const current = fs.lstatSync(archive.path);
    if (current.isSymbolicLink() || !current.isFile()
        || current.dev !== archive.dev || current.ino !== archive.ino
        || current.size !== archive.size || current.mtimeMs !== archive.mtimeMs) {
      throw new Error(`Managed interaction log archive changed before pruning: ${archive.name}`);
    }
    fs.unlinkSync(archive.path);
  }
  const remaining = collectManagedArchives(logPath).length;
  if (remaining > maxArchives) {
    throw new Error(`Managed interaction log archive count remains above ${maxArchives}`);
  }
  return { removed: Math.max(0, archives.length - remaining), remaining };
}

function boundLogBuffer(args, maxBytes) {
  const formatted = redactManagedLogText(util.format(...args));
  const raw = Buffer.from(`${formatted}\n`, "utf8");
  if (raw.length <= maxBytes) return raw;
  if (maxBytes <= TRUNCATION_MARKER.length) return raw.subarray(0, maxBytes);

  let prefixLength = maxBytes - TRUNCATION_MARKER.length;
  while (prefixLength > 0 && (raw[prefixLength] & 0xc0) === 0x80) prefixLength -= 1;
  return Buffer.concat([raw.subarray(0, prefixLength), TRUNCATION_MARKER]);
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (written <= 0) throw new Error("Could not write the complete managed interaction log entry");
    offset += written;
  }
}

export function installManagedInteractionLog({
  logPath = DEFAULT_LOG_PATH,
  maxBytes = INTERACTION_LISTENER_LOG_LIMIT_BYTES,
  now = () => new Date()
} = {}) {
  if (activeInstallation) throw new Error("Managed interaction logging is already installed");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Managed interaction log limit must be a positive safe integer");
  }
  if (typeof now !== "function") throw new Error("Managed interaction log clock must be a function");
  validateLogPath(logPath);
  pruneManagedInteractionLogArchives({ logPath });

  let { fd, size: currentBytes } = openActiveLog(logPath);
  let closed = false;
  const archives = [];
  const originalConsole = Object.fromEntries(CONSOLE_METHODS.map((name) => [name, console[name]]));
  const installedConsole = {};

  const reopenAfterRename = () => {
    const archivePath = selectArchivePath(logPath, now());
    fs.closeSync(fd);
    fd = null;
    try {
      // The listener lock guarantees this process is the sole writer. Closing
      // before a same-directory rename and reopening before the next write
      // removes copytruncate's tail-loss race while keeping rotation atomic.
      fs.renameSync(logPath, archivePath);
      fs.chmodSync(archivePath, 0o600);
      ({ fd, size: currentBytes } = openActiveLog(logPath, { exclusive: true }));
      archives.push(archivePath);
      pruneManagedInteractionLogArchives({ logPath, preservePath: archivePath });
    } catch (error) {
      if (fd === null && fs.existsSync(logPath)) {
        try {
          ({ fd, size: currentBytes } = openActiveLog(logPath));
        } catch {
          // Preserve the original rotation error. The caller will terminate
          // instead of continuing with an unobservable listener.
        }
      }
      throw error;
    }
  };

  if (currentBytes > maxBytes) reopenAfterRename();

  const write = (...args) => {
    if (closed || fd === null) throw new Error("Managed interaction log is closed");
    const buffer = boundLogBuffer(args, maxBytes);
    if (currentBytes > 0 && currentBytes + buffer.length > maxBytes) reopenAfterRename();
    writeAll(fd, buffer);
    currentBytes += buffer.length;
  };

  for (const name of CONSOLE_METHODS) {
    installedConsole[name] = (...args) => write(...args);
    console[name] = installedConsole[name];
  }

  const installation = {
    get activeBytes() {
      return currentBytes;
    },
    get archivePaths() {
      return [...archives];
    },
    close() {
      if (closed) return;
      closed = true;
      for (const name of CONSOLE_METHODS) {
        if (console[name] === installedConsole[name]) console[name] = originalConsole[name];
      }
      if (fd !== null) fs.closeSync(fd);
      fd = null;
      activeInstallation = null;
    }
  };
  activeInstallation = installation;
  return installation;
}
