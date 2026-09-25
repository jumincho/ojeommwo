# Ojeommwo v3 public handoff

Release date: 2026-09-25. User-designated release attribution: GPT-6 Astra Max. Bot runtime: GPT-6 Luna / xhigh. Claude Opus 5 (max) is the planned next reviewer for frontend design and the public README.

A new contributor needs no earlier conversation or prompt cache: read AGENTS.md, README.md, ARCHITECTURE.md, MODEL_EVALUATION.md and observatory/HANDOFF.md. Run npm run check and npm test in the root, then pnpm test, pnpm lint and pnpm typecheck inside observatory after installing its locked dependencies. The public checkout supplies sanitized snapshots and synthetic stores; actual operating-store integration is a separate server check.

The bot/server is authoritative. Sites hosts the website and a sanitized read-only snapshot; it does not host the Slack bot or original operating database. Windows standby is normally off and requires a current matching source seal, seven consistent stores, valid candidates and an independently confirmed server outage. Separate-installation identifiers in this distribution are placeholders. Do not use the bundled production Site identifier to deploy a fork.

Preserve Korean interface wording and functionality. Never test-send to a shared meal channel. No credentials, original reactions, operator identity, deployment receipts or private recovery paths belong in this public document. Internal operational procedures and receipts are maintained separately.
