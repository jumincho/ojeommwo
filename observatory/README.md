# Ojeommwo Menu Observatory · v2.6

The observatory reads a public snapshot generated from the Ojeommwo bot's operating database. Its canonical source is `/root/ojeommwo-v2/observatory` in the pororo container, under the main project rather than in a sibling project. The public site is https://ojeommwo-observatory.jumincho.chatgpt.site/.

The interface provides a 3D menu cosmos, taste map and list, multiple category selection, search by menu, restaurant, or main ingredient, menu details, and menu browsing. The page does not refresh automatically; reopening or manually refreshing it loads the latest published snapshot. The operating database and Slack bot remain on pororo rather than moving to Sites.

On the server, run `corepack pnpm run verify:sites` to check tests, lint, types, and the Sites build. `corepack pnpm run verify` also checks the static build for local emergency viewing. `.openai/hosting.json` contains the Sites project ID and R2 binding; secrets and the raw database are excluded from public source and builds. A host cron job publishes a validated snapshot every ten minutes, and a separate health check compares the public response hash.

The parent project's `AGENTS.md`, `HANDOFF.md`, and `QUALITY_REPORT.md` define the deployment, operating, and emergency procedures. Internal Sites deployment numbers are separate from product version 2.6.
