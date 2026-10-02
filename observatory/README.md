# Ojeommwo Menu Observatory

Release: 2.5.0 (v2.5), 2026-10-03T00:56:08+09:00. User-requested attribution: GPT-6 Astra Ultra. Runtime: GPT-6 Luna / xhigh.

The `observatory/` child project presents aggregate menu preferences in a 3D cosmos and taste map, with search, multiple category selection, details and random menu browsing. [Open the reference observatory](https://ojeommwo-observatory.jumincho.chatgpt.site/). The interface is Korean; preserve its current terms, information scope, percentage displays and functions.

The bot and original database remain on the deployment server. Only a sanitized read-only snapshot and the frontend are published through Sites. Server exports incorporate data and algorithm changes; the page loads once without browser polling. Local expiry timers remove outdated price/delivery claims without fetching again.

For a source checkout, first install root dependencies with `npm ci --omit=dev --ignore-scripts`, then install this folder's frozen pnpm dependencies. Run `corepack pnpm test`, `corepack pnpm lint` and `corepack pnpm typecheck`. Tests without original stores use the sanitized sample and synthetic fixtures. The frontend is built on the authoritative deployment server; its separate prebuilt static export supplies the emergency viewer.

Forks require their own Sites project, storage binding and credentials. Do not publish to the bundled reference project's hosting configuration. Do not place secrets, raw stores, OAuth state or internal receipts in Git or browser bundles. The normal server deployment needs no permanent preview or temporary tunnel.

Windows remains a normally-OFF emergency environment. Its copied source, static output, validated snapshot and seven-store recovery bundle follow the parent source/freshness/outage/lease guards. The emergency viewer binds loopback only. Read the parent `HANDOFF.md` and this folder's `ARCHITECTURE.md`, `DESIGN.md` and `SECURITY.md` before changing publication or UI behavior.
