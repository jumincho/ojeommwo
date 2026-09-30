// Pin the security-patched transport independently of the shared Node runtime.
// Do not silently fall back to an older built-in transport when dependencies
// are missing: npm ci must complete before production or emergency activation.
export { fetch as fetchHttp, WebSocket as TransportWebSocket } from "undici";
