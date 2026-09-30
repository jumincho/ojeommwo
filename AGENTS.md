# Ojeommwo v2 contributor rules

The bot owns recommendation data and writes. `observatory/` is the integrated read-only website. Preserve the 19 meal categories, canonical identities, ingredient tags, cooldowns, Korean interface wording and existing features. Keep /bap and participant counts removed. Do not add browser polling.

Runtime research uses gpt-6-luna with xhigh and web search. Deterministic code validates evidence and handles ranking, preference weights, deduplication and atomic writes. Explicit food shapes override misleading ingredient or restaurant names; ambiguous identities require grounded model adjudication.

Never send tests to a shared meal channel. Use mocks, dry runs and capability reads. A private operator DM requires the installation owner's explicit instruction. Exclude private test contexts from learning. Production identifiers in this public checkout are placeholders.

Install root dependencies with npm ci --omit=dev --ignore-scripts. Run npm run check and npm test. Inside observatory install frozen pnpm dependencies and run tests, lint and typecheck. Original operating stores, credentials, private receipts and recovery paths do not belong in this repository. The sanitized public snapshot and synthetic fixtures support independent tests.

Deploying a fork requires its own Sites project and credentials; never deploy to the bundled reference project. Standby is normally off and requires independently confirmed server failure, matching source seal, consistent fresh stores and a bounded lease. No automatic offsite backup is provided.

Read HANDOFF, ARCHITECTURE, MODEL_EVALUATION and QUALITY_REPORT after a model change or a prompt cache miss. Frontend and five-language README improvements by Claude Opus 5.5 (max) were integrated on 2026-09-30. Validate each later change against current source and deployment receipts.
