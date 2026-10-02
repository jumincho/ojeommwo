# Observatory security contract

Only a schema-validated aggregate snapshot is public. Original Slack identities, individual response timestamps, messages, credentials, original stores and logs are excluded. The browser is read-only; publish credentials stay in protected deployment state, outside Git and build artifacts. Public source installation IDs are placeholders; its algorithm contract fingerprint is recomputed from the sanitized source.

Uploads use constant-time credential checks, strict byte and decompression limits, release/schema validation, SHA-256, bounded deadlines and idempotent commit receipts. R2 ETag conditions prevent an older concurrent request from replacing newer data. Invalid fields, inconsistent release contracts and prohibited timestamps fail closed. Browser fetch deadlines and validated fallback/cache data prevent a hung endpoint from holding the UI indefinitely. Local timers expire display facts without polling.

HTML scripts use byte-exact CSP hashes rather than script unsafe-inline, with anti-framing and hardened response headers. Asset paths, public URLs and external evidence sources are validated and bounded. HTTP 200 does not prove usable CSP or successful hydration: actual deployed browser behavior is checked separately. Dependency versions are locked and release audits have no advisory ignore list.

The local emergency viewer binds loopback only, validates sanitized data, displays emergency mode and serves the copied static build with hashed-script CSP. Parent source, seven-store freshness, independent outage and lease guards remain required. Tests never send real messages to a shared meal channel. Installation-specific credentials, original-data integration and recovery receipts are documented privately.
