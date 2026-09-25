# Observatory v3 public handoff

The Observatory is the observatory/ child project of Ojeommwo. Start with README.md, ARCHITECTURE.md, DESIGN.md and SECURITY.md. Its Korean wording, information, preference percentages, multi-category filters and manual refresh behavior are intentional.

After installing locked dependencies, pnpm test, pnpm lint and pnpm typecheck validate the public source. pnpm build requires the integrated parent bot source and produces the Sites artifact. The existing .openai/hosting.json identifies the author's Site: create or configure your own destination before deploying a fork. No original operating database or publisher secret belongs in the website artifact.

The next planned frontend and public README reviewer is Claude Opus 5 (max). Production edits and builds follow the owner's server-first workflow; deployment receipts, credentials and emergency synchronization details are kept in the private operations repository.
