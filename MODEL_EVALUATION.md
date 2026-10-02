# v2.5 runtime model assessment

Release: 2.5.0 (v2.5), 2026-10-03T00:56:08+09:00. User-requested attribution: GPT-6 Astra Ultra. Runtime: GPT-6 Luna / xhigh.

The required research model is `gpt-6-luna` with `xhigh` and web search. It searches for restaurants, maps loose meal entries to grounded branches/menus and adjudicates ambiguous categories. Independent code checks model claims against branch/menu pages, coordinates, food shape, price/delivery expiry and schemas. The model does not write the original DB or replace deterministic ranking, preferences, deduplication, locks or atomic writes. Cache-only sends, survey storage, taste scoring and website reads use no model tokens.

The retained Luna/xhigh sample captured before the final live candidate-refresh test contains 38 invocations: 33 successes and 5 failures without usable token totals. Known usage totals 4,958,913 tokens: 4,845,842 input and 113,071 output. Cached input is 3,805,184, already included in input; 97,016 reasoning tokens are already included in output. These are retained measured invocations, not all-time account consumption or an allowance estimate.

| Job | Measured successful total tokens | Notes |
| --- | --- | --- |
| Authentication probe | 13,592–13,646 | 14 successes; separate failed probes may consume usage |
| Category adjudication | 15,004–35,651 | 3 successes |
| Loose meal normalization | 71,760–112,628 | 2 successes with searched evidence |
| Candidate research | 269,427–1,253,873 | 7 successes, median 450,015; broad searches and retries dominate |

The final live candidate-refresh test added one successful run: 423,246 total tokens (414,176 input, including 323,840 cached; 9,070 output, including 8,126 reasoning), in about 205.6 seconds, with one attempt and no retry. It preserved 12 active candidates, grew the catalog from 89 to 90 with one verified new restaurant, passed two-meal readiness and left all 38 health checks passing. Combining this run with the preceding retained sample gives 39 invocations (34 successes and 5 unknown-usage failures) and 5,382,159 known tokens; this remains a bounded sample, not account-wide usage.

The latest successful post-login probe used 13,624 tokens with zero cached input. A real loose-entry normalization used 71,760 tokens, independently resolved the intended branch/menu and did not write a test meal to the operating DB. The preceding authentication failure was an invalidated/revoked token, not evidence that model quality or xhigh was insufficient. Five candidate research runs at the observed median would use about 2.25 million tokens, plus about 95,410 for seven median authentication probes. Actual weekly research count, cache reuse and retries vary substantially.

This division suits a relatively inexpensive semantic model: bounded search and judgment are followed by reproducible integrity gates. The audit is not a controlled head-to-head benchmark proving Luna superior to larger models or guaranteeing perfect semantic correctness. A model's assertion alone never proves delivery to the exact checkout address, a restaurant still being open, or an ambiguous branch match. Failures retain valid prior state and expose unresolved work instead of fabricating facts.

Prompt cache affects cost/latency, not correctness. Prompts, schemas, aliases, source and handoff contain the required context for a new worker/model. Zero-cache authentication succeeded, but the audit did not perform a complete cold-cache research benchmark. ChatGPT/Codex plan usage and API billing are different systems; token measurements do not establish future account limits.

For survey sensitivity, Beta(3,3) and weight 0.9 move one independent strong positive from 50% to about 56.5%, two to 61.5%, and ten to 80%; negative responses are symmetric. Same-person repeats are deduplicated/damped, and actual meals also participate. Survey-only data therefore has substantial effect without a one-response swing to an extreme.

Official model capabilities: https://developers.openai.com/api/docs/models/gpt-6-luna . Plan usage information: https://learn.chatgpt.com/docs/pricing . Operational settings and measured receipts, not the coding agent's release label, establish what this bot actually ran.
