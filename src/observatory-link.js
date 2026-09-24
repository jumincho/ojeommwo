import { isIP } from "node:net";

export const DEFAULT_OBSERVATORY_URL = "https://ojeommwo-observatory.jumincho.chatgpt.site/";

export function normalizeObservatoryUrl(value, { allowEmpty = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    if (allowEmpty) return "";
    throw new Error("OBSERVATORY_URL is required when ENABLE_OBSERVATORY_LINK is enabled");
  }
  if (raw.length > 3000) throw new Error("OBSERVATORY_URL cannot exceed 3000 characters");

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OBSERVATORY_URL must be a valid HTTP or HTTPS URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OBSERVATORY_URL must not contain credentials");
  }
  if (parsed.protocol !== "https:") throw new Error("OBSERVATORY_URL must use HTTPS");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!hostname || parsed.port || isIP(hostname)
      || hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("OBSERVATORY_URL must use a public HTTPS hostname without a custom port");
  }
  return parsed.href;
}
