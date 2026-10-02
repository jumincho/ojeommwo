# Observatory v2.5 handoff

Release: 2.5.0 (v2.5), 2026-10-03T00:56:08+09:00. User-requested attribution: GPT-6 Astra Ultra. Runtime: GPT-6 Luna / xhigh.

`observatory/` is a child of the authoritative bot project. Sites serves the frontend/Worker and sanitized aggregate R2 snapshot; the bot and original database remain on the server. Runtime model research remains GPT-6 Luna / xhigh. The GPT-6 Astra Ultra label belongs to this release; a later Claude Opus 5 Ultracode frontend and README improvement pass is planned, not completed here.

Read the parent handoff, then `ARCHITECTURE.md`, `DESIGN.md` and `SECURITY.md` in this folder. The snapshot includes verified catalog identities and historical taste without publishing raw responses or Slack identities. Price/delivery display freshness is distinct from retained identity. API loading has a 10-second deadline and static fallback 5 seconds; a validated local cache is the last fallback. Expiry timers and visibility changes update only local rendering, with no network polling.

Preserve Korean wording, information scope, percentage displays and functions. First category selection isolates it; later categories can be combined. The taste axis shows dislike/neutral/like with text, colour and shape; nearest-star selection and non-intercepting labels support crowded views. The paused orbit still permits selection. Reduced motion and GPU-context loss stop animation safely. No browser auto-refresh or removed filters should be restored.

Uploads have bounded authenticated chunks, SHA-256, idempotent commit receipts and R2 conditional writes. Validate the published snapshot and actual browser rendering/CSP; HTTP 200 alone is insufficient. A fork needs its own Site project and credentials and must never deploy to the bundled reference project. Install frozen dependencies, run tests/lint/typecheck, then build only on the authoritative deployment server. Copy its prebuilt static output to emergency standby rather than rebuilding a different UI locally.

The normally-OFF emergency viewer is loopback-only and requires the parent source/store/lease guards. No automatic offsite backup exists. Release-specific private deployment, local sync and DM receipts stay outside this public repository; see the parent quality report for scoped results and limitations.
