# Ojeommwo v2.5 architecture

Release: 2.5.0 (v2.5), 2026-10-03T00:56:08+09:00. User-requested attribution: GPT-6 Astra Ultra. Runtime: GPT-6 Luna / xhigh.

```text
server cron -> bounded wrappers -> verified candidate refresh / scheduled Slack send
Slack Socket Mode -> immediate acknowledgement -> validation / survey / meal normalization
local meal wording -> trash rejection -> aliases + Luna search -> verified canonical identity
original JSON stores -> Bayesian taste + cooldown + diversity -> three meal choices
original stores + verified catalog -> sanitized snapshot -> authenticated Sites Worker / R2
Sites page -> bounded API load -> static snapshot fallback -> validated browser cache
server source + static emergency build + seven stores -> normally-OFF Windows standby
```

`src/` owns the bot contracts, food taxonomy, evidence, ranking, feedback, weather and persistence; `prompts/` defines structured model output. `config/` holds explicit restaurant/menu aliases. `scripts/` contains bounded operational CLIs and emergency deployment. `test/` covers the bot. `observatory/app`, `worker`, `build`, `scripts` and `tests` are one child module, not a sibling deployment or another writer of the original database.

## Decisions and data

Luna/xhigh researches restaurants and ambiguous meal/category meanings. It has no authority to write stores. Deterministic gates check independent branch/menu HTML, public URLs, coordinates, closure, distance, current prices, delivery and food shape. An ingredient such as bulgogi cannot turn pizza into Korean food. Known aliases collapse whitespace and spelling variants; uncertain identities stay retryable or rejected rather than entering as unsupported guesses.

Taste starts at Beta(3,3), weighs recommended-menu surveys at 0.9 and actual meal records at 1.0, and decays with a 180-day half-life. Repeated same-person input is deduplicated/damped across both channels; neutral and missing responses do not become dislikes. Ranking blends 82% stable posterior mean and 18% Beta exploration with a small 0.5 bonus for a well-evidenced untried restaurant. Hard cooldown, distance, evidence and meal diversity gates still apply.

The active candidate set holds up to 12 items; a bounded catalog preserves other verified discoveries and re-verifies them in rotation. Exploration and readiness are separate: optional new-restaurant research cannot destroy a viable prepared pool. Scheduled research targets two independently usable three-choice meal sets. Only the guarded 08:50–09:10 morning fallback may retain one revalidated set for lunch if the reserve cannot be filled; later refreshes replenish it. Refresh distinguishes operational failure from a harmless optional discovery shortfall.

## Freshness and publication

Recommendation price evidence expires after 7 days and delivery/HTML evidence after 3 days. Actual pages are revisited; identity, closure or branch mismatch removes eligibility. Still-valid evidence may survive a transient provider error, but an expired claim never becomes current solely because it was cached. Catalog identity and past preference can remain visible independently of expiring commercial facts.

The public snapshot combines eligible catalog identities with historical aggregate taste. Display evidence has its own explicit expiry; a retained restaurant name is not a promise of current price or delivery. Browsers bound the API fetch to 10 seconds and static fallback to 5 seconds, then use only a schema-valid local cache. Local expiry timers and visibility changes hide expired display facts without making network polls. Normal server exports continue every ten minutes; an open page does not auto-fetch them.

Snapshot upload uses authenticated bounded chunks, SHA-256, bounded decompression, commit receipts and R2 conditional writes. Retry of an already committed payload is idempotent; older data cannot replace a newer object. Browser rendering, schema validation and contract fingerprints defend against HTTP 200 responses with invalid or stale data. Public source has its own fingerprint because deployment identifiers are sanitized.

## Operations and boundaries

Seven original stores use schema validation, size limits, locks, atomic rename and fsync. The Slack outbox records delivery uncertainty instead of blindly resending. Scheduled send context is checked before live operations. Tests and private preview contexts are excluded from group learning. Weather uses five domestic KMA/AirKorea services; Open-Meteo is not a fallback.

The server listener is a small Node process; frontend dependencies are build tooling, not a permanent separate frontend server. Static/Worker hosting serves the website. Bounded candidate count, page sizes, model attempts and job deadlines limit operating weight. Dependency audits, live provider capability checks and actual browser checks complement unit tests; none can guarantee future external availability.

Windows standby is emergency-only and starts OFF. Version equality, source hashes and DB freshness are independent checks. The seven-store snapshot must be within 24 hours, the primary independently unavailable, and the lease valid. The copied static website binds loopback only. Primary recovery stops standby; a guarded merge handles emergency writes after recovery. Without automatic offsite synchronization, a long-unsynchronized local copy can be unusable during an outage and must not be forced past safety checks.

The v2.5 presentation follow-up adds forced-colour and higher-contrast support, clearer keyboard focus and scroll hints, and emergency-viewer CSS isolation. The local review also bounds the status pulse, prevents the emergency banner from clipping on narrow screens, including simultaneous offline warnings, and stops backdrop wheel scrolling. These changes preserve existing UI terms, information scope, bot decisions and data flow. Braces is build tooling with a local depth-limit mitigation; raw upstream audit status is documented in observatory/SECURITY.md.
