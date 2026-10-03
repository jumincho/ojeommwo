# Ojeommwo v2.5 contributor rules

Release: 2.5.0 (v2.5), 2026-10-03T00:56:08+09:00. User-requested attribution: GPT-6 Astra Ultra. Runtime: GPT-6 Luna / xhigh.

The integrated server project owns the bot, original stores and `observatory/` child project. Sites hosts only the read-only website and sanitized aggregate snapshot. Runtime research uses `gpt-6-luna` with `xhigh` and web search. Preserve 19 meal categories, canonical identities, ingredient tags, cooldowns, Korean UI wording, percentages and existing features. Keep `/bap`, participant counts and browser polling removed.

Model output is an untrusted structured claim. Code verifies branch identity, pages, prices, delivery, distance, category structure and expiry before atomic writes. The model never writes original stores or replaces reproducible preference/ranking arithmetic. Strong dish forms protect against ingredient-driven errors; genuinely ambiguous categories use identity-bound model adjudication.

Never test-send to a shared meal channel. Use mocks, dry runs and capability reads; an operator DM requires the installation owner's explicit instruction. Private DM input and preview contexts must not influence group taste or meal history. Public checkout identifiers are placeholders. Secrets, original stores, receipts, OAuth state and runtime logs must not enter Git.

Install root dependencies with `npm ci --omit=dev --ignore-scripts`; run `npm run check`, `npm test`, `npm run observatory:validate` and `npm run observatory:test`. Observatory build checks additionally need frozen pnpm dependencies, lint and typecheck. Build production UI on the authoritative deployment server, then copy its static emergency build. A fork needs its own Sites project and credentials; never deploy to the bundled reference project.

Standby is normally OFF. Activation needs a matching source seal, seven consistent stores no older than 24 hours, valid recommendation evidence, independently confirmed primary outage and a bounded lease. Recovery or expiry stops standby. No automatic offsite backup is provided, so an unsynchronized standby may correctly refuse activation.

After a model replacement or prompt cache miss, read `HANDOFF.md`, `ARCHITECTURE.md`, `MODEL_EVALUATION.md`, `QUALITY_REPORT.md` and `observatory/HANDOFF.md`; inspect actual code and rerun relevant checks. No remembered conversation or prompt cache is authoritative. Claude Opus 5.5 Ultracode completed the frontend and five-language README changes in PR #3. They are integrated as a v2.5 follow-up; the original 2.5.0 package version, release declaration, immutable tag and GPT-6 Luna / xhigh runtime remain unchanged. Current integration and publication status is recorded in HANDOFF.md and QUALITY_REPORT.md.

Keep `observatory/patches/braces@3.0.3.patch`, its pinned pnpm patch hash and `observatory/tests/braces-security.test.mjs` together. A raw High advisory remains until an upstream fixed release exists; document the local depth-limit mitigation separately from the audit result. Do not add an advisory ignore entry to obtain PASS.
