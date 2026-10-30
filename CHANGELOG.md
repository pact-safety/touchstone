# Changelog

Dated history of the project, newest first. The docs describe the current state only.

- 2026-10-30: Adjudication prompt v4. `mentions` carry verbatim spans like conditions, and code checks them. Version 3 still gave BetterBench level 5 too freely: an observed score range counted as mentioning a floor or ceiling, and a repo name as mentioning a persistent identifier.
- 2026-10-30: Adjudication prompt v3. Two judges, requirements and alternatives, verbatim spans. Version 2 (one judge at low reasoning effort) over-credited in an audit: a related fact taken as the condition, partial evidence passed for "every", an OR-rule treated as needing both branches.
- 2026-10-30: Adjudication prompt v2 added. No judge call without quotes, a looser span check, and a two-level BetterBench skip.
- 2026-10-30: Cross-check of two model readings (`scripts/crosscheck.ts`) and adjudication of disputed rows by a fixed rule cascade (`scripts/adjudicate.ts`), with a script to apply a reviewer's decisions.
- 2026-10-30: Repository prepared for public release: nightly schedule documented as paused, draft status stated in the README, `CITATION.cff` added, bakeoff `replayed_from` paths made repository-relative.
- 2026-10-29: Four catalogued standards encoded. The excerpt budget is recorded per assessment.
- 2026-10-29: Automated draft assessments (google/gemma-4-31b-it) for the eight standards encoded at the time.
- 2026-10-28: The arXiv watcher's scope check was tuned on a hand-labelled set of 71 items; Gemma had said yes to 46 of 48 papers. Qwen3.6-35B-A3B was chosen.
- 2026-10-28: Bake-off checks the model the provider served. DeepInfra had retired OLMo 3.1 and served Gemma 4 for that id.
- 2026-10-28: Bake-off `--replay` added, and the quote check fixed so it no longer rejects verbatim quotes. The 40,000-character bake-off was rescored, then run again, then both runs were rescored after a reply-parsing fix. See [bakeoff/README.md](bakeoff/README.md).
- 2026-10-28: Hourly news and daily arXiv watchers added; they file candidate issues for a person to review.
- 2026-10-27: First bake-off against BetterBench: four models on 23 benchmarks.
- 2026-10-26: The `guidance.met` rules of 81 items were rewritten so that two assessors reach the same verdict: `aisl-scorecard` (34 rules, now 2026.07.1), `abc` (25, now 1.0.1), `construct-validity` (15, now 2025.1.1) and `stream` (7, now 1.0.1). An audit had flagged 81 of 154 rules as open to interpretation. Agreement has not yet been measured.
- 2026-10-26: Roadmap items 1 (what would most improve this rating) and 2 (safety benchmark coverage) built.
