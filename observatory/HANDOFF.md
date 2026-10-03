# Observatory v2.5 handoff

Release: 2.5.0 (v2.5), 2026-10-03T00:56:08+09:00. User-requested attribution: GPT-6 Astra Ultra. Runtime: GPT-6 Luna / xhigh.

`observatory/` is a child of the authoritative bot project. Sites serves the frontend/Worker and sanitized aggregate R2 snapshot; the bot and original database remain on the server. Runtime model research remains GPT-6 Luna / xhigh. The GPT-6 Astra Ultra label belongs to the original release. Claude Opus 5.5 Ultracode completed the frontend and five-language README changes in PR #3. They are integrated as a v2.5 follow-up; the original 2.5.0 package version, release declaration, immutable tag and GPT-6 Luna / xhigh runtime remain unchanged. Current integration and publication status is recorded in HANDOFF.md and QUALITY_REPORT.md.

Read the parent handoff, then `ARCHITECTURE.md`, `DESIGN.md` and `SECURITY.md` in this folder. The snapshot includes verified catalog identities and historical taste without publishing raw responses or Slack identities. Price/delivery display freshness is distinct from retained identity. API loading has a 10-second deadline and static fallback 5 seconds; a validated local cache is the last fallback. Expiry timers and visibility changes update only local rendering, with no network polling.

Preserve Korean wording, information scope, percentage displays and functions. First category selection isolates it; later categories can be combined. The taste axis shows dislike/neutral/like with text, colour and shape; nearest-star selection and non-intercepting labels support crowded views. The paused orbit still permits selection. Reduced motion and GPU-context loss stop animation safely. No browser auto-refresh or removed filters should be restored.

Uploads have bounded authenticated chunks, SHA-256, idempotent commit receipts and R2 conditional writes. Validate the published snapshot and actual browser rendering/CSP; HTTP 200 alone is insufficient. A fork needs its own Site project and credentials and must never deploy to the bundled reference project. Install frozen dependencies, run tests/lint/typecheck, then build only on the authoritative deployment server. Copy its prebuilt static output to emergency standby rather than rebuilding a different UI locally.

The normally-OFF emergency viewer is loopback-only and requires the parent source/store/lease guards. No automatic offsite backup exists. Release-specific private deployment, local sync and DM receipts stay outside this public repository; see the parent quality report for scoped results and limitations.

## Current follow-up

The v2.5 follow-up was deployed successfully on 2026-10-03 at 14:06:46.919 KST. [Public PR #3](https://github.com/jumincho/ojeommwo/pull/3) was merged with all four author commits preserved; reviewed local refinements and current documentation are recorded in the following source commit. The original v2.5.0 tag, 2.5.0 package version and original release declaration remain unchanged. Source/deployment receipts are retained privately. Repository branch cleanup and automatic branch deletion are not part of this completed validation claim.

Preserve forced-colour contrast, keyboard focus visibility, bounded pulse motion, narrow emergency banner and offline-warning coexistence and backdrop wheel suppression. The emergency viewer CSS is scoped so it cannot alter the copied production build. Validate the local braces depth-limit patch with frozen install and the direct-pattern/AST regression; retain the raw High advisory in reports until upstream publishes a fix. See SECURITY.md and the parent QUALITY_REPORT.md for the exact boundary and checked results.
