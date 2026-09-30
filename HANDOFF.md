# Ojeommwo v2 public handoff

Release: 2.0.0, 2026-09-30. Source declaration: 2026-09-30T17:33:38+09:00. Implementation attribution: GPT-6.1 Sol (max). Runtime: GPT-6 Luna / xhigh. Planned next frontend and README reviewer: Claude Opus 5 (max).

No previous conversation or prompt cache is required. Read AGENTS.md, README.md, ARCHITECTURE.md, MODEL_EVALUATION.md, QUALITY_REPORT.md and observatory/HANDOFF.md. Run locked dependency installation, root syntax/unit checks and Observatory tests/lint/typecheck. Public tests use sanitized snapshots and synthetic fixtures; original-store integration and deployment receipts are private installation checks.

The server is authoritative. Sites hosts the frontend and sanitized aggregate snapshot, while the Slack bot and original DB stay on the server. The observatory is a child project. Windows standby is normally off and requires matching source/locks, seven consistent stores, valid evidence, a recent snapshot and independently confirmed outage. Server recovery or lease expiry stops the standby.

Never test-send to shared meal channels. Preserve Korean UI text, existing percentage displays and functions. Keep /bap, participant counts and browser auto-refresh removed. Public identifiers are placeholders and the bundled reference Site project must not be used to deploy forks. No credentials, original reactions, operator identity or private deployment receipts belong here.
