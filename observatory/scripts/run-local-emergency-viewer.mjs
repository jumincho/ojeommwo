#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOT_ROOT } from "./lib/bot-contract.mjs";
import {
  SNAPSHOT_INPUT_FILES,
  buildSnapshot,
  writeSnapshotAtomic,
} from "./lib/observatory-snapshot.mjs";
import { validateSnapshot } from "./lib/snapshot-schema.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const MAX_REQUEST_TARGET_BYTES = 2_048;
const MAX_STATIC_FILE_BYTES = 16 * 1024 * 1024;
const FALLBACK_FILES = Object.freeze({
  html: path.join(SCRIPT_DIR, "local-emergency-viewer.html"),
  css: path.join(SCRIPT_DIR, "local-emergency-viewer.css"),
  js: path.join(SCRIPT_DIR, "local-emergency-viewer.js"),
});
const SOURCE_FILES = Object.freeze([
  ...SNAPSHOT_INPUT_FILES,
  "coffee-participation.json",
]);
const STATIC_EXTENSIONS = new Set([".css", ".gif", ".ico", ".jpeg", ".jpg", ".js", ".png", ".svg", ".webp", ".woff", ".woff2"]);
const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function sameOrInside(parent, candidate) {
  const relative = path.relative(comparablePath(parent), comparablePath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return sameOrInside(left, right) || sameOrInside(right, left);
}

function resolveSafePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty local path`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label} must not be a filesystem root`);
  return resolved;
}

function assertNoSymlinkComponents(resolvedPath, label) {
  const parsed = path.parse(resolvedPath);
  let cursor = parsed.root;
  const segments = resolvedPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
  }
}

function assertSafeDirectory(directory, label) {
  assertNoSymlinkComponents(directory, label);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

function assertSafeRegularFile(filePath, label) {
  assertNoSymlinkComponents(filePath, label);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return stat;
}

function assertReadOnlySourceLayout(dataDir) {
  assertSafeDirectory(dataDir, "dataDir");
  for (const name of SOURCE_FILES) {
    assertSafeRegularFile(path.join(dataDir, name), `dataDir/${name}`);
  }
  const optionalOutbox = path.join(dataDir, "delivery-outbox.json");
  if (fs.existsSync(optionalOutbox)) assertSafeRegularFile(optionalOutbox, "dataDir/delivery-outbox.json");
}

export function validatePort(value) {
  const rendered = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,4})$/u.test(rendered)) throw new Error("port must be an integer from 0 through 65535");
  const port = Number(rendered);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  return port;
}

function readBundledFile(filePath, label) {
  const stat = assertSafeRegularFile(filePath, label);
  if (stat.size > MAX_STATIC_FILE_BYTES) throw new Error(`${label} is unexpectedly large`);
  return fs.readFileSync(filePath);
}

function inlineScriptHashes(html) {
  const hashes = new Set();
  const pattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu;
  for (const match of html.matchAll(pattern)) {
    if (!match[1]) continue;
    const digest = crypto.createHash("sha256").update(match[1], "utf8").digest("base64");
    hashes.add(`'sha256-${digest}'`);
  }
  return [...hashes].sort();
}

function contentSecurityPolicy({ scriptHashes = [], allowInlineStyles = false } = {}) {
  const scriptSources = ["'self'", ...scriptHashes].join(" ");
  const styleSources = allowInlineStyles ? "'self' 'unsafe-inline'" : "'self'";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src ${scriptSources}`,
    `style-src ${styleSources}`,
    "worker-src 'none'",
  ].join("; ");
}

function injectEmergencyBanner(html) {
  if (!/<head(?:\s[^>]*)?>/iu.test(html) || !/<body(?:\s[^>]*)?>/iu.test(html) || !/<\/head>/iu.test(html)) {
    throw new Error("out/index.html is not a complete HTML document");
  }
  const stylesheet = '<link rel="stylesheet" href="/local-emergency-viewer.css" data-local-emergency-style="true" />';
  const banner = '<aside class="local-emergency-banner" data-local-emergency-banner="true" role="status"><strong>로컬은 비상용입니다.</strong> 서버 장애 시 읽기 전용 확인에만 사용합니다.</aside>';
  const withStylesheet = html.replace(/<\/head>/iu, `${stylesheet}</head>`);
  return withStylesheet.replace(/<body(?:\s[^>]*)?>/iu, (body) => `${body}${banner}`);
}

function prepareUi(outDir) {
  const fallback = {
    html: readBundledFile(FALLBACK_FILES.html, "fallback HTML"),
    css: readBundledFile(FALLBACK_FILES.css, "fallback CSS"),
    js: readBundledFile(FALLBACK_FILES.js, "fallback JavaScript"),
  };
  const fallbackCsp = contentSecurityPolicy();
  if (!fs.existsSync(outDir)) return { mode: "fallback", fallback, csp: fallbackCsp, outDir: null, outRealDir: null };

  assertSafeDirectory(outDir, "outDir");
  const indexPath = path.join(outDir, "index.html");
  const rawIndex = readBundledFile(indexPath, "out/index.html").toString("utf8");
  const fullHtml = Buffer.from(injectEmergencyBanner(rawIndex), "utf8");
  return {
    mode: "full-static",
    fallback,
    fullHtml,
    csp: contentSecurityPolicy({
      scriptHashes: inlineScriptHashes(fullHtml.toString("utf8")),
      allowInlineStyles: true,
    }),
    outDir,
    outRealDir: fs.realpathSync.native(outDir),
  };
}

function securityHeaders(csp, contentType, length, extra = {}) {
  return {
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    "Content-Security-Policy": csp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(Number.isSafeInteger(length) ? { "Content-Length": String(length) } : {}),
    ...extra,
  };
}

function sendBuffer(request, response, status, body, contentType, csp, extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  response.writeHead(status, securityHeaders(csp, contentType, payload.length, extraHeaders));
  response.end(request.method === "HEAD" ? undefined : payload);
}

function requestPath(rawTarget) {
  if (typeof rawTarget !== "string" || !rawTarget.startsWith("/") || rawTarget.startsWith("//")
      || Buffer.byteLength(rawTarget, "utf8") > MAX_REQUEST_TARGET_BYTES) {
    throw new Error("invalid request target");
  }
  const queryIndex = rawTarget.search(/[?#]/u);
  const rawPath = queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
  let decoded = rawPath;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (/%(?:00|2e|2f|5c)/iu.test(decoded) || decoded.includes("\0") || decoded.includes("\\")) {
    throw new Error("unsafe request path");
  }
  const segments = decoded.split("/");
  // Rejecting ASCII control characters is the purpose of this path-safety expression.
  // eslint-disable-next-line no-control-regex
  if (segments.some((segment) => segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new Error("unsafe request path");
  }
  return decoded || "/";
}

function resolveStaticAsset(ui, pathname) {
  if (!ui.outDir) return null;
  const isNextAsset = pathname.startsWith("/_next/");
  const isRootAsset = pathname === "/icon.svg" || pathname === "/favicon.ico";
  if (!isNextAsset && !isRootAsset) return null;
  const extension = path.extname(pathname).toLocaleLowerCase("en-US");
  if (!STATIC_EXTENSIONS.has(extension)) return null;
  const relative = pathname.slice(1).split("/");
  const candidate = path.resolve(ui.outDir, ...relative);
  if (!sameOrInside(ui.outDir, candidate) || !fs.existsSync(candidate)) return null;
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATIC_FILE_BYTES) return null;
  const real = fs.realpathSync.native(candidate);
  if (!sameOrInside(ui.outRealDir, real)) return null;
  return { filePath: candidate, contentType: CONTENT_TYPES[extension] || "application/octet-stream" };
}

function createRequestHandler({ snapshotJson, healthJson, ui }) {
  const plainCsp = contentSecurityPolicy();
  return (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendBuffer(request, response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", plainCsp, { Allow: "GET, HEAD" });
        return;
      }

      let pathname;
      try {
        pathname = requestPath(request.url || "/");
      } catch {
        sendBuffer(request, response, 400, "Bad Request\n", "text/plain; charset=utf-8", plainCsp);
        return;
      }

      if (pathname === "/healthz") {
        sendBuffer(request, response, 200, healthJson, "application/json; charset=utf-8", plainCsp);
        return;
      }
      if (pathname === "/data/snapshot.json" || pathname === "/snapshot.json") {
        sendBuffer(request, response, 200, snapshotJson, "application/json; charset=utf-8", plainCsp);
        return;
      }
      if (pathname === "/local-emergency-viewer.css") {
        sendBuffer(request, response, 200, ui.fallback.css, CONTENT_TYPES[".css"], plainCsp);
        return;
      }
      if (pathname === "/local-emergency-viewer.js") {
        sendBuffer(request, response, 200, ui.fallback.js, CONTENT_TYPES[".js"], plainCsp);
        return;
      }
      if (pathname === "/" || pathname === "/index.html") {
        const html = ui.mode === "full-static" ? ui.fullHtml : ui.fallback.html;
        sendBuffer(request, response, 200, html, "text/html; charset=utf-8", ui.csp, { "Content-Language": "ko" });
        return;
      }

      const asset = resolveStaticAsset(ui, pathname);
      if (asset) {
        sendBuffer(request, response, 200, fs.readFileSync(asset.filePath), asset.contentType, ui.csp);
        return;
      }
      sendBuffer(request, response, 404, "Not Found\n", "text/plain; charset=utf-8", plainCsp);
    } catch {
      if (!response.headersSent) {
        sendBuffer(request, response, 500, "Internal Server Error\n", "text/plain; charset=utf-8", plainCsp);
      } else {
        response.destroy();
      }
    }
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => server.closeAllConnections(), 2_000);
    forceTimer.unref();
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function normalizedGeneratedAt(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("generatedAt must be a valid timestamp");
  return date.toISOString();
}

export async function startLocalEmergencyViewer({
  port = DEFAULT_PORT,
  dataDir = path.join(BOT_ROOT, "data"),
  runtimeDir = path.join(PROJECT_ROOT, "runtime", "local-emergency-viewer"),
  outDir = path.join(PROJECT_ROOT, "out"),
  generatedAt,
  onServerError,
} = {}) {
  const safePort = validatePort(port);
  const safeDataDir = resolveSafePath(dataDir, "dataDir");
  const safeRuntimeDir = resolveSafePath(runtimeDir, "runtimeDir");
  const safeOutDir = resolveSafePath(outDir, "outDir");
  if (path.basename(safeOutDir).toLocaleLowerCase("en-US") !== "out") throw new Error("outDir must end with an out directory");
  if (sameOrInside(safeDataDir, safeRuntimeDir)) throw new Error("runtimeDir must stay outside the source data directory");
  if (pathsOverlap(safeRuntimeDir, safeOutDir)) throw new Error("runtimeDir and outDir must not overlap");
  if (pathsOverlap(safeDataDir, safeOutDir)) throw new Error("outDir must stay separate from the source data directory");

  assertReadOnlySourceLayout(safeDataDir);
  assertNoSymlinkComponents(safeRuntimeDir, "runtimeDir");
  if (fs.existsSync(safeRuntimeDir)) assertSafeDirectory(safeRuntimeDir, "runtimeDir");
  fs.mkdirSync(safeRuntimeDir, { recursive: true, mode: 0o700 });
  assertSafeDirectory(safeRuntimeDir, "runtimeDir");

  const snapshotPath = path.join(safeRuntimeDir, "snapshot.json");
  if (fs.existsSync(snapshotPath)) assertSafeRegularFile(snapshotPath, "runtime snapshot");
  const generatedIso = normalizedGeneratedAt(generatedAt);
  const snapshot = validateSnapshot(buildSnapshot({ dataDir: safeDataDir, generatedAt: generatedIso }));
  writeSnapshotAtomic(snapshot, snapshotPath);
  validateSnapshot(JSON.parse(fs.readFileSync(snapshotPath, "utf8")));

  const ui = prepareUi(safeOutDir);
  const snapshotJson = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  const healthJson = Buffer.from(`${JSON.stringify({
    status: "ok",
    service: "ojeommwo-observatory-local-emergency-viewer",
    mode: "local-emergency-read-only",
    ui: ui.mode,
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    menus: snapshot.stats.menus,
    restaurants: snapshot.stats.restaurants,
  })}\n`, "utf8");
  const server = http.createServer(
    { maxHeaderSize: 8_192, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 },
    createRequestHandler({ snapshotJson, healthJson, ui }),
  );
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const handleListenError = (error) => reject(error);
    server.once("error", handleListenError);
    server.listen({ host: LOCAL_HOST, port: safePort, exclusive: true }, () => {
      server.off("error", handleListenError);
      resolve();
    });
  }).catch(async (error) => {
    await closeServer(server).catch(() => {});
    throw error;
  });
  server.on("error", (error) => {
    if (typeof onServerError === "function") onServerError(error);
  });

  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOCAL_HOST) {
    await closeServer(server);
    throw new Error("local emergency viewer failed to bind to loopback only");
  }
  return Object.freeze({
    server,
    host: LOCAL_HOST,
    port: address.port,
    url: `http://${LOCAL_HOST}:${address.port}`,
    mode: ui.mode,
    snapshot,
    snapshotPath,
    close: () => closeServer(server),
  });
}

export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const values = {
    port: env.OJEOMMWO_LOCAL_VIEWER_PORT || DEFAULT_PORT,
    dataDir: env.OJEOMMWO_DATA_DIR || path.join(BOT_ROOT, "data"),
    runtimeDir: env.OJEOMMWO_LOCAL_VIEWER_RUNTIME_DIR || path.join(PROJECT_ROOT, "runtime", "local-emergency-viewer"),
    outDir: env.OJEOMMWO_LOCAL_VIEWER_OUT_DIR || path.join(PROJECT_ROOT, "out"),
  };
  const names = new Map([
    ["--port", "port"],
    ["--data-dir", "dataDir"],
    ["--runtime-dir", "runtimeDir"],
    ["--out-dir", "outDir"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help" || name === "-h") return { help: true };
    const key = names.get(name);
    if (!key) throw new Error(`unknown option: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values[key] = value;
    seen.add(name);
    index += 1;
  }
  return { ...values, port: validatePort(values.port), help: false };
}

function printHelp() {
  process.stdout.write([
    "오점뭐 로컬 비상 관측소 (읽기 전용)",
    "",
    "Usage: node scripts/run-local-emergency-viewer.mjs [options]",
    "  --port <0-65535>       loopback port (default: 8790)",
    "  --data-dir <path>      ojeommwo-v2 data directory",
    "  --runtime-dir <path>   sanitized runtime snapshot directory",
    "  --out-dir <path>       optional prebuilt observatory out directory",
    "  --help                 show this help",
    "",
  ].join("\n"));
}

async function runCli() {
  try {
    const options = parseCliArgs();
    if (options.help) {
      printHelp();
      return;
    }
    let fatalServerError;
    const viewer = await startLocalEmergencyViewer({
      ...options,
      onServerError: (error) => {
        fatalServerError = error;
        process.stderr.write(`local emergency viewer server error: ${error.message}\n`);
      },
    });
    process.stdout.write(`로컬은 비상용입니다. 읽기 전용 관측소: ${viewer.url} (${viewer.mode})\n`);
    let closing = false;
    const shutdown = async (signal) => {
      if (closing) return;
      closing = true;
      process.stdout.write(`local emergency viewer stopping (${signal})\n`);
      try {
        await viewer.close();
        process.exitCode = fatalServerError ? 1 : 0;
      } catch (error) {
        process.stderr.write(`local emergency viewer shutdown failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    process.stderr.write(`local emergency viewer failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && comparablePath(process.argv[1]) === comparablePath(SCRIPT_PATH)) {
  await runCli();
}
