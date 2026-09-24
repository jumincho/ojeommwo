const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function parseEnvUpdates(text, allowedKeys) {
  const updates = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = line.indexOf("=");
    if (index <= 0) throw new Error("Environment update lines must use KEY=VALUE");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    if (!KEY_PATTERN.test(key) || !allowedKeys.has(key)) throw new Error(`Environment key is not allowed: ${key}`);
    if (value.includes("\n") || value.includes("\r")) throw new Error(`Environment value contains a newline: ${key}`);
    updates.set(key, value);
  }
  return updates;
}

export function mergeEnvText(currentText, updates) {
  const seen = new Set();
  const lines = String(currentText || "").split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line);
  const merged = lines.map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !updates.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates.get(match[1])}`;
  });
  for (const [key, value] of updates) {
    if (!seen.has(key)) merged.push(`${key}=${value}`);
  }
  return `${merged.join("\n")}\n`;
}

export function removeEnvKeys(currentText, keys) {
  const removed = [];
  const lines = String(currentText || "").split(/\r?\n/);
  const kept = lines.filter((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !keys.has(match[1])) return true;
    removed.push(match[1]);
    return false;
  });
  return {
    text: `${kept.filter((line, index, all) => index < all.length - 1 || line).join("\n")}\n`,
    removed: [...new Set(removed)]
  };
}
