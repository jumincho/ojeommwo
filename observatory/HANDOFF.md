# Observatory v2 handoff

This is the `observatory/` child project of Ojeommwo v2, released 2026-09-30 with GPT-6.1 Sol (max) attribution. Planned next frontend and README reviewer: Claude Opus 5 (max).

Sites serves the UI and sanitized read-only aggregate snapshot. The bot owns the original data. The integration includes bounded chunk upload, SHA-256, retry receipts, R2 conditional writes and CSP hashes. Validate byte equality and actual browser behavior after deploying; HTTP 200 alone is insufficient. Deploy a fork to its own Site project, never the bundled reference installation.

Preserve text, information scope, preference percentages and features. First category selection isolates it; additional categories can be combined. The map has explicit dislike/neutral/like ends and nearest-point selection. The 3D view includes layered nebula/arms/glow/lensing and bounded density/pixel ratio; context loss stops animation. Keep browser auto-refresh and removed filters disabled.

Install frozen pnpm dependencies, run tests/lint/typecheck, then build on the deployment server. Copy prebuilt static output to emergency standby; do not rebuild a different frontend there. Standby is normally off. Read DESIGN.md, ARCHITECTURE.md, SECURITY.md and the parent handoff after any model or prompt-cache change.
