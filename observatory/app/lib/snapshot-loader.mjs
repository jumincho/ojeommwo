import { validateSnapshot } from "./snapshot-validator.mjs";

export const SNAPSHOT_ENDPOINTS = ["/api/snapshot/current", "/data/snapshot.json"];
const MAX_SNAPSHOT_TEXT_LENGTH = 5_000_000;

// Independent deadlines allow the static fallback even when the API stalls.
// The parent signal only cancels unmounts; total network budget is 15 seconds.
/** @param {{ signal?: AbortSignal, fetchImpl?: typeof globalThis.fetch, deadlines?: number[] }} options */
export async function loadSnapshotFromEndpoints({ signal, fetchImpl = globalThis.fetch,
  deadlines = [10_000, 5_000] } = {}) {
  let lastError;
  for (const [index, endpoint] of SNAPSHOT_ENDPOINTS.entries()) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, deadlines[index]);
    try {
      const response = await fetchImpl(endpoint, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SNAPSHOT_TEXT_LENGTH) throw new Error("데이터 파일이 허용 크기를 초과했습니다.");
      const snapshotText = await response.text();
      if (snapshotText.length > MAX_SNAPSHOT_TEXT_LENGTH) throw new Error("데이터 파일이 허용 크기를 초과했습니다.");
      return validateSnapshot(JSON.parse(snapshotText));
    } catch (cause) {
      if (signal?.aborted) throw cause;
      lastError = timedOut ? new Error("요청 시간 초과") : cause;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }
  throw lastError ?? new Error("스냅샷을 불러오지 못했습니다.");
}
