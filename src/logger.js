const SECRET_PATTERNS = [
  /xoxb-[A-Za-z0-9-]+/g,
  /xapp-[A-Za-z0-9-]+/g,
  /sk-[A-Za-z0-9_-]+/g
];

export function redact(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

function timestamped(message) {
  return `${new Date().toISOString()} ${redact(message)}`;
}

export function logInfo(message, ...args) {
  console.log(timestamped(message), ...args.map(redact));
}

export function logWarn(message, ...args) {
  console.warn(timestamped(message), ...args.map(redact));
}

export function logError(message, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  console.error(timestamped(message), redact(detail));
}
