const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Content-hash chunk writes and commit are idempotent. Bound each fetch/body
// read and the whole upload, including retries.
export async function requestSitesJson(url, headers, {
  signal, attempts = 3, timeoutMs = 15_000, fetchImpl = globalThis.fetch, sleep = delay,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await fetchImpl(url, {
        method: "GET", headers, redirect: "error", signal: requestSignal,
      });
      const text = await response.text();
      if (text.length > 16 * 1024) throw new Error("Sites response is too large");
      let body;
      try { body = JSON.parse(text); } catch { /* transient gateway response */ }
      if (response.ok && body?.status === "ok") return body;
      const error = new Error(`Sites request failed with status ${response.status}: ${String(body?.reason ?? "invalid JSON response")}`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500 || response.ok;
      throw error;
    } catch (error) {
      if (signal?.aborted || error.retryable === false) throw error;
      lastError = error;
      if (attempt + 1 < attempts) await sleep(250 * (2 ** attempt));
    }
  }
  throw lastError;
}
