# v2 runtime model assessment

The required research model is gpt-6-luna with xhigh reasoning and web search. It investigates local restaurants, resolves loosely written meal entries and adjudicates ambiguous food categories. Web output is checked against current address/menu HTML. Explicit food shapes such as pizza, curry and sushi have structural guards; an ambiguous model decision is bound to the grounded identity.

The model does not write the DB or replace deterministic ranking, locks, deduplication, price/delivery TTL or cooldown checks. Existing-cache sends, survey storage, taste scoring and the read-only website use no model tokens. This division is appropriate for Luna: scoped semantic judgments with verifiable output, and reproducible code for integrity.

Measured job ranges in a small installation sample: live authentication about 13,600 tokens; category adjudication about 15,000; a searched loose-entry normalization about 112,600; full candidate research about 269,000 to 1,254,000, with substantial cached input in large runs. Reasoning tokens are already included in output totals and must not be counted twice. Retries and failed runs may consume additional usage. Pro OAuth allowance and API billing are different systems; these observations are not guaranteed future quotas.

Taste retains Beta(3,3), survey weight 0.9 and a 180-day half-life. One strong positive independent survey moves 50% to 56.5%, two to 61.5%; negative reactions are symmetric. A mild positive moves to 53.5%, and same-person same-day repetition is deduplicated. Ten independent strong positives move toward 80%. Actual meal entries and surveys are deduplicated together, while survey-only signals remain meaningful.
