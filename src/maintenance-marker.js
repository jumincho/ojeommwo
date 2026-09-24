import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export const OPERATING_MAINTENANCE_MARKER = ".operating-maintenance";
export const OPERATING_MAINTENANCE_MAX_AGE_MS = 60 * 60 * 1000;
export const OPERATING_MAINTENANCE_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const OPERATING_MAINTENANCE_OPERATIONS = Object.freeze([
  "integrated-source-deployment",
  "food-taxonomy-migration",
  "local-emergency-reconciliation"
]);

function invalid(detail) {
  return { state: "invalid", detail };
}

export function inspectOperatingMaintenanceMarker({
  markerPath = path.join(DATA_DIR, OPERATING_MAINTENANCE_MARKER),
  now = new Date(),
  expectedToken = String(process.env.OJEOMMWO_MAINTENANCE_TOKEN || "")
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Maintenance marker inspection requires a valid current time");
  }
  if (!fs.existsSync(markerPath)) {
    return { state: "absent", detail: "no operating-data maintenance is active" };
  }

  let stat;
  try {
    stat = fs.lstatSync(markerPath);
  } catch (error) {
    return invalid(`maintenance marker cannot be inspected: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return invalid("maintenance marker must be a regular, non-symbolic file");
  }
  if (stat.size <= 0 || stat.size > 4096) {
    return invalid("maintenance marker must contain 1-4096 bytes");
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    return invalid(`maintenance marker is not valid JSON: ${error.message}`);
  }
  if (!marker || Array.isArray(marker) || typeof marker !== "object") {
    return invalid("maintenance marker must be a JSON object");
  }
  if (marker.version !== 1) return invalid("maintenance marker version must be 1");
  if (!OPERATING_MAINTENANCE_OPERATIONS.includes(marker.operation)) {
    return invalid("maintenance marker operation is not allowlisted");
  }
  if (typeof marker.issuedAt !== "string" || !marker.issuedAt.trim()) {
    return invalid("maintenance marker requires issuedAt");
  }
  const issuedAtMs = Date.parse(marker.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return invalid("maintenance marker issuedAt is invalid");
  const ageMs = now.getTime() - issuedAtMs;
  if (ageMs < -OPERATING_MAINTENANCE_FUTURE_SKEW_MS) {
    return invalid("maintenance marker issuedAt is too far in the future");
  }
  if (ageMs > OPERATING_MAINTENANCE_MAX_AGE_MS) {
    return {
      state: "stale",
      detail: `maintenance marker is stale (${Math.floor(ageMs / 60000)} minutes old)`,
      marker,
      ageMs
    };
  }
  if (marker.operation === "integrated-source-deployment"
      || marker.operation === "local-emergency-reconciliation") {
    if (!/^[a-f0-9]{32}$/u.test(String(marker.token || ""))) {
      return invalid(`${marker.operation} maintenance marker requires a 32-character token`);
    }
  }

  const owned = Boolean(expectedToken)
    && /^[a-f0-9]{32}$/u.test(expectedToken)
    && marker.token === expectedToken;
  return {
    state: "active",
    detail: `${marker.operation} maintenance is active since ${new Date(issuedAtMs).toISOString()}${owned ? " and owned by this process" : ""}`,
    marker,
    ageMs,
    owned
  };
}

