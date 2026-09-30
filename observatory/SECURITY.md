# Observatory security contract

Only a schema-validated aggregate snapshot is public. Original Slack identities, timestamps, individual responses, credentials, raw stores and internal logs are excluded. Browser data is read-only. Runtime push credentials stay in protected deployment state and do not belong in Git or a build artifact.

Uploads require constant-time credential checks, byte limits, schema and release validation, checksums, bounded deadlines and idempotent commit receipts. R2 ETag checks prevent an older concurrent write from replacing a newer snapshot. Private data, stale/future timestamps and wrong release data fail closed.

HTML scripts use byte-exact CSP hashes and avoid script unsafe-inline. Include no-store and hardened response headers. Public URLs and image paths are validated, external sources are bounded, and image decoding/size inputs are tested. Known dependency vulnerabilities were patched for v2; locked audits are repeated at release time.

The local emergency viewer binds loopback only, validates sanitized data, displays emergency mode and serves the copied static build with hashed-script CSP. Installation-specific credentials, receipts and recovery paths are documented privately. Tests never send real messages to shared meal channels.
