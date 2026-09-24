import handler from "vinext/server/app-router-entry";
import {
  SNAPSHOT_ABORT_PATH,
  SNAPSHOT_CHUNK_PATH,
  SNAPSHOT_COMMIT_PATH,
  SNAPSHOT_PATH,
  SNAPSHOT_UPLOAD_PATH,
  abortSnapshotChunks,
  addResponseSecurity,
  commitSnapshotChunks,
  healthResponse,
  jsonResponse,
  serveSnapshot,
  uploadSnapshot,
  uploadSnapshotChunk,
} from "./snapshot-edge.mjs";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
  SNAPSHOTS: {
    get(key: string): Promise<unknown>;
    put(key: string, value: ArrayBuffer | ArrayBufferView, options: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  SNAPSHOT_PUSH_TOKEN?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === SNAPSHOT_UPLOAD_PATH) {
      if (request.method !== "POST") return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      return uploadSnapshot(request, env);
    }
    if (url.pathname === SNAPSHOT_CHUNK_PATH) {
      if (request.method !== "GET") return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      return uploadSnapshotChunk(request, env);
    }
    if (url.pathname === SNAPSHOT_COMMIT_PATH) {
      if (request.method !== "GET") return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      return commitSnapshotChunks(request, env);
    }
    if (url.pathname === SNAPSHOT_ABORT_PATH) {
      if (request.method !== "GET") return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      return abortSnapshotChunks(request, env);
    }
    if (url.pathname === SNAPSHOT_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      }
      return serveSnapshot(request, env);
    }
    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      }
      return healthResponse(env);
    }
    if (url.pathname === "/robots.txt" || url.pathname === "/robots.txt/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      }
      const response = new Response(
        request.method === "HEAD" ? null : "User-agent: *\nDisallow: /\n",
        {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
      return addResponseSecurity(response, url, { method: request.method });
    }
    if (url.pathname === "/icon.svg/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ status: "error", reason: "method not allowed" }, 405);
      }
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/icon.svg";
      const response = await env.ASSETS.fetch(new Request(assetUrl, request));
      return addResponseSecurity(response, url, { method: request.method });
    }
    return addResponseSecurity(await handler.fetch(request, env, ctx), url, { method: request.method });
  },
};

export default worker;
