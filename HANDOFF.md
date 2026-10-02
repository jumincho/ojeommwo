# Ojeommwo v2.5 public handoff

Release: 2.5.0 (v2.5), 2026-10-03T00:56:08+09:00. User-requested attribution: GPT-6 Astra Ultra. Runtime: GPT-6 Luna / xhigh.

Release attribution `GPT-6 Astra Ultra` is a user-requested release label. The bot's operational model is `gpt-6-luna` with `xhigh`; changing the coding agent does not silently change that runtime contract. A later frontend and GitHub README improvement pass is planned for Claude Opus 5 Ultracode. It has not been counted as completed v2.5 work.

Start without relying on any earlier conversation or prompt cache: read `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `MODEL_EVALUATION.md`, `QUALITY_REPORT.md`, then `observatory/HANDOFF.md`. Inspect the actual version/source contracts. Root and Observatory dependencies are locked; run root syntax/tests, snapshot validation, Observatory tests/lint/typecheck and server builds before publishing changed UI.

The server is the authority for the Slack bot and seven original stores. The website is integrated under `observatory/`, with Sites serving only static assets/Worker and sanitized R2 aggregates. This public repository has placeholder installation identifiers and no original operating stores or private release receipts. Keep the independently maintained five-language README scope and MIT license. A fork must create its own hosting project; the bundled reference project is not a deployment target for contributors.

Tests must never send to a shared meal channel. Use mocks and dry runs; a real operator DM requires explicit authorization. Preserve Korean UI wording, information scope, preference percentages and existing functions. `/bap`, participant counts, browser polling and removed UI filters stay removed. Preserve delivery freshness, category structure, identity deduplication and shared-learning isolation when changing model prompts.

Standby remains OFF except a confirmed outage, with matching source seal, fresh consistent seven-store snapshot, current evidence and bounded lease. The 24-hour snapshot guard is intentional. No automatic offsite backup means source equality alone cannot promise emergency availability. Live authentication, Slack membership and provider/API availability need release-time verification outside the public synthetic test environment.

Final installation-specific server, browser, local standby, publication and DM evidence is held outside this public checkout. `QUALITY_REPORT.md` states the verified scope and its limits. Existing older Git tags remain immutable; current documentation focuses on v2.5.
